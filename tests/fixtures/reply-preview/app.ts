import { Hono } from 'hono';
import { getAgentByName } from 'agents';
import { init,getAgentInstance } from '@flue/runtime';
import { ReplyPreview } from '../../../src/agents/reply-preview.ts';
import { reserveTranslation,createTranslationBudget,setTranslationBudgetEnabled,bindTranslationReceipt,readTranslationRun,settleTranslationUsage } from '../../../src/modules/translations/storage.ts';
import type { TranslationRun } from '../../../src/modules/translations/types.ts';
import { createApp } from '../../../src/application.ts';
import { submitReplyPreview,readReplyPreview } from '../../../src/modules/translations/service.ts';
import { createTranslationRuntime } from '../../../src/modules/translations/runtime.ts';

const scope={organizationId:'org',storeId:'store',conversationId:'conv'};
const actor={orgId:'org',actorUserId:'staff',sessionId:'staff-session'};
const manager={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
const config={provider:'nvidia' as const,model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,
  pricing:{version:'synthetic',currency:'USD' as const,inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
const app=new Hono<{Bindings:Record<string,any>}>();
app.get('/api/health',c=>c.json({service:'preview-fixture'}));
app.use('/test/*',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${c.env.TEST_TOKEN}`)return c.text('denied',403);await next();});
app.post('/test/safety',c=>c.json({syntheticKey:c.env.NVAPI_KEY==='synthetic-never-real'}));
const query=(requestId:string)=>({requestId,storeId:'store',conversationId:'conv',expectedMemberId:'staff-member'});
const instance=(id:string)=>`reply-preview:${id}`;
async function stub(env:Record<string,any>,id:string){return await getAgentByName(env.FLUE_REPLY_PREVIEW_AGENT,instance(id)) as any;}
app.post('/test/sql',async c=>{const body=await c.req.json<{sql:string;params?:unknown[];batch?:string[]}>();const db=c.env.DB as D1Database;return c.json(body.batch?await db.batch(body.batch.map(sql=>db.prepare(sql))):await db.prepare(body.sql).bind(...body.params??[]).all());});
app.post('/test/fund',async c=>{const db=c.env.DB as D1Database;await createTranslationBudget(db,manager,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000});await setTranslationBudgetEnabled(db,manager,'budget',0,true);return c.json({ok:true});});
app.post('/test/reserve',async c=>{const body=await c.req.json<{requestId:string;source?:string;config?:typeof config}>();return c.json(await reserveTranslation(c.env.DB,actor,{...query(body.requestId),source:body.source??'你好，请确认订单。',sourceRevision:1,budgetId:'budget'},body.config??config));});
app.post('/test/native-dispatch',async c=>{const body=await c.req.json<{runId:string;source:string}>();return c.json(await init(ReplyPreview,{id:instance(body.runId)}).dispatch({message:body.source,initialData:{runId:body.runId},idempotencyKey:body.runId}));});
app.post('/test/native-inspect',async c=>{const body=await c.req.json<{runId:string}>();return c.json(await(await stub(c.env,body.runId)).inspectPreview());});
app.post('/test/service/:operation',async c=>{
  const body=await c.req.json<{requestId:string;source:string;sourceRevision:number;loseReceipt?:boolean;closedConfig?:boolean}>();
  const env={...c.env,TRANSLATION_CONFIG_JSON:JSON.stringify(config),...(body.closedConfig?{TRANSLATION_ENABLED:'false',TRANSLATION_CONFIG_JSON:undefined,NVAPI_KEY:undefined}:{})};
  const native=createTranslationRuntime(env),original=native.dispatch;
  if(body.loseReceipt)native.dispatch=async run=>{await original(run);throw new Error('synthetic receipt response lost');};
  const target={conversationId:'conv',expectedMemberId:'staff-member'},deps={translationRuntime:native};
  return c.json(c.req.param('operation')==='submit'
    ?await submitReplyPreview(env,actor,target,{requestId:body.requestId,source:body.source,sourceRevision:body.sourceRevision},deps)
    :await readReplyPreview(env,actor,target,body.requestId,deps));
});
app.post('/test/:operation',async c=>{
  const body=await c.req.json<{requestId:string;runId:string;changedSource?:string;wrongId?:string;skipBind?:boolean}>();
  const run=await readTranslationRun(c.env.DB,actor,query(body.requestId)) as TranslationRun|null;
  if(!run)return c.json({error:'not_found'},404);
  const target=await stub(c.env,body.wrongId??body.runId);
  const handle=init(ReplyPreview,{id:instance(body.runId)});
  const operation=c.req.param('operation');
  if(operation==='prepare'){await target.preparePreview(scope,run.id);return c.json({ok:true});}
  if(operation==='dispatch'){
    const receipt=await handle.dispatch({message:body.changedSource??run.source,initialData:{runId:run.id},idempotencyKey:run.id});
    if(!body.skipBind)await bindTranslationReceipt(c.env.DB,scope,run.id,{submissionId:receipt.submissionId,uid:receipt.uid,acceptedAt:receipt.acceptedAt});return c.json(receipt);
  }
  if(operation==='inspect')return c.json(await target.inspectPreview());
  if(operation==='close'){await target.closeUnstartedPreview(scope,run.id);return c.json({ok:true});}
  if(operation==='destroy'){await target.destroy();return c.json({ok:true});}
  if(operation==='read'){
    if(!run.receipt)return c.json({status:'missing_receipt'},409);
    const current=await getAgentInstance(ReplyPreview,instance(run.id));if(current?.uid!==run.receipt.uid)return c.json({status:'incarnation_changed'},409);
    try{const reply=await handle.read(run.receipt,{signal:AbortSignal.timeout(500)});return c.json({status:'completed',reply});}
    catch(error){if(error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name))return c.json({status:'pending'},202);return c.json({status:'failed',diagnostic:String(error),cause:error instanceof Error?JSON.stringify(error.cause):null,ledger:await target.inspectPreview()},409);}
  }
  if(operation==='settle'){
    if(!run.receipt)return c.json({error:'missing'},409);
    let preview:any;try{preview=(await handle.read(run.receipt,{signal:AbortSignal.timeout(500)})).metadata?.preview;}catch{return c.json({status:'held'},409);}
    if(!preview?.usageReported||!preview.usage)return c.json({status:'held'},409);
    await settleTranslationUsage(c.env.DB,scope,run.id,run.receipt,preview.usage);return c.json({ok:true});
  }
  if(operation==='run')return c.json(run);
  return c.json({error:'unknown'},400);
});
const production=createApp();
app.all('*',c=>production.fetch(c.req.raw,c.env,c.executionCtx));
app.onError(error=>Response.json({error:error.message},{status:500}));
export default app;
