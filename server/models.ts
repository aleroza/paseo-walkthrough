import type { ModelOption } from "../shared/types";
import type { PaseoApi } from "./host-types";

interface DaemonModel {
  provider?: string;
  id: string;
  label?: string;
  isSelectable?: boolean;
  isDefault?: boolean;
}

/** A model the reviewer may pick, with the daemon's own flags. */
export interface AvailableModel extends ModelOption {
  isDefault: boolean;
}

interface ProviderModels {
  provider: string;
  models: AvailableModel[];
}

/** The name the daemon takes for a model: "provider/id". */
export const modelReference = (model: ModelOption) => `${model.provider}/${model.id}`;

async function providerModels(paseo: PaseoApi): Promise<ProviderModels[]> {
  const availability = await paseo.providers.listAvailable();
  const groups: ProviderModels[] = [];

  for (const entry of availability.providers) {
    if (entry.available !== true) continue;
    const listed = await paseo.providers.listModels(entry.provider).catch(() => null);
    const models: AvailableModel[] = [];
    for (const model of (listed?.models ?? []) as DaemonModel[]) {
      if (model.isSelectable === false) continue;
      models.push({
        provider: model.provider ?? entry.provider,
        id: model.id,
        label: model.label ?? model.id,
        isDefault: model.isDefault === true,
      });
    }
    groups.push({ provider: entry.provider, models });
  }

  return groups;
}

function defaultModel(groups: ProviderModels[]): string | null {
  for (const group of groups) {
    const preferred = group.models.find((model) => model.isDefault) ?? group.models[0];
    if (preferred) return modelReference(preferred);
  }
  return null;
}

/** The models the daemon has ready, in the order the providers were listed. */
export async function listAvailableModels(paseo: PaseoApi) {
  const groups = await providerModels(paseo);
  return { models: groups.flatMap((group) => group.models), defaultModel: defaultModel(groups) };
}

/**
 * The model the walkthrough is written by: the one the reviewer picked, or the default of the
 * first provider the daemon has ready. A model the daemon does not have is refused, never
 * swapped for another one.
 */
export async function resolveModel(paseo: PaseoApi, requested: string | null): Promise<string> {
  const groups = await providerModels(paseo);
  const available = groups.flatMap((group) => group.models);

  const wanted = requested?.trim();
  if (wanted) {
    const chosen = available.find((model) => modelReference(model) === wanted);
    if (!chosen) throw new Error(`The model ${wanted} is not available. Pick another model for the walkthrough.`);
    return modelReference(chosen);
  }

  const preferred = defaultModel(groups);
  if (preferred) return preferred;

  throw new Error("No model is available. Sign in to a provider or pick a model for the walkthrough.");
}
