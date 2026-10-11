import type { ReplyRejectCode, ReplyTranslation } from './reply-types.ts';
import type { StoreActor } from '../stores/storage.ts';
import type {AiReceipt} from './ai-state.ts';
import type {AiListeningReceipt} from './ai-listening.ts';
import type {InboundReceipt} from './inbound.ts';
import type {AiIntakeReceipt,AiDispatchStopReceipt} from './ai-intake.ts';
import type {AiSendReceipt} from './ai-reply-receipt.ts';

export type WorkStatus = 'needs_reply' | 'waiting_customer' | 'waiting_internal';
export type ControlAction = 'claim' | 'takeover' | 'resolve' | 'reopen' | 'set_work_status' | 'transfer' | 'add_note' | 'send_reply' | 'cancel_reply';
export type ControlActor = StoreActor & { expectedMemberId?: string };
export interface ControlScope {
  organizationId: string;
  storeId: string;
  conversationId: string;
  controllerId: string;
}
interface ControlStateFields {
  version: number;
  controlEpoch: number;
  sequence: number;
  lifecycle: 'open' | 'resolved';
  reception: 'paused' | 'human' | 'ai';
  assignedMemberId: string | null;
  updatedAt: number;
}
export interface LegacyControlState extends Omit<ControlStateFields,'reception'> { schemaVersion: 1; reception:'paused'|'human' }
export type ControlState = ControlStateFields & { schemaVersion: 2 } & (
  | { lifecycle: 'open'; workStatus: WorkStatus }
  | { lifecycle: 'resolved'; workStatus: null }
);
export type StoredControlState = LegacyControlState | ControlState;
export type ControlCommand = {
  commandId: string;
  expectedVersion: number;
} & (
  | { action: Exclude<ControlAction, 'set_work_status' | 'transfer' | 'add_note' | 'send_reply' | 'cancel_reply'> }
  | { action: 'set_work_status'; workStatus: WorkStatus }
  | { action: 'transfer'; targetMemberId: string; reason: string }
  | { action: 'add_note'; body: string }
  | { action: 'send_reply'; body: string; previewRequestId?: string }
  | { action: 'cancel_reply'; targetIntentId: string }
);
interface ReceiptFields {
  actorUserId: string;
  actorMemberId: string;
  appliedState: StoredControlState;
}
export type ControlReceipt =
  | (Exclude<ControlCommand, { action: 'add_note' | 'send_reply' }> & ReceiptFields)
  | (Extract<ControlCommand, { action: 'add_note' }> & ReceiptFields & { authorName: string })
  | (Extract<ControlCommand, { action: 'send_reply' }> & ReceiptFields & { intentId: string; translation?: ReplyTranslation });
export interface ControlEvent {
  scope: ControlScope;
  receipt: ControlReceipt;
}
export type ControlOutboxEvent=ControlEvent|{scope:ControlScope;receipt:AiReceipt|AiListeningReceipt|InboundReceipt|AiIntakeReceipt|AiDispatchStopReceipt|AiSendReceipt};
export interface ControlView {
  state: ControlState;
  viewerMemberId: string;
  projectionPending: boolean;
}
export type ControlReadResult = { outcome: 'found'; view: ControlView } | { outcome: 'not_found' };
export type ControlCommandResult =
  | { outcome: 'accepted'; receipt: ControlReceipt; view: ControlView }
  | { outcome: 'rejected'; code: ReplyRejectCode | 'PREVIEW_UNAVAILABLE' | 'REPLY_NOT_CANCELABLE'; view: ControlView }
  | { outcome: 'conflict'; reason: 'version' | 'command' | 'state' | 'target'; view: ControlView }
  | { outcome: 'not_found' };
export interface ControlDirectory {
  scope: ControlScope;
  state: StoredControlState;
  repairDueAt: number;
}
export interface ControlAccess {
  organizationId: string;
  storeId: string;
  conversationId: string;
  memberId: string;
  memberName: string;
  targetEligible: boolean;
  directory: ControlDirectory | null;
}
export interface TransferTarget {
  memberId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}
export interface TransferTargetsPage {
  targets: TransferTarget[];
  nextOffset: number | null;
}
export type ControlAssignee =
  | { memberId: string; name: string; status: 'eligible' | 'ineligible' }
  | { memberId: string; name: null; status: 'removed' };
export interface ControlNote {
  commandId: string;
  sequence: number;
  body: string;
  authorMemberId: string;
  authorName: string;
  createdAt: number;
}
export type ControlNotesReadResult =
  | { outcome: 'not_found' }
  | { outcome: 'found'; notes: ControlNote[]; nextBeforeSequence: number | null };
