import {credentialConfig,type CredentialBindings} from '../stores/credentials.ts';
export type PushSecret={keyVersion:string;nonce:string;ciphertext:string;secretHash:string};
export async function pushHash(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export function equalHash(left:string,right:string){let difference=left.length^right.length;for(let index=0;index<64;index++)difference|=(left.charCodeAt(index)||0)^(right.charCodeAt(index)||0);return difference===0;}
const encode=(value:Uint8Array)=>btoa(String.fromCharCode(...value));
const decode=(value:string)=>Uint8Array.from(atob(value),letter=>letter.charCodeAt(0));
function aad(orgId:string,storeId:string,endpointId:string,generation:number){return new TextEncoder().encode(JSON.stringify(['dingbell.ozon.push',1,orgId,storeId,endpointId,generation]));}
export async function sealPushSecret(env:CredentialBindings,orgId:string,storeId:string,endpointId:string,generation:number,secret:string):Promise<PushSecret>{
 const config=credentialConfig(env);if(!config)throw new Error('PUSH_ENCRYPTION_UNAVAILABLE');
 const keyVersion=config.activeKeyVersion,key=await crypto.subtle.importKey('raw',config.keys.get(keyVersion)!,'AES-GCM',false,['encrypt']);
 const nonce=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(orgId,storeId,endpointId,generation)},key,new TextEncoder().encode(secret));
 return {keyVersion,nonce:encode(nonce),ciphertext:encode(new Uint8Array(ciphertext)),secretHash:await pushHash(secret)};
}
export async function openPushSecret(env:CredentialBindings,row:PushSecret&{orgId:string;storeId:string;endpointId:string;generation:number}){
 try{const bytes=credentialConfig(env)?.keys.get(row.keyVersion);if(!bytes)throw new Error();const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);
  const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(row.nonce),additionalData:aad(row.orgId,row.storeId,row.endpointId,row.generation)},key,decode(row.ciphertext));
  const secret=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);if(!equalHash(await pushHash(secret),row.secretHash))throw new Error();return secret;
 }catch{throw new Error('PUSH_SECRET_UNAVAILABLE');}
}
export function newPushToken(){return encode(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export function localPushMode(base:string|undefined){try{const url=new URL(base??'');return ['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{return false;}}
export function pushCallbackUrl(base:string|undefined,endpointId:string,secret:string){
 const url=new URL(base??'');if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&localPushMode(base)))throw new RangeError('PUSH_PUBLIC_URL_INVALID');
 return new URL(`/api/ozon/push/${endpointId}/${secret}`,url.origin).href;
}
