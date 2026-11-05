import assert from 'node:assert/strict';
import {conversationsFixture} from './conversations.ts';
import {capabilityCodes} from '../../src/modules/stores/ozon.ts';
import {encryptCredentials} from '../../src/modules/stores/credentials.ts';
export async function pushFixture(){
 const f=await conversationsFixture();
 const env={...f.env,STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,11).toString('base64')}),STORE_COORDINATOR:{getByName:()=>({wake:async()=>{}})}};
 const base='/api/companies/company/stores/store-a/push';
 const manage=(body?:unknown,who='owner')=>f.app.request(env.APP_BASE_URL+base,{method:body===undefined?'GET':'POST',headers:{cookie:f.cookies[who]??'',origin:env.APP_BASE_URL,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env as never);
 const callback=(url:string,body:unknown)=>f.app.request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},env as never);
 async function activate(){
  const envelope=await encryptCredentials(env,{orgId:'company',storeId:'store-a',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-push-api-key'});
  await f.DB.prepare(`UPDATE store SET status='verified',credential_key_version=?,credential_nonce=?,credential_ciphertext=?,checked_at=?,expires_at=?,capabilities=? WHERE id='store-a'`).bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,Date.now(),Date.now()+86_400_000,JSON.stringify(capabilityCodes.map(code=>({code,status:'available',reason:'synthetic'})))).run();
  for(const source of ['', '/products','/fbs-postings','/fbo-postings','/fbp-postings']){
   const response=await f.app.request(env.APP_BASE_URL+'/api/companies/company/stores/store-a/sync'+source,{method:'POST',headers:{cookie:f.cookies.owner,origin:env.APP_BASE_URL,'content-type':'application/json'},body:JSON.stringify({enabled:true,expectedEpoch:0})},env as never);assert.equal(response.status,200,await response.clone().text());
  }
  const prepared=await manage({operation:'prepare',expectedRevision:0,sellerId:'1'});assert.equal(prepared.status,200,await prepared.clone().text());const result=await prepared.json() as {push:{callbackUrl:string}};
  assert.equal((await callback(result.push.callbackUrl,{message_type:'TYPE_PING'})).status,200);
  const active=await manage({operation:'activate',expectedRevision:1});assert.equal(active.status,200,await active.clone().text());return result.push.callbackUrl;
 }
 return {...f,env,base,manage,callback,activate};
}
