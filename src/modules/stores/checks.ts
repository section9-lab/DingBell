import { credentialConfig, decryptCredentials, type CredentialBindings } from './credentials.ts';
import { inspectOzonCapabilities } from './ozon.ts';
import { capabilityStatus } from './storage.ts';
import { logEvent, logFailure } from '../../platform/log.ts';

type Row = {
  id: string; orgId: string; platformStoreId: string; credentialVersion: number; revision: number;
  keyVersion: string; nonce: string; ciphertext: string;
};

/**
 * A verified check is only valid for 24 hours, and an expired check silently blocks every
 * outbound reply (including AI). Refresh read capabilities before they lapse instead of
 * waiting for a human to press the button.
 */
export async function renewExpiringStoreChecks(
  env: CredentialBindings & { DB?: D1Database },
  deps: { fetcher?: typeof fetch; now?: number } = {},
): Promise<number> {
  if (!env.DB || !credentialConfig(env)) return 0;
  const now = deps.now ?? Date.now();
  const rows = (await env.DB.prepare(`SELECT id,organization_id AS orgId,platform_store_id AS platformStoreId,credential_version AS credentialVersion,revision,
      credential_key_version AS keyVersion,credential_nonce AS nonce,credential_ciphertext AS ciphertext
    FROM store WHERE status IN ('verified','partial','attention')
      AND credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL AND credential_key_version IS NOT NULL
      AND expires_at IS NOT NULL AND expires_at<=? AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY expires_at LIMIT 5`)
    .bind(now + 3_600_000, now).all<Row>()).results;
  let renewed = 0;
  for (const row of rows) {
    try {
      // Throttle retries to once an hour per store, even when the provider call fails.
      const claim = await env.DB.prepare('UPDATE store SET next_check_at=? WHERE id=? AND organization_id=? AND (next_check_at IS NULL OR next_check_at<=?)')
        .bind(now + 3_600_000, row.id, row.orgId, now).run();
      if (claim.meta.changes !== 1) continue;
      const { apiKey } = await decryptCredentials(env, {
        orgId: row.orgId, storeId: row.id, platformStoreId: row.platformStoreId, credentialVersion: row.credentialVersion,
      }, { keyVersion: row.keyVersion, nonce: row.nonce, ciphertext: row.ciphertext });
      const capabilities = await inspectOzonCapabilities({ clientId: row.platformStoreId, apiKey }, deps.fetcher ?? fetch, new Date(now));
      if (capabilities[0]?.status !== 'available') {
        logEvent('store.check.renew_failed', { storeId: row.id, auth: capabilities[0]?.status ?? 'unknown' });
        continue;
      }
      const status = capabilityStatus(capabilities);
      const changed = await env.DB.prepare(`UPDATE store SET capabilities=?,status=?,checked_at=?,expires_at=?+86400000,revision=revision+1,updated_at=?
        WHERE id=? AND organization_id=? AND revision=? AND credential_version=? AND status NOT IN ('paused','disconnected')`)
        .bind(JSON.stringify(capabilities), status, now, now, now, row.id, row.orgId, row.revision, row.credentialVersion).run();
      if (changed.meta.changes === 1) {
        renewed += 1;
        logEvent('store.check.renewed', { storeId: row.id, status, expiresAt: new Date(now + 86_400_000).toISOString() });
      }
    } catch (error) {
      logFailure('store.check.renew_failed', error, { storeId: row.id });
    }
  }
  return renewed;
}
