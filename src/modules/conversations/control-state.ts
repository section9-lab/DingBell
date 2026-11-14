import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import * as v from 'valibot';
import { REPLY_BODY_MAX } from '../../shared/reply-body.ts';
import type { ControlState } from './control-types.ts';

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const counter = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const fields = {
  version: counter, controlEpoch: counter, sequence: counter,
  lifecycle: v.picklist(['open', 'resolved']), reception: v.picklist(['paused', 'human', 'ai']),
  assignedMemberId: v.nullable(identifier),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_TIMESTAMP_MS)),
};
const workStatus = v.picklist(['needs_reply', 'waiting_customer', 'waiting_internal']);
const currentState = v.pipe(v.strictObject({ ...fields, schemaVersion: v.literal(2), workStatus: v.nullable(workStatus) }),
  v.check(state => (state.lifecycle === 'resolved' ? state.workStatus === null : state.workStatus !== null)
    &&(state.reception!=='ai'||state.lifecycle==='open'&&state.workStatus==='needs_reply'&&state.assignedMemberId===null)));
export const storedControlStateSchema = v.union([v.strictObject({ ...fields, reception:v.picklist(['paused','human']),schemaVersion: v.literal(1) }), currentState]);
const commandFields = { commandId: identifier, expectedVersion: v.pipe(counter, v.maxValue(Number.MAX_SAFE_INTEGER - 1)) };
export const noteBodySchema = v.pipe(v.string(), v.maxLength(4000),
  v.check(body => body.trim().length > 0 && body.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)));
export const replyBodySchema = v.pipe(v.string(), v.maxLength(REPLY_BODY_MAX),
  v.check(body => body.trim().length > 0 && body.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)));
export const controlCommandSchema = v.union([
  v.strictObject({ ...commandFields, action: v.picklist(['claim', 'takeover', 'resolve', 'reopen']) }),
  v.strictObject({ ...commandFields, action: v.literal('set_work_status'), workStatus }),
  v.strictObject({ ...commandFields, action: v.literal('transfer'), targetMemberId: identifier,
    reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)) }),
  v.strictObject({ ...commandFields, action: v.literal('add_note'), body: noteBodySchema }),
  v.strictObject({ ...commandFields, action: v.literal('send_reply'), body: replyBodySchema }),
  v.strictObject({ ...commandFields, action: v.literal('cancel_reply'), targetIntentId: v.pipe(v.string(),v.uuid()) }),
]);

export function normalizeControlState(value: unknown): ControlState {
  const parsed = v.safeParse(storedControlStateSchema, value);
  if (!parsed.success) throw new Error('UNSUPPORTED_CONTROL_STATE');
  const state = parsed.output;
  return { ...state, schemaVersion: 2, workStatus: state.schemaVersion === 1 ? state.lifecycle === 'open' ? 'needs_reply' : null : state.workStatus } as ControlState;
}
