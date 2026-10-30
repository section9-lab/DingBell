import type { TranslationRuntime } from '../../modules/translations/api-types.ts';
import type { ReplyTestRuntime } from '../../modules/reply-tests/execution.ts';
import type { SupportRuntime } from '../../modules/ai-runs/execution.ts';
export interface PortableAgents { translation: TranslationRuntime; replyTest: ReplyTestRuntime; support: SupportRuntime }
