import * as v from 'valibot';
import { request } from './api.ts';

export type MemberRole = 'owner' | 'admin' | 'member';

export async function changeMember(companyId: string, memberId: string, expectedRole: MemberRole, role: MemberRole | null, password?: string) {
  return request(`/api/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(memberId)}/${role === null ? 'remove' : 'role'}`,
    v.object({ memberId: v.literal(memberId), role: role === null ? v.null() : v.literal(role) }), {
      method: 'POST', body: JSON.stringify({ expectedRole, ...(role === null ? {} : { role }), ...(password ? { password } : {}) }),
    });
}
