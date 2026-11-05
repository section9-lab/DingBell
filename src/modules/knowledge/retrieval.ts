import * as v from 'valibot';
import {knowledgeCitationRequestSchema} from '../../shared/knowledge.ts';
export const retrievalScopeSchema=v.omit(knowledgeCitationRequestSchema,['citations']);
export type RetrievalScope=v.InferOutput<typeof retrievalScopeSchema>;
export type ResolvedKnowledge={documentId:string;revision:number;chunkId:string;bodyHash:string;body:string;title:string;contentHash:string};
export const retrievalDocumentLimit=160;
