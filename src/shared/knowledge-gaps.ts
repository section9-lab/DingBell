import * as v from 'valibot';
import { knowledgeScopeSchema } from './knowledge.ts';

export const knowledgeGapStateSchema = v.picklist(['pending', 'retested', 'published']);
export const knowledgeGapCursorSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-4])?$/i));
export const knowledgeGapFiltersSchema = v.strictObject({ kind: v.optional(knowledgeScopeSchema.entries.kind),
  storeId: v.optional(knowledgeScopeSchema.entries.storeId), language: v.optional(knowledgeScopeSchema.entries.language),
  state: v.optional(knowledgeGapStateSchema), after: v.optional(knowledgeGapCursorSchema, '') });
export type KnowledgeGapFilters = v.InferOutput<typeof knowledgeGapFiltersSchema>;
