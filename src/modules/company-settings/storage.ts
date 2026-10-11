export type SettingsActor = { orgId: string; actorUserId: string; sessionId: string };
export type SettingsRecord = { companyId: string; timeZone: string; version: number; updatedAt: number | null; role: string };
const access = `SELECT 1 FROM member actor JOIN user caller ON caller.id=actor.user_id
  JOIN session login ON login.user_id=caller.id WHERE actor.organization_id=? AND actor.user_id=?
  AND login.id=? AND login.expires_at>unixepoch()*1000 AND caller.email_verified=1 AND actor.role IN ('owner','admin')`;
const parameters = (actor: SettingsActor) => [actor.orgId, actor.actorUserId, actor.sessionId];

export function readCompanySettings(db: D1Database, actor: SettingsActor) {
  return db.prepare(`SELECT org.id AS companyId, COALESCE(settings.time_zone,'UTC') AS timeZone,
    COALESCE(settings.version,0) AS version, settings.updated_at AS updatedAt, actor.role
    FROM organization org JOIN member actor ON actor.organization_id=org.id JOIN user caller ON caller.id=actor.user_id
    JOIN session login ON login.user_id=caller.id LEFT JOIN company_settings settings ON settings.organization_id=org.id
    WHERE org.id=? AND actor.user_id=? AND login.id=? AND login.expires_at>unixepoch()*1000 AND caller.email_verified=1
    AND actor.role IN ('owner','admin','member')`).bind(...parameters(actor)).first<SettingsRecord>();
}

export function saveCompanyTimeZone(db: D1Database, actor: SettingsActor, timeZone: string, expectedVersion: number) {
  if (expectedVersion === 0) return db.prepare(`INSERT INTO company_settings (organization_id,time_zone,version,updated_at)
    SELECT ?,?,1,unixepoch()*1000 WHERE EXISTS (${access}) ON CONFLICT(organization_id) DO NOTHING RETURNING version`)
    .bind(actor.orgId, timeZone, ...parameters(actor)).first<{ version: number }>();
  return db.prepare(`UPDATE company_settings SET time_zone=?,version=version+1,updated_at=unixepoch()*1000
    WHERE organization_id=? AND version=? AND version<9007199254740991 AND EXISTS (${access}) RETURNING version`)
    .bind(timeZone, actor.orgId, expectedVersion, ...parameters(actor)).first<{ version: number }>();
}
