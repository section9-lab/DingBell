import * as v from 'valibot';
import {knowledgeCitationRequestSchema,type KnowledgeCitationRequest} from '../../shared/knowledge.ts';
import {queryKnowledge,knowledgeRevisionBatchSize,type KnowledgeActiveRevision} from './vectorize.ts';
export const retrievalScopeSchema=v.omit(knowledgeCitationRequestSchema,['citations']);
export type RetrievalScope=v.InferOutput<typeof retrievalScopeSchema>;
export type ResolvedKnowledge={documentId:string;revision:number;chunkId:string;bodyHash:string;body:string;title:string;contentHash:string};
export const retrievalDocumentLimit=160;
type Access={snapshot:()=>Promise<{authority:string;revisions:KnowledgeActiveRevision[]}>;resolve:(citations:KnowledgeCitationRequest['citations'])=>Promise<ResolvedKnowledge[]|null>};
/** Staff and AI callers provide their own authority checks; vector ranking never grants access. */
export async function retrievePublishedKnowledge(index:Vectorize,orgId:string,input:RetrievalScope,vector:number[],access:Access){
 const scope=v.parse(retrievalScopeSchema,input);let snapshot=await access.snapshot();const authority=snapshot.authority;
 for(let attempt=0;attempt<2;attempt++){
  const candidates:Awaited<ReturnType<typeof queryKnowledge>>=[];let missingBatch=false;
  for(let offset=0;offset<snapshot.revisions.length;offset+=knowledgeRevisionBatchSize){
   const batch=await queryKnowledge(index,orgId,scope,vector,snapshot.revisions.slice(offset,offset+knowledgeRevisionBatchSize));missingBatch ||= batch.length===0;candidates.push(...batch);
  }
  candidates.sort((a,b)=>b.score-a.score||(a.chunkId<b.chunkId?-1:a.chunkId>b.chunkId?1:0));const best=candidates.slice(0,10);
  const resolved=best.length?await access.resolve(best.map(({score,...citation})=>citation)):[];
  const current=await access.snapshot();if(current.authority!==authority)throw new Error('KNOWLEDGE_ACCESS_CHANGED');
  if(JSON.stringify(snapshot.revisions)===JSON.stringify(current.revisions)){
   if(missingBatch)throw new Error('KNOWLEDGE_INDEX_NOT_VISIBLE');if(!resolved)throw new Error('KNOWLEDGE_CITATIONS_INVALID');
   return resolved.map((row,ordinal)=>({...row,score:best[ordinal].score}));
  }
  snapshot=current;
 }
 throw new Error('KNOWLEDGE_CHANGED');
}
