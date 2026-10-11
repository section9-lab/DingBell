import type { SyncBindings } from '../sync/bindings.ts';
import type { ConversationController } from './controller.ts';

export interface ControlBindings extends SyncBindings {
  OUTBOUND_ENABLED?:string;
  AI_RECEPTION_ENABLED?:string;
  AI_OUTBOUND_ENABLED?:string;
  DB?:D1Database;
  CONVERSATION_CONTROLLER?:DurableObjectNamespace<ConversationController>;
}
export function getConversationController(env:ControlBindings,controllerId:string) {
  if(!env.CONVERSATION_CONTROLLER)throw new Error('CONTROL_RUNTIME_UNAVAILABLE');
  return env.CONVERSATION_CONTROLLER.get(env.CONVERSATION_CONTROLLER.idFromName(controllerId));
}
