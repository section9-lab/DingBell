export interface CredentialBindings {
  STORE_CREDENTIAL_KEYS?: string;
  STORE_CREDENTIAL_ACTIVE_KEY?: string;
}
export interface CredentialScope {
  orgId: string;
  storeId: string;
  platformStoreId: string;
  credentialVersion: number;
}
export interface CredentialEnvelope { keyVersion: string; nonce: string; ciphertext: string }
export interface CredentialConfig { activeKeyVersion: string; keys: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }
export class CredentialError extends Error {
  readonly code = 'STORE_CREDENTIALS_UNAVAILABLE';
  constructor() { super('Store credentials are unavailable.'); }
}

function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new CredentialError();
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new CredentialError();
  return bytes;
}

export function credentialConfig(env: CredentialBindings): CredentialConfig | null {
  try {
    const active = env.STORE_CREDENTIAL_ACTIVE_KEY;
    if (!active || !env.STORE_CREDENTIAL_KEYS) return null;
    const values: unknown = JSON.parse(env.STORE_CREDENTIAL_KEYS);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const keys = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [version, value] of Object.entries(values)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(version) || typeof value !== 'string') return null;
      const bytes = decode(value);
      if (bytes.length !== 32) return null;
      keys.set(version, bytes);
    }
    return keys.has(active) ? { activeKeyVersion: active, keys } : null;
  } catch { return null; }
}

function aad(scope: CredentialScope, keyVersion: string) {
  if (![scope.orgId, scope.storeId, scope.platformStoreId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    || !Number.isSafeInteger(scope.credentialVersion) || scope.credentialVersion < 1) throw new CredentialError();
  // Fixed tuple ordering and domain/schema version prevent ambiguous contexts.
  return new TextEncoder().encode(JSON.stringify(['dingbell.store.credentials', 1,
    scope.orgId, scope.storeId, 'ozon', scope.platformStoreId, scope.credentialVersion, keyVersion]));
}

function validPayload(value: unknown): value is { apiKey: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && 'apiKey' in value
    && typeof value.apiKey === 'string' && value.apiKey.length > 0 && value.apiKey.length <= 4096;
}

export async function encryptCredentials(env: CredentialBindings, scope: CredentialScope, credentials: { apiKey: string }): Promise<CredentialEnvelope> {
  try {
    const config = credentialConfig(env);
    if (!config || !validPayload(credentials)) throw new CredentialError();
    const keyVersion = config.activeKeyVersion;
    const key = await crypto.subtle.importKey('raw', config.keys.get(keyVersion)!, 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(scope, keyVersion), tagLength: 128 },
      key, new TextEncoder().encode(JSON.stringify(credentials)));
    return { keyVersion, nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
  } catch { throw new CredentialError(); }
}

export async function decryptCredentials(env: CredentialBindings, scope: CredentialScope, envelope: CredentialEnvelope): Promise<{ apiKey: string }> {
  try {
    const config = credentialConfig(env);
    const bytes = config?.keys.get(envelope.keyVersion);
    if (!bytes || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 65536) throw new CredentialError();
    const nonce = decode(envelope.nonce);
    const ciphertext = decode(envelope.ciphertext);
    if (nonce.length !== 12 || ciphertext.length < 16) throw new CredentialError();
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(scope, envelope.keyVersion), tagLength: 128 }, key, ciphertext);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext));
    if (!validPayload(value)) throw new CredentialError();
    return value;
  } catch { throw new CredentialError(); }
}
