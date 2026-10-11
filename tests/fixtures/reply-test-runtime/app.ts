import { Hono } from 'hono';
import { getAgentByName } from 'agents';
import { init } from '@flue/runtime';
import { ReplyTest } from '../../../src/agents/reply-test.ts';
import { createApp } from '../../../src/application.ts';
import { seedReplyTest } from '../reply-test.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge } from '../../../src/modules/reply-tests/service.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,reserveReplyTest,readReplyTestRun } from '../../../src/modules/reply-tests/storage.ts';
import { executeReplyTest,readExecutedReplyTest,replyTestControl } from '../../../src/modules/reply-tests/execution.ts';
import { createReplyTestRuntime } from '../../../src/modules/reply-tests/runtime.ts';
const actor={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
const config={provider:'nvidia' as const,model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-reply-test-v1',promptVersion:'grounded-reply-v1',maxInputTokens:262144,maxOutputTokens:2048,
  pricing:{version:'synthetic',currency:'USD' as const,inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
let seed:Awaited<ReturnType<typeof seedReplyTest>>;
const app=new Hono<{Bindings:Record<string,any>}>();
app.get('/api/health',c=>c.json({service:'reply-test-runtime-fixture'}));
app.use('/test/*',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${c.env.TEST_TOKEN}`)return c.text('denied',403);await next();});
app.post('/test/safety',c=>c.json({syntheticKey:c.env.NVAPI_KEY==='synthetic-never-real'}));
app.post('/test/sql',async c=>{const body=await c.req.json<{sql:string;params?:unknown[];batch?:string[]}>();const db=c.env.DB as D1Database;return c.json(body.batch?await db.batch(body.batch.map(sql=>db.prepare(sql))):await db.prepare(body.sql).bind(...body.params??[]).all());});
app.post('/test/setup',async c=>{
  seed=await seedReplyTest(c.env.DB,actor,'store');await seed.source();
  await createReplyTestBudget(c.env.DB,actor,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000,maxRuns:50});
  await setReplyTestBudgetEnabled(c.env.DB,actor,'budget',0,true);return c.json({ok:true});
});
app.post('/test/reserve',async c=>{
  const body=await c.req.json<{promptVersion?:string;modelConfigVersion?:string}>();
  const control=replyTestControl(c.env),context=await prepareReplyTest(c.env.DB,control,actor,seed.input);
  const evidence=await retrieveReplyTestKnowledge(c.env.DB,seed.index,control,actor,context,seed.embedding);
  return c.json(await reserveReplyTest(c.env.DB,control,actor,{requestId:crypto.randomUUID(),budgetId:'budget',context,evidence},{...config,promptVersion:body.promptVersion??config.promptVersion,modelConfigVersion:body.modelConfigVersion??config.modelConfigVersion}));
});
app.post('/test/:operation',async c=>{
  const body=await c.req.json<{requestId:string;loseReceipt?:boolean;message?:string}>(),target={requestId:body.requestId,memberId:'owner-member'};
  const runtime=createReplyTestRuntime(c.env),original=runtime.dispatch;
  if(body.loseReceipt)runtime.dispatch=async run=>{await original(run);throw new Error('synthetic receipt lost');};
  const operation=c.req.param('operation');
  if(operation==='execute')return c.json(await executeReplyTest(c.env,actor,target,{runtime}));
  if(operation==='read')return c.json(await readExecutedReplyTest(c.env,actor,target,{runtime}));
  const run=await readReplyTestRun(c.env.DB,actor,target.requestId,target.memberId);if(!run)return c.json({error:'not_found'},404);
  if(operation==='run')return c.json(run);
  if(operation==='inspect')return c.json(await runtime.inspect(run.id));
  if(operation==='prepare'){await runtime.prepare(run.payload.context.scope,run.id);return c.json({ok:true});}
  if(operation==='close'){await runtime.close(run.payload.context.scope,run.id);return c.json({ok:true});}
  if(operation==='destroy'){await(await getAgentByName(c.env.FLUE_REPLY_TEST_AGENT,`reply-test:${run.id}`)).destroy();return c.json({ok:true});}
  if(operation==='dispatch-altered')return c.json(await init(ReplyTest,{id:`reply-test:${run.id}`,uid:null}).dispatch({message:body.message??'altered',initialData:{runId:run.id},idempotencyKey:run.id}));
  return c.json({error:'unknown'},400);
});
const production=createApp();app.all('*',c=>production.fetch(c.req.raw,c.env,c.executionCtx));
app.onError(error=>Response.json({error:error.message},{status:500}));
export default app;
