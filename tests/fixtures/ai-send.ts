import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {aiAnswerFixture} from './ai-answer.ts';
import {encryptCredentials} from '../../src/modules/stores/credentials.ts';
import {prepareAiReply} from '../../src/modules/ai-runs/reply-intent.ts';
import {bindAiExecutionReceipt,claimAiGeneration,closeAiExecution,settleAiGeneration} from '../../src/modules/ai-runs/storage.ts';

export async function aiSendFixture(config:{aiEnabled?:string;outboundEnabled?:string;aiOutboundEnabled?:string;aiTimeoutMs?:number}={}){
 const x=await aiAnswerFixture('support-reply-v1',{aiEnabled:'true',outboundEnabled:'true',aiOutboundEnabled:'true',...config});
 try{
  const key=await encryptCredentials(x.f.credentialEnv,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'")
   .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now(),Date.now()+3600000).run();
  const env={...x.env,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'},runId=x.run.request.runId,intentId='ai-reply:'+runId;
  const receipt={submissionId:runId,uid:crypto.randomUUID(),acceptedAt:new Date().toISOString()};
  async function prepare(){assert.equal((await prepareAiReply(env,x.read,x.scope,runId,x.input)).status,'prepared');}
  async function finish(outcome:'completed'|'failed'|'aborted'='completed',settled=true){
   await bindAiExecutionReceipt(x.f.db,x.scope,runId,receipt);
   assert.equal(await claimAiGeneration(x.f.db,x.read,x.scope,runId,1),true);
   if(settled)await settleAiGeneration(x.f.db,x.scope,runId,1,receipt,{input:10,output:5,cacheRead:0,cacheWrite:0});
   await closeAiExecution(x.f.db,x.scope,runId,{kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:'ai-support:'+runId,
    receipt,outcome,executionClosed:true,providerPermits:1,verifiedAt:Date.now()});
  }
  const enqueue=(extra:Record<string,unknown>={})=>x.f.call('ai-reply-enqueue',{runId,...extra},x.scope);
  async function reply(){const r=await x.f.call('reply',{intentId},x.scope);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.reply;}
  async function takeover(){const state=(await x.f.call('read',{},x.scope)).body.view.state;
   const r=await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope);assert.equal(r.body.outcome,'accepted');return r.body.view.state;}
  async function holdQueue(){await x.f.call('inject',{key:'replyRateLimit',value:{until:Date.now()+120000,dueAt:Date.now()+120000}});}
  async function ready(){await prepare();await finish();}
  return {...x,env,runId,intentId,receipt,prepare,finish,ready,enqueue,reply,takeover,holdQueue};
 }catch(e){await x.f.close();throw e;}
}
export async function waitAiSend(check:()=>Promise<boolean>,duration=10000){
 const deadline=Date.now()+duration;while(Date.now()<deadline){if(await check())return;await delay(30);}assert.fail('synthetic AI sender did not reach the expected state');
}
