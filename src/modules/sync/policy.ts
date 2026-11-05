/** Scheduling and failure policy for Ozon synchronization. Times are milliseconds. */
const HISTORY_CONTINUATION_MS = 1_000;
const HISTORY_ACTIVE_MS = 60_000;
const HISTORY_IDLE_MS = 900_000;
const MAX_PROVIDER_RETRY_AFTER_MS = 86_400_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_RETRY_EXPONENT = 6;
const MAX_TRANSIENT_FAILURES = 4;

const permissionErrors: Readonly<Record<string, string>> = {
  discovery: 'chat_list_permission_denied',
  'product-list': 'product_list_permission_denied',
  'product-details': 'product_details_permission_denied',
  'fbs-list': 'fbs_list_permission_denied',
  'fbs-detail': 'fbs_details_permission_denied',
  'fbo-list': 'fbo_list_permission_denied',
  'fbo-detail': 'fbo_details_permission_denied',
  'fbp-list': 'fbp_list_permission_denied',
  'fbp-detail': 'fbp_details_permission_denied',
};

const credentialErrors = new Set(['invalid_credentials', 'credentials_unavailable']);
const terminalErrors = new Set([
  ...credentialErrors,
  ...Object.values(permissionErrors),
  'chat_history_permission_denied',
  'invalid_request',
  'redirect_refused',
  'cursor_stalled',
]);

export interface SyncFailureDecision {
  code: string;
  nextDueAt: number;
  disable: boolean;
  blockedUntil?: number;
  disableAll?: boolean;
}

// Discovery finds new messages; a slow idle sweep is a safety net that avoids
// saturating the store's shared provider request budget.
export function historyDueIn(hasNext: boolean, messageCount: number): number {
  if (hasNext) return HISTORY_CONTINUATION_MS;
  return messageCount > 0 ? HISTORY_ACTIVE_MS : HISTORY_IDLE_MS;
}

export function retrySyncFailure(
  error: { code: string; retryAfterMs?: number },
  stream: string,
  failures: number,
  now: number,
  jitter = Math.random(),
): SyncFailureDecision {
  const code = error.code === 'permission_denied'
    ? (Object.hasOwn(permissionErrors, stream) ? permissionErrors[stream] : undefined) ?? 'chat_history_permission_denied'
    : error.code;
  const wait = error.retryAfterMs ?? 0;
  if (wait > MAX_PROVIDER_RETRY_AFTER_MS) {
    return {
      code: 'retry_after_requires_review',
      nextDueAt: now,
      disable: true,
      blockedUntil: Math.min(MAX_TIMESTAMP_MS, now + wait),
    };
  }
  const backoff = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** Math.min(failures, MAX_RETRY_EXPONENT));
  const delay = Math.max(wait, backoff * (1 + Math.max(0, Math.min(1, jitter))));
  return {
    code,
    nextDueAt: now + delay,
    disable: terminalErrors.has(code) || failures >= MAX_TRANSIENT_FAILURES,
    ...(credentialErrors.has(code) ? { disableAll: true } : {}),
    ...(code === 'rate_limited' ? { blockedUntil: now + delay } : {}),
  };
}
