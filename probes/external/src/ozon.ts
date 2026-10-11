import { readOzonCapabilities } from '../../ozon/read-capabilities.ts';

interface OzonControls {
  externalClaim(kind: 'ozon'): Promise<boolean>;
  externalInspect(kind: 'ozon'): Promise<unknown>;
  externalRecordOzon(result: unknown): Promise<void>;
}

export async function runOzonOnce(controls: OzonControls, env: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const clientId = env.OZON_CLIENT_ID;
  const apiKey = env.OZON_API_KEY;
  if (typeof clientId !== 'string' || !clientId.trim() || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Ozon configuration is missing.');
  }
  // A lost response may leave a claimed run pending. Do not repeat seller requests automatically.
  if (await controls.externalClaim('ozon')) {
    const result = await readOzonCapabilities({ clientId, apiKey }, fetcher);
    await controls.externalRecordOzon(result);
  }
  return controls.externalInspect('ozon');
}
