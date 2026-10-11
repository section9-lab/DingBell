import * as actual from '../../../src/modules/ai-runs/knowledge.ts';
import type {AiRunReader} from '../../../src/modules/ai-runs/storage.ts';
import type {ControlScope} from '../../../src/modules/conversations/control-types.ts';
import {knowledgeProfile} from '../../../src/modules/knowledge/vectorize.ts';
export {reviewAiKnowledgeEvidence} from '../../../src/modules/ai-runs/knowledge.ts';
/** Synthetic outbound bindings only; retrieval, permits and authorization use the production service. */
export function searchAiKnowledge(env:actual.AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,id:string){
 const db=env.DB!;
 return actual.searchAiKnowledge({...env,AI_KNOWLEDGE_QUERY_CONFIG_JSON:JSON.stringify({profile:knowledgeProfile.id,priceVersion:'synthetic',maxInputTokens:60000,inputMicrosPerMillion:1000}),
  KNOWLEDGE_AI:{async run(model:string,input:{text:string[];truncate_inputs:boolean}){
   if(model!==knowledgeProfile.model||input.text.length!==1||input.truncate_inputs!==false)throw new Error('synthetic embedding shape');
   await db.prepare("INSERT INTO synthetic_knowledge_calls(kind,payload) VALUES('embedding',?)").bind(JSON.stringify(input)).run();return {shape:[1,1024],data:[Array.from({length:1024},(_,i)=>i===0?1:0)]};
  }} as unknown as Ai,
  KNOWLEDGE_INDEX:{async query(_vector:number[],options:VectorizeQueryOptions){
   const rows=(await db.prepare('SELECT vector FROM synthetic_knowledge_vectors').all<{vector:string}>()).results.map(r=>JSON.parse(r.vector) as VectorizeVector);
   return {matches:rows.filter(row=>row.namespace===options.namespace&&Object.entries(options.filter??{}).every(([key,value])=>value&&typeof value==='object'&&'$in' in value?Array.isArray(value.$in)&&value.$in.includes(row.metadata![key] as string):row.metadata?.[key]===value)).map(({values,...row})=>({...row,score:.8})).slice(0,options.topK)};
  }} as unknown as Vectorize,
 },read,scope,id);
}
