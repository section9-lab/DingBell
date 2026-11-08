/**
 * Backoff for the durable reply observer. Each observation is a Durable Object wake plus a
 * D1 read, so a slow provider run must not cost one poll per second for the whole deadline.
 */
export const replyWakeDelaysMs = [1_000, 2_000, 3_000, 5_000, 8_000] as const;

export function replyWakeDelay(attempts: number): number {
  if (!Number.isFinite(attempts)) throw new RangeError('INVALID_REPLY_WAKE_ATTEMPTS');
  const index = Math.min(Math.max(Math.trunc(attempts), 0), replyWakeDelaysMs.length - 1);
  return replyWakeDelaysMs[index]!;
}
