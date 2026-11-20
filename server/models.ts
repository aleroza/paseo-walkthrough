import type { ModelOption } from "../shared/types";
import type { PaseoApi } from "./host-types";

interface AvailableProvider {
  provider: string;
  available: boolean;
  error?: string | null;
}

interface ProviderModel {
  id: string;
  label?: string;
  isSelectable?: boolean;
  isDefault?: boolean;
}

const isAvailable = (provider: AvailableProvider) => provider.available === true;

/** The models the daemon offers, one entry per model the reviewer can pick. */
export async function listModelOptions(paseo: PaseoApi): Promise<ModelOption[]> {
  const available = await paseo.providers.listAvailable();
  const options: ModelOption[] = [];

  for (const entry of available.providers.filter(isAvailable)) {
    const models = await paseo.providers.listModels(entry.provider).catch(() => null);
    for (const model of models?.models ?? []) {
      if (model.isSelectable === false) continue;
      options.push({ provider: entry.provider, id: model.id, label: model.label ?? model.id });
    }
  }

  return options;
}

/**
 * The model the walkthrough is written by: the one the reviewer picked, or the default of the
 * first provider the daemon has ready.
 */
export async function resolveModel(paseo: PaseoApi, requested: string | null): Promise<string> {
  const chosen = requested?.trim();
  if (chosen) return chosen;

  const available = await paseo.providers.listAvailable();
  for (const entry of available.providers.filter(isAvailable)) {
    const models = await paseo.providers.listModels(entry.provider).catch(() => null);
    const list = (models?.models ?? []) as ProviderModel[];
    const model = list.find((entry) => entry.isDefault && entry.isSelectable !== false) ?? list.find((entry) => entry.isSelectable !== false);
    if (model) return `${entry.provider}/${model.id}`;
  }

  throw new Error("No model is available. Sign in to a provider or pick a model for the walkthrough.");
}
