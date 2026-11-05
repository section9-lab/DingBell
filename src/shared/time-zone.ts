// Named zones retain daylight-saving rules; numeric offsets do not.
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return null; }
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
function partsAt(value: number, timeZone: string) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(values.find(part => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}
export function parseLocalDate(value: string) {
  const match = datePattern.exec(value); if (!match) throw new RangeError('INVALID_LOCAL_DATE');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError('INVALID_LOCAL_DATE');
  return { year, month, day };
}
// Calendar day of an instant as it reads in the company zone.
export function localDate(value: number, timeZone: string) {
  const p = partsAt(value, timeZone);
  return `${p.year.toString().padStart(4, '0')}-${p.month.toString().padStart(2, '0')}-${p.day.toString().padStart(2, '0')}`;
}
export function nextDate(value: string) {
  const p = parseLocalDate(value), next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return next.toISOString().slice(0, 10);
}
// First instant of a company-local calendar day; used to turn inclusive date ranges into [from,to) instants.
export function zonedStart(value: string, timeZone: string) {
  const target = parseLocalDate(value), targetWall = Date.UTC(target.year, target.month - 1, target.day); let instant = targetWall;
  for (let i = 0; i < 4; i++) {
    const p = partsAt(instant, timeZone), wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second), delta = targetWall - wall;
    if (delta === 0) break;
    instant += delta;
  }
  const result = partsAt(instant, timeZone);
  if (result.year !== target.year || result.month !== target.month || result.day !== target.day || result.hour !== 0 || result.minute !== 0 || result.second !== 0) throw new RangeError('UNSUPPORTED_LOCAL_DATE');
  return instant;
}
