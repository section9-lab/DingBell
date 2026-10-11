'use agent';
import { setProvider,useModel,useInitialData,useDelivery,useResponseFinish } from '@flue/runtime';
import * as v from 'valibot';
import { replyTestExtension } from '../modules/reply-tests/extension.ts';
import { currentReplyTestLedger,replyTestProvider } from '../modules/reply-tests/provider.ts';
import { REPLY_TEST_MODEL,REPLY_TEST_PROVIDER } from '../modules/reply-tests/policy.ts';
import { replyTestOutputSchema } from '../modules/reply-tests/service.ts';
import { getReplyTestInstructions } from '../modules/reply-tests/prompt.ts';
export const cloudflare=replyTestExtension;
setProvider(replyTestProvider());
export function ReplyTest(){
  const initial=useInitialData<{runId:string}>(),delivery=useDelivery(),state=currentReplyTestLedger().inspect();
  if(!state||state.closed||initial.runId!==state.run.id||delivery.kind!=='user'||delivery.body!==JSON.stringify(state.run.payload.modelInput)||delivery.attachments?.length)throw new Error('REPLY_TEST_INPUT_MISMATCH');
  useModel(`${REPLY_TEST_PROVIDER}/${REPLY_TEST_MODEL}`,{thinkingLevel:'off',compaction:false});
  useResponseFinish(({response})=>{
    const evidence=currentReplyTestLedger().inspect()?.evidence,usage=evidence?.usage;
    const usageReported=!!evidence?.complete&&evidence.usageReported&&!!usage&&(['input','output','cacheRead','cacheWrite'] as const).every(key=>response.usage[key]===usage[key])
      &&response.usage.totalTokens===usage.input+usage.output+usage.cacheRead+usage.cacheWrite;
    let outputValid=false;try{outputValid=!!evidence?.complete&&evidence.finishReason==='stop'&&!evidence.tools&&response.toolCalls.length===0&&v.is(replyTestOutputSchema,JSON.parse(evidence.output));}catch{}
    return {replyTest:{usageReported,usage:usageReported?usage:null,outputValid}};
  });
  return getReplyTestInstructions(state.run.config.promptVersion);
}
ReplyTest.agentName='ReplyTest';
ReplyTest.durability={maxAttempts:1,timeoutMs:60_000};
ReplyTest.initialData=v.strictObject({runId:v.pipe(v.string(),v.uuid())});
