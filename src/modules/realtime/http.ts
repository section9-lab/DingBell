import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { apiError, type ApplicationEnv } from '../../http.ts';
import { configured, signedIn, companyFor } from '../identity/http.ts';
import { storeAccess } from '../stores/storage.ts';
import { pushHash } from '../ozon-push/security.ts';

// Each frame rechecks authorization. Changing this interval affects both revocation
// latency and database load; tune only after measuring production capacity.
const FRAME_INTERVAL_MS = 1_000;
const STREAM_LIFETIME_MS = 25_000;
const RECONNECT_DELAY_MS = 2_000;
const MAX_VISIBLE_STORES = 1_000;

type StoreRevision = { storeId: string; revision: number; messageStatusRevision: number };

/** Browser invalidation only: this stream never calls Ozon or carries business bodies or secrets. */
export function registerRealtimeRoutes(app: Hono<ApplicationEnv>) {
  app.get('/api/companies/:companyId/events', configured, signedIn, async c => {
    const identity = c.get('identitySession');
    const orgId = c.req.param('companyId')!, db = c.env.DB!;
    const actorId = identity.user.id, sessionId = identity.session.id;
    if (new URL(c.req.url).search) return apiError(c, 'INVALID_REQUEST', 'Unexpected stream parameters.', 400);
    if (!await companyFor(c, orgId, actorId)) return apiError(c, 'NOT_FOUND', 'Company unavailable.', 404);
    const previous = c.req.header('Last-Event-ID') ?? '';
    if (previous && !/^[a-f0-9]{64}$/.test(previous)) return apiError(c, 'INVALID_REQUEST', 'Invalid stream position.', 400);
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async stream => {
      let aborted = false, fingerprint = previous;
      const expires = Date.now() + STREAM_LIFETIME_MS;
      stream.onAbort(() => { aborted = true; });
      await stream.writeSSE({ event: 'connected', data: '{}', retry: RECONNECT_DELAY_MS });
      while (!aborted && Date.now() < expires) {
        const access = await db.prepare(`SELECT member.id AS memberId,member.role FROM member JOIN user ON user.id=member.user_id JOIN session ON session.user_id=user.id WHERE member.organization_id=? AND user.id=? AND session.id=? AND session.expires_at>CAST(unixepoch('subsecond')*1000 AS INTEGER) AND user.email_verified=1`)
          .bind(orgId, actorId, sessionId).first<{ memberId: string; role: string }>();
        if (!access) {
          await stream.writeSSE({ event: 'access_revoked', data: '{}' });
          break;
        }
        // Read one extra row so an oversized scope fails closed rather than silently truncating.
        const stores = (await db.prepare(`SELECT store.id AS storeId,COALESCE(changes.revision,0) AS revision,COALESCE(changes.message_status_revision,0) AS messageStatusRevision FROM store LEFT JOIN store_change_revision AS changes ON changes.store_id=store.id AND changes.organization_id=store.organization_id
     WHERE store.organization_id=? AND ${storeAccess('store.organization_id', false)} ORDER BY store.id LIMIT ?`)
          .bind(orgId, actorId, sessionId, MAX_VISIBLE_STORES + 1).all<StoreRevision>()).results;
        if (stores.length > MAX_VISIBLE_STORES) {
          await stream.writeSSE({ event: 'capacity_exceeded', data: '{}' });
          break;
        }
        const next = await pushHash(JSON.stringify([orgId, sessionId, access, stores]));
        if (aborted) break;
        if (next !== fingerprint) {
          fingerprint = next;
          await stream.writeSSE({ event: 'sync', id: fingerprint, data: JSON.stringify({ stores, viewerRole: access.role }) });
        }
        await stream.sleep(FRAME_INTERVAL_MS);
      }
    });
  });
}
