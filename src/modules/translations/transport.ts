import { createParser } from 'eventsource-parser';
import type { TranslationUsage } from './types.ts';
export interface PreviewEvidence { usage:TranslationUsage|null; usageReported:boolean; output:string; finishReason:string|null; tools:boolean; complete:boolean }
export interface PreviewTransportGate { claim():Promise<boolean>; spend():void; record(evidence:PreviewEvidence):void|Promise<void> }
export const PREVIEW_ENDPOINT='https://integrate.api.nvidia.com/v1/chat/completions';
const maximum=1_048_576;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function reported(value:unknown):TranslationUsage|null {
  if(!value||typeof value!=='object')return null;
  const u=value as Record<string,any>,details=u.prompt_tokens_details;
  if(Object.hasOwn(u,'prompt_cache_hit_tokens')||Object.hasOwn(u,'cached_tokens'))return null;
  if(details!==undefined&&(!details||typeof details!=='object'||Array.isArray(details)))return null;
  const read=details?.cached_tokens??0,write=details?.cache_write_tokens??0;
  if(![u.prompt_tokens,u.completion_tokens,u.total_tokens,read,write].every(integer)
    ||u.prompt_tokens<1||u.completion_tokens<1||u.prompt_tokens+u.completion_tokens!==u.total_tokens||read+write>u.prompt_tokens)return null;
  return {input:u.prompt_tokens-read-write,output:u.completion_tokens,cacheRead:read,cacheWrite:write};
}
// Buffer only this small, one-shot translation. The unchanged SSE bytes still go
// through the official SDK; the side record distinguishes reported usage from its defaults.
export function previewFetch(gate:PreviewTransportGate,send:typeof fetch=fetch,options:{allowedTool?:string;allowedTools?:readonly string[]}={}):typeof fetch {
  const allowed=options.allowedTools?[...options.allowedTools]:options.allowedTool?[options.allowedTool]:[];
  return async(input,init)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    const parent=init?.signal??(input instanceof Request?input.signal:undefined);
    parent?.throwIfAborted();
    if(url!==PREVIEW_ENDPOINT||method!=='POST')throw new Error('PREVIEW_REQUEST_REJECTED');
    gate.spend();
    if(!await gate.claim())throw new Error('PREVIEW_REQUEST_UNAVAILABLE');
    const signal=parent?AbortSignal.any([parent,AbortSignal.timeout(45_000)]):AbortSignal.timeout(45_000);
    signal.throwIfAborted();
    const response=await send(input,{...init,redirect:'manual',signal});
    if(response.status!==200||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')||!response.body){
      await response.body?.cancel();throw new Error('PREVIEW_RESPONSE_UNAVAILABLE');
    }
    const names=new Map<number,string>();let invalidTools=false,toolId:string|undefined;
    const evidence:PreviewEvidence={usage:null,usageReported:false,output:'',finishReason:null,tools:false,complete:false};
    const parser=createParser({maxBufferSize:maximum,onError(error){if(error.type==='max-buffer-size-exceeded')throw new Error('PREVIEW_RESPONSE_TOO_LARGE');},onEvent(event){
      if(event.data==='[DONE]'){evidence.complete=true;return;}
      if(evidence.complete)throw new Error('PREVIEW_INVALID_STREAM');
      const data=JSON.parse(event.data);
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('PREVIEW_INVALID_STREAM');
      if(Object.hasOwn(data,'usage')&&data.usage!==null){evidence.usage=reported(data.usage);evidence.usageReported=evidence.usage!==null;}
      if(data.choices!==undefined&&!Array.isArray(data.choices))throw new Error('PREVIEW_INVALID_STREAM');
      for(const choice of data.choices??[]){
        if(!choice||typeof choice!=='object'||(choice.index!==undefined&&choice.index!==0))throw new Error('PREVIEW_INVALID_STREAM');
        if(typeof choice.delta?.content==='string')evidence.output+=choice.delta.content;
        else if(choice.delta?.content!==undefined&&choice.delta.content!==null)throw new Error('PREVIEW_INVALID_STREAM');
        if(choice.delta?.tool_calls!==undefined&&choice.delta.tool_calls!==null){
          if(!Array.isArray(choice.delta.tool_calls)){evidence.tools=true;invalidTools=true;continue;}
          if(choice.delta.tool_calls.length)evidence.tools=true;
          for(const tool of choice.delta.tool_calls){
            if(!tool||tool.index!==0||(tool.type!==undefined&&tool.type!=='function')){invalidTools=true;continue;}
            if(tool.id!==undefined){if(typeof tool.id!=='string'||(toolId!==undefined&&toolId!==tool.id))invalidTools=true;else toolId=tool.id;}
            if(tool.function!==undefined&&(!tool.function||typeof tool.function!=='object'||Array.isArray(tool.function)))invalidTools=true;
            if(tool.function?.arguments!==undefined&&typeof tool.function.arguments!=='string')invalidTools=true;
            if(tool.function?.name!==undefined){if(typeof tool.function.name!=='string')invalidTools=true;else names.set(0,(names.get(0)??'')+tool.function.name);}
          }
        }
        if(typeof choice.finish_reason==='string')evidence.finishReason=choice.finish_reason;
      }
    }});
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
    let abort:()=>void=()=>{};
    const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
    try{
      while(true){
        signal.throwIfAborted();
        const chunk=await Promise.race([reader.read(),interrupted]);if(chunk.done)break;
        size+=chunk.value.byteLength;if(size>maximum)throw new Error('PREVIEW_RESPONSE_TOO_LARGE');
        chunks.push(chunk.value);parser.feed(decoder.decode(chunk.value,{stream:true}));
      }
      parser.feed(decoder.decode());await gate.record(evidence);
      if(evidence.tools&&(invalidTools||names.size!==1||!allowed.includes(names.get(0)!)))throw new Error('PREVIEW_TOOLS_REJECTED');
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return new Response(bytes,{status:response.status,headers:response.headers});
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
  };
}
