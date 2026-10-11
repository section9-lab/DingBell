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
import type {AiExecution} from '../../src/modules/ai-runs/storage.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('native support reply closes and settles through a durable wake before the shared sender delivers once',{timeout:120000},async t=>{
 const f=await fixture({outboundEnabled:'true',aiOutboundEnabled:'true'});t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-reply-server.txt'),f.logs());await f.close();});
 const source=await f.call('knowledge-source');assert.equal(source.status,200,JSON.stringify(source.body));assert.equal((await f.call('reply-store')).status,200);f.mode('reply');
 const run=await f.reserve({reply:true,model:{promptVersion:'support-reply-v1'}}),args={scope:run.payload.run.scope,runId:run.id},intentId='ai-reply:'+run.id;
 const dispatched=await f.call('execute',args);assert.equal(dispatched.status,200,JSON.stringify(dispatched.body));assert.ok(['pending','completed'].includes(dispatched.body.status),JSON.stringify(dispatched.body));
 // Only inspect the projection here: no read/result/cron call may manufacture runtime closure or enqueue.
 let sent=false;for(let i=0;i<150;i++){if((await f.sql('SELECT state FROM send_intent WHERE id=?',[intentId]))[0]?.state==='sent'){sent=true;break;}await delay(100);}
 assert.ok(sent,'the persisted controller wake must observe completion and dispatch without a minute cron or caller polling runtime state');
 assert.equal(f.calls().length,2);assert.deepEqual(f.calls()[0].body.tools.map((tool:any)=>tool.function.name),['request_handoff','search_knowledge','prepare_reply']);
 assert.equal(f.calls()[0].body.parallel_tool_calls,false);assert.match(JSON.stringify(f.calls()[1].body.messages),/Ширина — 26 см/);
 assert.deepEqual(f.ozonCalls(),[{url:'https://api-seller.ozon.ru/v1/chat/send/message',method:'POST',body:{chat_id:args.scope.conversationId,text:'Ширина этой модели — 26 см.'}}]);
 const saved=(await f.sql('SELECT * FROM ai_execution WHERE id=?',[run.id]))[0],closure=JSON.parse(saved.closure);
 assert.equal(closure.kind,'runtime_closed');assert.equal(closure.outcome,'completed');assert.equal(closure.providerPermits,2);assert.ok(saved.receipt);
 const generations=await f.sql('SELECT usage,charged_micros FROM ai_generation WHERE run_id=? ORDER BY sequence',[run.id]);assert.equal(generations.length,2);assert.ok(generations.every((g:any)=>g.usage!==null&&g.charged_micros!==null));
 const prepared=(await f.sql('SELECT * FROM ai_reply_intent WHERE run_id=?',[run.id]))[0];assert.equal(prepared.id,intentId);assert.equal(prepared.body,'Ширина этой модели — 26 см.');assert.deepEqual(JSON.parse(prepared.citations),[source.body.chunkId]);
 assert.equal(JSON.parse(prepared.knowledge_evidence).chunks[0].documentId,source.body.id);
 const audit=(await f.sql("SELECT actor_user_id,actor_member_id,receipt FROM conversation_control_event WHERE conversation_id=? AND action='ai_send_reply'",[args.scope.conversationId]))[0];
 assert.ok(audit);assert.equal(audit.actor_user_id,null);assert.equal(audit.actor_member_id,null);assert.equal(JSON.parse(audit.receipt).runId,run.id);
 assert.equal((await f.sql("SELECT count(*) n FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'",[args.scope.conversationId]))[0].n,0);
 assert.equal((await f.sql('SELECT count(*) n FROM send_attempt WHERE intent_id=?',[intentId]))[0].n,1);
 assert.equal((await f.call('reply-read',{...args,intentId})).body.reply.status,'sent');
 await f.restart();assert.equal((await f.call('execute',args)).body.status,'completed');assert.equal((await f.call('reply-enqueue',args)).body.outcome,'accepted');
 assert.equal((await f.call('reply-read',{...args,intentId})).body.reply.status,'sent');await delay(1200);
 assert.equal(f.calls().length,2);assert.equal(f.ozonCalls().length,1);assert.equal((await f.sql('SELECT count(*) n FROM send_attempt WHERE intent_id=?',[intentId]))[0].n,1);
});
test('a recovered native dispatch cannot stop a delivered AI reply after timeout or any switch is disabled',{timeout:120000},async t=>{
 const f=await fixture({outboundEnabled:'true',aiOutboundEnabled:'true'});t.after(f.close);
 assert.equal((await f.call('knowledge-source')).status,200);assert.equal((await f.call('reply-store')).status,200);f.mode('reply');
 const input=(await f.call('intake',{queued:true})).body;let prepared=false;
 for(let i=0;i<25;i++){await f.call('cron',{reply:true});if((await f.sql('SELECT count(*) n FROM ai_reply_intent'))[0].n===1){prepared=true;break;}await delay(100);}
 assert.ok(prepared,'the persisted input dispatcher must reach the original reply tool');
 let sent=false;for(let i=0;i<150;i++){if((await f.sql("SELECT count(*) n FROM send_intent WHERE state='sent'"))[0].n===1){sent=true;break;}await delay(100);}
 assert.ok(sent,'the durable reply wake must finish the original delivery');
 const control=()=>f.sql('SELECT lifecycle,reception,assigned_member_id,work_status,version,control_epoch,sequence,updated_at FROM conversation_control WHERE conversation_id=?',[input.scope.conversationId]);
 const before=await control(),queue=(await f.sql('SELECT event_id,run_id,input_sequence FROM ai_dispatch'))[0];assert.ok(queue);
 assert.equal(before[0].reception,'ai');assert.equal(f.calls().length,3);assert.equal(f.ozonCalls().length,1);
 for(const flag of ['timeout','AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED']){
  if(flag!=='timeout')await f.restart(flag!=='AI_RECEPTION_ENABLED',{aiOutboundEnabled:flag==='AI_OUTBOUND_ENABLED'?'false':'true',outboundEnabled:flag==='OUTBOUND_ENABLED'?'false':'true'});
  // Restore only the original queue row, as when its completion acknowledgement was lost.
  await f.sql('UPDATE ai_dispatch SET due_at=0,created_at=?',[Date.now()-(flag==='timeout'?300001:0)]);
  await f.call('cron',{reply:true});assert.deepEqual(await control(),before,flag);
  assert.equal((await f.sql('SELECT due_at FROM ai_dispatch'))[0].due_at,null,flag);
  assert.deepEqual((await f.sql('SELECT event_id,run_id,input_sequence FROM ai_dispatch'))[0],queue);
  assert.equal((await f.sql("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'"))[0].n,0,flag);
  assert.equal(f.calls().length,3,flag);assert.equal(f.ozonCalls().length,1,flag);
 }
});
test('native automatic reply does not request the model or Ozon after any deployment switch is disabled',{timeout:240000},async()=>{
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED']){
  const f=await fixture({outboundEnabled:'true',aiOutboundEnabled:'true'});try{
   assert.equal((await f.call('reply-store')).status,200);f.mode('reply');const run=await f.reserve({reply:true,model:{promptVersion:'support-reply-v1'}});
   await f.restart(flag!=='AI_RECEPTION_ENABLED',flag==='AI_OUTBOUND_ENABLED'?{aiOutboundEnabled:'false'}:flag==='OUTBOUND_ENABLED'?{outboundEnabled:'false'}:{});
   const result=await f.call('execute',{scope:run.payload.run.scope,runId:run.id});assert.equal(result.status,200,JSON.stringify(result.body));assert.notEqual(result.body.status,'pending');
   await delay(1200);assert.equal(f.calls().length,0,flag);assert.equal(f.ozonCalls().length,0,flag);
   assert.equal((await f.sql('SELECT count(*) n FROM ai_reply_intent'))[0].n,0);assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);
  }finally{await f.close();}
 }
});
test('native automatic support saves a cited draft and commits human review without any customer send',{timeout:120000},async t=>{
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-answer-server.txt'),f.logs());await f.close();});
 const source=await f.call('knowledge-source');assert.equal(source.status,200);f.mode('answer');const input=(await f.call('intake',{queued:true})).body;let finished=false;
 for(let i=0;i<25;i++){await f.call('cron',{answer:true});if((await f.sql('SELECT count(*) n FROM ai_answer'))[0].n===1&&(await f.sql("SELECT count(*) n FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'",[input.scope.conversationId]))[0].n===1){finished=true;break;}await delay(100);}
 assert.ok(finished,'automatic dispatch must create a cited draft and a human-review receipt');assert.equal(f.calls().length,3);
 assert.deepEqual(f.calls()[1].body.tools.map((t:any)=>t.function.name),['request_handoff','search_knowledge','submit_answer']);
 const draft=(await f.sql('SELECT * FROM ai_answer'))[0];assert.equal(draft.body,'Ширина этой модели — 26 см.');assert.deepEqual(JSON.parse(draft.citations),[source.body.chunkId]);assert.equal(JSON.parse(draft.knowledge_evidence).chunks[0].documentId,source.body.id);
 const event=(await f.sql("SELECT receipt FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'",[input.scope.conversationId]))[0];assert.match(event.receipt,/draft.*human review/i);
 assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);assert.equal((await f.sql("SELECT count(*) n FROM synthetic_knowledge_calls WHERE kind='embedding'"))[0].n,1);
 await f.restart();await f.call('cron',{answer:true});await f.call('execute',{scope:input.scope,runId:draft.run_id});assert.equal(f.calls().length,3);assert.equal((await f.sql('SELECT count(*) n FROM ai_answer'))[0].n,1);
});
test('native automatic dispatch classifies a live input and retrieves published knowledge once before its answer generation',{timeout:120000},async t=>{
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-knowledge-server.txt'),f.logs());await f.close();});
 const source=await f.call('knowledge-source');assert.equal(source.status,200,JSON.stringify(source.body));f.mode('knowledge');
 const input=(await f.call('intake',{queued:true})).body;let finished=false;
 for(let i=0;i<25;i++){await f.call('cron',{knowledge:true});if((await f.sql("SELECT count(*) n FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'",[input.scope.conversationId]))[0].n===1){finished=true;break;}await delay(100);}
 assert.ok(finished,f.logs());assert.equal(f.calls().length,3);assert.deepEqual(f.calls()[0].body.tools.map((t:any)=>t.function.name),['submit_classification']);
 assert.deepEqual(f.calls()[1].body.tools.map((t:any)=>t.function.name),['request_handoff','search_knowledge']);assert.equal(f.calls()[1].body.parallel_tool_calls,false);
 assert.match(JSON.stringify(f.calls()[2].body.messages),/Ширина — 26 см/);
 assert.equal((await f.sql("SELECT count(*) n FROM synthetic_knowledge_calls WHERE kind='embedding'"))[0].n,1);
 const query=(await f.sql('SELECT * FROM ai_knowledge_query'))[0];assert.equal(JSON.parse(query.evidence).chunks[0].documentId,source.body.id);assert.equal(query.reserved_micros,60);
 for(const privateValue of [query.run_id,input.scope.controllerId])assert.equal(JSON.stringify(f.calls()[2].body.messages).includes(privateValue),false);
 const budget=(await f.sql('SELECT reserved_micros FROM ai_budget'))[0];assert.equal(budget.reserved_micros,60,'unknown embedding token usage retains its conservative allowance after chat generations settle');
 assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);
 await f.restart();await f.call('cron',{knowledge:true});await f.call('execute',{scope:input.scope,runId:query.run_id});assert.equal(f.calls().length,3);assert.equal((await f.sql("SELECT count(*) n FROM synthetic_knowledge_calls WHERE kind='embedding'"))[0].n,1);
});
async function stop(child:ChildProcess){
  if(child.pid===undefined)return;
  const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child.pid!,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const done=child.exitCode===null&&child.signalCode===null?once(child,'exit'):Promise.resolve();kill('SIGTERM');
  const timer=setTimeout(()=>kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(timer);kill('SIGKILL');}
}
test('native automatic dispatch consumes a live input, classifies it and starts the original answer without manual admission',{timeout:120000},async t=>{
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-dispatch-server.txt'),f.logs());await f.close();});
 const input=(await f.call('intake',{queued:true})).body;await f.call('cron');for(let i=0;i<20&&!f.calls().length;i++)await delay(100);assert.ok(f.calls().length>=1&&f.calls().length<=2,'scheduled input delivery must start classification');
 let complete=false;for(let i=0;i<20;i++){
  await f.call('cron');const rows=await f.sql("SELECT count(*) n FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'",[input.scope.conversationId]);
  if(rows[0].n===1){complete=true;break;}await delay(100);
 }
 assert.ok(complete,f.logs());await f.call('cron');assert.equal(f.calls().length,2);assert.deepEqual(f.calls().map(c=>c.body.tools.map((t:any)=>t.function.name)),[['submit_classification'],['request_handoff']]);
 assert.equal((await f.sql('SELECT admitted_runs FROM ai_budget'))[0].admitted_runs,2);assert.equal((await f.sql('SELECT due_at FROM ai_dispatch'))[0].due_at,null);
 assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);assert.equal((await f.sql("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'"))[0].n,0);
 await f.restart();await f.call('cron');assert.equal(f.calls().length,2);
});
test('native classification persists the routing decision and closes before a separate answer target starts',{timeout:120000},async t=>{
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-classification-server.txt'),f.logs());await f.close();});
 const input=(await f.call('intake')).body,executed=await f.call('execute',input);assert.equal(executed.status,200,JSON.stringify(executed.body));assert.ok(['pending','completed'].includes(executed.body.status),JSON.stringify(executed.body));
 const run=(await f.call('run',input)).body as AiExecution;assert.equal(run.config.maxGenerations,1);assert.equal(run.config.model.promptVersion,'intake-v1');assert.equal(run.payload.run.schemaVersion,2);
 assert.deepEqual(run.modelInput,{task:'classify',untrustedCustomerQuestion:'Какая ширина?'});assert.equal((await f.result(run)).body.status,'completed');
 const classified=(await f.call('classified',input)).body;assert.equal(classified.request.stage,'presale');assert.equal(classified.request.language,'ru');assert.equal(classified.intakeRunId,input.runId);
 assert.equal(f.calls().length,1);const payload=f.calls()[0].body;assert.deepEqual(payload.tools.map((t:any)=>t.function.name),['submit_classification']);assert.equal(payload.parallel_tool_calls,false);
 assert.ok(payload.messages.some((m:any)=>m.role==='system'&&JSON.stringify(m.content).includes('unknown')));assert.ok(!JSON.stringify(payload).includes('untrustedMerchantInstructions'));
 const closed=(await f.call('run',input)).body;assert.ok(closed.closure);assert.equal(closed.generations.length,1);assert.equal((await f.call('execute',input)).body.status,'completed');assert.equal(f.calls().length,1);
 await f.restart();assert.deepEqual((await f.call('classified',input)).body,classified);assert.equal((await f.call('execute',input)).body.status,'completed');assert.equal(f.calls().length,1);
 const next=(await f.call('advance',input)).body;assert.equal(next.result.outcome,'accepted');assert.notEqual(next.runId,input.runId);assert.equal((await f.call('execute',next)).status,200);
 const answer=(await f.call('run',next)).body as AiExecution;assert.equal(answer.config.model.promptVersion,'support-v1');assert.equal(answer.config.maxGenerations,3);assert.notEqual(answer.instanceId,run.instanceId);assert.equal((await f.result(answer)).body.status,'completed');assert.equal(f.calls().length,2);
 assert.deepEqual(f.calls()[1].body.tools.map((t:any)=>t.function.name),['request_handoff']);assert.equal((await f.sql('SELECT admitted_runs FROM ai_budget'))[0].admitted_runs,2);
 assert.deepEqual((await f.sql('SELECT action FROM conversation_control_event ORDER BY sequence')).map((r:any)=>r.action),['ai_intake_start','ai_classification','ai_start','request_handoff']);
});
test('native classification sends unknown input to humans and rejects forged tool arguments within one generation',{timeout:120000},async t=>{
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-classification-boundaries-server.txt'),f.logs());await f.close();});
 for(const mode of ['unknown-classification','invalid-input']){
  f.mode(mode);const input=(await f.call('intake')).body,before=f.calls().length;await f.call('execute',input);const run=(await f.call('run',input)).body as AiExecution;
  const result=await f.result(run);assert.equal(result.body.status,mode==='invalid-input'?'failed':'completed');assert.equal(f.calls().length-before,1);assert.equal((await f.call('classified',input)).body,null);
  const saved=(await f.call('run',input)).body;assert.equal(saved.generations.length,1);assert.ok(saved.closure);assert.equal(saved.status,'settled');await f.call('execute',input);assert.equal(f.calls().length-before,1);
  if(mode==='unknown-classification'){assert.equal((await f.call('control',input)).body.view.state.reception,'paused');const rows=await f.sql("SELECT receipt FROM conversation_control_event WHERE conversation_id=? AND action='ai_classification'",[input.scope.conversationId]);assert.equal(JSON.parse(rows[0].receipt).decision.reason,'unclassified');}
 }
 assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);
});
test('native Support uses the production budget, controlled tool and original Flue receipts',{timeout:240000},async t=>{
 const module=await import('../../src/modules/ai-runs/execution.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof module?.executeAiRun,'function','Support must execute the frozen production plan through native Flue');
 assert.equal(typeof module?.reconcileConversationAi,'function','controller repair must stop invalid runs without dispatching new model work');
 const f=await fixture();t.after(async()=>{if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,'native-support-server.txt'),f.logs());await f.close();});
 const args=(run:AiExecution)=>({scope:run.payload.run.scope,runId:run.id});
 await t.test('an admitted input selects server configuration and budget before native dispatch, and replay keeps the original plan',async()=>{
  const before=f.calls().length,input=(await f.call('reserve',{unreserved:true})).body;
  const executed=await f.call('execute',input);assert.equal(executed.status,200);assert.ok(['pending','completed'].includes(executed.body.status));
  const run=(await f.call('run',input)).body as AiExecution;assert.equal(run.id,input.runId);assert.equal(run.config.maxGenerations,3);assert.equal(run.config.model.modelConfigVersion,'support-v1');assert.equal(run.reservedMicros,run.perGenerationMicros*3);
  assert.equal((await f.result(run)).body.status,'completed');const saved=(await f.call('run',input)).body;
  assert.equal((await f.call('execute',input)).body.status,'completed');assert.deepEqual((await f.call('run',input)).body,saved);assert.equal(f.calls().length-before,1);
 });
 await t.test('same-conversation resume uses a new native target while old aborts and unknown usage remain isolated',async()=>{
  f.mode('hold');try{
   const old=await f.reserve(),before=f.calls().length;await f.call('execute',args(old));await f.call('takeover',args(old));await f.call('reconcile',args(old));
   assert.equal((await f.result(old)).body.status,'aborted');const previous=(await f.call('run',args(old))).body;assert.equal(previous.status,'unconfirmed');
   const resumed=await f.call('resume',args(old));assert.equal(resumed.status,200,JSON.stringify(resumed.body));assert.equal(resumed.body.outcome,'reserved');const next=resumed.body.run as AiExecution;
   assert.notEqual(next.id,old.id);assert.notEqual(next.instanceId,old.instanceId);assert.equal((await f.call('execute',args(next))).body.status,'pending');
   assert.equal((await f.call('abort',args(old))).status,200);assert.equal((await f.call('read',args(next))).body.status,'pending');assert.equal((await f.call('inspect',args(next))).body.cancellation,null);
   f.release();assert.equal((await f.result(next)).body.status,'completed');await f.call('cron');assert.equal(f.calls().length-before,2);
   assert.equal((await f.call('run',args(old))).body.remainingReservedMicros,old.perGenerationMicros);
   const rows=await f.sql('SELECT id,repair_due_at AS due,repair_token AS token FROM ai_execution WHERE id IN (?,?)',[old.id,next.id]);
   assert.ok(rows.find((r:any)=>r.id===old.id).due>Date.now()+240000);assert.equal(rows.find((r:any)=>r.id===next.id).due,null);assert.ok(rows.every((r:any)=>r.token===null));
  }finally{f.release();f.mode('success');}
 });
 await t.test('repair leaves valid work alone and closes an invalid unstarted run without a model request',async()=>{
  const run=await f.reserve(),before=f.calls().length;
  assert.equal((await f.call('reconcile',args(run))).body.status,'unconfirmed');assert.equal((await f.call('inspect',args(run))).body,null);
  await f.call('takeover',args(run));assert.equal((await f.call('reconcile',args(run))).body.status,'closed');
  const saved=(await f.call('run',args(run))).body;assert.equal(saved.closure.kind,'unstarted_closed');assert.equal(saved.remainingReservedMicros,0);
  assert.equal((await f.call('execute',args(run))).body.status,'closed');assert.equal(f.calls().length,before);
 });
 await t.test('takeover persists cancellation before abort; a failed abort is repaired after restart even with AI disabled',async()=>{
  f.mode('hold');try{
   const run=await f.reserve(),before=f.calls().length;assert.equal((await f.call('execute',args(run))).body.status,'pending');
   assert.equal((await f.call('reconcile',args(run))).body.status,'pending');assert.equal((await f.call('inspect',args(run))).body.cancellation,null);
   await f.call('takeover',args(run));assert.equal((await f.call('reconcile',{...args(run),failAbort:true})).body.status,'unconfirmed');
   const state=(await f.call('inspect',args(run))).body;assert.ok(state.cancellation);assert.equal(state.closed,false);
   assert.equal((await f.call('run',args(run))).body.closure,null);
   await f.restart(false);await f.call('cron');f.release();
   for(let i=0;i<30&&!(await f.call('run',args(run))).body.closure;i++){await f.call('reconcile',args(run));await delay(50);}
   const saved=(await f.call('run',args(run))).body;assert.ok(saved.closure);assert.equal(saved.status,'unconfirmed');assert.equal(saved.remainingReservedMicros,run.perGenerationMicros);
   assert.deepEqual((await f.call('inspect',args(run))).body.cancellation,state.cancellation);assert.equal(f.calls().length-before,1);
   assert.equal((await f.call('control',args(run))).body.view.state.reception,'human');
  }finally{f.release();f.mode('success');await f.restart(true);}
 });
 await t.test('new input revokes the original run and native abort cannot affect a separate run',async()=>{
  f.mode('hold');try{
   const run=await f.reserve(),other=await f.reserve(),before=f.calls().length;
   await f.call('execute',args(run));await f.call('execute',args(other));
   await f.sql("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id=?",[run.payload.run.scope.conversationId]);
   const result=await f.call('reconcile',args(run));assert.ok(['aborted','pending'].includes(result.body.status),JSON.stringify(result.body));
   for(let i=0;i<30&&(await f.call('read',args(run))).body.status==='pending';i++){await f.call('reconcile',args(run));await delay(50);}
   assert.equal((await f.call('read',args(run))).body.status,'aborted');
   await f.call('reconcile',args(run));assert.equal((await f.call('read',args(other))).body.status,'pending');
   assert.equal((await f.call('inspect',args(other))).body.cancellation,null);assert.equal(f.calls().length-before,2);
  }finally{f.release();f.mode('success');}
 });
 await t.test('late known usage settles after cancellation without delivering its tool or refunding an unknown call',async()=>{
  f.mode('hold');try{
   const run=await f.reserve(),before=f.calls().length;await f.call('execute',args(run));await f.call('takeover',args(run));
   await f.call('reconcile',{...args(run),failAbort:true});f.release();
   assert.equal((await f.result(run)).body.status,'failed');const saved=(await f.call('run',args(run))).body;
   assert.equal(saved.status,'settled');assert.ok(saved.generations[0].usage);assert.equal(saved.remainingReservedMicros,0);assert.equal(f.calls().length-before,1);
   assert.equal((await f.call('inspect',args(run))).body.generations[0].delivered,false);assert.equal((await f.call('control',args(run))).body.view.state.reception,'human');
  }finally{f.release();f.mode('success');}
 });
 await t.test('repair cannot use a foreign scope or reconstruct destroyed authority',async()=>{
  f.mode('503');try{const run=await f.reserve(),before=f.calls().length;
  const foreign=await f.call('reconcile',{...args(run),scope:{...run.payload.run.scope,organizationId:'foreign'}});assert.equal(foreign.body.status,'unavailable');
  await f.call('execute',args(run));await f.result(run);const saved=(await f.call('run',args(run))).body;await f.call('destroy',args(run));
  assert.equal(saved.status,'unconfirmed');assert.equal((await f.call('reconcile',args(run))).body.status,'unconfirmed');assert.deepEqual((await f.call('run',args(run))).body,saved);assert.equal(f.calls().length-before,1);
  }finally{f.mode('success');}
 });
 await t.test('handoff changes actual controller state, settles one generation and cannot send',async()=>{
  const run=await f.reserve(),before=f.calls().length;const submitted=await f.call('execute',args(run));assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  const result=await f.result(run);assert.equal(result.body.status,'completed',JSON.stringify(result.body));assert.equal(result.body.canSend,false);
  assert.equal(f.calls().length-before,1);const payload=f.calls().at(-1)!.body;assert.deepEqual(payload.tools.map((x:any)=>x.function.name),['request_handoff']);
  for(const privateValue of [run.id,run.payload.run.scope.controllerId])assert.equal(JSON.stringify(payload).includes(privateValue),false);
  const saved=(await f.call('run',args(run))).body;assert.equal(saved.status,'settled');assert.equal(saved.generations.length,1);assert.equal(saved.remainingReservedMicros,0);assert.ok(saved.receipt.uid);
  assert.equal((await f.call('reconcile',{...args(run),failLookup:true})).body.status,'completed','settled executions need no further native polling');
  assert.equal((await f.call('control',args(run))).body.view.state.reception,'paused');assert.equal((await f.sql('SELECT count(*) n FROM send_intent'))[0].n,0);
  await f.call('execute',args(run));assert.equal(f.calls().length-before,1);
 });
 await t.test('provider execution recovers and binds the native receipt before the caller saves anything',async()=>{
  const run=await f.reserve(),before=f.calls().length;await f.call('prepare',args(run));const native=await f.call('dispatch-raw',args(run));assert.equal(native.status,200,JSON.stringify(native.body));
  for(let i=0;i<80&&!(await f.call('run',args(run))).body.receipt;i++)await delay(50);
  const result=await f.result(run);assert.equal(result.body.status,'completed',JSON.stringify(result.body));const saved=(await f.call('run',args(run))).body;
  assert.deepEqual(saved.receipt,{submissionId:native.body.submissionId,uid:native.body.uid,acceptedAt:native.body.acceptedAt});assert.equal(saved.status,'settled');assert.equal(f.calls().length-before,1);
 });
 await t.test('invalid tool arguments cannot escape the frozen generation cap',async()=>{
  f.mode('invalid-input');try{const run=await f.reserve({maxGenerations:2}),before=f.calls().length;await f.call('execute',args(run));const result=await f.result(run);assert.equal(result.body.status,'failed',JSON.stringify(result.body));assert.equal(f.calls().length-before,2);const saved=(await f.call('run',args(run))).body;assert.equal(saved.status,'settled');assert.equal(saved.generations.length,2);}finally{f.mode('success');}
 });
 await t.test('unknown outcomes stay reserved, while unsolicited tools are never executed',async()=>{
  try{for(const mode of ['503','missing-usage','unexpected-tool']){f.mode(mode);const run=await f.reserve(),before=f.calls().length;await f.call('execute',args(run));await f.result(run);assert.equal(f.calls().length-before,1,mode);const saved=(await f.call('run',args(run))).body;assert.equal(saved.status,mode==='unexpected-tool'?'settled':'unconfirmed',mode);if(mode!=='unexpected-tool')assert.equal(saved.remainingReservedMicros,run.perGenerationMicros);await f.call('execute',args(run));assert.equal(f.calls().length-before,1,mode);}}finally{f.mode('success');}
 });
 await t.test('lost caller receipts recover from native state and restart without another generation',async()=>{
  const run=await f.reserve(),before=f.calls().length;await f.call('execute',{...args(run),loseReceipt:true});await f.result(run);const saved=(await f.call('run',args(run))).body;
  try{await f.restart(false);assert.equal((await f.call('execute',args(run))).body.status,'completed');assert.deepEqual((await f.call('run',args(run))).body.receipt,saved.receipt);assert.equal(f.calls().length-before,1);}finally{await f.restart(true);}
 });
 await t.test('paused budgets, altered input and closed prepared runs never call the provider',async()=>{
  const run=await f.reserve(),before=f.calls().length;await f.call('prepare',args(run));await f.sql('UPDATE ai_budget SET enabled=0');try{await f.call('execute',args(run));assert.equal((await f.result(run)).body.status,'failed');assert.equal(f.calls().length,before);}finally{await f.sql('UPDATE ai_budget SET enabled=1');}
  const closed=await f.reserve();await f.call('prepare',args(closed));assert.equal((await f.call('close',args(closed))).status,200);assert.equal((await f.call('execute',args(closed))).body.status,'closed');assert.equal(f.calls().length,before);
  const altered=await f.reserve();await f.call('prepare',args(altered));await f.call('dispatch-altered',args(altered));await delay(250);assert.equal(f.calls().length,before);
 });
 await t.test('a running request cannot release its reservation; human takeover wins over its late tool',async()=>{
  f.mode('hold');try{
   const run=await f.reserve(),before=f.calls().length;assert.equal((await f.call('execute',args(run))).body.status,'pending');assert.equal(f.calls().length-before,1);
   assert.equal((await f.call('close',args(run))).status,500);assert.equal((await f.call('inspect',args(run))).body.closed,false);
   assert.equal((await f.call('takeover',args(run))).body.outcome,'accepted');f.release();assert.equal((await f.result(run)).body.status,'completed');
   assert.equal((await f.call('control',args(run))).body.view.state.reception,'human');assert.equal((await f.call('run',args(run))).body.status,'settled');assert.equal(f.calls().length-before,1);
  }finally{f.mode('success');f.release();}
 });
 await t.test('a process restart during an admitted request never grants another HTTP and retains unknown usage',async()=>{
  f.mode('hold');try{
   const run=await f.reserve(),before=f.calls().length;assert.equal((await f.call('execute',args(run))).body.status,'pending');assert.equal(f.calls().length-before,1);
   await f.restart();f.release();const result=await f.result(run);assert.equal(result.body.status,'failed',JSON.stringify(result.body));assert.equal(f.calls().length-before,1);
   const saved=(await f.call('run',args(run))).body;assert.equal(saved.status,'unconfirmed');assert.equal(saved.remainingReservedMicros,run.perGenerationMicros);
  }finally{f.mode('success');f.release();}
 });
 await t.test('destroyed authority cannot reconstruct a consumed financial generation',async()=>{
  const run=await f.reserve(),before=f.calls().length;await f.call('execute',args(run));await f.result(run);await f.call('destroy',args(run));assert.equal((await f.call('execute',args(run))).body.status,'unconfirmed');assert.equal(f.calls().length-before,1);
 });
 await t.test('public native model, history, abort and attachment routes remain blocked',async()=>{
  for(const suffix of ['', '/history','/abort','/attachments']){const response=await fetch(`${f.base()}/agents/Support/untrusted${suffix}`,{method:suffix==='/history'?'GET':'POST',body:suffix==='/history'?undefined:'arbitrary'});assert.ok([401,403,404].includes(response.status));}
 });
});
async function fixture(sendOptions:{outboundEnabled?:string;aiOutboundEnabled?:string}={}){
  const path=await mkdtemp(join(tmpdir(),'dingbell-answer-')),token=crypto.randomUUID();
  let mode='success',calls:{url:string;method:string;body:any}[]=[],ozonCalls:{url:string;method:string;body:any}[]=[],held:ServerResponse[]=[],releases:(()=>void)[]=[],sendConfig={outboundEnabled:'false',aiOutboundEnabled:'false',...sendOptions};
  const gate=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    let raw='';for await(const chunk of request)raw+=chunk;const call=JSON.parse(raw);
    if(call.url==='https://api-seller.ozon.ru/v1/chat/send/message'){
      ozonCalls.push(call);response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({result:'success'}));return;
    }
    calls.push(call);
    if(mode==='lost'){request.socket.destroy();return;}
    if(mode==='503'){response.writeHead(503).end('synthetic');return;}
    const intake=calls.at(-1)!.body.tools.some((t:any)=>t.function.name==='submit_classification');
    const knowledge=['knowledge','answer','reply'].includes(mode)&&!calls.at(-1)!.body.messages.some((m:any)=>m.role==='tool');
    const answer=['answer','reply'].includes(mode)&&!knowledge&&!intake,reference=answer?calls.at(-1)!.body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>JSON.parse(m.content)).find((r:any)=>r.references?.length)?.references[0].chunkId:undefined;
    const names=mode==='unexpected-tool'?['task']:[intake?'submit_classification':knowledge?'search_knowledge':answer?mode==='reply'?'prepare_reply':'submit_answer':'request_handoff'];
    const args={...(intake?{stage:mode==='unknown-classification'?'unknown':'presale',language:'ru',customerRequestedHuman:false}:knowledge?{}:answer?{body:'Ширина этой модели — 26 см.',citations:[reference]}:{reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]}),...(mode==='invalid-input'?{runId:'forged'}:{})};
    const records=[{id:'synthetic',object:'chat.completion.chunk',created:1,model:'nvidia/nemotron-3-super-120b-a12b',choices:[{index:0,delta:{role:'assistant',content:mode==='text'?'Unreviewed reply.':null,...(mode==='text'?{}:{tool_calls:names.map((name,index)=>({index,id:`call${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}}))})},finish_reason:mode==='text'?'stop':'tool_calls'}]},
      ...(mode==='missing-usage'?[]:[{id:'synthetic',choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:2,cache_write_tokens:1}}}])];
    const wire=records.map(item=>`data: ${JSON.stringify(item)}\n\n`).join('')+(mode==='truncated'?'':'data: [DONE]\n\n');
    const respond=()=>response.writeHead(200,{'content-type':'text/event-stream'}).end(wire);
    if(mode==='hold'){held.push(response);releases.push(respond);return;}respond();
  });gate.listen(0,'127.0.0.1');await once(gate,'listening');const address=gate.address();assert.ok(address&&typeof address==='object');const gatePort=address.port;
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'));config.name='ai-runtime-fixture';delete config.triggers;delete config.assets;
  const configPath=join(path,'wrangler.json');await writeFile(configPath,JSON.stringify(config));
  let child:ChildProcess|undefined,base='',logs='';
  async function start(enabled=true){
    const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const portAddress=portServer.address();assert.ok(portAddress&&typeof portAddress==='object');const port=portAddress.port;await new Promise<void>(resolve=>portServer.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--config','tests/fixtures/ai-runtime/vite.config.ts','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',DINGBELL_SUPPORT_CONFIG:configPath,DINGBELL_SUPPORT_STATE:path,DINGBELL_SUPPORT_GATE:`http://127.0.0.1:${gatePort}`,DINGBELL_SUPPORT_TOKEN:token,DINGBELL_SUPPORT_ENABLED:String(enabled),DINGBELL_SUPPORT_OUTBOUND:sendConfig.outboundEnabled,DINGBELL_SUPPORT_AI_OUTBOUND:sendConfig.aiOutboundEnabled}});
    child.stdout!.on('data',data=>{logs=(logs+data).slice(-16000);});child.stderr!.on('data',data=>{logs=(logs+data).slice(-16000);});
    for(let i=0;i<240;i++){try{const r=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(700)});if(r.ok&&(await r.json() as any).service==='support-runtime-fixture'){assert.ok(logs.includes('SUPPORT_TRANSPORT_BOUND'),'provider transport must resolve to the synthetic fixture before any dispatch');assert.ok(logs.includes('SUPPORT_OZON_TRANSPORT_BOUND'),'Ozon must resolve to a local transport before any dispatch');assert.equal((await call('safety')).body.syntheticKey,true,'effective Worker key must be the fixed synthetic value');return;}}catch{}if(child.exitCode!==null)break;await delay(250);}
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
    await sql("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','verified',1,1)");
    const setup=await call('setup');assert.equal(setup.status,200,JSON.stringify(setup.body));
    return {call,sql,calls:()=>calls,ozonCalls:()=>ozonCalls,release(){for(const fn of releases.splice(0))fn();held=[];},mode:(next:string)=>{mode=next;},base:()=>base,logs:()=>logs,async restart(enabled=true,patch:{outboundEnabled?:string;aiOutboundEnabled?:string}={}){if(child)await stop(child);child=undefined;sendConfig={...sendConfig,...patch};await start(enabled);},close,
      async reserve(options:unknown={}){const result=await call('reserve',options);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'reserved');return result.body.run as AiExecution;},
      async result(run:AiExecution){for(let i=0;i<100;i++){const result=await call('read',{scope:run.payload.run.scope,runId:run.id});if(result.body.status!=='pending')return result;await delay(100);}throw new Error(`result timeout ${logs}`);},
    };
  }catch(error){await close();throw error;}
}
