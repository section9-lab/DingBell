import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

/** A model that this deployment can address through the Pi provider catalog. */
export interface ProviderModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  input: readonly string[];
}

export interface ProviderEntry {
  id: string;
  name: string;
  authKinds: readonly ('api_key' | 'oauth')[];
  models: readonly ProviderModel[];
  /** Phase 1 executes OpenAI Chat Completions only; other APIs stay listed but unselectable. */
  supported: boolean;
}

const EXECUTABLE_API = 'openai-completions';

function displayName(id: string, name: string | undefined): string {
  const value = typeof name === 'string' ? name.trim() : '';
  return value && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value) ? value : id;
}

function buildCatalog(): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const provider of builtinProviders()) {
    try {
      // `getModels()` already reports chat models only.
      const models = provider.getModels().flatMap(model => {
        if (typeof model.baseUrl !== 'string' || !model.baseUrl || typeof model.id !== 'string' || !model.id) return [];
        // Account/deployment placeholders (Cloudflare account ID, Azure deployment) are not
        // executable without extra deployment configuration, so they stay out of the catalog.
        if (model.baseUrl.includes('{') || model.baseUrl.includes('}')) return [];
        return [{
          id: model.id,
          name: displayName(model.id, model.name),
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          input: model.input,
        }];
      });
      if (!models.length) continue;
      const authKinds: ('api_key' | 'oauth')[] = [];
      if (provider.auth.apiKey) authKinds.push('api_key');
      if (provider.auth.oauth) authKinds.push('oauth');
      entries.push({
        id: provider.id,
        name: provider.name,
        authKinds,
        models,
        supported: models.some(model => model.api === EXECUTABLE_API),
      });
    } catch {
      // A provider whose catalog cannot be read is omitted rather than taking down settings.
    }
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

let catalog: ProviderEntry[] | undefined;

/** The bundled Pi provider catalog. Static: no network call and no credentials required. */
export function providerCatalog(): readonly ProviderEntry[] {
  return catalog ??= buildCatalog();
}

export function findProvider(providerId: string): ProviderEntry | undefined {
  return providerCatalog().find(provider => provider.id === providerId);
}

/** Resolves exactly the pair the company saved; a provider never silently substitutes another model. */
export function resolveProviderModel(providerId: string, modelId: string): { provider: ProviderEntry; model: ProviderModel } | null {
  const provider = findProvider(providerId);
  if (!provider || !provider.supported) return null;
  const model = provider.models.find(candidate => candidate.id === modelId && candidate.api === EXECUTABLE_API);
  return model ? { provider, model } : null;
}

/**
 * Provider-specific routing headers. OpenCode requires a stable per-conversation
 * session identifier on both Zen and Go; other catalog providers use plain bearer auth.
 */
export function providerRequestHeaders(providerId: string, sessionId: string): Record<string, string> {
  if (providerId === 'opencode' || providerId === 'opencode-go') return { 'x-opencode-session': sessionId };
  return {};
}

/** Hosts reachable through the bundled catalog. Used by the URL policy; never a user-supplied list. */
export function providerHosts(): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const provider of providerCatalog()) {
    for (const model of provider.models) {
      try {
        hosts.add(new URL(model.baseUrl).hostname);
      } catch {
        // Malformed catalog entries are ignored here and filtered by the URL policy anyway.
      }
    }
  }
  return hosts;
}
