import { AgentRunError,getAgentInstance,init } from '@flue/runtime';
import { getAgentByName } from 'agents';
import { ReplyTest } from '../../agents/reply-test.ts';
import { replyTestInstance } from './policy.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import type { ReplyTestBindings,ReplyTestInspection,ReplyTestRuntime } from './execution.ts';
interface Stub {prepareReplyTest(scope:ControlScope,id:string):Promise<void>;inspectReplyTest():Promise<ReplyTestInspection|null>;closeUnstartedReplyTest(scope:ControlScope,id:string):Promise<void>}
export function createReplyTestRuntime(env:ReplyTestBindings):ReplyTestRuntime{
  if(!env.FLUE_REPLY_TEST_AGENT)throw new Error('REPLY_TEST_RUNTIME_UNAVAILABLE');
  const stub=async(id:string)=>await getAgentByName(env.FLUE_REPLY_TEST_AGENT!,replyTestInstance(id)) as unknown as Stub;
  return {
    lookup:id=>getAgentInstance(ReplyTest,replyTestInstance(id)),inspect:async id=>(await stub(id)).inspectReplyTest(),
    prepare:async(scope,id)=>(await stub(id)).prepareReplyTest(scope,id),close:async(scope,id)=>(await stub(id)).closeUnstartedReplyTest(scope,id),
    async dispatch(run){
      const receipt=await init(ReplyTest,{id:replyTestInstance(run.id),uid:null}).dispatch({message:JSON.stringify(run.payload.modelInput),initialData:{runId:run.id},idempotencyKey:run.id});
      return {submissionId:receipt.submissionId,uid:receipt.uid,acceptedAt:receipt.acceptedAt};
    },
    async read(id,receipt){
      try{
        const result=await init(ReplyTest,{id:replyTestInstance(id)}).read(receipt,{signal:AbortSignal.timeout(500)});
        if(result.uid!==receipt.uid||result.submissionId!==receipt.submissionId)throw new Error('REPLY_TEST_RESULT_MISMATCH');
        return {outcome:'completed',text:result.text,metadata:result.metadata};
      }catch(error){
        if(error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name))return {outcome:'pending'};
        if(error instanceof AgentRunError)return {outcome:'failed'};throw error;
      }
    },
  };
}
