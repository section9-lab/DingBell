// Deliberately synthetic, test-only content. No customer data or external requests.
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const timestamp = Date.parse('2026-10-09T09:01:00Z');
export const unsafeMessageText = '<img src="https://message-fixture.invalid/pixel" onerror="window.__messageInjected = true">';
export const messageImageURL = 'https://message-fixture.invalid/private-image.png';
export const fragmentedMessageParts = Array.from({ length: 1000 }, (_, index) => `原文片段 ${String(index + 1).padStart(4, '0')}`);

export function conversationHistoryFixture(storeId: string, options: { neighbors?: number; unsafe?: boolean; fragments?: boolean } = {}) {
  const id = crypto.randomUUID();
  const threadId = `fixture-${id}`;
  const messageId = (index: number) => `9100000000000000${String(index).padStart(3, '0')}`;
  const messageSQL = (index: number, eventAt = timestamp) => {
    const image = options.unsafe && index === 54;
    const text = options.unsafe && index === 55 ? unsafeMessageText : image ? messageImageURL : `原始消息 ${String(index).padStart(3, '0')}\nОригинальное сообщение ${String(index).padStart(3, '0')}`;
    const content = options.fragments && index === 55 ? fragmentedMessageParts : [text];
    return `INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
      VALUES (${quote(`${id}-${String(index).padStart(3, '0')}`)},'company-a',${quote(storeId)},${quote(id)},${quote(messageId(index))},'9100000000000000199','Customer','inbound',${quote(JSON.stringify(content))},${image ? 1 : 0},0,'SYNTHETIC-ORDER-001',NULL,${eventAt},${eventAt + 1000},'backfill');`;
  };
  const conversationSQL = (conversationId: string, platformId: string, lastMessageId: string | null, lastMessageAt: number | null) => `INSERT INTO conversation (id,organization_id,store_id,channel_type,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_id,imported_at,last_message_at)
    VALUES (${quote(conversationId)},'company-a',${quote(storeId)},'private',${quote(platformId)},'BUYER_SELLER','OPENED',${timestamp - 1000},${lastMessageId ? quote(lastMessageId) : 'NULL'},${timestamp + 1000},${lastMessageAt ?? 'NULL'});`;
  const emptyId = crypto.randomUUID();
  const emptyThreadId = `empty-${emptyId}`;
  const seedSQL = [
    conversationSQL(id, threadId, messageId(55), timestamp),
    ...Array.from({ length: 55 }, (_, index) => messageSQL(index + 1)),
    conversationSQL(emptyId, emptyThreadId, null, null),
    ...Array.from({ length: options.neighbors ?? 0 }, (_, index) => conversationSQL(crypto.randomUUID(), `neighbor-${String(index).padStart(3, '0')}-${id}`, null, timestamp - 1000)),
  ].join('\n');
  return {
    id, threadId, emptyId, emptyThreadId, seedSQL,
    appendBatchSQL(first: number, count: number, eventAt?: number) {
      if (!Number.isInteger(first) || first < 1 || !Number.isInteger(count) || count < 1 || count > 300) throw new Error('Invalid synthetic message batch');
      return Array.from({ length: count }, (_, index) => messageSQL(first + index, eventAt ?? timestamp + (first + index) * 1000).replace(/;$/, ' ON CONFLICT DO NOTHING;')).join('\n');
    },
    appendSQL: `${messageSQL(56, timestamp + 2000)}\nUPDATE conversation SET last_message_id=${quote(messageId(56))},last_message_at=${timestamp + 2000} WHERE id=${quote(id)};`,
  };
}
