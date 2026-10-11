export type ReplyStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped' | 'canceled';
export type ReplyRejectCode = 'OUTBOUND_DISABLED' | 'CAPABILITY_UNVERIFIED' | 'REPLY_UNAVAILABLE';
export interface ReplyTranslation {
  requestId:string;runId:string;sourceRevision:number;sourceHash:string;outputHash:string;confirmedBodyHash:string;
}
interface ReplyIntentFields {
  id: string;
  commandId: string;
  body: string;
  bodyHash: string;
  platformThreadId: string;
  credentialVersion: number;
  controlEpoch: number;
  state: ReplyStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  lastError: string | null;
}
export interface HumanReplyIntent extends ReplyIntentFields { schemaVersion:1;actorUserId:string;actorMemberId:string }
export interface AiReplyIntent extends ReplyIntentFields { schemaVersion:2;origin:'ai';runId:string;actorUserId:null;actorMemberId:null }
export type ReplyIntent=HumanReplyIntent|AiReplyIntent;
export interface ReplyAttempt {
  id: string;
  intentId: string;
  state: 'sending' | 'sent' | 'failed' | 'unknown';
  startedAt: number;
  deadlineAt: number;
  finishedAt: number | null;
  httpStatus: number | null;
  providerResult: 'success' | null;
  errorCode: string | null;
}
export interface ReplySnapshot { intent: ReplyIntent; attempt: ReplyAttempt | null }
export interface ReplyView {
  intentId: string;
  commandId: string;
  body: string;
  previewRequestId?: string;
  status: ReplyStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  reason: string | null;
  attempt: {
    id: string;
    status: ReplyAttempt['state'];
    startedAt: number;
    finishedAt: number | null;
    httpStatus: number | null;
    providerResult: 'success' | null;
    errorCode: string | null;
  } | null;
}
export type ReplyReadResult = { outcome: 'found'; reply: ReplyView } | { outcome: 'not_found' };
export type ReplyListReadResult = { outcome: 'not_found' } | {
  outcome: 'found';
  viewerMemberId: string;
  controlVersion: number;
  historyReady: boolean;
  readiness: { allowed: boolean; code: ReplyRejectCode | null };
  replies: ReplyView[];
};
