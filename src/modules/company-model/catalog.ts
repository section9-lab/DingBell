const maximumBytes=2*1024*1024;
const maximumModels=2000;
export type ModelCatalogCode='MODEL_CATALOG_UNAUTHORIZED'|'MODEL_CATALOG_UNSUPPORTED'|'MODEL_CATALOG_RATE_LIMITED'|'MODEL_CATALOG_UNAVAILABLE'|'MODEL_CATALOG_INVALID_RESPONSE';
export class ModelCatalogError extends Error {
  readonly code:ModelCatalogCode;
  constructor(code:ModelCatalogCode){super(code);this.name='ModelCatalogError';this.code=code;}
}
const invalid=()=>new ModelCatalogError('MODEL_CATALOG_INVALID_RESPONSE');
/** Only called with an already approved Base URL. Never follows provider pagination or redirects. */
export async function listProviderModels(baseUrl:string,apiKey:string,send:typeof fetch,signal:AbortSignal):Promise<{models:string[];truncated:boolean}>{
  const controller=new AbortController();
  let rejectAbort!:(error:Error)=>void;
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{controller.abort();rejectAbort(new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE'));};
  // Install the listener before creating any asynchronous provider work.
  signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,8000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    if(signal.aborted)throw new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE');
    const response=await Promise.race([send(`${baseUrl}/models`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${apiKey}`},redirect:'manual',signal:controller.signal}),aborted]);
    if(!response.ok){
      void response.body?.cancel().catch(()=>{});
      throw new ModelCatalogError(response.status===401||response.status===403?'MODEL_CATALOG_UNAUTHORIZED':response.status===404||response.status===405||response.status===501?'MODEL_CATALOG_UNSUPPORTED':response.status===429?'MODEL_CATALOG_RATE_LIMITED':'MODEL_CATALOG_UNAVAILABLE');
    }
    if(!response.body)throw invalid();
    reader=response.body.getReader();
    if(Number(response.headers.get('content-length'))>maximumBytes)throw invalid();
    const parts:Uint8Array[]=[];let length=0;
    for(;;){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;length+=part.value.byteLength;if(length>maximumBytes)throw invalid();parts.push(part.value);}
    const bytes=new Uint8Array(length);let offset=0;
    for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
    let value:unknown;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw invalid();}
    if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
    const data=(value as {data?:unknown}).data;
    if(!Array.isArray(data)||data.length>10000)throw invalid();
    const models=new Set<string>();
    for(const item of data){
      const id=item&&typeof item==='object'&&!Array.isArray(item)?(item as {id?:unknown}).id:null;
      if(typeof id!=='string'||!id||id.length>256||id!==id.trim()||!id.isWellFormed()||/[\u0000-\u001f\u007f]/.test(id)||id===apiKey||apiKey.length>=8&&id.includes(apiKey))throw invalid();
      models.add(id);
    }
    const sorted=[...models].sort();
    return {models:sorted.slice(0,maximumModels),truncated:sorted.length>maximumModels||(value as {has_more?:unknown}).has_more===true};
  }catch(error){
    if(error instanceof ModelCatalogError)throw error;
    // Never surface response bodies, request URLs, provider messages or credentials.
    throw new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE');
  }finally{
    clearTimeout(timer);signal.removeEventListener('abort',abort);
    void reader?.cancel().catch(()=>{});
  }
}
