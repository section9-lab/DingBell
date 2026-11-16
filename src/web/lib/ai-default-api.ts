import * as v from 'valibot';
import { request } from './api.ts';

const path = (companyId: string) => `/api/companies/${encodeURIComponent(companyId)}/ai-reception-default`;
const schema = (companyId: string) => v.object({
  companyId: v.literal(companyId),
  enabled: v.boolean(),
  updatedAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  canManage: v.boolean(),
});
export type DefaultReception = v.InferOutput<ReturnType<typeof schema>>;
export function readDefaultReception(companyId: string, signal?: AbortSignal) {
  return request(path(companyId), schema(companyId), { signal });
}
export function saveDefaultReception(companyId: string, enabled: boolean) {
  return request(path(companyId), schema(companyId), { method: 'POST', body: JSON.stringify({ enabled }) });
}
