import type {ApplicationEnv} from '../../http.ts';
import type {CompanyModelTestFailure} from '../../shared/company-model.ts';
import {aiFetch,type AiTransportEvidence} from '../ai-runs/transport.ts';
import {modelBaseUrl,modelEndpoint} from './security.ts';
import {modelAccessToken} from './oauth.ts';
import {providerRequestHeaders} from './providers.ts';
import type {ModelRecord} from './storage.ts';
export type ModelProbeResult={status:'passed'|'failed';failureCode:CompanyModelTestFailure|null;providerStatus:number|null};
/** Only fixed diagnostic enums and HTTP status escape this one-shot provider request. */
export async function probeCompanyModel(env:ApplicationEnv['Bindings'],row:ModelRecord,send:typeof fetch,signal:AbortSignal,authorize:()=>Promise<boolean>):Promise<ModelProbeResult>{
  let providerStatus:number|null=null;
  const fail=(failureCode:CompanyModelTestFailure):ModelProbeResult=>({status:'failed',failureCode,providerStatus});
  if(modelBaseUrl(row.baseUrl,env)!==row.baseUrl)return fail('url_rejected');
  let key:string;
  try{key=await modelAccessToken(env,row,send);}catch{return fail('credentials_unavailable');}
  let evidence:AiTransportEvidence|undefined;
  const timeout=AbortSignal.timeout(10000);
  const transport=aiFetch({spend(){},claim:authorize,record(value){evidence=value;}},async(input,init)=>{
    const response=await send(input,init);providerStatus=response.status;return response;
  },{endpoint:modelEndpoint(row.baseUrl),allowedTool:'connection_probe'});
  try{
    await transport(modelEndpoint(row.baseUrl),{method:'POST',headers:{'content-type':'application/json',...providerRequestHeaders(row.provider,crypto.randomUUID()),authorization:`Bearer ${key}`},
      signal:AbortSignal.any([signal,timeout]),body:JSON.stringify({model:row.model,stream:true,stream_options:{include_usage:true},
        messages:[{role:'user',content:'This is an installation connectivity test, not a customer conversation. Respond only by calling connection_probe with ok=true; do not answer with text.'}],
        tools:[{type:'function',function:{name:'connection_probe',description:'Confirm model tool support.',parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}],
        // Reasoning models (for example DeepSeek V4 in thinking mode) reject a named
        // or required tool_choice, so the probe must use the same automatic selection
        // as normal support runs.
        tool_choice:'auto',parallel_tool_calls:false})});
  }catch(error){
    if(providerStatus!==null&&providerStatus!==200){
      if(providerStatus===401)return fail('unauthorized');
      if(providerStatus===403)return fail('forbidden');
      if(providerStatus===404)return fail('not_found');
      if(providerStatus===429)return fail('rate_limited');
      if(providerStatus>=300&&providerStatus<400)return fail('redirect_refused');
      return fail(providerStatus>=500?'provider_unavailable':'request_rejected');
    }
    if(timeout.aborted)return fail('timed_out');
    if(signal.aborted||providerStatus===null)return fail('network_error');
    if(error instanceof Error&&error.message==='AI_TOOLS_REJECTED')return fail('tool_call_invalid');
    return fail('invalid_response');
  }
  if(evidence?.finishReason==='length')return fail('output_limit');
  if(!evidence?.complete)return fail('invalid_response');
  if(!evidence.tools)return fail('tool_call_missing');
  return {status:'passed',failureCode:null,providerStatus};
}
