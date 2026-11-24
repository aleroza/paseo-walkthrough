import type { ModelOption } from "../shared/types";
import type { PaseoApi } from "./host-types";

interface DaemonModel {
  provider?: string;
  id: string;
  label?: string;
  isSelectable?: boolean;
}

/** The name the daemon takes for a model: "provider/id". */
export const modelReference = (model: ModelOption) => `${model.provider}/${model.id}`;

/** The models the daemon has ready, in the order the providers were listed. */
export async function listAvailableModels(paseo: PaseoApi): Promise<ModelOption[]> {
  const availability = await paseo.providers.listAvailable();
  const models: ModelOption[] = [];

  for (const entry of availability.providers) {
    if (entry.available !== true) continue;
    const listed = await paseo.providers.listModels(entry.provider).catch(() => null);
    for (const model of (listed?.models ?? []) as DaemonModel[]) {
      if (model.isSelectable === false) continue;
      models.push({
        provider: model.provider ?? entry.provider,
        id: model.id,
        label: model.label ?? model.id,
      });
    }
  }
  return models;
}

/** Resolves the model the reviewer selected against the daemon's current catalog. */
export async function resolveModel(paseo: PaseoApi, requested: string | null): Promise<string> {
  const wanted = requested?.trim();
  if (!wanted) throw new Error("Choose a model for the walkthrough first.");
  const available = await listAvailableModels(paseo);
  if (!available.some((model) => modelReference(model) === wanted)) {
    throw new Error(`The model ${wanted} is not available. Pick another model for the walkthrough.`);
  }
  return wanted;
}
