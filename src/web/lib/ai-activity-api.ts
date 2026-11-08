import { request } from './api.ts';
import { aiActivitySchema, type AiActivity } from '../../shared/ai-activity.ts';

const path = (companyId: string, conversationId: string) => `/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/ai-activity`;

export function readAiActivity(companyId: string, conversationId: string, memberId: string, signal?: AbortSignal): Promise<AiActivity> {
  return request(path(companyId, conversationId), aiActivitySchema, {
    headers: { 'X-DingBell-Member-Id': encodeURIComponent(memberId) },
    signal,
  });
}
