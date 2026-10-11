// Named zones retain daylight-saving rules; numeric offsets do not.
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return null; }
}
