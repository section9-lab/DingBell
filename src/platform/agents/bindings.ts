import type { TranslationRuntime } from '../../modules/translations/api-types.ts';
import type { SupportRuntime } from '../../modules/ai-runs/execution.ts';
export interface PortableAgents { translation: TranslationRuntime; support: SupportRuntime }
