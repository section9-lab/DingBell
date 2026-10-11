export type MemberRole = 'owner' | 'admin' | 'member';
export interface MemberChange {
  organizationId: string;
  memberId: string;
  expectedRole: MemberRole;
  role: MemberRole | null;
  actorUserId: string;
  sessionId: string;
}

export async function changeMember(database: D1Database, input: MemberChange) {
  // Better Auth's member adapter writes by ID only. This narrow D1 write keeps
  // the current session, actor permission and expected target role atomic.
  const authorization = `EXISTS (
    SELECT 1 FROM member AS actor
    JOIN user AS caller ON caller.id = actor.user_id
    JOIN session AS login ON login.user_id = actor.user_id
    WHERE actor.organization_id = member.organization_id
      AND actor.user_id = ? AND login.id = ?
      AND login.expires_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER)
      AND caller.email_verified = 1
      AND (actor.role = 'owner' OR (actor.role = 'admin'
        AND member.role IN ('admin', 'member') AND ? <> 'owner'))
  )`;
  const statement = input.role === null
    ? 'DELETE FROM member'
    : 'UPDATE member SET role = ?';
  const parameters = [input.memberId, input.organizationId, input.expectedRole, input.actorUserId, input.sessionId, input.role ?? ''];
  if (input.role !== null) parameters.unshift(input.role);
  return database.prepare(`${statement}
    WHERE id = ? AND organization_id = ? AND role = ? AND ${authorization}
    RETURNING id AS memberId, ${input.role === null ? 'NULL' : 'role'} AS role`)
    .bind(...parameters).first<{ memberId: string; role: MemberRole | null }>();
}
