import {toJsonSchema} from '@valibot/to-json-schema';
import {replyTestOutputSchema} from './service.ts';
// Arbitrary checks (Unicode, blank text and source uniqueness) still run locally.
// Unknown unsupported actions must fail conversion rather than weaken the contract.
const schema=toJsonSchema(replyTestOutputSchema,{ignoreActions:['check']});
export function replyTestSampling(modelConfigVersion:string){
  if(!['nvidia-reply-test-v1','nvidia-reply-test-v2'].includes(modelConfigVersion))throw new Error('REPLY_TEST_CONFIG_UNSUPPORTED');
  return {tool_choice:'none',chat_template_kwargs:{enable_thinking:false},
    ...(modelConfigVersion==='nvidia-reply-test-v2'?{guided_json:structuredClone(schema)}:{})};
}
