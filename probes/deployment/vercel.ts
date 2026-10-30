import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { Drive, Sandbox } from '../../deploy/vercel/node_modules/@vercel/sandbox/dist/index.js';
import { getAuth } from '../../deploy/vercel/node_modules/@vercel/sandbox/dist/auth/index.js';

if(!process.argv.includes('--isolated-cloud'))throw new Error('Pass --isolated-cloud to create and remove a synthetic-only full application.');
const option=(key:string)=>process.argv[process.argv.indexOf(key)+1];
const cli=option('--cli'),scope=option('--scope');
if(!cli||!scope||!/^[-a-z0-9]+$/.test(scope))throw new Error('Provide --cli and --scope.');
const root=resolve(import.meta.dirname,'../..'),name=`dingbell-app-check-${Date.now().toString(36)}-${crypto.randomUUID().slice(0,6)}`;
const output=join(root,'test-results/deployment',name);await mkdir(output,{recursive:true});
for(const file of ['.vercel/project.json','.env.local']){try{await readFile(join(root,file));throw new Error('Refusing to replace an existing local project or environment.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
const secret=crypto.randomUUID()+crypto.randomUUID(),identitySecret=crypto.randomUUID()+crypto.randomUUID(),bootstrap=crypto.randomUUID()+crypto.randomUUID(),password=crypto.randomUUID()+'!Aa1';
const redact=(value:string)=>[secret,identitySecret,bootstrap,password,getAuth()?.token??''].filter(Boolean).reduce((text,key)=>text.replaceAll(key,'[redacted]'),value);
const phases:{phase:string;code:number|null}[]=[];
const evidence:Record<string,unknown>={startedAt:new Date().toISOString(),name,phases,scope:'production-full-application-native-sandbox-drive-world-synthetic-identities-no-real-email-model-or-sends'};
let attempted=false,origin:string|undefined,credentials:{token:string;projectId:string;teamId:string}|undefined;
async function command(phase:string,args:string[],input?:string){
 const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{
  const child=spawn(process.execPath,[cli!,...args,'--scope',scope!],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DO_NOT_TRACK:'1',VERCEL_TELEMETRY_DISABLED:'1'}});child.stdin.end(input??'');let captured='';
  const capture=(chunk:Buffer)=>{captured=(captured+chunk.toString()).slice(-300000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
  const timer=setTimeout(()=>child.kill('SIGKILL'),600000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);done({code,output:redact(captured)});});
 });await writeFile(join(output,phase+'.log'),result.output,{mode:0o600});phases.push({phase,code:result.code});console.log(`${phase}: ${result.code===0?'passed':'failed'}`);return result;
}
function success(value:{code:number|null;output:string}){assert.equal(value.code,0,value.output.slice(-6000));return value.output;}
async function deploy(phase:string,force=false){const log=success(await command(phase,['deploy','--prod','--yes','--logs',...(force?['--force']:[])]));assert.doesNotMatch(log,/TS2688|error TS\d+/,'Cloud build must contain no TypeScript diagnostics');const value=/"productionUrl":\s*"(https:\/\/[-a-z0-9.]+\.vercel\.app)"/.exec(log)?.[1];assert.ok(value,'Production alias must be returned');return value;}
async function request(path:string,method='GET',cookie='',body?:unknown,internal=false){assert.ok(origin);return fetch(new URL(path,origin),{method,redirect:'manual',signal:AbortSignal.timeout(120000),headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...(internal?{'x-dingbell-internal':secret}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function run(sandbox:Sandbox,source:string){const result=await sandbox.runCommand('node',['--input-type=module','-e',source]);assert.equal(result.exitCode,0,redact(await result.stderr()));const text=await result.stdout();return text.trim()?JSON.parse(text) as unknown:undefined;}
try{
 attempted=true;success(await command('create-project',['project','create',name]));success(await command('link-project',['link','--yes','--project',name]));
 const linked=JSON.parse(await readFile(join(root,'.vercel/project.json'),'utf8')) as {projectId:string;orgId:string;projectName:string};assert.equal(linked.projectName,name);
 const auth=getAuth();assert.ok(auth?.token,'CLI authentication required');credentials={token:auth.token,projectId:linked.projectId,teamId:linked.orgId};
 const inputs=JSON.parse(success(await command('deploy-inputs',['deploy','--dry','--json']))) as {files:{path:string}[]};
 for(const path of ['api/app.js','api/harness.js','api/flow.js','api/maintenance.js'])assert.ok(inputs.files.some(file=>file.path===path),`Missing ${path}`);
 assert.equal(inputs.files.some(file=>/(?:^|\/)\.(?:env|dev)/.test(file.path)),false);
 for(const [key,value]of Object.entries({DINGBELL_GATEWAY_SECRET:secret,BETTER_AUTH_SECRET:identitySecret,BOOTSTRAP_SECRET:bootstrap}))success(await command('configure-'+key.toLowerCase(),['env','add',key,'--environment','production','--sensitive','--yes'],value));
 origin=await deploy('deploy');evidence.origin=origin;
 const health=await request('/api/health');assert.equal(health.status,200,(await health.clone().text()).slice(0,800));
 const bootstrapResponse=await request('/api/bootstrap');assert.equal(bootstrapResponse.status,200,(await bootstrapResponse.clone().text()).slice(0,800));assert.deepEqual(await bootstrapResponse.json(),{state:'unclaimed',configured:true,emailConfigured:false});
 const page=await request('/login');assert.equal(page.status,200);const html=await page.text(),asset=/<script[^>]+src="(\/assets\/[^"?]+\.js)"/.exec(html)?.[1];assert.ok(asset);assert.equal((await request(asset)).status,200);
 assert.equal((await request('/api/companies')).status,401);assert.equal((await request('/api/platform/version')).status,404);assert.equal((await request('/api/harness','POST','',{})).status,401);
 console.log('fresh-installation: passed');evidence.freshInstallation={schemaReadable:true,unclaimed:true,identityConfigured:true,staticAssets:true,anonymousDenied:true,privateAuthorityDenied:true};
 let mountedDrive=await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)});assert.ok(mountedDrive.currentSandboxName);let sandbox=await Sandbox.get({...credentials,name:mountedDrive.currentSandboxName,resume:false});
 const now=Date.now(),hashed=await hashPassword(password);
 await run(sandbox,`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/business.sqlite');db.prepare('INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('fixture-a','Fixture A','a@example.invalid',1,${now},${now});db.prepare('INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('fixture-account','fixture-a','credential','fixture-a',${JSON.stringify(hashed)},${now},${now});db.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('fixture-company-a','Fixture A','fixture-a',${now}),('fixture-company-b','Fixture B','fixture-b',${now});INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('fixture-owner','fixture-company-a','fixture-a','owner',${now});");db.close();`);
 const login=await request('/api/auth/sign-in/email','POST','',{email:'a@example.invalid',password});assert.equal(login.status,200,(await login.clone().text()).slice(0,800));
 const cookie=login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');assert.ok(cookie.includes('session_token='));assert.ok(login.headers.getSetCookie().some(value=>/httponly/i.test(value)));
 const companies=await request('/api/companies','GET',cookie);assert.equal(companies.status,200);assert.deepEqual((await companies.json() as {companies:{id:string}[]}).companies.map(value=>value.id),['fixture-company-a']);
 assert.equal((await request('/api/companies/fixture-company-a/activate','POST',cookie,{})).status,200);
 const path='/api/companies/fixture-company-a/settings',current=await(await request(path,'GET',cookie)).json() as {version:number};
 const saved=await request(path,'POST',cookie,{timeZone:'Asia/Shanghai',expectedVersion:current.version});assert.equal(saved.status,200);const expected=await saved.json();
 assert.equal((await request('/api/companies/fixture-company-b/settings','GET',cookie)).status,404);
 console.log('business-contracts: passed');evidence.business={realSignIn:true,httpOnlySession:true,companyIsolation:true,settingsWrite:true};
 // Only read passive Drive metadata while stopped: a health request would wake the backend itself.
 const before=await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)});const stoppedAt=Date.now();console.log('Waiting for native maintenance after Sandbox stop.');await sandbox.stop({signal:AbortSignal.timeout(30000)});
 let after=before;const until=Date.now()+180000;
 while(Date.now()<until){await delay(2500);after=await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)});if(after.currentSessionId&&after.currentSessionId!==before.currentSessionId)break;}
 assert.ok(after.currentSessionId&&after.currentSessionId!==before.currentSessionId,'Native maintenance queue must attach a new Sandbox without a public request');
 assert.ok(after.currentSandboxName);sandbox=await Sandbox.get({...credentials,name:after.currentSandboxName,resume:false});
 const readMarker=async()=>await run(sandbox,`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/business.sqlite',{readOnly:true});const row=db.prepare("SELECT value FROM runtime_platform_setting WHERE key='maintenance_queue_tick'").get();console.log(JSON.stringify({tick:Number(row?.value??0),integrity:db.prepare('PRAGMA integrity_check').get()}));db.close();`) as {tick:number;integrity:unknown};
 let marker=await readMarker();
 const tickDeadline=Date.now()+60000;
 while(marker.tick<stoppedAt&&Date.now()<tickDeadline){
  await delay(1000);
  assert.equal((await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)})).currentSessionId,after.currentSessionId,'Observer must not resume another session');
  marker=await readMarker();
 }
 assert.equal((await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)})).currentSessionId,after.currentSessionId);
 evidence.maintenanceObservation={marker,stoppedAt,beforeSession:before.currentSessionId,afterSession:after.currentSessionId};
 assert.ok(marker.tick>=stoppedAt,'The native queue must execute maintenance after replacement, not merely mount a Drive');
 console.log('native-maintenance: passed');evidence.nativeMaintenance={passiveObservation:true,beforeSession:before.currentSessionId,afterSession:after.currentSessionId,queueTickAfterStop:true,integrity:marker.integrity};
 const restored=await request(path,'GET',cookie);assert.equal(restored.status,200);assert.deepEqual(await restored.json(),expected);
 origin=await deploy('redeploy',true);let upgraded=await request(path,'GET',cookie);const upgradeReads:{status:number;code?:string}[]=[];const upgradeDeadline=Date.now()+90000;
 while(upgraded.status===503&&Date.now()<upgradeDeadline){upgradeReads.push({status:upgraded.status,code:(await upgraded.json() as {error?:{code?:string}}).error?.code});await delay(1500);upgraded=await request(path,'GET',cookie);}
 evidence.upgradeReads=upgradeReads;const upgradeBody=await upgraded.text();evidence.upgradeHttp={status:upgraded.status,bytes:Buffer.byteLength(upgradeBody),contentType:upgraded.headers.get('content-type'),contentEncoding:upgraded.headers.get('content-encoding')};assert.equal(upgraded.status,200,upgradeBody.slice(0,800));assert.ok(upgradeBody.length,'Successful settings response must contain its original JSON');assert.deepEqual(JSON.parse(upgradeBody),expected);
 evidence.redeployment={migrationsIdempotent:true,settingsPreserved:true,sessionPreserved:true,noTypeDiagnostics:true};
 // A second replacement catches races that one successful upgrade can miss.
 origin=await deploy('redeploy-again',true);
 const secondDeadline=Date.now()+90000;let second=await request(path,'GET',cookie);let unavailable=0;
 while(second.status===503&&Date.now()<secondDeadline){unavailable++;await second.arrayBuffer();await delay(1500);second=await request(path,'GET',cookie);}
 assert.equal(second.status,200);assert.deepEqual(await second.json(),expected);
 evidence.repeatedUpgrade={settingsPreserved:true,sessionPreserved:true,unavailableReads:unavailable};evidence.status='passed';
}catch(error){evidence.status='failed';evidence.error=redact(error instanceof Error?error.stack??error.message:String(error));process.exitCode=1;}
finally{
 const cleanup:Record<string,boolean>={};
 if(origin)await delay(5000);
 if(origin)await command('runtime-logs',['logs','--project',name,'--since','20m','--json','--limit','100']);
 if(origin){try{const stopped=await request('/api/platform/maintenance-stop','POST','',{},true);cleanup.maintenance=stopped.ok;}catch{cleanup.maintenance=false;}}
 if(credentials){
  try{const list=await Sandbox.list({...credentials,signal:AbortSignal.timeout(15000)});for(const item of list.sandboxes){if(!item.name.startsWith('dingbell-business-'))throw new Error('Unexpected test Sandbox');const sandbox=await Sandbox.get({...credentials,name:item.name,resume:false});if(!['stopped','failed','aborted'].includes(sandbox.status))await sandbox.stop({signal:AbortSignal.timeout(30000)});await sandbox.delete({deleteOrphanSnapshots:true,signal:AbortSignal.timeout(30000)});}cleanup.sandbox=true;}catch(error){cleanup.sandbox=String(error).includes('not found');}
  try{const until=Date.now()+30000;let drive:Drive|undefined;while(Date.now()<until){drive=await Drive.get({...credentials,name:'dingbell-business-data',signal:AbortSignal.timeout(15000)});if(!drive.currentSessionId)break;await delay(500);}assert.ok(drive&&!drive.currentSessionId);await drive.delete({signal:AbortSignal.timeout(30000)});cleanup.drive=true;}catch(error){cleanup.drive=String(error).includes('not found');}
 }
 if(attempted)cleanup.project=(await command('remove-project',['project','rm',name,'--yes'])).code===0;
 if(cleanup.project){await rm(join(root,'.vercel'),{recursive:true,force:true});await rm(join(root,'.env.local'),{force:true});}
 evidence.cleanup=cleanup;evidence.finishedAt=new Date().toISOString();if(Object.values(cleanup).some(value=>!value))process.exitCode=1;
 await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,cleanup,evidencePath:join(output,'evidence.json'),error:evidence.error}));
}
