import type {PreviewSql} from '../translations/ledger.ts';
import type {PreviewEvidence} from '../translations/transport.ts';
import type {TranslationReceipt} from '../translations/types.ts';
import type {AiExecution} from './storage.ts';
type Marker={evidenceId:string;verifiedAt:number};
export type SupportInspection={run:AiExecution;receipt:TranslationReceipt|null;closed:boolean;marker:Marker|null;cancellation:Marker|null;generations:{sequence:number;http:boolean;delivered:boolean;evidence:PreviewEvidence|null}[]};
function binding(run:AiExecution){return {...run,receipt:null,closure:null,generations:[],remainingReservedMicros:run.reservedMicros,status:'open'};}
export class SupportLedger {
 readonly sql:PreviewSql;
 constructor(sql:PreviewSql){
  this.sql=sql;
  sql.exec('CREATE TABLE IF NOT EXISTS dingbell_support_cancel (id INTEGER PRIMARY KEY CHECK(id=1),marker TEXT NOT NULL)').toArray();
  sql.exec(`CREATE TABLE IF NOT EXISTS dingbell_support (id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),binding TEXT NOT NULL,receipt TEXT,closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),marker TEXT)`).toArray();
  sql.exec(`CREATE TABLE IF NOT EXISTS dingbell_support_generation (sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 8),http INTEGER NOT NULL DEFAULT 0 CHECK(http IN (0,1)),delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),evidence TEXT)`).toArray();
 }
 prepare(run:AiExecution){
  const encoded=JSON.stringify(binding(run)),old=this.inspect();if(old){if(JSON.stringify(old.run)!==encoded)throw new Error('SUPPORT_BINDING_CONFLICT');return;}
  if(run.receipt||run.closure||run.generations.length)throw new Error('SUPPORT_AUTHORITY_MISSING');
  this.sql.exec('INSERT INTO dingbell_support(id,schema_version,binding) VALUES(1,1,?)',encoded).toArray();
 }
 inspect():SupportInspection|null{
  const row=this.sql.exec('SELECT * FROM dingbell_support WHERE id=1').toArray()[0];if(!row)return null;if(row.schema_version!==1)throw new Error('SUPPORT_SCHEMA_UNSUPPORTED');
  const generations=this.sql.exec('SELECT * FROM dingbell_support_generation ORDER BY sequence').toArray().map(g=>({sequence:Number(g.sequence),http:g.http===1,delivered:g.delivered===1,evidence:g.evidence===null?null:JSON.parse(String(g.evidence)) as PreviewEvidence}));
  const cancellation=this.sql.exec('SELECT marker FROM dingbell_support_cancel WHERE id=1').toArray()[0];
  return {run:JSON.parse(String(row.binding)),receipt:row.receipt===null?null:JSON.parse(String(row.receipt)),closed:row.closed===1,marker:row.marker===null?null:JSON.parse(String(row.marker)),cancellation:cancellation?JSON.parse(String(cancellation.marker)):null,generations};
 }
 begin(){
  const s=this.inspect(),last=s?.generations.at(-1);if(!s||s.closed||s.cancellation||s.generations.length>=s.run.config.maxGenerations||(last&&(!last.delivered||!last.evidence?.complete||!last.evidence.usageReported||!last.evidence.usage)))throw new Error('SUPPORT_GENERATION_UNAVAILABLE');
  const sequence=s.generations.length+1;this.sql.exec('INSERT INTO dingbell_support_generation(sequence) VALUES(?)',sequence).toArray();return sequence;
 }
 spend(sequence:number){
  if(this.sql.exec('UPDATE dingbell_support_generation SET http=1 WHERE sequence=? AND http=0 AND EXISTS(SELECT 1 FROM dingbell_support WHERE id=1 AND closed=0) AND NOT EXISTS(SELECT 1 FROM dingbell_support_cancel) RETURNING sequence',sequence).toArray().length!==1)throw new Error('SUPPORT_HTTP_UNAVAILABLE');
 }
 deliver(sequence:number){
  if(this.sql.exec('UPDATE dingbell_support_generation SET delivered=1 WHERE sequence=? AND http=1 AND evidence IS NOT NULL AND EXISTS(SELECT 1 FROM dingbell_support WHERE id=1 AND closed=0) AND NOT EXISTS(SELECT 1 FROM dingbell_support_cancel) RETURNING sequence',sequence).toArray().length!==1)throw new Error('SUPPORT_DELIVERY_UNAVAILABLE');
 }
 bindReceipt(receipt:TranslationReceipt){
  const encoded=JSON.stringify(receipt);
  if(this.sql.exec('UPDATE dingbell_support SET receipt=? WHERE id=1 AND receipt IS NULL AND closed=0 RETURNING id',encoded).toArray().length!==1&&JSON.stringify(this.inspect()?.receipt)!==encoded)throw new Error('SUPPORT_RECEIPT_CONFLICT');
 }
 record(sequence:number,evidence:PreviewEvidence){
  const encoded=JSON.stringify(evidence);
  if(this.sql.exec('UPDATE dingbell_support_generation SET evidence=? WHERE sequence=? AND http=1 AND evidence IS NULL RETURNING sequence',encoded,sequence).toArray().length!==1
   &&this.sql.exec('SELECT evidence FROM dingbell_support_generation WHERE sequence=?',sequence).toArray()[0]?.evidence!==encoded)throw new Error('SUPPORT_EVIDENCE_CONFLICT');
 }
 cancel():Marker{
  const state=this.inspect();if(!state)throw new Error('SUPPORT_AUTHORITY_MISSING');
  this.sql.exec('INSERT OR IGNORE INTO dingbell_support_cancel(id,marker) VALUES(1,?)',JSON.stringify({evidenceId:crypto.randomUUID(),verifiedAt:Math.max(Date.now(),state.run.createdAt)})).toArray();
  return this.inspect()!.cancellation!;
 }
 close():Marker{
  const state=this.inspect();if(!state)throw new Error('SUPPORT_AUTHORITY_MISSING');if(state.marker)return state.marker;
  const marker={evidenceId:crypto.randomUUID(),verifiedAt:Math.max(Date.now(),state.run.createdAt)};
  this.sql.exec('UPDATE dingbell_support SET closed=1,marker=? WHERE id=1 AND closed=0',JSON.stringify(marker)).toArray();return this.inspect()!.marker!;
 }
}
