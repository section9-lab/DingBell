export type AuditOutcome = 'started' | 'succeeded' | 'rejected' | 'unknown';
export class AuditUnavailable extends Error {}
export class OperationUnconfirmed extends Error {}

export async function auditedChange(record: (outcome: AuditOutcome) => Promise<void>, operation: () => Promise<Response>, allowMissingIntent = false) {
  let auditComplete = true;
  try { await record('started'); } catch {
    if (!allowMissingIntent) throw new AuditUnavailable('Audit storage is unavailable.');
    auditComplete = false;
  }
  let response: Response;
  try { response = await operation(); } catch {
    try { await record('unknown'); } catch { /* The persisted intent remains unresolved. */ }
    throw new OperationUnconfirmed('Operation outcome is unconfirmed.');
  }
  const outcome = response.ok ? 'succeeded' : response.status < 500 ? 'rejected' : 'unknown';
  try { await record(outcome); } catch { auditComplete = false; }
  return { response, auditComplete };
}
