import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { createServer,type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath,URL } from 'node:url';
import { test } from 'node:test';
import type { ReplyTestRun } from '../../src/modules/reply-tests/storage.ts';
import { getReplyTestInstructions } from '../../src/modules/reply-tests/prompt.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function stop(child:ChildProcess){
  if(child.pid===undefined)return;
  const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child.pid!,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const done=child.exitCode===null&&child.signalCode===null?once(child,'exit'):Promise.resolve();kill('SIGTERM');
  const timer=setTimeout(()=>kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(timer);kill('SIGKILL');}
}
test('native Flue answer tests use frozen knowledge, isolated provider permissions and reusable receipts',{timeout:180_000},async t=>{
  const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-answer-server.txt'),f.logs());await f.close();});
  const args=(run:ReplyTestRun)=>({requestId:run.requestId});
  await t.test('one provider request becomes a reviewed answer and cannot send to the customer',async()=>{
    const run=await f.reserve(),before=f.calls().length;
    const submitted=await f.call('execute',args(run));assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    const result=submitted.body.status==='pending'?await f.result(run):submitted;
    assert.equal(result.body.status,'review_required',JSON.stringify(result.body));assert.equal(result.body.review.canSend,false);assert.equal(result.body.usageStatus,'settled');
    assert.equal(f.calls().length-before,1);const payload=f.calls().at(-1)!.body;
    assert.equal(payload.model,'nvidia/nemotron-3-super-120b-a12b');assert.equal(payload.max_tokens??payload.max_completion_tokens,2048);assert.equal(payload.tool_choice,'none');assert.ok(!payload.tools?.length);
    const serialized=JSON.stringify(payload);for(const privateValue of [run.id,run.actorMemberId,run.payload.context.actor.sessionId,run.payload.context.scope.controllerId])assert.equal(serialized.includes(privateValue),false);
    assert.equal((await f.call('execute',args(run))).body.status,'review_required');assert.equal(f.calls().length-before,1);
    assert.equal((await f.sql('SELECT count(*) AS n FROM send_intent'))[0].n,0);
    const publicAgent=await fetch(`${f.base()}/agents/ReplyTest/untrusted`,{method:'POST',body:'arbitrary question'});assert.ok([401,403,404].includes(publicAgent.status));
  });
  await t.test('invalid quotes and missing usage remain distinct; failures do not retry',async()=>{
    for(const mode of ['bad-quote','missing-usage','503','tool']){
      f.mode(mode);const run=await f.reserve(),before=f.calls().length;await f.call('execute',args(run));const result=await f.result(run);
      assert.equal(f.calls().length-before,1,mode);
      assert.equal(result.body.status,mode==='missing-usage'?'review_required':'unavailable',JSON.stringify(result.body));
      assert.equal((await f.call('run',args(run))).body.settlement,['bad-quote','tool'].includes(mode)?'settled':'held',mode);
      await f.call('execute',args(run));assert.equal(f.calls().length-before,1,mode);
    }f.mode('success');
  });
  await t.test('the native Agent selects the frozen prompt revision rather than silently replacing old runs',async()=>{
    for(const version of ['grounded-reply-v2','grounded-reply-v1']){
      const run=await f.reserve(version),before=f.calls().length;assert.equal(run.config.promptVersion,version);await f.call('execute',args(run));assert.equal((await f.result(run)).body.status,'review_required');assert.equal(f.calls().length-before,1);
      const system=f.calls().at(-1)!.body.messages.filter((m:any)=>m.role==='system').map((m:any)=>typeof m.content==='string'?m.content:m.content.map((p:any)=>p.text??'').join('')).join('\n');
      assert.ok(system.includes(getReplyTestInstructions(version)));if(version==='grounded-reply-v1')assert.equal(system.includes(getReplyTestInstructions('grounded-reply-v2')),false);
    }
  });
  await t.test('native provider applies only the frozen model output contract and never retries without it',async()=>{
    const {replyTestSampling}=await import('../../src/modules/reply-tests/output.ts');
    for(const version of ['nvidia-reply-test-v2','nvidia-reply-test-v1']){
      const run=await f.reserve('grounded-reply-v2',version),before=f.calls().length;assert.equal(run.config.modelConfigVersion,version);
      await f.call('execute',args(run));assert.equal((await f.result(run)).body.status,'review_required');assert.equal(f.calls().length-before,1);assert.deepEqual(f.calls().at(-1)!.body.guided_json,replyTestSampling(version).guided_json);
    }
    f.mode('503');try{const run=await f.reserve('grounded-reply-v2','nvidia-reply-test-v2'),before=f.calls().length;await f.call('execute',args(run));assert.equal((await f.result(run)).body.status,'unavailable');await f.call('execute',args(run));assert.equal(f.calls().length-before,1);assert.ok(f.calls().at(-1)!.body.guided_json);}finally{f.mode('success');}
  });
  await t.test('altered input and closed execution never reach the provider',async()=>{
    const altered=await f.reserve(),before=f.calls().length;await f.call('prepare',args(altered));await f.call('dispatch-altered',args(altered));
    for(let i=0;i<20;i++)await delay(20);assert.equal(f.calls().length,before);
    const closed=await f.reserve();await f.call('prepare',args(closed));assert.equal((await f.call('close',args(closed))).status,200);
    assert.equal((await f.call('execute',args(closed))).body.status,'unavailable');assert.equal((await f.call('run',args(closed))).body.settlement,'released');assert.equal(f.calls().length,before);
  });
  await t.test('a budget disabled after preparation blocks HTTP at dispatch time',async()=>{
    const run=await f.reserve(),before=f.calls().length;await f.call('prepare',args(run));
    await f.sql("UPDATE reply_test_budget SET enabled=0 WHERE id='budget'");
    try{
      await f.call('execute',args(run));const result=await f.result(run);assert.equal(result.body.status,'unavailable',JSON.stringify(result.body));
      assert.equal(f.calls().length,before);const saved=(await f.call('run',args(run))).body;assert.equal(saved.providerRequestClaimedAt,null);assert.equal(saved.settlement,'held');
    }finally{await f.sql("UPDATE reply_test_budget SET enabled=1 WHERE id='budget'");}
  });
  await t.test('destroyed native execution cannot recover an already spent provider permission',async()=>{
    const run=await f.reserve(),before=f.calls().length;await f.call('execute',{...args(run),loseReceipt:true});
    for(let i=0;i<100&&!(await f.call('inspect',args(run))).body.evidence?.complete;i++)await delay(50);
    assert.equal(f.calls().length-before,1);assert.equal((await f.call('destroy',args(run))).status,200);
    assert.equal((await f.call('execute',args(run))).body.status,'unconfirmed');assert.equal(f.calls().length-before,1);assert.equal((await f.call('run',args(run))).body.settlement,'held');
  });
  await t.test('lost dispatch receipts survive restart and recover the original answer without another HTTP',async()=>{
    const run=await f.reserve(),before=f.calls().length;assert.equal((await f.call('execute',{...args(run),loseReceipt:true})).body.status,'unconfirmed');
    for(let i=0;i<100&&!(await f.call('inspect',args(run))).body.evidence?.complete;i++)await delay(50);
    assert.equal(f.calls().length-before,1);assert.equal((await f.call('run',args(run))).body.receipt,null);
    await f.restart(false);const recovered=await f.call('execute',args(run));assert.equal(recovered.body.status,'review_required',JSON.stringify(recovered.body));assert.equal(f.calls().length-before,1);
  });
});
async function fixture(){
  const path=await mkdtemp(join(tmpdir(),'dingbell-answer-')),token=crypto.randomUUID();
  let mode='success',calls:{url:string;method:string;body:any}[]=[],held:ServerResponse[]=[];
  const gate=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    let raw='';for await(const chunk of request)raw+=chunk;calls.push(JSON.parse(raw));
    if(mode==='hold'){held.push(response);return;}
    if(mode==='lost'){request.socket.destroy();return;}
    if(mode==='503'){response.writeHead(503).end('synthetic');return;}
    const content=calls.at(-1)!.body.messages.find((m:any)=>m.role==='user').content;
    const input=JSON.parse(typeof content==='string'?content:content.map((part:any)=>part.text??'').join(''));
    const output=mode==='empty'?'':JSON.stringify({kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:input.untrustedKnowledge[0].chunkId,quote:mode==='bad-quote'?'fabricated':'26 см.'}]});
    const finish=mode==='length'?'length':mode==='tool'?'tool_calls':'stop';
    const records=[{id:'synthetic',object:'chat.completion.chunk',created:1,model:'nvidia/nemotron-3-super-120b-a12b',choices:[{index:0,delta:{role:'assistant',content:output,...(mode==='tool'?{tool_calls:[{index:0,id:'bad',type:'function',function:{name:'task',arguments:'{}'}}]}:{})},finish_reason:finish}]},
      ...(mode==='missing-usage'?[]:[{id:'synthetic',choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:2,cache_write_tokens:1},...(mode==='cache-alias'?{prompt_cache_hit_tokens:4}:{})}}])];
    response.writeHead(200,{'content-type':'text/event-stream'}).end(records.map(item=>`data: ${JSON.stringify(item)}\n\n`).join('')+(mode==='truncated'?'':'data: [DONE]\n\n'));
  });gate.listen(0,'127.0.0.1');await once(gate,'listening');const address=gate.address();assert.ok(address&&typeof address==='object');const gatePort=address.port;
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'));config.name='reply-test-runtime-fixture';delete config.triggers;delete config.assets;
  const configPath=join(path,'wrangler.json');await writeFile(configPath,JSON.stringify(config));
  let child:ChildProcess|undefined,base='',logs='';
  async function start(enabled=true){
    const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const portAddress=portServer.address();assert.ok(portAddress&&typeof portAddress==='object');const port=portAddress.port;await new Promise<void>(resolve=>portServer.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--config','tests/fixtures/reply-test-runtime/vite.config.ts','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',DINGBELL_REPLY_TEST_CONFIG:configPath,DINGBELL_REPLY_TEST_STATE:path,DINGBELL_REPLY_TEST_GATE:`http://127.0.0.1:${gatePort}`,DINGBELL_REPLY_TEST_TOKEN:token,DINGBELL_REPLY_TEST_ENABLED:String(enabled)}});
    child.stdout!.on('data',data=>{logs=(logs+data).slice(-16000);});child.stderr!.on('data',data=>{logs=(logs+data).slice(-16000);});
    for(let i=0;i<240;i++){try{const r=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(700)});if(r.ok&&(await r.json() as any).service==='reply-test-runtime-fixture'){assert.ok(logs.includes('REPLY_TEST_TRANSPORT_BOUND'),'provider transport must resolve to the synthetic fixture before any dispatch');assert.equal((await call('safety')).body.syntheticKey,true,'effective Worker key must be the fixed synthetic value');return;}}catch{}if(child.exitCode!==null)break;await delay(250);}
    throw new Error(`fixture startup failed: ${logs}`);
  }
  async function call(operation:string,body:unknown={}){const response=await fetch(`${base}/test/${operation}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});return {status:response.status,body:await response.json() as any};}
  async function sql(sql:string,params:unknown[]=[]){const result=await call('sql',{sql,params});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.results;}
  async function close(){for(const res of held)res.destroy();held=[];if(child)await stop(child);await new Promise<void>(resolve=>gate.close(()=>resolve()));await rm(path,{recursive:true,force:true});}
  try{
    await start();
    for(const name of (await readdir(join(root,'migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      const batch=(await readFile(join(root,'migrations',name),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
      const result=await call('sql',{batch});assert.equal(result.status,200,JSON.stringify(result.body));
    }
    await sql("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)");
    await sql("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1)");
    await sql("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1)");
    await sql("INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES ('owner-session','owner','owner-token',?,1)",[Date.now()+3600_000]);
    await sql("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)");
    const setup=await call('setup');assert.equal(setup.status,200,JSON.stringify(setup.body));
    return {call,sql,calls:()=>calls,mode:(next:string)=>{mode=next;},base:()=>base,logs:()=>logs,async restart(enabled=true){if(child)await stop(child);child=undefined;await start(enabled);},close,
      async reserve(promptVersion?:string,modelConfigVersion?:string){const result=await call('reserve',{promptVersion,modelConfigVersion});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'reserved');return result.body.run as ReplyTestRun;},
      async result(run:ReplyTestRun){for(let i=0;i<60;i++){const result=await call('read',{requestId:run.requestId});if(result.body.status!=='pending')return result;await delay(100);}throw new Error(`result timeout ${logs}`);},
    };
  }catch(error){await close();throw error;}
}
