import type { KnowledgeDraft, KnowledgeScope } from '../../shared/knowledge.ts';

export async function knowledgeHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function prepareKnowledge(orgId: string, documentId: string, revision: number, scope: KnowledgeScope, draft: KnowledgeDraft) {
  const contentHash = await knowledgeHash({ kind: scope.kind, storeId: scope.storeId, productRef: scope.productRef, language: scope.language, ...draft });
  const content = draft.source.format === 'product' ? draft.source.facts.map(fact => `${fact.label}: ${fact.value}`).join('\n') : draft.source.content;
  const header = `${draft.title}\n${scope.productRef ? `商品 / Product: ${scope.productRef}\n` : ''}\n`;
  const encoder = new TextEncoder(), budget = 2400 - encoder.encode(header).length, chars = Array.from(content);
  const chunks: { id: string; ordinal: number; body: string; bodyHash: string }[] = [];
  for (let start = 0; start < chars.length;) {
    let end = start, size = 0, boundary = -1;
    while (end < chars.length && size + encoder.encode(chars[end]).length <= budget) {
      size += encoder.encode(chars[end]).length;
      if (chars[end] === '\n' && size > budget / 2) boundary = end + 1;
      end++;
    }
    if (end < chars.length && boundary > start) end = boundary;
    const body = header + chars.slice(start, end).join(''), bodyHash = await knowledgeHash(body), ordinal = chunks.length;
    chunks.push({ id: await knowledgeHash([orgId, documentId, revision, ordinal, bodyHash]), ordinal, body, bodyHash });
    if (end === chars.length) break;
    let next = end, overlap = 0;
    while (next > start + 1 && overlap + encoder.encode(chars[next - 1]).length <= 200) overlap += encoder.encode(chars[--next]).length;
    start = next;
  }
  return { ...draft, contentHash, chunks };
}
export type PreparedKnowledge = Awaited<ReturnType<typeof prepareKnowledge>>;
