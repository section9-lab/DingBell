import { isOzonImageHost } from './ozon-image.ts';

// Ozon history stores image references as plain URLs or standalone Markdown images.
// This is deliberately not an HTML/Markdown renderer or a general-purpose URL proxy.
export function messageImageReference(
  content: string,
): { url: string; authenticated: boolean } | null {
  if (content.length > 4096) return null;
  const text = content.trim();
  const candidate = /^!\[[^\]\r\n]*\]\((https:\/\/[^\s()]+)\)$/.exec(text)?.[1] ?? text;
  if (!candidate.startsWith('https://') || /[\s\\\u0000-\u001f\u007f]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return null;
    if (url.hostname === 'api-seller.ozon.ru') {
      // No encoded paths, traversal, query overrides or arbitrary Seller API endpoints.
      if (
        url.search ||
        candidate !== url.href ||
        !/^\/v2\/chat\/file\/(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp)$/i.test(
          url.pathname,
        )
      )
        return null;
      return { url: url.href, authenticated: true };
    }
    if (isOzonImageHost(url.hostname)) return { url: url.href, authenticated: false };
  } catch {
    /* Untrusted message content is not a URL. */
  }
  return null;
}

export function messageImagePath(
  companyId: string,
  conversationId: string,
  messageId: string,
  index: number,
) {
  return `/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/images/${index}`;
}
