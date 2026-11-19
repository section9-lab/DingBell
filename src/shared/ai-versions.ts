/** Frozen prompt versions. A new tool surface must never rewrite an in-flight run. */
export const SUPPORT_REPLY_V2 = 'support-reply-v2';
/** Adds the customer-safe product service profile (description, attributes, availability). */
export const SUPPORT_REPLY_V3 = 'support-reply-v3';
export const SUPPORT_REPLY_VERSIONS = [SUPPORT_REPLY_V2, SUPPORT_REPLY_V3] as const;
export const SUPPORT_KNOWLEDGE_VERSIONS = [SUPPORT_REPLY_V2, SUPPORT_REPLY_V3] as const;
/** New runs use the current surface; existing runs keep the version they were frozen with. */
export const SUPPORT_REPLY_CURRENT = SUPPORT_REPLY_V3;
export type SupportReplyVersion = typeof SUPPORT_REPLY_VERSIONS[number];
export function isOutboundPromptVersion(version: string): version is SupportReplyVersion {
  return version === SUPPORT_REPLY_V2 || version === SUPPORT_REPLY_V3;
}
export function isSupportKnowledgePromptVersion(version: string): boolean {
  return version === SUPPORT_REPLY_V2 || version === SUPPORT_REPLY_V3;
}
