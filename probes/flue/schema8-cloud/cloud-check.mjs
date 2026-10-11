import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [phase, origin, checkpoint] = process.argv.slice(2);
assert.ok(['before','after'].includes(phase) && origin && checkpoint && process.env.DINGBELL_PROBE_SECRET_FILE,'arguments: before|after ORIGIN CHECKPOINT and DINGBELL_PROBE_SECRET_FILE are required');
const url = new URL(origin);
assert.equal(url.protocol,'https:','origin: HTTPS is required');
assert.ok(url.hostname.startsWith('dingbell-flue-schema8-probe.') && url.hostname.endsWith('.workers.dev'),'origin: only the dedicated schema8 Worker is allowed');
assert.equal(url.href,url.origin+'/','origin: no path, query or fragment is allowed');
const {PROBE_TOKEN:token} = JSON.parse(await readFile(process.env.DINGBELL_PROBE_SECRET_FILE,'utf8'));
assert.ok(typeof token === 'string' && token.length >= 32,'secret file: PROBE_TOKEN must have at least 32 characters');
async function request(path,body,auth=`Bearer ${token}`){
  return fetch(new URL(path,url),{method:body===undefined?'GET':'POST',headers:{authorization:auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(60000)});
}
async function json(path,body,status=200){
  const response=await request(path,body); assert.equal(response.status,status,`${path}: ${response.status}`);return response.json();
}
const expectedHealth = phase === 'before'
 ? {service:'dingbell-flue-schema8-probe',variant:'legacy',runtimeVersion:'2.0.0-nightly.202607240825',storageFormat:{kind:'schema',version:8}}
 : {service:'dingbell-flue-schema8-probe',variant:'current',runtimeVersion:'2.2.2',storageFormat:{kind:'format',version:1}};
let health;
const deadline=Date.now()+60000;
while(Date.now()<deadline){
 try{
  const response=await fetch(new URL('/api/health',url),{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(response.status===200){health=await response.json();assert.deepEqual(health,expectedHealth,'/api/health: deployed runtime is not the expected phase');break;}
 }catch{}
 await delay(1000);
}
assert.deepEqual(health,expectedHealth,'/api/health: expected deployed runtime was not ready within 60 seconds');
if(phase==='before'){
 const id=`schema8-${crypto.randomUUID()}`;
 for(const auth of ['', 'Bearer wrong-token'])for(const [path,body]of [[`/fixture/${id}`,{}],[`/fixture/${id}/unknown`,undefined],[`/agents/history/${id}`,undefined]])assert.equal((await request(path,body,auth)).status,401,`${path}: ${auth ? 'wrong' : 'missing'} token must return 401`);
 const receipt=await json(`/fixture/${id}`,{},202);
 const reply=await json(`/fixture/${id}/${receipt.submissionId}`);
 assert.equal(reply.text,'authentic schema8 cloud fixture reply',`/fixture/${id}/${receipt.submissionId}: expected legacy answer`);assert.equal(reply.submissionId,receipt.submissionId,`/fixture/${id}/${receipt.submissionId}: original submission ID`);
 const history=await json(`/agents/history/${id}`);
 assert.equal(history.messages.filter(x=>x.role==='user').length,1,`/agents/history/${id}: one user message`);assert.equal(history.messages.filter(x=>x.role==='assistant').length,1,`/agents/history/${id}: one assistant message`);
 await writeFile(checkpoint,JSON.stringify({origin:url.origin,health,id,receipt,reply,history,checkedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({phase,status:'passed',checkpoint}));
} else {
 const saved=JSON.parse(await readFile(checkpoint,'utf8'));assert.equal(saved.origin,url.origin,`${checkpoint}: origin must match`);
 const reply=await json(`/fixture/${saved.id}/${saved.receipt.submissionId}`);assert.deepEqual(reply,saved.reply,`/fixture/${saved.id}/${saved.receipt.submissionId}: original stored answer must be preserved`);
 const history=await json(`/agents/history/${saved.id}`);assert.equal(history.messages.length,saved.history.messages.length,`/agents/history/${saved.id}: message count must be preserved`);
 for(let i=0;i<history.messages.length;i++){
  const before=saved.history.messages[i],after=history.messages[i];
  for(const key of Object.keys(before))assert.deepEqual(after[key],before[key],`/agents/history/${saved.id}: messages[${i}].${key} must be preserved`);
  for(const key of Object.keys(after).filter(key=>!(key in before))){assert.equal(key,'timestamp',`/agents/history/${saved.id}: only timestamp may be added to messages[${i}]`);assert.ok(Number.isFinite(Date.parse(after[key])),`/agents/history/${saved.id}: messages[${i}].timestamp must be valid`);}
 }
 const evidence=checkpoint+'.after.json';
 await writeFile(evidence,JSON.stringify({phase,origin:url.origin,health,id:saved.id,receipt:saved.receipt,reply,history,checkedAt:new Date().toISOString(),assertions:['public health confirms current runtime and format before reading the old receipt','original receipt read before any new POST','old message IDs and content preserved','current model is intentionally unable to generate a replacement']},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({phase,status:'passed',evidence}));
}
