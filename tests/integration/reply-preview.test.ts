import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { createServer,type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath,URL } from 'node:url';
import { test } from 'node:test';
import type { TranslationRun } from '../../src/modules/translations/types.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function stop(child:ChildProcess){
  if(child.pid===undefined)return;
  const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child.pid!,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const done=child.exitCode===null&&child.signalCode===null?once(child,'exit'):Promise.resolve();kill('SIGTERM');
  const timer=setTimeout(()=>kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(timer);kill('SIGKILL');}
}
async function fixture(){
  const path=await mkdtemp(join(tmpdir(),'dingbell-preview-')),token=crypto.randomUUID();
  let mode='success',calls:{url:string;method:string;body:any}[]=[],held:ServerResponse[]=[];
  const gate=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    let raw='';for await(const chunk of request)raw+=chunk;calls.push(JSON.parse(raw));
    if(mode==='hold'){held.push(response);return;}
    if(mode==='lost'){request.socket.destroy();return;}
    if(mode==='503'){response.writeHead(503).end('synthetic');return;}
    const output=mode==='empty'?'':mode==='long'?'я'.repeat(1001):'Здравствуйте! Подтвердите заказ.';
    const finish=mode==='length'?'length':mode==='tool'?'tool_calls':'stop';
    const records=[{id:'synthetic',object:'chat.completion.chunk',created:1,model:'nvidia/nemotron-3-super-120b-a12b',choices:[{index:0,delta:{role:'assistant',content:output,...(mode==='tool'?{tool_calls:[{index:0,id:'bad',type:'function',function:{name:'task',arguments:'{}'}}]}:{})},finish_reason:finish}]},
      ...(mode==='missing-usage'?[]:[{id:'synthetic',choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:2,cache_write_tokens:1},...(mode==='cache-alias'?{prompt_cache_hit_tokens:4}:{})}}])];
    response.writeHead(200,{'content-type':'text/event-stream'}).end(records.map(item=>`data: ${JSON.stringify(item)}\n\n`).join('')+(mode==='truncated'?'':'data: [DONE]\n\n'));
  });gate.listen(0,'127.0.0.1');await once(gate,'listening');const address=gate.address();assert.ok(address&&typeof address==='object');const gatePort=address.port;
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'));config.name='preview-fixture';delete config.triggers;delete config.assets;
  const configPath=join(path,'wrangler.json');await writeFile(configPath,JSON.stringify(config));
  let child:ChildProcess|undefined,base='',logs='';
  async function start(enabled=true){
    const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const portAddress=portServer.address();assert.ok(portAddress&&typeof portAddress==='object');const port=portAddress.port;await new Promise<void>(resolve=>portServer.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--config','tests/fixtures/reply-preview/vite.config.ts','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',DINGBELL_PREVIEW_CONFIG:configPath,DINGBELL_PREVIEW_STATE:path,DINGBELL_PREVIEW_GATE:`http://127.0.0.1:${gatePort}`,DINGBELL_PREVIEW_TOKEN:token,DINGBELL_PREVIEW_ENABLED:String(enabled)}});
    child.stdout!.on('data',data=>{logs=(logs+data).slice(-16000);});child.stderr!.on('data',data=>{logs=(logs+data).slice(-16000);});
    for(let i=0;i<240;i++){try{const r=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(700)});if(r.ok&&(await r.json() as any).service==='preview-fixture'){assert.ok(logs.includes('PREVIEW_TEST_TRANSPORT_BOUND'),'provider transport must resolve to the synthetic fixture before any dispatch');assert.equal((await call('safety')).body.syntheticKey,true,'effective Worker key must be the fixed synthetic value');return;}}catch{}if(child.exitCode!==null)break;await delay(250);}
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
    await sql("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1),('staff','Staff','staff@example.invalid',1)");
    await sql("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1)");
    await sql("INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES ('owner-session','owner','owner-token',?,1),('staff-session','staff','staff-token',?,1)",[Date.now()+3600_000,Date.now()+3600_000]);
    await sql("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)");
    await sql("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)");
    await sql("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','chat','BUYER_SELLER','Opened',1,1)");
    assert.equal((await call('fund')).status,200);
    return {call,sql,calls:()=>calls,mode:(next:string)=>{mode=next;},base:()=>base,logs:()=>logs,async restart(enabled=true){if(child)await stop(child);child=undefined;await start(enabled);},close,
      async reserve(config?:TranslationRun['config']){const result=await call('reserve',{requestId:crypto.randomUUID(),...(config?{config}:{})});assert.equal(result.status,200);assert.equal(result.body.outcome,'reserved');return result.body.run as TranslationRun;},
      async result(run:TranslationRun){for(let i=0;i<30;i++){const result=await call('read',{requestId:run.requestId,runId:run.id});if(result.body.status!=='pending')return result;await delay(100);}throw new Error(`result timeout ${logs}`);},
    };
  }catch(error){await close();throw error;}
}
test('native Flue translation uses a prepared budget run and never exposes public agent routes',{timeout:180_000},async t=>{
  const f=await fixture();t.after(async()=>{try{await mkdir(join(root,'test-results/portable-validation'),{recursive:true});await writeFile(join(root,'test-results/portable-validation/legacy-translation-server.log'),f.logs());}finally{await f.close();}});
  const args=(run:TranslationRun)=>({runId:run.id,requestId:run.requestId});
  await t.test('prepared immutable scope uses the actual generated extension',async()=>{
    const run=await f.reserve();const result=await f.call('prepare',args(run));assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal((await f.call('inspect',args(run))).body.run.id,run.id);
    assert.equal((await f.call('prepare',{...args(run),wrongId:crypto.randomUUID()})).status,500);
  });
  await t.test('one model request yields Russian text with reported usage and a reusable native receipt',async()=>{
    const run=await f.reserve();assert.equal((await f.call('prepare',args(run))).status,200);const before=f.calls().length;
    const receipts=await Promise.all([f.call('dispatch',args(run)),f.call('dispatch',args(run))]);assert.equal(receipts[0]!.status,200,JSON.stringify(receipts[0]!.body));assert.equal(receipts[0]!.body.submissionId,receipts[1]!.body.submissionId);
    const result=await f.result(run);assert.equal(result.body.status,'completed',JSON.stringify(result.body));assert.equal(result.body.reply.text,'Здравствуйте! Подтвердите заказ.');assert.equal(result.body.reply.metadata.preview.usageReported,true);
    assert.equal(f.calls().length-before,1);assert.equal(f.calls().at(-1)!.url,'https://integrate.api.nvidia.com/v1/chat/completions');const payload=f.calls().at(-1)!.body;
    assert.equal(payload.tool_choice,'none');assert.equal(payload.max_tokens??payload.max_completion_tokens,512);assert.ok(!payload.tools?.length);
    assert.equal((await f.call('settle',args(run))).status,200);assert.equal((await f.call('run',args(run))).body.settlement,'settled');
  });
  await t.test('unprepared and altered dispatch input never reach the provider',async()=>{
    for(const prepared of [false,true]){const run=await f.reserve(),before=f.calls().length;if(prepared)await f.call('prepare',args(run));await f.call('dispatch',{...args(run),...(prepared?{changedSource:'different'}:{})});assert.equal((await f.result(run)).body.status,'failed');assert.equal(f.calls().length,before);}
  });
  await t.test('model failures and invalid output have no automatic second HTTP',async()=>{
    for(const mode of ['503','lost','length','tool','empty','long','truncated']){
      f.mode(mode);const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;await f.call('dispatch',args(run));const result=await f.result(run);assert.equal(f.calls().length-before,1,mode);
      if(['length','empty','long'].includes(mode)){
        assert.equal(result.body.status,'completed',mode);assert.equal(result.body.reply.metadata.preview.outputValid,false,mode);assert.equal(result.body.reply.metadata.preview.usageReported,true,mode);
        assert.equal((await f.call('settle',args(run))).status,200,mode);assert.equal((await f.call('run',args(run))).body.settlement,'settled',mode);
      }else if(mode==='truncated'){
        if(result.body.status==='completed'){assert.equal(result.body.reply.metadata.preview.outputValid,false);assert.equal(result.body.reply.metadata.preview.usageReported,false);}else assert.equal(result.body.status,'failed');
        assert.equal((await f.call('settle',args(run))).status,409);assert.equal((await f.call('run',args(run))).body.settlement,'held');assert.equal((await f.call('inspect',args(run))).body.evidence.complete,false);
      }else{
        assert.equal(result.body.status,'failed',mode);assert.equal((await f.call('settle',args(run))).status,409,mode);assert.equal((await f.call('run',args(run))).body.settlement,'held',mode);
        const evidence=(await f.call('inspect',args(run))).body.evidence;
        if(mode==='tool'){assert.equal(evidence.tools,true);assert.equal(evidence.usageReported,true);}else assert.equal(evidence,null);
      }
      await f.call('dispatch',args(run));assert.equal(f.calls().length-before,1,mode);
    }
    f.mode('success');
  });
  await t.test('missing reported usage remains held even when the SDK returns successful text',async()=>{
    for(const mode of ['missing-usage','cache-alias']){f.mode(mode);const run=await f.reserve();await f.call('prepare',args(run));await f.call('dispatch',args(run));const result=await f.result(run);assert.equal(result.body.status,'completed');assert.equal(result.body.reply.metadata.preview.usageReported,false);assert.equal((await f.call('settle',args(run))).status,409);assert.equal((await f.call('run',args(run))).body.settlement,'held');}f.mode('success');
  });
  await t.test('closing a genuinely unstarted ledger atomically releases and prevents later dispatch',async()=>{
    const run=await f.reserve();await f.call('prepare',args(run));assert.equal((await f.call('close',args(run))).status,200);assert.equal((await f.call('run',args(run))).body.settlement,'released');const before=f.calls().length;await f.call('dispatch',args(run));await f.result(run);assert.equal(f.calls().length,before);
  });
  await t.test('lost dispatch receipt and a process restart reuse the same durable execution',async()=>{
    const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;await f.call('dispatch',{...args(run),skipBind:true});for(let i=0;i<50&&f.calls().length===before;i++)await delay(50);assert.equal(f.calls().length-before,1);
    for(let i=0;i<50&&!(await f.call('inspect',args(run))).body.evidence?.complete;i++)await delay(50);
    await f.restart();await f.call('dispatch',args(run));const result=await f.result(run);assert.equal(result.body.status,'completed',JSON.stringify(result.body));assert.equal(f.calls().length-before,1);
  });
  await t.test('frozen output token budget is respected and undersized input envelope is refused',async()=>{
    const seed=await f.reserve(),run=await f.reserve({...seed.config,maxOutputTokens:10});await f.call('prepare',args(run));await f.call('dispatch',args(run));assert.equal((await f.result(run)).body.status,'completed');
    const payload=f.calls().at(-1)!.body;assert.equal(payload.max_tokens??payload.max_completion_tokens,10);
    const undersized=await f.reserve({...seed.config,maxInputTokens:1000}),before=f.calls().length;
    assert.equal((await f.call('prepare',args(undersized))).status,500);assert.equal(f.calls().length,before);
  });
  await t.test('revoked store permission and disabled budget are rechecked immediately before HTTP',async()=>{
    for(const revoke of ['permission','budget']){
      const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;
      await f.sql(revoke==='permission'?"DELETE FROM store_grant WHERE member_id='staff-member'":"UPDATE translation_budget_bucket SET enabled=0 WHERE id='budget'");
      try{
        assert.equal((await f.call('native-dispatch',{runId:run.id,source:run.source})).status,200);
        for(let i=0;i<50&&!(await f.call('native-inspect',{runId:run.id})).body?.http;i++)await delay(50);
        assert.equal((await f.call('native-inspect',{runId:run.id})).body.http,1);
        assert.equal(f.calls().length,before);assert.equal((await f.sql('SELECT provider_request_claimed_at FROM reply_preview_run WHERE id=?',[run.id]))[0].provider_request_claimed_at,null);
      }finally{await f.sql(revoke==='permission'?"INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)":"UPDATE translation_budget_bucket SET enabled=1 WHERE id='budget'");}
    }
  });
  await t.test('destroyed native authority cannot acquire another HTTP even before receipt binding',async()=>{
    const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;await f.call('dispatch',{...args(run),skipBind:true});
    for(let i=0;i<50&&!(await f.call('inspect',args(run))).body.evidence?.complete;i++)await delay(50);
    assert.equal(f.calls().length-before,1);assert.equal((await f.call('run',args(run))).body.receipt,null);
    assert.equal((await f.call('destroy',args(run))).status,200);assert.equal((await f.call('inspect',args(run))).body,null);
    const refused=await f.call('prepare',args(run));assert.equal(refused.status,500);assert.equal(refused.body.error,'PREVIEW_AUTHORITY_MISSING');
    await f.call('dispatch',args(run));assert.equal((await f.result(run)).body.status,'failed');assert.equal(f.calls().length-before,1);
  });
  await t.test('restart during a provider request retains the claimed permit without another HTTP',async()=>{
    f.mode('hold');const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;await f.call('dispatch',args(run));
    for(let i=0;i<50&&f.calls().length===before;i++)await delay(50);assert.equal(f.calls().length-before,1);
    assert.equal((await f.call('close',args(run))).status,500);await f.restart();f.mode('success');await f.call('dispatch',args(run));
    assert.equal((await f.result(run)).body.status,'failed');assert.equal((await f.call('run',args(run))).body.settlement,'held');assert.equal(f.calls().length-before,1);
  });
  await t.test('disabled execution cannot prepare or dispatch previously prepared work',async()=>{
    const run=await f.reserve();await f.call('prepare',args(run));const before=f.calls().length;await f.restart(false);
    try{assert.equal((await f.call('prepare',args(run))).status,500);await f.call('dispatch',args(run));assert.equal((await f.result(run)).body.status,'failed');assert.equal(f.calls().length,before);}finally{await f.restart();}
  });
  await t.test('the raw prompt, history, abort and attachment routes remain inaccessible',async()=>{
    const before=f.calls().length;
    for(const [method,path]of [['POST','/agents/ReplyPreview/raw'],['GET','/agents/ReplyPreview/raw'],['POST','/agents/ReplyPreview/raw/abort'],['GET','/agents/ReplyPreview/raw/attachments/x']]){const response=await fetch(f.base()+path,{method});assert.equal(response.status,404);assert.equal((await response.json()as any).error.code,'NOT_FOUND');}
    assert.equal(f.calls().length,before);
  });
  const previewInput=()=>({requestId:crypto.randomUUID(),source:'请确认您的订单。',sourceRevision:3});
  async function previewResult(body:ReturnType<typeof previewInput>){
    for(let i=0;i<30;i++){const value=await f.call('service/read',body);assert.equal(value.status,200,JSON.stringify(value.body));if(value.body.preview?.status!=='pending')return value.body;await delay(100);}
    throw new Error('preview result did not settle');
  }
  await t.test('business service invokes the real uid-null native path and GET creates no control directory or model work',async()=>{
    const before=f.calls().length,directories=(await f.sql('SELECT COUNT(*) AS n FROM conversation_control'))[0].n;
    assert.deepEqual((await f.call('service/read',previewInput())).body,{outcome:'not_found'});assert.equal(f.calls().length,before);
    const body=previewInput(),submitted=await f.call('service/submit',body);assert.equal(submitted.status,200,JSON.stringify(submitted.body));assert.equal(submitted.body.outcome,'found');
    const result=await previewResult(body);assert.equal(result.preview.status,'ready',JSON.stringify(result));assert.equal(result.preview.usageStatus,'settled');assert.equal(result.preview.translation,'Здравствуйте! Подтвердите заказ.');
    const outputQuery='SELECT output.*,run.source,run.source_revision,run.receipt AS run_receipt FROM reply_preview_output AS output JOIN reply_preview_run AS run ON run.id=output.run_id WHERE run.request_id=?';
    const frozen=await f.sql(outputQuery,[body.requestId]);assert.equal(frozen.length,1);assert.equal(frozen[0].body,result.preview.translation);assert.equal(frozen[0].source,body.source);assert.equal(frozen[0].source_revision,body.sourceRevision);assert.equal(frozen[0].receipt,frozen[0].run_receipt);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.preview.translation)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');assert.equal(frozen[0].body_hash,hash);
    assert.equal(f.calls().length-before,1);assert.deepEqual((await f.call('service/submit',body)).body,result);assert.equal(f.calls().length-before,1);
    assert.deepEqual(await f.sql(outputQuery,[body.requestId]),frozen);
    assert.equal((await f.sql('SELECT COUNT(*) AS n FROM conversation_control'))[0].n,directories);
    assert.deepEqual(Object.keys(result.preview).sort(),['requestId','source','sourceRevision','targetLanguage','status','translation','reason','usageStatus'].sort());
  });
  await t.test('business POST recovers a lost native receipt with its unchanged creating payload after configuration closes',async()=>{
    const body=previewInput(),before=f.calls().length,lost=await f.call('service/submit',{...body,loseReceipt:true});assert.equal(lost.body.preview.status,'unconfirmed');
    for(let i=0;i<50&&f.calls().length===before;i++)await delay(50);assert.equal(f.calls().length-before,1);
    assert.equal((await f.call('service/read',body)).body.preview.status,'unconfirmed');assert.equal(f.calls().length-before,1);
    await f.sql("UPDATE translation_budget_bucket SET enabled=0 WHERE id='budget'");
    try{
      const recovered=await f.call('service/submit',{...body,closedConfig:true});assert.equal(recovered.status,200);assert.notEqual(recovered.body.preview?.status,'unconfirmed',JSON.stringify(recovered.body));
      const result=await previewResult(body);assert.equal(result.preview.status,'ready',JSON.stringify(result));assert.equal(result.preview.usageStatus,'settled');assert.equal(f.calls().length-before,1);
    }finally{await f.sql("UPDATE translation_budget_bucket SET enabled=1 WHERE id='budget'");}
  });
  await t.test('business recovery refuses a lost incarnation after a provider claim instead of creating another execution',async()=>{
    const body=previewInput(),before=f.calls().length;await f.call('service/submit',{...body,loseReceipt:true});
    for(let i=0;i<50&&f.calls().length===before;i++)await delay(50);assert.equal(f.calls().length-before,1);
    const row=(await f.sql('SELECT id FROM reply_preview_run WHERE request_id=?',[body.requestId]))[0];assert.ok(row);
    assert.equal((await f.call('destroy',{runId:row.id,requestId:body.requestId})).status,200);
    const value=await f.call('service/submit',body);assert.equal(value.body.preview.status,'unconfirmed');assert.equal(value.body.preview.reason,'AUTHORITY_UNAVAILABLE');assert.equal(f.calls().length-before,1);
  });
  await t.test('business result reads are bounded while an admitted model request is still running',async()=>{
    f.mode('hold');const body=previewInput(),before=f.calls().length;
    try{
      const submitted=await f.call('service/submit',body);assert.equal(submitted.body.preview.status,'pending',JSON.stringify(submitted.body));assert.equal(f.calls().length-before,1);
      const read=await f.call('service/read',body);assert.equal(read.body.preview.status,'pending');assert.equal(read.body.preview.usageStatus,'held');assert.equal(f.calls().length-before,1);
    }finally{f.mode('success');}
  });
});
