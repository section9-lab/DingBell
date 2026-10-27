import { sendOzonMessage } from '../../src/modules/ozon/send.ts';
import { ConversationController } from '../../src/modules/conversations/controller.ts';
export { StoreCoordinator } from '../../src/modules/sync/coordinator.ts';
import workerEvents from '../../src/cloudflare.ts';
import type { ReplySnapshot } from '../../src/modules/conversations/reply-types.ts';
import type { ControlOutboxEvent as ControlEvent, ControlScope } from '../../src/modules/conversations/control-types.ts';

export class TestConversationController extends ConversationController {
  protected override aiTimeoutMs(){return Number((this.env as any).TEST_AI_TIMEOUT_MS??60000);}
  private classificationReadRace:unknown;
  async raceClassificationRead(value:unknown){this.classificationReadRace=value;}
  override async readAiWork(scope:ControlScope,runId:string){
    if(this.classificationReadRace!==undefined){
      const classification=this.classificationReadRace;this.classificationReadRace=undefined;
      await this.recordAiClassification(scope,runId,classification);
    }
    return super.readAiWork(scope,runId);
  }
  private releaseProjection: (() => void) | undefined;
  private projectionHeld = false;
  private releaseExpiry:(()=>void)|undefined;
  private expiryHeld=false;
  async holdExpiry(){
    const controller=this as any,original=controller.commitHandoff;
    controller.commitHandoff=async(...args:any[])=>{
      controller.commitHandoff=original;const result=await original.apply(this,args);this.expiryHeld=true;
      await new Promise<void>(resolve=>{this.releaseExpiry=resolve;});this.expiryHeld=false;return result;
    };
  }
  async releaseExpiredRun(){this.releaseExpiry?.();this.releaseExpiry=undefined;}
  async faults(value: Record<string, boolean>) { await this.ctx.storage.put('test:faults', value); }
  async inspect() {
    return { state: await this.ctx.storage.get('state'), scope: await this.ctx.storage.get('scope'),
      receipts: [...(await this.ctx.storage.list({prefix:'receipt:'})).keys()],
      outbox: [...(await this.ctx.storage.list({prefix:'event:'})).keys()],
      notes: [...(await this.ctx.storage.list({prefix:'note:'})).entries()],
      replies: [...(await this.ctx.storage.list({prefix:'reply:'})).entries()],
      replyOutbox: [...(await this.ctx.storage.list({prefix:'reply-event:'})).entries()],
      replyHistory:await this.ctx.storage.get('replyHistory'),rateFeedback:await this.ctx.storage.get('replyRateLimit'),sendError:await this.ctx.storage.get('test:sendError'),
      alarm: await this.ctx.storage.getAlarm(), projectionHeld: this.projectionHeld,expiryHeld:this.expiryHeld,aiDeadline:await this.ctx.storage.get('aiDeadline') };
  }
  async serialized() {
    return {receipts:[...(await this.ctx.storage.list({prefix:'receipt:'}))].map(([key,value])=>[key,JSON.stringify(value)]),
      outbox:[...(await this.ctx.storage.list({prefix:'event:'}))].map(([key,value])=>[key,JSON.stringify(value)]),
      notes:[...(await this.ctx.storage.list({prefix:'note:'}))].map(([key,value])=>[key,JSON.stringify(value)])};
  }
  async inject(key: string, value: unknown) { await this.ctx.storage.put(key, value); }
  async injectMany(values:{key:string;value:unknown}[]) {await this.ctx.storage.transaction(async transaction=>{for(const {key,value}of values)await transaction.put(key,value);});}
  async clearAuthority() { await this.ctx.storage.delete(['state','scope']); }
  async clearAlarm() { await this.ctx.storage.deleteAlarm(); }
  async alarmAt(time:number) { await this.ctx.storage.setAlarm(time); }
  async retrySoon() { await this.ctx.storage.setAlarm(Date.now()+50); }
  async release() { this.releaseProjection?.(); this.releaseProjection=undefined; }
  protected override async persistCommand(transaction: DurableObjectTransaction, event: ControlEvent) {
    await super.persistCommand(transaction,event);
    if ((await transaction.get<Record<string,boolean>>('test:faults'))?.commit) throw new Error('synthetic transaction failure');
  }
  protected override async project(scope: ControlScope, events: ControlEvent[]) {
    const faults=await this.ctx.storage.get<Record<string,boolean>>('test:faults');
    if(faults?.hold && !this.projectionHeld) {
      this.projectionHeld=true;
      await new Promise<void>(resolve=>{this.releaseProjection=resolve;});
      this.projectionHeld=false;
    } else if(faults?.project) throw new Error('synthetic projection failure');
    await super.project(scope,events);
  }
  protected override async projectReplies(scope: ControlScope, snapshots: ReplySnapshot[]) {
    if((await this.ctx.storage.get<Record<string,boolean>>('test:faults'))?.replyProject)throw new Error('synthetic reply projection failure');
    await super.projectReplies(scope,snapshots);
  }
  protected override sendReply(credentials:{clientId:string;apiKey:string},input:{chatId:string;body:string}) {
    return sendOzonMessage(credentials,input,async (...args:Parameters<typeof fetch>)=>{try{return await fetch(...args);}catch(error){await this.ctx.storage.put('test:sendError',String(error));throw error;}});
  }
  protected override async publishRateLimit(scope:ControlScope,until:number) {
    if((await this.ctx.storage.get<Record<string,boolean>>('test:faults'))?.rateFeedback)throw new Error('synthetic rate feedback failure');
    await super.publishRateLimit(scope,until);
  }
  protected override async acknowledge(keys: string[]) {
    if((await this.ctx.storage.get<Record<string,boolean>>('test:faults'))?.ack) throw new Error('synthetic acknowledgment failure');
    await super.acknowledge(keys);
  }
}

export default {
  async fetch(request: Request, env: any) {
    const input=await request.json() as any;
    try {
      if(input.op==='fixture-migrate') {
        await env.DB.batch(input.statements.map((sql:string)=>env.DB.prepare(sql)));
        return Response.json({ok:true});
      }
      if(input.op==='cron') {
        const actualDB=env.DB;
        const repairs:string[]=[],wakes:string[]=[];
        if(input.failRepairs) env={...env,CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:(id:string)=>({repair:async()=>{repairs.push(id);throw new Error('synthetic RPC unavailable');}})}};
        if(input.recordWakes) env={...env,STORE_COORDINATOR:{getByName:(name:string)=>({wake:async()=>{wakes.push(name);}})}};
        if(input.failSync||input.failControls) env={...env,STORE_COORDINATOR:env.STORE_COORDINATOR??{},DB:{
          prepare(sql:string){
            if(input.failSync&&sql.includes('store_sync_source'))throw new Error('synthetic sync branch failure');
            if(input.failControls&&sql.includes('FROM conversation_control'))throw new Error('synthetic control branch failure');
            return actualDB.prepare(sql);
          },
          batch:actualDB.batch.bind(actualDB),
        }};
        await workerEvents.scheduled({} as ScheduledController,env);
        return Response.json({ok:true,repairs,wakes});
      }
      const stub=env.CONVERSATION_CONTROLLER.get(env.CONVERSATION_CONTROLLER.idFromName(input.name??input.scope.controllerId));
      switch(input.op) {
        case 'classification-read-race':await stub.raceClassificationRead(input.classification);break;
        case 'ai-reception-read':return Response.json(await stub.readAiReception(input.scope,input.actor,input.commandId));
        case 'inbound':return Response.json(await stub.receiveInbound(input.scope,input.eventId));
        case 'ai-pending-input':return Response.json(await stub.readPendingAiInput(input.scope));
        case 'ai-intake-start':return Response.json(await stub.startAiIntake(input.scope,input.request));
        case 'ai-work-read':return Response.json(await stub.readAiWork(input.scope,input.runId));
        case 'ai-classify':return Response.json(await stub.recordAiClassification(input.scope,input.runId,input.classification));
        case 'ai-classified-input':return Response.json(await stub.readClassifiedInput(input.scope));
        case 'ai-dispatch-admit':return Response.json(await stub.admitAiDispatch(input.scope,input.request));
        case 'ai-dispatch-stop':return Response.json(await stub.stopAiDispatch(input.scope,input.request));
        case 'ai-reception-resume':return Response.json(await stub.resumeAiReception(input.scope,input.actor,input.request));
        case 'holdExpiry':await stub.holdExpiry();break;
        case 'releaseExpiry':await stub.releaseExpiredRun();break;
        case 'ai-listen':return Response.json(await stub.resumeAiForNewMessages(input.scope,input.actor,input.request));
        case 'ai-listening':return Response.json(await stub.readAiListening(input.scope));
        case 'ai-read':return Response.json(await stub.readAiRun(input.scope,input.runId));
        case 'ai-start':return Response.json(await stub.startAi(input.scope,input.request));
        case 'ai-resume':return Response.json(await stub.resumeAi(input.scope,input.actor,input.request));
        case 'ai-handoff':return Response.json(await stub.requestHandoff(input.scope,input.runId,input.input));
        case 'ai-reply-enqueue':{
          const result=await stub.enqueueAiReply(input.scope,input.runId);
          if(input.loseResponse)throw new Error('synthetic lost AI enqueue response');
          return Response.json(result);
        }
        case 'replies':return Response.json(await stub.readReplies(input.scope,input.actor));
        case 'reply':return Response.json(await stub.readReply(input.scope,input.actor,input.intentId));
        case 'read':return Response.json(await stub.read(input.scope,input.actor));
        case 'notes':return Response.json(await stub.readNotes(input.scope,input.actor,input.beforeSequence===undefined?null:input.beforeSequence,input.limit===undefined?50:input.limit));
        case 'execute':return Response.json(await stub.execute(input.scope,input.actor,input.command));
        case 'repair':await stub.repair(input.scope);break;
        case 'faults':await stub.faults(input.value);break;
        case 'inspect':return Response.json(await stub.inspect());
        case 'serialized':return Response.json(await stub.serialized());
        case 'injectMany':await stub.injectMany(input.values);break;
        case 'inject':await stub.inject(input.key,input.value);break;
        case 'clearAuthority':await stub.clearAuthority();break;
        case 'clearAlarm':await stub.clearAlarm();break;
        case 'alarmAt':await stub.alarmAt(input.value);break;
        case 'retrySoon':await stub.retrySoon();break;
        case 'release':await stub.release();break;
        default:throw new Error('Unexpected fixture operation');
      }
      return Response.json({ok:true});
    } catch(error) {return Response.json({error:String(error)},{status:500});}
  },
};
