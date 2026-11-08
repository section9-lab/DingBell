/** Frozen prompt versions. A new tool surface must never rewrite an in-flight run. */
export const SUPPORT_REPLY_V2 = 'support-reply-v2';
export const SUPPORT_REPLY_VERSIONS = [SUPPORT_REPLY_V2] as const;
export const SUPPORT_KNOWLEDGE_VERSIONS = [SUPPORT_REPLY_V2] as const;
export type SupportReplyVersion = typeof SUPPORT_REPLY_VERSIONS[number];
export function isOutboundPromptVersion(version: string): version is SupportReplyVersion {
  return version === SUPPORT_REPLY_V2;
}
export function isSupportKnowledgePromptVersion(version: string): boolean {
  return version === SUPPORT_REPLY_V2;
}
