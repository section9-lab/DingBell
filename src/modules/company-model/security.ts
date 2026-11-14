import { credentialConfig, type CredentialBindings } from '../stores/credentials.ts';
import { providerHosts } from './providers.ts';
export interface CompanyModelBindings extends CredentialBindings { AI_MODEL_ALLOWED_HOSTS?:string }
// Unknown gateways require an explicit deployment allowlist. Do not resolve arbitrary
// user-supplied hosts or allow redirects with provider credentials attached.
// The bundled Pi catalog contributes its own hosts so every provider shipped with the
// runtime is selectable without maintaining a second hand-written list.
const staticTrusted=new Set(['api.openai.com','integrate.api.nvidia.com','api.deepseek.com','dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com',
  'openrouter.ai','api.moonshot.cn','api.moonshot.ai','api.siliconflow.cn','api.siliconflow.com','open.bigmodel.cn','api.z.ai']);
let trustedHosts:ReadonlySet<string>|undefined;
function trusted(){return trustedHosts??=new Set([...staticTrusted,...providerHosts()]);}
export function modelBaseUrl(value:string,env:CompanyModelBindings):string|null {
  if(value.length>2048||value!==value.trim()||/[\s\\\u0000-\u001f\u007f]/.test(value))return null;
  try {
    const url=new URL(value),host=url.hostname;
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||!host.includes('.')
      ||!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)||/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)
      ||!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname)||url.pathname.replace(/\/$/,'').endsWith('/chat/completions'))return null;
    const extras=(env.AI_MODEL_ALLOWED_HOSTS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(!trusted().has(host)&&!extras.includes(host))return null;
    const result=url.href.replace(/\/$/,'');
    // Reject URL normalization of traversal, encoded segments and ambiguous authorities.
    if(value.replace(/\/$/,'')!==result)return null;
    return result;
  }catch{return null;}
}
export const modelEndpoint=(baseUrl:string)=>`${baseUrl}/chat/completions`;
export type ModelSecret={keyVersion:string;nonce:string;ciphertext:string};
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const decode=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function aad(companyId:string,revision:number,baseUrl:string,model:string){return new TextEncoder().encode(JSON.stringify(['dingbell.company-model',1,companyId,revision,baseUrl,model]));}
export async function sealModelKey(env:CompanyModelBindings,companyId:string,revision:number,baseUrl:string,model:string,apiKey:string):Promise<ModelSecret>{
  const config=credentialConfig(env);if(!config)throw new Error('MODEL_ENCRYPTION_UNAVAILABLE');
  const key=await crypto.subtle.importKey('raw',config.keys.get(config.activeKeyVersion)!,'AES-GCM',false,['encrypt']),nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(companyId,revision,baseUrl,model)},key,new TextEncoder().encode(apiKey));
  return {keyVersion:config.activeKeyVersion,nonce:encode(nonce),ciphertext:encode(new Uint8Array(ciphertext))};
}
export async function openModelKey(env:CompanyModelBindings,companyId:string,revision:number,baseUrl:string,model:string,envelope:ModelSecret):Promise<string>{
  const config=credentialConfig(env),bytes=config?.keys.get(envelope.keyVersion);if(!bytes)throw new Error('MODEL_ENCRYPTION_UNAVAILABLE');
  const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);
  const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.nonce),additionalData:aad(companyId,revision,baseUrl,model)},key,decode(envelope.ciphertext));
  const secret=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(value);if(!/^[\x21-\x7e]{1,4096}$/.test(secret))throw new Error('MODEL_SECRET_UNAVAILABLE');return secret;
}
// OAuth credentials and short-lived device codes are not model keys, so they use a
// separate domain-separated AAD. The same deployment key ring still owns both.
function secretAad(companyId:string,provider:string,purpose:string,version:number){
  return new TextEncoder().encode(JSON.stringify(['dingbell.company-model-secret',1,companyId,provider,purpose,version]));
}
export async function sealModelSecret(env:CompanyModelBindings,companyId:string,provider:string,purpose:string,version:number,value:string):Promise<ModelSecret>{
  const config=credentialConfig(env);if(!config)throw new Error('MODEL_ENCRYPTION_UNAVAILABLE');
  if(value.length<1||value.length>16384)throw new Error('MODEL_SECRET_INVALID');
  const key=await crypto.subtle.importKey('raw',config.keys.get(config.activeKeyVersion)!,'AES-GCM',false,['encrypt']),nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:secretAad(companyId,provider,purpose,version)},key,new TextEncoder().encode(value));
  return {keyVersion:config.activeKeyVersion,nonce:encode(nonce),ciphertext:encode(new Uint8Array(ciphertext))};
}
export async function openModelSecret(env:CompanyModelBindings,companyId:string,provider:string,purpose:string,version:number,envelope:ModelSecret):Promise<string>{
  const config=credentialConfig(env),bytes=config?.keys.get(envelope.keyVersion);if(!bytes)throw new Error('MODEL_ENCRYPTION_UNAVAILABLE');
  const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);
  const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.nonce),additionalData:secretAad(companyId,provider,purpose,version)},key,decode(envelope.ciphertext));
  const secret=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(value);
  if(secret.length<1||secret.length>16384)throw new Error('MODEL_SECRET_UNAVAILABLE');return secret;
}
