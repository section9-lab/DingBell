import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APIError, Drive, Sandbox } from '@vercel/sandbox';
import { configuration, productionRequest } from './config.ts';

const sandboxPrefix='dingbell-business-',driveName='dingbell-business-data';
let opening:Promise<Sandbox>|undefined;
const environmentKeys=['BETTER_AUTH_SECRET','BOOTSTRAP_SECRET','RESEND_API_KEY','MAIL_FROM','STORE_CREDENTIAL_KEYS','STORE_CREDENTIAL_ACTIVE_KEY',
  'TRANSLATION_ENABLED','TRANSLATION_CONFIG_JSON','REPLY_TEST_ENABLED','AI_RECEPTION_ENABLED','AI_RECEPTION_CONFIG_JSON','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED','AI_KNOWLEDGE_QUERY_CONFIG_JSON'];
async function files(directory:string,prefix:string):Promise<{path:string;content:Buffer}[]> {
 const result:{path:string;content:Buffer}[]=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())result.push(...await files(join(directory,entry.name),prefix+'/'+entry.name));
  else if(entry.isFile())result.push({path:prefix+'/'+entry.name,content:await readFile(join(directory,entry.name))});
 }return result;
}
async function version(sandbox:Sandbox):Promise<string|null> {
 try{const response=await fetch(new URL('/__internal/version',sandbox.domain(3000)),{headers:{'x-dingbell-gateway':configuration().secret},signal:AbortSignal.timeout(2000)});return response.ok?(await response.json() as {build:string}).build:null;}catch{return null;}
}
async function currentRelease(){
 const response=await productionRequest('/api/platform/version',{});
 if((await response.json() as {build:string}).build!==process.env.VERCEL_DEPLOYMENT_ID)throw new Error('BUSINESS_STALE_DEPLOYMENT');
}
async function remove(sandbox:Sandbox){
 if(!sandbox.name.startsWith(sandboxPrefix))throw new Error('UNEXPECTED_BUSINESS_SANDBOX');
 // Deletion alone does not establish that the Drive detached. Stop the session
 // and confirm release first, keeping its address available if stopping fails.
 try{
  if(!['stopped','failed','aborted'].includes(sandbox.status))await sandbox.stop({signal:AbortSignal.timeout(30000)});
  const until=Date.now()+20000;
  for(;;){
   const mount=await Drive.get({name:driveName,signal:AbortSignal.timeout(10000)});
   if(!mount.currentSessionId||mount.currentSandboxName!==sandbox.name)break;
   if(Date.now()>=until)throw new Error('BUSINESS_DRIVE_RELEASE_UNCONFIRMED');
   await delay(500);
  }
  await sandbox.delete({deleteOrphanSnapshots:true,signal:AbortSignal.timeout(20000)});
 }catch(error){if(!(error instanceof APIError)||error.response.status!==404)throw error;}
}
async function cleanupStopped(){
 try{
  const list=await Sandbox.list({signal:AbortSignal.timeout(10000)});
  for(const item of list.sandboxes.filter(item=>item.name.startsWith(sandboxPrefix)&&['stopped','failed','aborted'].includes(item.status)).slice(0,5)){
   try{await remove(await Sandbox.get({name:item.name,resume:false,signal:AbortSignal.timeout(10000)}));}catch(error){if(!(error instanceof APIError)||error.response.status!==404)throw error;}
  }
 }catch{process.stderr.write('DINGBELL_SANDBOX_CLEANUP_UNCONFIRMED\n');}
}
async function acquire(drive:Drive):Promise<{sandbox:Sandbox;created:boolean}>{
 const until=Date.now()+45000;
 while(Date.now()<until){
  const state=await Drive.get({name:driveName,signal:AbortSignal.timeout(10000)});
  if(state.currentSessionId&&state.currentSandboxName){
   if(!state.currentSandboxName.startsWith(sandboxPrefix))throw new Error('UNEXPECTED_BUSINESS_SANDBOX');
   try{return{sandbox:await Sandbox.get({name:state.currentSandboxName,resume:false,signal:AbortSignal.timeout(15000)}),created:false};}
   catch(error){if(!(error instanceof APIError)||error.response.status!==404)throw error;}
  }else{
   try{return{sandbox:await Sandbox.create({name:sandboxPrefix+crypto.randomUUID(),region:'iad1',persistent:false,timeout:30*60000,resources:{vcpus:1},ports:[3000],mounts:{'/data':drive},signal:AbortSignal.timeout(45000)}),created:true};}
   catch(error){if(!(error instanceof APIError)||error.response.status!==409)throw error;}
  }
  await delay(500);
 }throw new Error('BUSINESS_DRIVE_ATTACHMENT_UNCONFIRMED');
}
async function install(sandbox:Sandbox){
 const {secret,origin}=configuration(),build=process.env.VERCEL_DEPLOYMENT_ID??'local',folder='/vercel/sandbox/dingbell';
 await sandbox.writeFiles([{path:folder+'/package.json',content:Buffer.from('{"type":"module"}')},...await files(resolve('dist/node/server'),folder+'/server'),...await files(resolve('migrations'),folder+'/migrations')]);
 await currentRelease();
 const env:Record<string,string>={NODE_ENV:'production',HOST:'0.0.0.0',PORT:'3000',APP_BASE_URL:origin,DINGBELL_DATA_DIR:'/data',DINGBELL_MIGRATIONS_DIR:folder+'/migrations',DINGBELL_ASSETS_DIR:folder+'/unused-assets',DINGBELL_GATEWAY_SECRET:secret,DINGBELL_EXECUTION_TARGET:'vercel',DINGBELL_BUILD_ID:build};
 for(const key of environmentKeys)if(process.env[key])env[key]=process.env[key]!;
 if(process.env.NVAPI_KEY)env.NVAPI_KEY=process.env.NVAPI_KEY;
 await sandbox.runCommand({cmd:'node',args:[folder+'/server/server.mjs'],cwd:folder,env,detached:true});
}
async function openBackend(){
 await currentRelease();const build=process.env.VERCEL_DEPLOYMENT_ID;
 const drive=await Drive.getOrCreate({name:driveName,region:'iad1',maxSize:1024*1024*1024,signal:AbortSignal.timeout(20000)});
 // The Drive's exclusive mount is the creation fence. Every incarnation has a unique name:
 // deleting an expired incarnation can never delete a replacement created by another Function.
 for(let attempt=0;attempt<3;attempt++){
  await currentRelease();const {sandbox,created}=await acquire(drive);
  if(created)await install(sandbox);
  const until=Date.now()+60000;let current=await version(sandbox);
  while(!current&&Date.now()<until){await delay(500);current=await version(sandbox);}
  if(current===build){await cleanupStopped();return sandbox;}
  await currentRelease();
  await remove(sandbox);
 }
 throw new Error('BUSINESS_BACKEND_START_UNCONFIRMED');
}
export async function backendRequest(path:string,init:RequestInit={}){
 let sandbox=await(opening??=openBackend().catch(error=>{opening=undefined;throw error;}));
 if(await version(sandbox)!==process.env.VERCEL_DEPLOYMENT_ID){opening=undefined;sandbox=await(opening??=openBackend().catch(error=>{opening=undefined;throw error;}));}
 const headers=new Headers(init.headers);headers.set('x-dingbell-gateway',configuration().secret);
 try{
  const response=await fetch(new URL(path,sandbox.domain(3000)),{...init,headers,redirect:'manual',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
  // Fetch already decoded the ingress response; these headers describe its old wire bytes.
  const outgoing=new Headers(response.headers);for(const key of ['content-encoding','content-length','transfer-encoding','connection'])outgoing.delete(key);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:outgoing});
 }catch(error){opening=undefined;throw error;}
}
