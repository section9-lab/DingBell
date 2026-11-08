/**
 * Maximum character count of an outbound human reply.
 *
 * Shared by the composer counter, local drafts and the request schemas so the
 * UI never accepts text the API will reject.
 */
export const REPLY_BODY_MAX = 1000;
