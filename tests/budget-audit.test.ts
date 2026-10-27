import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {knowledgeFixture} from './fixtures/knowledge.ts';

async function api(){
  const m=await import('../src/modules/budget-audit/storage.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
  assert.equal(typeof m?.readCompanyBudgetAudit,'function','company reservations need an independent ledger audit');
  assert.equal(typeof m?.readQueryAllowanceAudit,'function','deployment query allowances must be audited separately');return m!;
}
async function fixture(){
  const f=await knowledgeFixture(),actor={orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string,expectedMemberId:'owner'};
  f.sqlite.exec("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('audit-conv','company','store-a','audit-thread','BUYER_SELLER','Opened',1,1)");
  function budget(table:string,id='budget',org='company'){
    f.sqlite.prepare(`INSERT INTO ${table}(id,organization_id,starts_at,ends_at,limit_micros${table==='translation_budget_bucket'?'':',max_runs'}) VALUES(?,?,1,2,9007199254740991${table==='translation_budget_bucket'?'':',100'})`).run(id,org);
  }
  function aiRun(id='run',per=100,max=3){
    const scope={organizationId:'company',storeId:'store-a',conversationId:'audit-conv',controllerId:'controller'};
    const payload={schemaVersion:1,run:{schemaVersion:1,scope,request:{runId:id}},target:{agent:'Support',instanceId:`ai-support:${id}`,dispatchKey:id}};
    f.sqlite.prepare("INSERT INTO ai_execution(id,organization_id,store_id,conversation_id,controller_id,budget_id,payload,payload_hash,config,per_generation_micros,reserved_micros,max_generations,created_at) VALUES(?,'company','store-a','audit-conv','controller','budget',?,?,?, ?,?,?,1)")
      .run(id,JSON.stringify(payload),'a'.repeat(64),JSON.stringify({maxGenerations:max}),per,per*max,max);
  }
  function generation(runId:string,sequence:number,charge:number|null){
    f.sqlite.prepare('UPDATE ai_execution SET generations=? WHERE id=?').run(sequence,runId);
    f.sqlite.prepare('INSERT INTO ai_generation(run_id,sequence,claimed_at,usage,charged_micros,settled_at) VALUES(?,?,1,?,?,?)')
      .run(runId,sequence,charge===null?null:'{}',charge,charge===null?null:1);
  }
  function query(id:string,amount:number,day='2026-10-11'){
    f.sqlite.prepare("INSERT INTO reply_test_query(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,budget_id,payload,payload_hash,reserved_micros,quota_day,admission_token,created_at) VALUES(?,'company','store-a','audit-conv',?,'owner','owner','budget','{}',?,?,?,'permit',1)")
      .run(id,id,'a'.repeat(64),amount,day);
  }
  return {...f,actor,budget,aiRun,generation,query};
}
test('AI audit includes unused generations, unknown claimed usage and a separate embedding allowance',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('ai_budget');f.aiRun();f.generation('run',1,20);f.generation('run',2,null);
  f.sqlite.exec("INSERT INTO ai_knowledge_query(run_id,config,scope,question_hash,reserved_micros,created_at) VALUES('run','{}','{}',printf('%064d',0),60,1)");
  f.sqlite.exec("UPDATE ai_budget SET reserved_micros=260,spent_micros=20,admitted_runs=1");
  const audit=await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget');assert.equal(audit!.status,'balanced');
  assert.deepEqual(audit!.expected,{reservedMicros:'260',spentMicros:'20',admittedRuns:'1'});assert.equal(audit!.embeddingReservedMicros,'60');
  f.sqlite.exec("UPDATE ai_execution SET closure='{}'; UPDATE ai_budget SET reserved_micros=160");
  const closed=await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget');assert.equal(closed!.status,'balanced');assert.equal(closed!.expected.reservedMicros,'160');
  const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM ai_budget').all());
  assert.deepEqual({...await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget'),at:0},{...closed,at:0});assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM ai_budget').all()),before);
  assert.equal(closed!.canRelease,false);assert.equal(closed!.supplierCostsVerified,false);
});
test('translation and reply-test audits distinguish held, settled and released runs',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  for(const [kind,table,runTable] of [['translation','translation_budget_bucket','reply_preview_run'],['reply-test','reply_test_budget','reply_test_run']] as const){
    f.budget(table);for(const state of ['held','settled','released']){
      const id=`${kind}-${state}`,held=state==='held',settled=state==='settled';
      const identity=kind==='translation'?"source,source_hash,source_revision":"payload,payload_hash";
      const identityValues=kind==='translation'?"'private original',?,0":"'{}',?";
      f.sqlite.prepare(`INSERT INTO ${runTable}(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,${identity},budget_id,config,reserved_micros,created_at,receipt,provider_request_claimed_at,settlement,usage,charged_micros,settled_at,release_evidence)
        VALUES(?,'company','store-a','audit-conv',?,'owner','owner',${identityValues},'budget','{}',100,1,?,?,?, ?,?,?,?)`)
        .run(id,id,'a'.repeat(64),settled?'{}':null,settled?1:null,state,settled?'{}':null,held?null:settled?25:0,held?null:1,state==='released'?'{}':null);
    }
    f.sqlite.exec(`UPDATE ${table} SET reserved_micros=100,spent_micros=25${kind==='translation'?'':',admitted_runs=3'}`);
    const audit=await m.readCompanyBudgetAudit(f.db,f.actor,kind,'budget');assert.equal(audit!.status,'balanced');
    assert.deepEqual(audit!.expected,{reservedMicros:'100',spentMicros:'25',admittedRuns:kind==='translation'?null:'3'});
    assert.equal(JSON.stringify(audit).includes('private original'),false);
  }
});
test('differences and missing generation records are reported without fixing money or granting authority',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('ai_budget');f.aiRun();
  f.sqlite.exec('UPDATE ai_budget SET reserved_micros=299,spent_micros=7,admitted_runs=2');
  const audit=await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget');assert.equal(audit!.status,'mismatch');
  assert.deepEqual(audit!.difference,{reservedMicros:'-1',spentMicros:'7',admittedRuns:'1'});
  f.sqlite.exec('UPDATE ai_execution SET generations=1; UPDATE ai_budget SET reserved_micros=200,spent_micros=0');
  const corrupt=await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget');assert.equal(corrupt!.status,'mismatch');assert.equal(corrupt!.invalidExecutions,1);
  assert.equal(f.sqlite.prepare('SELECT reserved_micros FROM ai_budget').get()!.reserved_micros,200);
});
test('audits bind the current verified manager and deny cross-company and replaced membership reads',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('ai_budget');f.budget('ai_budget','other-budget','other');
  for(const patch of [{orgId:'other'},{expectedMemberId:'replacement'},{sessionId:'wrong'},{actorUserId:'staff'}])
    assert.equal(await m.readCompanyBudgetAudit(f.db,{...f.actor,...patch},'ai','budget'),null);
  assert.equal(await m.readCompanyBudgetAudit(f.db,f.actor,'ai','other-budget'),null);
  f.after(sql=>{if(sql.includes('WITH selected AS')){f.after(undefined);f.sqlite.exec("UPDATE user SET email_verified=0 WHERE id='owner'");}});
  assert.equal(await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget'),null);
});
test('large sums remain exact past Number.MAX_SAFE_INTEGER and zero-priced runs still count',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('ai_budget');
  f.aiRun('first',Number.MAX_SAFE_INTEGER,1);f.aiRun('second',Number.MAX_SAFE_INTEGER,1);f.aiRun('free',0,1);
  f.sqlite.exec('UPDATE ai_budget SET reserved_micros=9007199254740991,admitted_runs=3');
  const audit=await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget');assert.equal(audit!.expected.reservedMicros,'18014398509481982');
  assert.equal(audit!.difference.reservedMicros,'-9007199254740991');assert.equal(audit!.expected.admittedRuns,'3');assert.equal(audit!.status,'mismatch');
});
test('deployment query audit uses its own day allowance and never deducts it from company test money',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('reply_test_budget');f.query('query',60);f.query('free',0);f.query('yesterday',90,'2026-10-10');
  f.sqlite.exec("INSERT INTO reply_test_query_usage VALUES('2026-10-11',60,2)");
  const audit=await m.readQueryAllowanceAudit(f.db,'2026-10-11');assert.equal(audit.status,'balanced');assert.deepEqual(audit.expected,{reservedMicros:'60',queries:'2'});
  assert.equal((await m.readCompanyBudgetAudit(f.db,f.actor,'reply-test','budget'))!.status,'balanced');
  f.sqlite.exec("UPDATE reply_test_query_usage SET reserved_micros=61 WHERE day='2026-10-11'");assert.equal((await m.readQueryAllowanceAudit(f.db,'2026-10-11')).status,'mismatch');
  assert.equal((await m.readQueryAllowanceAudit(f.db,'2026-10-10')).status,'mismatch');assert.equal((await m.readQueryAllowanceAudit(f.db,'2026-10-09')).status,'balanced');
  await assert.rejects(()=>m.readQueryAllowanceAudit(f.db,'2026-02-30'));
});
test('integer overflow is unavailable rather than a rounded balance or automatic refund',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('reply_test_budget');
  for(let i=0;i<1025;i++)f.query(`large-${i}`,Number.MAX_SAFE_INTEGER);
  await assert.rejects(()=>m.readQueryAllowanceAudit(f.db,'2026-10-11'),/integer overflow/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM reply_test_query_usage').get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM reply_test_query').get()!.n,1025);
});
test('scheduled reconciliation persists bounded alerts and never changes financial counters',async t=>{
  const m=await api(),r=await import('../src/modules/budget-audit/reconciliation.ts'),f=await fixture();t.after(f.close);f.budget('ai_budget');f.aiRun();f.sqlite.exec("UPDATE ai_budget SET reserved_micros=300,admitted_runs=1 WHERE id='budget'");
  const before=JSON.stringify(f.sqlite.prepare("SELECT reserved_micros,spent_micros,admitted_runs FROM ai_budget WHERE id='budget'").get());
  let claims=await r.claimBudgetReconciliations(f.db,1000,25);const claim=claims.find(c=>c.kind==='ai'&&c.budgetId==='budget');assert.ok(claim);
  await r.finishBudgetReconciliation(f.db,claim,1001);
  let state=f.sqlite.prepare("SELECT * FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'").get()!;
  assert.equal(state.status,'balanced');assert.equal(state.consecutive_mismatches,0);assert.equal(state.last_error_code,null);assert.equal(JSON.parse(state.payload as string).schemaVersion,1);
  f.sqlite.exec("UPDATE ai_budget SET reserved_micros=301; UPDATE budget_reconciliation_state SET next_due_at=0 WHERE kind='ai' AND budget_id='budget'");
  const mismatchDue:number[]=[];for(const at of [2000,3000]){claims=await r.claimBudgetReconciliations(f.db,at,25);await r.finishBudgetReconciliation(f.db,claims.find(c=>c.kind==='ai'&&c.budgetId==='budget')!,at+1);mismatchDue.push(f.sqlite.prepare("SELECT next_due_at AS due FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'").get()!.due as number);f.sqlite.exec("UPDATE budget_reconciliation_state SET next_due_at=0 WHERE kind='ai' AND budget_id='budget'");}
  assert.deepEqual(mismatchDue,[302001,603001]);state=f.sqlite.prepare("SELECT * FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'").get()!;assert.equal(state.status,'mismatch');assert.equal(state.consecutive_mismatches,2);assert.equal(state.mismatch_since,2001);
  claims=await r.claimBudgetReconciliations(f.db,4000,25);await r.failBudgetReconciliation(f.db,claims.find(c=>c.kind==='ai'&&c.budgetId==='budget')!,4001);
  state=f.sqlite.prepare("SELECT * FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'").get()!;assert.equal(state.status,'mismatch');assert.equal(state.last_error_code,'AUDIT_UNAVAILABLE');assert.equal(state.consecutive_failures,1);assert.equal(state.next_due_at,304001);
  f.sqlite.exec("UPDATE budget_reconciliation_state SET next_due_at=0 WHERE kind='ai' AND budget_id='budget'");claims=await r.claimBudgetReconciliations(f.db,5000,25);await r.failBudgetReconciliation(f.db,claims.find(c=>c.kind==='ai'&&c.budgetId==='budget')!,5001);
  state=f.sqlite.prepare("SELECT * FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'").get()!;assert.equal(state.consecutive_failures,2);assert.equal(state.next_due_at,605001);
  assert.equal(JSON.stringify(f.sqlite.prepare("SELECT reserved_micros,spent_micros,admitted_runs FROM ai_budget WHERE id='budget'").get()),JSON.stringify({...JSON.parse(before),reserved_micros:301}));
  assert.throws(()=>f.sqlite.exec("DELETE FROM budget_reconciliation_state WHERE kind='ai' AND budget_id='budget'"),/cannot be deleted/);
  assert.equal(typeof m.readBudgetAuditForRepair,'function');
});
test('0047 atomically backfills existing budgets and preserves them on an injected migration failure',async t=>{
  const f=await knowledgeFixture('0046');t.after(f.close);
  for(const [table,id] of [['ai_budget','a'],['translation_budget_bucket','t'],['reply_test_budget','r']] as const){
   const count=table==='translation_budget_bucket'?'':',max_runs',value=table==='translation_budget_bucket'?'':',10';
   f.sqlite.exec(`INSERT INTO ${table}(id,organization_id,starts_at,ends_at,limit_micros${count}) VALUES('${id}','company',1,2,100${value})`);
  }
  const migration=readFileSync(new URL('../migrations/0047_budget_reconciliation.sql',import.meta.url),'utf8');
  f.sqlite.exec('BEGIN');assert.throws(()=>{f.sqlite.exec(migration);f.sqlite.exec('SELECT * FROM synthetic_missing_reconciliation_table');});f.sqlite.exec('ROLLBACK');
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='budget_reconciliation_state'").get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM ai_budget').get()!.n,1);
  f.sqlite.exec(migration);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM budget_reconciliation_state').get()!.n,3);
  f.sqlite.exec("INSERT INTO ai_budget(id,organization_id,starts_at,ends_at,limit_micros,max_runs) VALUES('new','company',3,4,1,1)");
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM budget_reconciliation_state WHERE kind='ai'").get()!.n,2);assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('large reconciliation backlogs remain bounded, fair and company scoped',async t=>{
  const m=await api(),r=await import('../src/modules/budget-audit/reconciliation.ts'),f=await fixture();t.after(f.close);
  f.sqlite.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
   INSERT INTO budget_reconciliation_state(organization_id,kind,budget_id) SELECT 'company','ai',printf('queued-%04d',value) FROM n`);
  const first=await r.claimBudgetReconciliations(f.db,1000,25),second=await r.claimBudgetReconciliations(f.db,1000,25);
  assert.equal(first.length,25);assert.equal(second.length,25);assert.equal(new Set([...first,...second].map(c=>c.budgetId)).size,50);assert.equal(first[0].budgetId,'queued-0001');assert.equal(second[0].budgetId,'queued-0026');
  const summary=await m.readCompanyBudgetReconciliationSummary(f.db,f.actor);assert.equal(summary!.totals.tracked,1000);assert.equal(summary!.items.length,50);assert.equal(summary!.truncated,true);
  const duePlan=JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM budget_reconciliation_state WHERE next_due_at<=1 ORDER BY next_due_at,organization_id,kind,budget_id LIMIT 25').all());
  assert.match(duePlan,/budget_reconciliation_due_idx/);const companyPlan=JSON.stringify(f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM budget_reconciliation_state WHERE organization_id='company'").all());assert.match(companyPlan,/sqlite_autoindex_budget_reconciliation_state_1/);
});
test('new budgets of every kind enter the persistent reconciliation queue without business content',async t=>{
  const f=await fixture();t.after(f.close);f.budget('ai_budget','a');f.budget('translation_budget_bucket','t');f.budget('reply_test_budget','r');
  assert.deepEqual(f.sqlite.prepare("SELECT kind,budget_id AS id FROM budget_reconciliation_state ORDER BY kind").all().map(row=>({...row})),[
    {kind:'ai',id:'a'},{kind:'reply-test',id:'r'},{kind:'translation',id:'t'}]);
  const serialized=JSON.stringify(f.sqlite.prepare('SELECT * FROM budget_reconciliation_state').all());assert.equal(serialized.includes('private'),false);
});
test('a manager losing their role during the read cannot receive an old financial snapshot',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.budget('ai_budget');
  const admin={...f.actor,actorUserId:'admin',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='admin'").get()!.id as string,expectedMemberId:'admin'};
  f.after(sql=>{if(sql.includes('WITH selected AS')){f.after(undefined);f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'");}});
  assert.equal(await m.readCompanyBudgetAudit(f.db,admin,'ai','budget'),null);
  assert.equal((await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget'))!.status,'balanced');
  f.after(sql=>{if(sql.includes('SELECT')&&sql.includes('tracked')){f.after(undefined);f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'");}});
  assert.equal(await m.readCompanyBudgetReconciliationSummary(f.db,admin),null);
  f.sqlite.exec("UPDATE ai_budget SET commit_token='stranded' WHERE id='budget'");assert.equal((await m.readCompanyBudgetAudit(f.db,f.actor,'ai','budget'))!.status,'mismatch');
});
