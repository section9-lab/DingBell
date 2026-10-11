import type { CredentialEnvelope } from './credentials.ts';
import type { StoreCapability } from './ozon.ts';

export interface StoreActor { orgId: string; actorUserId: string; sessionId: string }
export type StoreStatus = 'unverified' | 'verified' | 'partial' | 'attention' | 'paused' | 'disconnected';
export interface StoreRecord {
  id: string; organizationId: string; name: string; platform: 'ozon'; platformStoreId: string;
  status: StoreStatus; revision: number; credentialVersion: number;
  credentialKeyVersion: string | null; credentialNonce: string | null; credentialCiphertext: string | null;
  capabilities: string | null; checkedAt: number | null; expiresAt: number | null;
  checkToken: string | null; checkUntil: number | null; nextCheckAt: number | null;
}

export const storeColumns = `store.id, store.organization_id AS organizationId, store.name, store.platform,
  store.platform_store_id AS platformStoreId, store.status, store.revision, store.credential_version AS credentialVersion,
  store.credential_key_version AS credentialKeyVersion, store.credential_nonce AS credentialNonce,
  store.credential_ciphertext AS credentialCiphertext, store.capabilities,
  store.checked_at AS checkedAt, store.expires_at AS expiresAt, store.check_token AS checkToken,
  store.check_until AS checkUntil, store.next_check_at AS nextCheckAt`;
const nowSQL = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";

// All final writes include current authorization. A preflight membership lookup
// cannot protect a request that lost its session or permission while awaiting I/O.
export function storeAccess(organization: string, manage = true) {
  return `EXISTS (SELECT 1 FROM member AS actor
    JOIN user AS caller ON caller.id = actor.user_id
    JOIN session AS login ON login.user_id = actor.user_id
    WHERE actor.organization_id = ${organization} AND actor.user_id = ? AND login.id = ?
      AND login.expires_at > ${nowSQL} AND caller.email_verified = 1
      AND (actor.role IN ('owner','admin')${manage ? '' : ` OR (actor.role = 'member' AND EXISTS (
        SELECT 1 FROM store_grant AS permission WHERE permission.organization_id = store.organization_id
          AND permission.store_id = store.id AND permission.member_id = actor.id))`}))`;
}
function actorParameters(actor: StoreActor) { return [actor.actorUserId, actor.sessionId]; }

export async function listStores(db: D1Database, actor: StoreActor, offset: number) {
  const result = await db.prepare(`SELECT ${storeColumns} FROM store WHERE organization_id = ? AND ${storeAccess('store.organization_id', false)} ORDER BY created_at, id LIMIT 101 OFFSET ?`)
    .bind(actor.orgId, ...actorParameters(actor), offset).all<StoreRecord>();
  return result.results;
}

export function findStore(db: D1Database, actor: StoreActor, id: string, manage = false) {
  return db.prepare(`SELECT ${storeColumns} FROM store WHERE id = ? AND organization_id = ? AND ${storeAccess('store.organization_id', manage)}`)
    .bind(id, actor.orgId, ...actorParameters(actor)).first<StoreRecord>();
}

export function insertStore(db: D1Database, actor: StoreActor, input: { id: string; name: string; clientId: string }, envelope: CredentialEnvelope) {
  return db.prepare(`INSERT INTO store (id,organization_id,name,platform,platform_store_id,status,
      credential_key_version,credential_nonce,credential_ciphertext,created_at,updated_at)
    SELECT ?,?,?,'ozon',?,'unverified',?,?,?,${nowSQL},${nowSQL}
    WHERE ${storeAccess('?')} ON CONFLICT DO NOTHING RETURNING ${storeColumns}`)
    .bind(input.id, actor.orgId, input.name, input.clientId, envelope.keyVersion, envelope.nonce, envelope.ciphertext,
      actor.orgId, ...actorParameters(actor)).first<StoreRecord>();
}

export function rotateStoreCredentials(db: D1Database, actor: StoreActor, id: string, revision: number, envelope: CredentialEnvelope) {
  return db.prepare(`UPDATE store SET credential_key_version=?,credential_nonce=?,credential_ciphertext=?,
      credential_version=credential_version+1,revision=revision+1,status='unverified',
      capabilities=NULL,checked_at=NULL,expires_at=NULL,check_token=NULL,check_until=NULL,updated_at=${nowSQL}
    WHERE id=? AND organization_id=? AND revision=? AND ${storeAccess('store.organization_id')}
    RETURNING ${storeColumns}`)
    .bind(envelope.keyVersion, envelope.nonce, envelope.ciphertext, id, actor.orgId, revision, ...actorParameters(actor)).first<StoreRecord>();
}

export function changeStoreState(db: D1Database, actor: StoreActor, id: string, revision: number, state: 'paused' | 'unverified' | 'disconnected') {
  const reset = state === 'paused' ? '' : ',capabilities=NULL,checked_at=NULL,expires_at=NULL';
  const disconnect = state === 'disconnected' ? ',credential_key_version=NULL,credential_nonce=NULL,credential_ciphertext=NULL,credential_version=credential_version+1' : '';
  return db.prepare(`UPDATE store SET status=?,revision=revision+1,check_token=NULL,check_until=NULL,updated_at=${nowSQL}${reset}${disconnect}
    WHERE id=? AND organization_id=? AND revision=?
      AND (?='disconnected' OR credential_ciphertext IS NOT NULL) AND ${storeAccess('store.organization_id')}
    RETURNING ${storeColumns}`)
    .bind(state, id, actor.orgId, revision, state, ...actorParameters(actor)).first<StoreRecord>();
}

export function beginStoreCheck(db: D1Database, actor: StoreActor, id: string, revision: number, token: string) {
  return db.prepare(`UPDATE store SET check_token=?,check_until=${nowSQL}+20000,next_check_at=${nowSQL}+30000
    WHERE id=? AND organization_id=? AND revision=? AND credential_ciphertext IS NOT NULL
      AND status NOT IN ('paused','disconnected') AND (check_until IS NULL OR check_until <= ${nowSQL})
      AND (next_check_at IS NULL OR next_check_at <= ${nowSQL}) AND ${storeAccess('store.organization_id')}
    RETURNING ${storeColumns}`)
    .bind(token, id, actor.orgId, revision, ...actorParameters(actor)).first<StoreRecord>();
}

export function finishStoreCheck(db: D1Database, actor: StoreActor, input: { id: string; revision: number; credentialVersion: number; token: string }, capabilities: StoreCapability[]) {
  const reads = capabilities.slice(0, 4);
  const status = reads.every(item => item.status === 'available') ? 'verified'
    : reads[0]?.status === 'available' ? 'partial' : 'attention';
  return db.prepare(`UPDATE store SET capabilities=?,status=?,checked_at=${nowSQL},expires_at=${nowSQL}+86400000,
      revision=revision+1,check_token=NULL,check_until=NULL,updated_at=${nowSQL}
    WHERE id=? AND organization_id=? AND revision=? AND credential_version=? AND check_token=?
      AND check_until > ${nowSQL} AND status NOT IN ('paused','disconnected') AND ${storeAccess('store.organization_id')}
    RETURNING ${storeColumns}`)
    .bind(JSON.stringify(capabilities), status, input.id, actor.orgId, input.revision, input.credentialVersion, input.token,
      ...actorParameters(actor)).first<StoreRecord>();
}

export async function listStoreGrants(db: D1Database, actor: StoreActor, id: string, offset: number) {
  const result = await db.prepare(`SELECT target.id AS memberId, person.name, person.email, target.role,
      EXISTS(SELECT 1 FROM store_grant AS permission WHERE permission.store_id=store.id AND permission.member_id=target.id) AS granted
    FROM store JOIN member AS target ON target.organization_id=store.organization_id JOIN user AS person ON person.id=target.user_id
    WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id')}
    ORDER BY target.created_at,target.id LIMIT 101 OFFSET ?`)
    .bind(id, actor.orgId, ...actorParameters(actor), offset).all<{ memberId: string; name: string; email: string; role: string; granted: number }>();
  return result.results.map(item => ({ ...item, granted: !!item.granted }));
}

export function changeStoreGrant(db: D1Database, actor: StoreActor, input: { storeId: string; memberId: string; expectedGranted: boolean; granted: boolean }) {
  if (input.expectedGranted === input.granted) return Promise.resolve(null);
  if (input.granted) {
    return db.prepare(`INSERT INTO store_grant (organization_id,store_id,member_id,created_at)
      SELECT store.organization_id,store.id,target.id,${nowSQL} FROM store
      JOIN member AS target ON target.organization_id=store.organization_id AND target.id=? AND target.role='member'
      WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id')}
      ON CONFLICT DO NOTHING RETURNING member_id AS memberId,1 AS granted`)
      .bind(input.memberId, input.storeId, actor.orgId, ...actorParameters(actor)).first<{ memberId: string; granted: number }>();
  }
  return db.prepare(`DELETE FROM store_grant WHERE store_id=? AND organization_id=? AND member_id=?
    AND EXISTS (SELECT 1 FROM member AS target WHERE target.id=store_grant.member_id AND target.organization_id=store_grant.organization_id AND target.role='member')
    AND ${storeAccess('store_grant.organization_id')} RETURNING member_id AS memberId,0 AS granted`)
    .bind(input.storeId, actor.orgId, input.memberId, ...actorParameters(actor)).first<{ memberId: string; granted: number }>();
}
