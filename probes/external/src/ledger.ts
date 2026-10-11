import type { DispatchReceipt } from '@flue/runtime';

export interface ProbeSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}
export type ProbeKind = 'model' | 'ozon';
export class ProbeLedger {
  readonly sql: ProbeSql;
  readonly kind: ProbeKind;
  constructor(sql: ProbeSql, kind: ProbeKind) {
    this.sql = sql;
    this.kind = kind;
    sql.exec(`CREATE TABLE IF NOT EXISTS dingbell_external_probe_control (
      kind TEXT PRIMARY KEY, claimed INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0,
      receipt TEXT, generation_count INTEGER NOT NULL DEFAULT 0, http_count INTEGER NOT NULL DEFAULT 0
    )`).toArray();
    sql.exec('CREATE TABLE IF NOT EXISTS dingbell_external_probe_evidence (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL)').toArray();
    sql.exec('INSERT OR IGNORE INTO dingbell_external_probe_control (kind) VALUES (?)', kind).toArray();
  }
  claim() {
    return this.sql.exec('UPDATE dingbell_external_probe_control SET claimed = 1 WHERE kind = ? AND claimed = 0 RETURNING kind', this.kind).toArray().length === 1;
  }
  bind(receipt: DispatchReceipt) {
    const existing = this.inspect().receipt;
    if (existing && (existing.submissionId !== receipt.submissionId || existing.uid !== receipt.uid)) throw new Error('The probe receipt cannot change.');
    this.sql.exec('UPDATE dingbell_external_probe_control SET receipt = ? WHERE kind = ? AND claimed = 1 AND receipt IS NULL', JSON.stringify(receipt), this.kind).toArray();
  }
  spend(kind: 'generation' | 'http') {
    const column = kind === 'generation' ? 'generation_count' : 'http_count';
    const updated = this.sql.exec(`UPDATE dingbell_external_probe_control SET ${column} = ${column} + 1 WHERE kind = ? AND claimed = 1 AND closed = 0 AND ${column} < 6 RETURNING ${column}`, this.kind).toArray();
    if (updated.length !== 1) throw new Error('The external probe budget is unavailable or exhausted.');
  }
  record(event: string, data: unknown) {
    // Only trusted code calls this with explicit, sanitized fields; never an error or environment object.
    this.sql.exec('INSERT INTO dingbell_external_probe_evidence (kind, event, data) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM dingbell_external_probe_evidence WHERE kind = ?) < 40', this.kind, event, JSON.stringify(data), this.kind).toArray();
  }
  close() {
    this.sql.exec('UPDATE dingbell_external_probe_control SET closed = 1 WHERE kind = ?', this.kind).toArray();
  }
  inspect() {
    const row = this.sql.exec('SELECT * FROM dingbell_external_probe_control WHERE kind = ?', this.kind).toArray()[0]!;
    return {
      claimed: row.claimed === 1, closed: row.closed === 1,
      receipt: typeof row.receipt === 'string' ? JSON.parse(row.receipt) as DispatchReceipt : null,
      modelCalls: Number(row.generation_count), httpRequests: Number(row.http_count),
      evidence: this.sql.exec('SELECT event, data FROM dingbell_external_probe_evidence WHERE kind = ? ORDER BY id', this.kind).toArray().map(row => ({ event: String(row.event), data: JSON.parse(String(row.data)) as unknown })),
    };
  }
}
export type ProbeInspection = ReturnType<ProbeLedger['inspect']>;
