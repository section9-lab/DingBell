import { DurableObject } from 'cloudflare:workers';
import { createConversationController } from './controller-core.ts';
export const ConversationController = createConversationController(DurableObject);
export type ConversationController = InstanceType<typeof ConversationController>;
