import type { TranslationRuntime } from '../../../src/modules/translations/api-types.ts';
import type { TranslationReceipt,TranslationRun } from '../../../src/modules/translations/types.ts';

export const previewConfig={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,
  pricing:{version:'browser-synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
export type PreviewBehavior='ready'|'pending'|'no-usage'|'failed';
export function syntheticPreviewRuntime(){
  let mode:PreviewBehavior='ready',text='Пожалуйста, подтвердите характеристики товара.',dispatches=0,reads=0;
  const prepared=new Set<string>(),records=new Map<string,{run:TranslationRun;receipt:TranslationReceipt;mode:PreviewBehavior;text:string}>();
  const runtime:TranslationRuntime={
    async lookup(id){const value=records.get(id);return value?{uid:value.receipt.uid}:null;},
    async inspect(id){const value=records.get(id);return value?{run:value.run,generation:1,http:1,closed:false,evidence:null}:null;},
    async prepare(_scope,id){prepared.add(id);},
    async dispatch(run){
      dispatches++;const previous=records.get(run.id);if(previous)return previous.receipt;
      if(!prepared.has(run.id))throw new Error('synthetic preview not prepared');
      const receipt={submissionId:`synthetic-${run.id}`,uid:`synthetic-${run.id}`,acceptedAt:new Date().toISOString()};records.set(run.id,{run,receipt,mode,text});return receipt;
    },
    async read(id){
      reads++;const record=records.get(id);if(!record)throw new Error('synthetic preview missing');
      if(record.mode==='pending')return {outcome:'pending'};if(record.mode==='failed')return {outcome:'failed'};
      return {outcome:'completed',text:record.text,metadata:{preview:{outputValid:true,usageReported:record.mode!=='no-usage',usage:record.mode==='no-usage'?null:{input:9,output:3,cacheRead:2,cacheWrite:1}}}};
    },
    async close(){throw new Error('browser synthetic model request cannot prove zero requests');},
  };
  return {runtime,
    state:()=>({dispatches,reads,requests:[...records.values()].map(value=>({requestId:value.run.requestId,source:value.run.source,sourceRevision:value.run.sourceRevision,memberId:value.run.actorMemberId,conversationId:value.run.conversationId}))}),
    configure(behavior:PreviewBehavior,translation?:string){mode=behavior;if(translation!==undefined)text=translation;},
    release(){for(const record of records.values())if(record.mode==='pending')record.mode='ready';},
  };
}
