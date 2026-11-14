export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelOptionSource {
  id: string;
  name: string;
}

/**
 * Prefer the provider's human-readable name in the picker. The catalog's name is
 * usually just a formatted model id, so repeating both produces labels such as
 * "DeepSeek V4.1 Flash · deepseek-v4.1-flash". Only append the id when two models
 * in the same provider share a display name.
 */
export function providerModelOptions(models: readonly ModelOptionSource[]): ModelOption[] {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1);
  return models.map(model => ({
    id: model.id,
    label: (counts.get(model.name) ?? 0) > 1 ? `${model.name} (${model.id})` : model.name,
  }));
}
