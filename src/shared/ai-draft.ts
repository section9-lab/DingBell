import * as v from 'valibot';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const text=v.pipe(v.string(),v.maxLength(1000),v.check(s=>!!s.trim()&&s.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)));
const hash=v.pipe(v.string(),v.regex(/^[0-9a-f]{64}$/));
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s));
const draft=v.pipe(v.strictObject({runId:v.pipe(v.string(),v.uuid()),body:text,question:text,language:v.picklist(['ru','zh-CN','en']),createdAt:timestamp,
 status:v.picklist(['current','stale']),reason:v.nullable(v.picklist(['new_input','source_changed','policy_changed','conversation_changed','changed'])),
 citations:v.pipe(v.array(v.strictObject({documentId:v.pipe(v.string(),v.uuid()),revision:v.pipe(v.number(),v.integer(),v.minValue(1)),chunkId:hash,title:v.pipe(v.string(),v.maxLength(160)),body:v.pipe(v.string(),v.maxLength(8192))})),v.minLength(1),v.maxLength(10)),
}),v.check(d=>(d.status==='current')===(d.reason===null)&&new Set(d.citations.map(c=>c.chunkId)).size===d.citations.length));
export const aiDraftSchema=v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,canSend:v.literal(false),draft:v.nullable(draft)});
export type AiDraft=v.InferOutput<typeof aiDraftSchema>;
