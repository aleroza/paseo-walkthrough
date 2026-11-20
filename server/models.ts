import type { PaseoApi } from "./host-types";

interface ProviderModel {
  id: string;
  isSelectable?: boolean;
  isDefault?: boolean;
}

/**
 * The model the walkthrough is written by: the one the reviewer picked, or the default of the
 * first provider the daemon has ready.
 */
export async function resolveModel(paseo: PaseoApi, requested: string | null): Promise<string> {
  const chosen = requested?.trim();
  if (chosen) return chosen;

  const available = await paseo.providers.listAvailable();
  for (const entry of available.providers) {
    if (entry.available !== true) continue;
    const models = await paseo.providers.listModels(entry.provider).catch(() => null);
    const list = (models?.models ?? []) as ProviderModel[];
    const model = list.find((candidate) => candidate.isDefault && candidate.isSelectable !== false) ?? list.find((candidate) => candidate.isSelectable !== false);
    if (model) return `${entry.provider}/${model.id}`;
  }

  throw new Error("No model is available. Sign in to a provider or pick a model for the walkthrough.");
}
