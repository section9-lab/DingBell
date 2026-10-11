import type { TranslationConfig } from '../translations/types.ts';
import { getReplyTestInstructions } from './prompt.ts';
import { replyTestSampling } from './output.ts';
export const REPLY_TEST_MODEL='nvidia/nemotron-3-super-120b-a12b';
// Flue's registry is global: do not replace the existing translation provider.
export const REPLY_TEST_PROVIDER='dingbell-reply-test';
export const replyTestInstance=(id:string)=>`reply-test:${id}`;
export function validateReplyTestConfig(c:TranslationConfig,contextWindow:number){
  getReplyTestInstructions(c.promptVersion);
  replyTestSampling(c.modelConfigVersion);
  if(c.provider!=='nvidia'||c.model!==REPLY_TEST_MODEL
    ||c.maxInputTokens<contextWindow||c.maxOutputTokens<1||c.maxOutputTokens>2048)throw new Error('REPLY_TEST_CONFIG_UNSUPPORTED');
}
