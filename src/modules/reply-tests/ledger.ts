import type { PreviewSql } from '../translations/ledger.ts';
import type { PreviewEvidence } from '../translations/transport.ts';
import type { UnstartedTranslationEvidence } from '../translations/types.ts';
import type { ReplyTestRun } from './storage.ts';
import type { ReplyTestInspection } from './execution.ts';
import { replyTestInstance } from './policy.ts';
export class ReplyTestLedger {
  constructor(readonly sql:PreviewSql){
    sql.exec(`CREATE TABLE IF NOT EXISTS dingbell_reply_test (
      id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),binding TEXT NOT NULL,
      generation_count INTEGER NOT NULL DEFAULT 0 CHECK(generation_count IN (0,1)),http_count INTEGER NOT NULL DEFAULT 0 CHECK(http_count IN (0,1)),
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),evidence TEXT,closure TEXT)`).toArray();
  }
  prepare(run:ReplyTestRun){
    const binding={...run,receipt:null,providerRequestClaimedAt:null,settlement:'held',usage:null,chargedMicros:null,settledAt:null,releaseEvidence:null};
    const encoded=JSON.stringify(binding),previous=this.inspect();
    if(previous){if(JSON.stringify(previous.run)!==encoded)throw new Error('REPLY_TEST_BINDING_CONFLICT');return;}
    if(run.settlement!=='held'||run.receipt!==null||run.providerRequestClaimedAt!==null)throw new Error('REPLY_TEST_AUTHORITY_MISSING');
    this.sql.exec('INSERT INTO dingbell_reply_test(id,schema_version,binding) VALUES(1,1,?)',encoded).toArray();
  }
  inspect():ReplyTestInspection|null{
    const row=this.sql.exec('SELECT * FROM dingbell_reply_test WHERE id=1').toArray()[0];if(!row)return null;
    if(row.schema_version!==1)throw new Error('REPLY_TEST_SCHEMA_UNSUPPORTED');
    return {run:JSON.parse(String(row.binding)),generation:Number(row.generation_count),http:Number(row.http_count),closed:row.closed===1,evidence:row.evidence===null?null:JSON.parse(String(row.evidence))};
  }
  spend(kind:'generation'|'http'){
    const column=kind==='generation'?'generation_count':'http_count';
    if(this.sql.exec(`UPDATE dingbell_reply_test SET ${column}=1 WHERE id=1 AND schema_version=1 AND closed=0 AND ${column}=0 RETURNING id`).toArray().length!==1)throw new Error('REPLY_TEST_PERMISSION_EXHAUSTED');
  }
  record(evidence:PreviewEvidence){
    const encoded=JSON.stringify(evidence);
    if(this.sql.exec('UPDATE dingbell_reply_test SET evidence=? WHERE id=1 AND closed=0 AND http_count=1 AND evidence IS NULL RETURNING id',encoded).toArray().length!==1
      &&this.sql.exec('SELECT evidence FROM dingbell_reply_test WHERE id=1').toArray()[0]?.evidence!==encoded)throw new Error('REPLY_TEST_EVIDENCE_CONFLICT');
  }
  close():UnstartedTranslationEvidence{
    const state=this.inspect();if(!state||state.http!==0)throw new Error('REPLY_TEST_ZERO_REQUEST_UNPROVEN');
    const previous=this.sql.exec('SELECT closure FROM dingbell_reply_test WHERE id=1').toArray()[0]?.closure;if(previous)return JSON.parse(String(previous));
    const proof:UnstartedTranslationEvidence={kind:'execution_closed_without_provider_request',evidenceId:crypto.randomUUID(),instanceId:replyTestInstance(state.run.id),verifiedAt:Math.max(Date.now(),state.run.createdAt),providerRequests:0,executionClosed:true};
    if(this.sql.exec('UPDATE dingbell_reply_test SET closed=1,closure=? WHERE id=1 AND closed=0 AND http_count=0 RETURNING id',JSON.stringify(proof)).toArray().length!==1)throw new Error('REPLY_TEST_ZERO_REQUEST_UNPROVEN');
    return proof;
  }
}
