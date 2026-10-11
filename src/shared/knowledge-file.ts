import * as v from 'valibot';
import { knowledgeScopeSchema } from './knowledge.ts';

export const knowledgeFileBytes = 64 * 1024;
export const knowledgeFileRows = 20;
export const knowledgeFileScopeSchema = v.strictObject({ ...knowledgeScopeSchema.entries,
  kind: v.picklist(['policy', 'guide', 'faq']), productRef: v.null() });
export type KnowledgeFileScope = v.InferOutput<typeof knowledgeFileScopeSchema>;
