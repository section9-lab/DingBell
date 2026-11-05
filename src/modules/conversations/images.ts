import { messageImageReference } from '../../shared/message-images.ts';
import { storeAccess, storeColumns, type StoreActor, type StoreRecord } from '../stores/storage.ts';
import { decryptCredentials, type CredentialBindings } from '../stores/credentials.ts';

const maximumBytes = 4 * 1024 * 1024;
export class MessageImageUnavailable extends Error {
  constructor() { super('MESSAGE_IMAGE_UNAVAILABLE'); }
}
type ImageSource = StoreRecord & { content: string; isImage: number };
async function sourceFor(db: D1Database, actor: StoreActor, conversationId: string, messageId: string) {
  return db.prepare(`SELECT ${storeColumns},message.content,message.is_image AS isImage FROM message
    JOIN conversation ON conversation.id=message.conversation_id AND conversation.organization_id=message.organization_id AND conversation.store_id=message.store_id
    JOIN store ON store.id=message.store_id AND store.organization_id=message.organization_id
    WHERE message.id=? AND conversation.id=? AND message.organization_id=? AND ${storeAccess('store.organization_id', false)}`)
    .bind(messageId, conversationId, actor.orgId, actor.actorUserId, actor.sessionId).first<ImageSource>();
}
function reference(row: ImageSource | null, index: number) {
  if (!row?.isImage) return null;
  const content: unknown = JSON.parse(row.content);
  if (!Array.isArray(content) || typeof content[index] !== 'string') return null;
  return messageImageReference(content[index]);
}
function validSignature(type: string, bytes: Uint8Array) {
  const starts = (...prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  return type === 'image/jpeg' ? starts(0xff, 0xd8, 0xff)
    : type === 'image/png' ? starts(137, 80, 78, 71, 13, 10, 26, 10)
    : type === 'image/gif' ? starts(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97
    : type === 'image/webp' ? starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 : false;
}

export async function readMessageImage(db: D1Database, env: CredentialBindings, actor: StoreActor,
  conversationId: string, messageId: string, index: number, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Response | null> {
  if (signal?.aborted) throw new MessageImageUnavailable();
  if (!Number.isSafeInteger(index) || index < 0 || index > 999) return null;
  const source = await sourceFor(db, actor, conversationId, messageId), image = reference(source, index);
  if (!source || !image) return null;
  if (source.status === 'disconnected') throw new MessageImageUnavailable();
  const headers = new Headers({ Accept: 'image/jpeg, image/png, image/gif, image/webp' });
  if (image.authenticated) {
    if (!source.credentialKeyVersion || !source.credentialNonce || !source.credentialCiphertext) throw new MessageImageUnavailable();
    try {
      const secret = await decryptCredentials(env, { orgId: actor.orgId, storeId: source.id, platformStoreId: source.platformStoreId, credentialVersion: source.credentialVersion },
        { keyVersion: source.credentialKeyVersion, nonce: source.credentialNonce, ciphertext: source.credentialCiphertext });
      headers.set('Client-Id', source.platformStoreId); headers.set('Api-Key', secret.apiKey);
    } catch { throw new MessageImageUnavailable(); }
  }
  if (signal?.aborted) throw new MessageImageUnavailable();
  const controller = new AbortController(), abort = () => controller.abort();
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new MessageImageUnavailable()), { once: true }));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([fetcher(image.url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }), aborted]);
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    if (!response.ok || !response.body || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type) || Number(response.headers.get('content-length')) > maximumBytes) {
      void response.body?.cancel().catch(() => {}); throw new MessageImageUnavailable();
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) throw new MessageImageUnavailable();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (!validSignature(type, bytes)) throw new MessageImageUnavailable();
    // Recheck after provider I/O: revocation, disconnect and credential rotation must take effect.
    const current = await sourceFor(db, actor, conversationId, messageId);
    if (!current || current.status === 'disconnected' || current.credentialVersion !== source.credentialVersion || reference(current, index)?.url !== image.url) return null;
    return new Response(bytes, { headers: { 'content-type': type, 'content-length': String(length),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; sandbox" } });
  } catch { throw new MessageImageUnavailable(); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); void reader?.cancel().catch(() => {}); }
}
