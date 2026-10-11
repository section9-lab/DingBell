import { seedReplyTest } from '../reply-test.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,readReplyTestExecutionContext,claimReplyTestProviderRequest } from '../../../src/modules/reply-tests/storage.ts';
import { replyTestControl,type ReplyTestRuntime,type ReplyTestInspection } from '../../../src/modules/reply-tests/execution.ts';
import type { ApplicationEnv } from '../../../src/http.ts';
import { knowledgeProfile } from '../../../src/modules/knowledge/vectorize.ts';
export const answerConfig={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-reply-test-v1',promptVersion:'grounded-reply-v1',maxInputTokens:262144,maxOutputTokens:2048,
  pricing:{version:'browser-synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
export const queryConfig={profile:knowledgeProfile.id,priceVersion:'browser-synthetic',maxInputTokens:60000,inputMicrosPerMillion:11800,dailyLimitMicros:70800,maxQueries:100};
export function syntheticReplyTestRuntime(){
  let env:ApplicationEnv['Bindings'],seed:Awaited<ReturnType<typeof seedReplyTest>>|null=null,embeds=0,generations=0,mode:'ready'|'pending'|'unknown'='ready';
  const states=new Map<string,ReplyTestInspection>(),receipts=new Map<string,{submissionId:string;uid:string;acceptedAt:string}>();
  const runtime:ReplyTestRuntime={
    lookup:async id=>receipts.has(id)?{uid:receipts.get(id)!.uid}:null,inspect:async id=>states.get(id)??null,
    prepare:async(scope,id)=>{const run=await readReplyTestExecutionContext(env.DB!,replyTestControl(env),scope,id);if(!run)throw new Error('synthetic answer scope changed');states.set(id,{run,generation:0,http:0,closed:false,evidence:null});},
    dispatch:async run=>{if(!receipts.has(run.id)){if(!await claimReplyTestProviderRequest(env.DB!,replyTestControl(env),run.payload.context.scope,run.id))throw new Error('synthetic answer permit missing');
      generations++;receipts.set(run.id,{submissionId:crypto.randomUUID(),uid:crypto.randomUUID(),acceptedAt:new Date().toISOString()});}return receipts.get(run.id)!;},
    read:async id=>{if(mode==='unknown')throw new Error('synthetic answer observation unavailable');if(mode==='pending')return {outcome:'pending'};
      return {outcome:'completed',text:JSON.stringify({kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:states.get(id)!.run.payload.evidence.chunks[0].chunkId,quote:'26 см.'}]}),
        metadata:{replyTest:{usageReported:true,usage:{input:9,output:3,cacheRead:2,cacheWrite:1},outputValid:true}}};},
    close:async()=>{throw new Error('synthetic answer has no zero-request proof');},
  };
  return {runtime,
    environment(value:ApplicationEnv['Bindings']){env=value;return {...value,REPLY_TEST_ENABLED:'true',NVAPI_KEY:'synthetic-never-real',FLUE_REPLY_TEST_AGENT:{} as never,
      REPLY_TEST_CONFIG_JSON:JSON.stringify(answerConfig),REPLY_TEST_QUERY_CONFIG_JSON:JSON.stringify(queryConfig),
      KNOWLEDGE_INDEX:seed?.index,KNOWLEDGE_AI:{run:async()=>{if(!seed)throw new Error('synthetic answer seed missing');embeds++;return {data:[seed.embedding.values],shape:[1,1024]};}} as unknown as Ai};},
    async seed(storeId:string){
      const session=await env.DB!.prepare("SELECT id FROM session WHERE user_id='web-owner' ORDER BY created_at DESC LIMIT 1").first<{id:string}>();if(!session)throw new Error('synthetic owner must log in');
      const actor={orgId:'company-a',actorUserId:'web-owner',sessionId:session.id};seed=await seedReplyTest(env.DB!,actor,storeId,'web-answer-test');await seed.source();
      await createReplyTestBudget(env.DB!,actor,{id:'web-answer-budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:100000,maxRuns:10});await setReplyTestBudgetEnabled(env.DB!,actor,'web-answer-budget',0,true);
      return {conversationId:'web-answer-test',policyId:seed.policyId};
    },
    async append(){if(!seed)throw new Error('synthetic answer seed missing');await seed.message('web-answer-new','Другой вопрос',20);},
    configure(value:typeof mode){mode=value;},state:()=>({embeds,generations}),
  };
}
