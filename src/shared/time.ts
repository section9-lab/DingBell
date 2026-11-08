/**
 * Largest millisecond timestamp supported by both JavaScript dates and the
 * application's stored timestamps (9999-12-31T23:59:59.999Z).
 *
 * Used as the upper bound of every `v.number()` timestamp schema so invalid
 * values are rejected before they reach SQL arithmetic.
 */
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
