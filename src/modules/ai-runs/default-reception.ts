export type DefaultReceptionActor = { orgId: string; actorUserId: string };

/** AI reception is the product default; only a stored opt-out turns it off. */
export async function readDefaultAiReception(db: D1Database, organizationId: string): Promise<boolean> {
  const row = await db.prepare('SELECT enabled FROM company_ai_reception_default WHERE organization_id=?')
    .bind(organizationId).first<{ enabled: number }>();
  return row === null || row.enabled === 1;
}

export function writeDefaultAiReception(db: D1Database, actor: DefaultReceptionActor, enabled: boolean) {
  return db.prepare(`INSERT INTO company_ai_reception_default(organization_id,enabled,updated_at,updated_by)
    VALUES(?,?,?,?)
    ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by
    RETURNING enabled,updated_at AS updatedAt`).bind(actor.orgId, enabled ? 1 : 0, Date.now(), actor.actorUserId)
    .first<{ enabled: number; updatedAt: number }>();
}
