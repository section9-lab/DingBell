import type { TranslationRun,UnstartedTranslationEvidence } from './types.ts';
import type { PreviewEvidence } from './transport.ts';
import { freezeTranslationConfig } from './config.ts';
export interface PreviewSql {exec(query:string,...bindings:unknown[]):{toArray():Record<string,unknown>[]}}
function binding(run:TranslationRun):TranslationRun {
  return {id:run.id,requestId:run.requestId,organizationId:run.organizationId,storeId:run.storeId,conversationId:run.conversationId,actorUserId:run.actorUserId,actorMemberId:run.actorMemberId,
    source:run.source,sourceHash:run.sourceHash,sourceRevision:run.sourceRevision,budgetId:run.budgetId,config:freezeTranslationConfig(run.config),reservedMicros:run.reservedMicros,createdAt:run.createdAt,
    receipt:null,settlement:'held',usage:null,chargedMicros:null,settledAt:null,releaseEvidence:null,providerRequestClaimedAt:null};
}
export class PreviewLedger {
  readonly sql:PreviewSql;
  constructor(sql:PreviewSql){
    this.sql=sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS dingbell_reply_preview (
      id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),binding TEXT NOT NULL,
      generation_count INTEGER NOT NULL DEFAULT 0 CHECK(generation_count IN (0,1)),http_count INTEGER NOT NULL DEFAULT 0 CHECK(http_count IN (0,1)),
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),evidence TEXT,closure TEXT)`).toArray();
  }
  prepare(run:TranslationRun):void{
    const encoded=JSON.stringify(binding(run)),previous=this.inspect();
    if(previous){if(JSON.stringify(previous.run)!==encoded)throw new Error('PREVIEW_BINDING_CONFLICT');return;}
    if(run.settlement!=='held'||run.receipt!==null||run.providerRequestClaimedAt!==null)throw new Error('PREVIEW_AUTHORITY_MISSING');
    this.sql.exec('INSERT INTO dingbell_reply_preview(id,schema_version,binding) VALUES (1,1,?)',encoded).toArray();
  }
  inspect():{run:TranslationRun;generation:number;http:number;closed:boolean;evidence:PreviewEvidence|null}|null{
    const row=this.sql.exec('SELECT * FROM dingbell_reply_preview WHERE id=1').toArray()[0];if(!row)return null;
    if(row.schema_version!==1)throw new Error('PREVIEW_SCHEMA_UNSUPPORTED');
    return {run:JSON.parse(String(row.binding)),generation:Number(row.generation_count),http:Number(row.http_count),closed:row.closed===1,evidence:row.evidence===null?null:JSON.parse(String(row.evidence))};
  }
  spend(kind:'generation'|'http'):void{
    const column=kind==='generation'?'generation_count':'http_count';
    if(this.sql.exec(`UPDATE dingbell_reply_preview SET ${column}=1 WHERE id=1 AND schema_version=1 AND closed=0 AND ${column}=0 RETURNING id`).toArray().length!==1)throw new Error('PREVIEW_PERMISSION_EXHAUSTED');
  }
  record(evidence:PreviewEvidence):void{
    const encoded=JSON.stringify(evidence);
    if(this.sql.exec('UPDATE dingbell_reply_preview SET evidence=? WHERE id=1 AND closed=0 AND http_count=1 AND evidence IS NULL RETURNING id',encoded).toArray().length!==1
      &&this.sql.exec('SELECT evidence FROM dingbell_reply_preview WHERE id=1').toArray()[0]?.evidence!==encoded)throw new Error('PREVIEW_EVIDENCE_CONFLICT');
  }
  close():UnstartedTranslationEvidence{
    const state=this.inspect();if(!state||state.http!==0)throw new Error('PREVIEW_ZERO_REQUEST_UNPROVEN');
    const existing=this.sql.exec('SELECT closure FROM dingbell_reply_preview WHERE id=1').toArray()[0]?.closure;
    if(existing)return JSON.parse(String(existing));
    const proof:UnstartedTranslationEvidence={kind:'execution_closed_without_provider_request',evidenceId:crypto.randomUUID(),instanceId:`reply-preview:${state.run.id}`,verifiedAt:Math.max(Date.now(),state.run.createdAt),providerRequests:0,executionClosed:true};
    if(this.sql.exec('UPDATE dingbell_reply_preview SET closed=1,closure=? WHERE id=1 AND closed=0 AND http_count=0 RETURNING id',JSON.stringify(proof)).toArray().length!==1)throw new Error('PREVIEW_ZERO_REQUEST_UNPROVEN');
    return proof;
  }
}
