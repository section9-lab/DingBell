import type { CompanyModelBindings } from './security.ts';
import { openModelKey,openModelSecret,sealModelSecret } from './security.ts';
import { insertAuthSession,readAuthSession,readCompanyCredential,saveCompanyCredential,updateAuthSession,type AuthSessionRecord,type CompanyCredentialRecord,type ModelRecord } from './storage.ts';
export interface OAuthBindings extends CompanyModelBindings { DB?: D1Database }

export type OAuthProvider='kimi-coding';
export type OAuthSessionStatus='pending'|'complete'|'failed'|'expired';
export interface OAuthSessionView {
  sessionId:string;provider:OAuthProvider;status:OAuthSessionStatus;
  userCode:string;verificationUri:string;intervalSeconds:number;expiresAt:string;
  failureCode:string|null;
}
export type OAuthFailure='oauth_denied'|'oauth_expired'|'oauth_unavailable'|'oauth_invalid_response'|'oauth_refresh_failed';
export class OAuthLoginError extends Error {
  readonly code:OAuthFailure;
  constructor(code:OAuthFailure){super(code);this.name='OAuthLoginError';this.code=code;}
}
interface OAuthCredential {type:'oauth';access:string;refresh:string;expires:number}
const KIMI_CLIENT_ID='17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_AUTH_HOST='https://auth.kimi.com';
const KIMI_DEVICE_URL=`${KIMI_AUTH_HOST}/api/oauth/device_authorization`;
const KIMI_TOKEN_URL=`${KIMI_AUTH_HOST}/api/oauth/token`;
const DEVICE_CODE_PURPOSE='device-code',CREDENTIAL_PURPOSE='credential';
const asRecord=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown,min:number,max:number)=>typeof value==='string'&&value.length>=min&&value.length<=max&&value===value.trim()&&value.isWellFormed()?value:null;
const positive=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;
function httpUrl(value:unknown){
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function signalWithTimeout(signal:AbortSignal){return AbortSignal.any([signal,AbortSignal.timeout(15_000)]);}
async function json(response:Response):Promise<Record<string,unknown>|null>{
  const type=response.headers.get('content-type')??'';
  if(!type.includes('application/json'))return null;
  return asRecord(await response.json().catch(()=>null));
}
function credential(value:string):OAuthCredential {
  let parsed:unknown;
  try{parsed=JSON.parse(value);}catch{throw new OAuthLoginError('oauth_invalid_response');}
  const record=asRecord(parsed),access=text(record?.access,1,8192),refresh=text(record?.refresh,1,8192),expiresAt=positive(record?.expires,0,Number.MAX_SAFE_INTEGER);
  if(record?.type!=='oauth'||!access||!refresh||expiresAt===null)throw new OAuthLoginError('oauth_invalid_response');
  return {type:'oauth',access,refresh,expires:expiresAt};
}
async function loadCredential(env:OAuthBindings,companyId:string){
  const row=await readCompanyCredential(env.DB!,companyId,'kimi-coding');
  if(!row)throw new OAuthLoginError('oauth_unavailable');
  const value=await openModelSecret(env,companyId,'kimi-coding',CREDENTIAL_PURPOSE,row.credentialVersion,row);
  return {row,credential:credential(value)};
}
function tokenCredential(value:Record<string,unknown>):OAuthCredential {
  const access=text(value.access_token,1,8192),refresh=text(value.refresh_token,1,8192),lifetime=positive(value.expires_in,1,365*24*3600);
  if(!access||!refresh||lifetime===null)throw new OAuthLoginError('oauth_invalid_response');
  return {type:'oauth',access,refresh,expires:Date.now()+lifetime*1000};
}
async function saveCredential(env:OAuthBindings,companyId:string,value:OAuthCredential,version:number):Promise<CompanyCredentialRecord>{
  const sealed=await sealModelSecret(env,companyId,'kimi-coding',CREDENTIAL_PURPOSE,version,JSON.stringify(value));
  const record:CompanyCredentialRecord={companyId,provider:'kimi-coding',authType:'oauth',credentialVersion:version,...sealed,expiresAt:value.expires,accountLabel:'Kimi Code',updatedAt:Date.now()};
  await saveCompanyCredential(env.DB!,record);
  return record;
}
function view(row:AuthSessionRecord):OAuthSessionView {
  return {sessionId:row.id,provider:'kimi-coding',status:row.status,userCode:row.userCode,verificationUri:row.verificationUri,
    intervalSeconds:row.intervalSeconds,expiresAt:new Date(row.expiresAt).toISOString(),failureCode:row.failureCode};
}
/** Starts an RFC 8628 device authorization. The device code never leaves the server. */
export async function startKimiLogin(env:OAuthBindings,companyId:string,send:typeof fetch,signal:AbortSignal):Promise<OAuthSessionView>{
  if(!env.DB)throw new OAuthLoginError('oauth_unavailable');
  let response:Response;
  try{response=await send(KIMI_DEVICE_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:KIMI_CLIENT_ID}).toString(),redirect:'manual',signal:signalWithTimeout(signal)});}
  catch{throw new OAuthLoginError('oauth_unavailable');}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new OAuthLoginError('oauth_unavailable');}
  const data=await json(response),deviceCode=text(data?.device_code,1,8192),userCode=text(data?.user_code,1,256),
    verificationUri=httpUrl(data?.verification_uri_complete)??httpUrl(data?.verification_uri),
    interval=positive(data?.interval,1,60)??5,lifetime=positive(data?.expires_in,60,15*60);
  if(!deviceCode||!userCode||!verificationUri||lifetime===null)throw new OAuthLoginError('oauth_invalid_response');
  const now=Date.now(),sealed=await sealModelSecret(env,companyId,'kimi-coding',DEVICE_CODE_PURPOSE,1,deviceCode);
  const row:AuthSessionRecord={id:crypto.randomUUID(),organizationId:companyId,provider:'kimi-coding',status:'pending',
    deviceCodeKeyVersion:sealed.keyVersion,deviceCodeNonce:sealed.nonce,deviceCodeCiphertext:sealed.ciphertext,
    userCode,verificationUri,intervalSeconds:interval,expiresAt:now+lifetime*1000,nextPollAt:now+interval*1000,
    failureCode:null,createdAt:now,updatedAt:now};
  await insertAuthSession(env.DB,row);
  return view(row);
}
/** Polls once. The browser drives this; the device code stays encrypted in D1. */
export async function pollKimiLogin(env:OAuthBindings,companyId:string,sessionId:string,send:typeof fetch,signal:AbortSignal):Promise<OAuthSessionView|null>{
  if(!env.DB)throw new OAuthLoginError('oauth_unavailable');
  let row=await readAuthSession(env.DB,companyId,sessionId);
  if(!row)return null;
  if(row.status!=='pending')return view(row);
  const now=Date.now();
  if(now>=row.expiresAt){await updateAuthSession(env.DB,companyId,row.id,'expired',row.nextPollAt,row.intervalSeconds,'oauth_expired');row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);}
  if(now<row.nextPollAt)return view(row);
  const deviceCode=await openModelSecret(env,companyId,'kimi-coding',DEVICE_CODE_PURPOSE,1,{keyVersion:row.deviceCodeKeyVersion,nonce:row.deviceCodeNonce,ciphertext:row.deviceCodeCiphertext});
  let response:Response;
  try{response=await send(KIMI_TOKEN_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:KIMI_CLIENT_ID,device_code:deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}).toString(),
    redirect:'manual',signal:signalWithTimeout(signal)});}
  catch{await updateAuthSession(env.DB,companyId,row.id,'pending',now+row.intervalSeconds*1000,row.intervalSeconds,null);row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);}
  const data=await json(response);
  if(response.ok){
    const value=tokenCredential(data??{});
    const current=await readCompanyCredential(env.DB,companyId,'kimi-coding');
    await saveCredential(env,companyId,value,(current?.credentialVersion??0)+1);
    await updateAuthSession(env.DB,companyId,row.id,'complete',row.nextPollAt,row.intervalSeconds,null);
    row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);
  }
  const error=text(data?.error,1,128);
  if(error==='authorization_pending'){
    await updateAuthSession(env.DB,companyId,row.id,'pending',now+row.intervalSeconds*1000,row.intervalSeconds,null);
    row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);
  }
  if(error==='slow_down'){
    const interval=Math.min(60,row.intervalSeconds+5);
    await updateAuthSession(env.DB,companyId,row.id,'pending',now+interval*1000,interval,null);
    row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);
  }
  const failure:OAuthFailure=error==='access_denied'?'oauth_denied':error==='expired_token'?'oauth_expired':'oauth_unavailable';
  await updateAuthSession(env.DB,companyId,row.id,failure==='oauth_expired'?'expired':'failed',row.nextPollAt,row.intervalSeconds,failure);
  row=(await readAuthSession(env.DB,companyId,sessionId))!;return view(row);
}
/** Resolves a short-lived Kimi access token, refreshing it once by CAS. */
export async function readKimiAccessToken(env:OAuthBindings,companyId:string,send:typeof fetch=fetch):Promise<string>{
  if(!env.DB)throw new OAuthLoginError('oauth_unavailable');
  const loaded=await loadCredential(env,companyId);
  if(loaded.credential.expires>Date.now()+60_000)return loaded.credential.access;
  let response:Response;
  try{response=await send(KIMI_TOKEN_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:KIMI_CLIENT_ID,grant_type:'refresh_token',refresh_token:loaded.credential.refresh}).toString(),
    redirect:'manual',signal:signalWithTimeout(new AbortController().signal)});}
  catch{throw new OAuthLoginError('oauth_refresh_failed');}
  const data=await json(response);
  if(response.status===401||response.status===403||data?.error==='invalid_grant')throw new OAuthLoginError('oauth_refresh_failed');
  if(!response.ok)throw new OAuthLoginError('oauth_refresh_failed');
  const value=tokenCredential(data??{});
  await saveCredential(env,companyId,value,loaded.row.credentialVersion+1);
  const latest=await loadCredential(env,companyId);
  return latest.credential.access;
}
/** Existing API-key revisions keep their immutable envelope; OAuth revisions resolve the mutable credential. */
export async function modelAccessToken(env:OAuthBindings,row:ModelRecord,send:typeof fetch=fetch){
  if(row.authType==='oauth')return readKimiAccessToken(env,row.companyId,send);
  return openModelKey(env,row.companyId,row.revision,row.baseUrl,row.model,row);
}
