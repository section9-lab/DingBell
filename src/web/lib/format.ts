/**
 * Shared number/date formatting.
 *
 * `Intl` formatters are comparatively expensive to construct, so every helper
 * reuses a module-level instance instead of creating one per render.
 */

const integer = new Intl.NumberFormat('zh-CN');
const cny = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const compactCny = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatInteger(value: number): string {
  return integer.format(value);
}

/** `cents` is an integer amount in CNY cents, as returned by the accounting API. */
export function formatCny(cents: number | null): string {
  return cents === null ? '—' : cny.format(cents / 100);
}

export function formatCompactCny(cents: number): string {
  return compactCny.format(cents / 100);
}

/** Formats a 0..1 ratio as a percentage. `null` means "not enough data". */
export function formatPercent(ratio: number | null, digits = 1): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(digits)}%`;
}

export function formatDuration(milliseconds: number | null, empty = '—'): string {
  if (milliseconds === null) return empty;
  return milliseconds < 60_000
    ? `${(milliseconds / 1000).toFixed(1)} 秒`
    : `${(milliseconds / 60_000).toFixed(1)} 分钟`;
}
