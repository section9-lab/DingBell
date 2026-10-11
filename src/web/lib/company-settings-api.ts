import * as v from 'valibot';
import { canonicalTimeZone } from '../../shared/time-zone.ts';
import { request } from './api.ts';

const schema = (companyId: string) => v.object({
  companyId: v.literal(companyId),
  timeZone: v.pipe(v.string(), v.check(value => canonicalTimeZone(value) !== null)),
  version: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  updatedAt: v.nullable(v.pipe(v.string(), v.isoTimestamp(), v.check(value => Number.isFinite(Date.parse(value))))),
  canManage: v.boolean(),
});
const path = (companyId: string) => `/api/companies/${encodeURIComponent(companyId)}/settings`;
export type CompanySettings = v.InferOutput<ReturnType<typeof schema>>;
export function readCompanySettings(companyId: string, signal?: AbortSignal) {
  return request(path(companyId), schema(companyId), { signal });
}
export function saveCompanySettings(companyId: string, timeZone: string, expectedVersion: number) {
  return request(path(companyId), schema(companyId), { method: 'POST', body: JSON.stringify({ timeZone, expectedVersion }) });
}
