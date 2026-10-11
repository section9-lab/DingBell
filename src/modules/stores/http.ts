import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { companyFor, configured, limitedBody, signedIn } from '../identity/http.ts';
import { member } from '../identity/schema.ts';
import type { StoreDependencies } from './bindings.ts';
import { credentialConfig, CredentialError, decryptCredentials, encryptCredentials } from './credentials.ts';
import { capabilityCodes, inspectOzonCapabilities, unknownCapabilities, type StoreCapability } from './ozon.ts';
import { beginStoreCheck, changeStoreGrant, changeStoreState, findStore, finishStoreCheck, insertStore, listStoreGrants, listStores, rotateStoreCredentials, type StoreActor, type StoreRecord } from './storage.ts';

const apiKey = v.pipe(v.string(), v.minLength(1), v.maxLength(4096), v.regex(/^[\x21-\x7e]+$/));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const createBody = v.strictObject({
  id: v.pipe(v.string(), v.uuid()), name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  clientId: v.pipe(v.string(), v.regex(/^[0-9]{1,32}$/)), apiKey,
});
const revisionBody = v.strictObject({ expectedRevision: revision });
const credentialBody = v.strictObject({ expectedRevision: revision, apiKey });
const stateBody = v.strictObject({ expectedRevision: revision, state: v.picklist(['paused', 'unverified', 'disconnected']) });
const grantBody = v.strictObject({ expectedGranted: v.boolean(), granted: v.boolean() });
const capabilitySchema = v.array(v.strictObject({ code: v.picklist(capabilityCodes), status: v.picklist(['unknown', 'available', 'denied', 'unsupported']), reason: v.string() }));
const base = '/api/companies/:companyId/stores';

function actorFor(c: Context<ApplicationEnv>): StoreActor {
  const identity = c.get('identitySession');
  return { orgId: c.req.param('companyId')!, actorUserId: identity.user.id, sessionId: identity.session.id };
}
function invalid(c: Context<ApplicationEnv>) { return apiError(c, 'INVALID_REQUEST', 'Provide only the fields required for this operation.', 400); }
function notFound(c: Context<ApplicationEnv>) { return apiError(c, 'NOT_FOUND', 'The company or store is not available.', 404); }
function changed(c: Context<ApplicationEnv>) { return apiError(c, 'STORE_CHANGED', 'The store or its authorization changed. Refresh before retrying.', 409); }
function credentialsNotConfigured(c: Context<ApplicationEnv>) { return apiError(c, 'CREDENTIALS_NOT_CONFIGURED', 'Configure deployment encryption before connecting or checking stores.', 503); }
function credentialsUnavailable(c: Context<ApplicationEnv>) { return apiError(c, 'CREDENTIALS_UNAVAILABLE', 'Saved credentials cannot be opened. Restore their encryption key or replace the store credentials.', 503); }

function offsetFor(c: Context<ApplicationEnv>) {
  const value = c.req.query('offset') ?? '0';
  return /^(0|[1-9][0-9]{0,8})$/.test(value) ? Number(value) : null;
}

export function storeDTO(row: StoreRecord, now = Date.now()) {
  const expired = row.expiresAt !== null && row.expiresAt <= now;
  let capabilities: StoreCapability[] = unknownCapabilities(expired ? 'expired' : 'unverified');
  if (!expired && row.capabilities !== null) {
    const parsed = v.safeParse(capabilitySchema, (() => { try { return JSON.parse(row.capabilities); } catch { return null; } })());
    if (parsed.success && parsed.output.length === capabilityCodes.length && capabilityCodes.every((code, index) => parsed.output[index]?.code === code)) capabilities = parsed.output;
  }
  return {
    id: row.id, name: row.name, platform: row.platform, platformStoreId: row.platformStoreId,
    status: expired && ['verified', 'partial', 'attention'].includes(row.status) ? 'unverified' : row.status,
    revision: row.revision, credentialVersion: row.credentialVersion, hasCredentials: row.credentialCiphertext !== null,
    capabilities, checkedAt: row.checkedAt === null ? null : new Date(row.checkedAt).toISOString(),
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
    checking: row.checkToken !== null && row.checkUntil !== null && row.checkUntil > now,
  };
}

async function authorize(c: Context<ApplicationEnv>, manage: boolean, id?: string): Promise<Response | StoreRecord | null> {
  const actor = actorFor(c);
  const company = await companyFor(c, actor.orgId, actor.actorUserId);
  if (!company) return notFound(c);
  if (manage && company.role !== 'owner' && company.role !== 'admin') return apiError(c, 'FORBIDDEN', 'Only company owners and administrators may manage stores.', 403);
  if (!id) return null;
  return await findStore(c.env.DB!, actor, id, manage) ?? notFound(c);
}

function recordStore(c: Context<ApplicationEnv>, action: string, id: string, fromRevision: number | null = null, targetMemberId: string | null = null) {
  const actor = actorFor(c);
  return async (outcome: AuditOutcome) => {
    const toRevision = outcome === 'succeeded' && targetMemberId === null ? (fromRevision ?? 0) + 1 : null;
    await c.env.DB!.prepare(`INSERT INTO store_audit_event (id,request_id,organization_id,store_id,actor_user_id,action,outcome,target_member_id,from_revision,to_revision,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), c.get('requestId'), actor.orgId, id, actor.actorUserId,
      action, outcome, targetMemberId, fromRevision, toRevision, Date.now()).run();
  };
}

async function audit(c: Context<ApplicationEnv>, action: string, id: string, operation: () => Promise<Response>, fromRevision: number | null = null, targetMemberId: string | null = null) {
  const result = await auditedChange(recordStore(c, action, id, fromRevision, targetMemberId), operation);
  return result.auditComplete ? result.response : apiError(c, 'OPERATION_UNCONFIRMED', 'The store operation may have completed. Refresh the store to confirm.', 503);
}

async function currentDTO(c: Context<ApplicationEnv>, row: StoreRecord | null) {
  if (!row) return changed(c);
  const current = await findStore(c.env.DB!, actorFor(c), row.id);
  // The write already succeeded. Losing read access afterwards must not turn
  // its audit result into a rejected (unperformed) operation.
  return current ? jsonResponse(c, { store: storeDTO(current) }) : apiError(c, 'OPERATION_UNCONFIRMED', 'The store changed but access was revoked before confirmation.', 503);
}

export function registerStoreRoutes(app: Hono<ApplicationEnv>, deps: StoreDependencies = {}) {
  app.get(base, configured, signedIn, async c => {
    const permission = await authorize(c, false); if (permission instanceof Response) return permission;
    const offset = offsetFor(c); if (offset === null) return invalid(c);
    const rows = await listStores(c.env.DB!, actorFor(c), offset);
    return jsonResponse(c, { stores: rows.slice(0, 100).map(row => storeDTO(row)), configured: !!credentialConfig(c.env), nextOffset: rows.length > 100 ? offset + 100 : null });
  });

  app.post(base, configured, limitedBody, signedIn, async c => {
    const permission = await authorize(c, true); if (permission instanceof Response) return permission;
    const parsed = v.safeParse(createBody, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    if (!credentialConfig(c.env)) return credentialsNotConfigured(c);
    const input = parsed.output; const actor = actorFor(c);
    const envelope = await encryptCredentials(c.env, { orgId: actor.orgId, storeId: input.id, platformStoreId: input.clientId, credentialVersion: 1 }, { apiKey: input.apiKey });
    return audit(c, 'store.create', input.id, async () => {
      const row = await insertStore(c.env.DB!, actor, input, envelope);
      return row ? currentDTO(c, row) : apiError(c, 'STORE_EXISTS', 'The store already exists or the company authorization changed. Refresh the store list.', 409);
    });
  });

  app.get(`${base}/:storeId`, configured, signedIn, async c => {
    const row = await authorize(c, false, c.req.param('storeId'));
    return row instanceof Response ? row : row ? jsonResponse(c, { store: storeDTO(row) }) : notFound(c);
  });

  app.post(`${base}/:storeId/credentials`, configured, limitedBody, signedIn, async c => {
    const row = await authorize(c, true, c.req.param('storeId')); if (row instanceof Response) return row; if (!row) return notFound(c);
    const parsed = v.safeParse(credentialBody, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    if (row.revision !== parsed.output.expectedRevision) return changed(c);
    if (!credentialConfig(c.env)) return credentialsNotConfigured(c);
    const actor = actorFor(c);
    const envelope = await encryptCredentials(c.env, { orgId: actor.orgId, storeId: row.id, platformStoreId: row.platformStoreId, credentialVersion: row.credentialVersion + 1 }, { apiKey: parsed.output.apiKey });
    return audit(c, 'store.credentials.rotate', row.id, async () => currentDTO(c, await rotateStoreCredentials(c.env.DB!, actor, row.id, parsed.output.expectedRevision, envelope)), row.revision);
  });

  app.post(`${base}/:storeId/state`, configured, limitedBody, signedIn, async c => {
    const row = await authorize(c, true, c.req.param('storeId')); if (row instanceof Response) return row; if (!row) return notFound(c);
    const parsed = v.safeParse(stateBody, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    if (row.revision !== parsed.output.expectedRevision) return changed(c);
    if (parsed.output.state !== 'disconnected' && !row.credentialCiphertext) return apiError(c, 'STORE_CREDENTIALS_REQUIRED', 'Connect credentials before changing this store state.', 409);
    const action = { paused: 'store.pause', unverified: 'store.resume', disconnected: 'store.disconnect' }[parsed.output.state];
    return audit(c, action, row.id, async () => currentDTO(c, await changeStoreState(c.env.DB!, actorFor(c), row.id, parsed.output.expectedRevision, parsed.output.state)), row.revision);
  });

  app.post(`${base}/:storeId/check`, configured, limitedBody, signedIn, async c => {
    const row = await authorize(c, true, c.req.param('storeId')); if (row instanceof Response) return row; if (!row) return notFound(c);
    const parsed = v.safeParse(revisionBody, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    if (row.revision !== parsed.output.expectedRevision) return changed(c);
    if (!credentialConfig(c.env)) return credentialsNotConfigured(c);
    if (!row.credentialCiphertext || !row.credentialNonce || !row.credentialKeyVersion) return apiError(c, 'STORE_CREDENTIALS_REQUIRED', 'Connect credentials before checking this store.', 409);
    if (row.status === 'paused' || row.status === 'disconnected') return apiError(c, 'STORE_PAUSED', 'Resume the store before checking its connection.', 409);
    let secret: { apiKey: string };
    try { secret = await decryptCredentials(c.env, { orgId: row.organizationId, storeId: row.id, platformStoreId: row.platformStoreId, credentialVersion: row.credentialVersion }, { keyVersion: row.credentialKeyVersion, nonce: row.credentialNonce, ciphertext: row.credentialCiphertext }); }
    catch (error) { if (error instanceof CredentialError) return credentialsUnavailable(c); throw error; }
    const actor = actorFor(c); const token = crypto.randomUUID();
    return audit(c, 'store.check', row.id, async () => {
      const claimed = await beginStoreCheck(c.env.DB!, actor, row.id, row.revision, token);
      if (!claimed) {
        const current = await findStore(c.env.DB!, actor, row.id, true);
        if (!current || current.revision !== row.revision) return changed(c);
        if (current.checkUntil !== null && current.checkUntil > Date.now()) return apiError(c, 'STORE_BUSY', 'A connection check is already running.', 409);
        if (current.nextCheckAt !== null && current.nextCheckAt > Date.now()) return apiError(c, 'CHECK_RATE_LIMITED', 'Wait briefly before checking this store again.', 429);
        return changed(c);
      }
      const capabilities = await inspectOzonCapabilities({ clientId: row.platformStoreId, apiKey: secret.apiKey }, deps.storeFetch);
      return currentDTO(c, await finishStoreCheck(c.env.DB!, actor, { id: row.id, revision: row.revision, credentialVersion: row.credentialVersion, token }, capabilities));
    }, row.revision);
  });

  app.get(`${base}/:storeId/grants`, configured, signedIn, async c => {
    const row = await authorize(c, true, c.req.param('storeId')); if (row instanceof Response) return row; if (!row) return notFound(c);
    const offset = offsetFor(c); if (offset === null) return invalid(c);
    const members = await listStoreGrants(c.env.DB!, actorFor(c), row.id, offset);
    return jsonResponse(c, { members: members.slice(0, 100), nextOffset: members.length > 100 ? offset + 100 : null });
  });

  app.post(`${base}/:storeId/grants/:memberId`, configured, limitedBody, signedIn, async c => {
    const row = await authorize(c, true, c.req.param('storeId')); if (row instanceof Response) return row; if (!row) return notFound(c);
    const parsed = v.safeParse(grantBody, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    const actor = actorFor(c); const memberId = c.req.param('memberId');
    const target = await c.get('identity').db.select({ role: member.role }).from(member).where(and(eq(member.id, memberId), eq(member.organizationId, actor.orgId))).get();
    if (!target) return notFound(c);
    if (target.role !== 'member') return apiError(c, 'FORBIDDEN', 'Owners and administrators already have access to all stores.', 403);
    return audit(c, parsed.output.granted ? 'store.grant.add' : 'store.grant.revoke', row.id, async () => {
      const result = await changeStoreGrant(c.env.DB!, actor, { storeId: row.id, memberId, ...parsed.output });
      return result ? jsonResponse(c, { memberId: result.memberId, granted: !!result.granted }) : apiError(c, 'GRANT_CHANGED', 'The grant or membership changed. Refresh access permissions.', 409);
    }, null, memberId);
  });
}
