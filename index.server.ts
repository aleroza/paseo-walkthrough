import type { PluginServerContext } from "@getpaseo/plugin/server";
import { collectDiff, listRecentCommits } from "./server/diff";
import { createWalkthroughService } from "./server/generate";
import { listAvailableModels } from "./server/models";
import { readWorkspaceSettings, writeWorkspaceSettings } from "./server/settings";
import { dataDirectory, prepareDataDirectory } from "./server/store";
import { resolveWorkspaceDirectory } from "./server/workspace";
import {
  cancelRpc,
  commitsRpc,
  diffRpc,
  generateRpc,
  modelsRpc,
  saveSettingsRpc,
  settingsRpc,
  statusRpc,
} from "./shared/contracts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  const dir = dataDirectory();
  const ready = prepareDataDirectory(dir).then(() => null, (error: unknown) => {
    const failure = new Error(`The walkthrough data directory is not usable: ${message(error)}`);
    console.error(`[walkthrough] ${failure.message}`);
    return failure;
  });
  const requireStorage = async () => {
    const error = await ready;
    if (error) throw error;
  };

  const service = createWalkthroughService({ dataDirectory: dir });

  server.handle(diffRpc, async ({ workspaceId, scope, commit }, { paseo }) => {
    try {
      const directory = await resolveWorkspaceDirectory(paseo, workspaceId);
      const collected = await collectDiff(directory, scope, commit);
      return { diff: collected.diff, error: null, base: collected.base };
    } catch (error) {
      return { diff: null, error: message(error), base: null };
    }
  });

  server.handle(modelsRpc, async (_input, { paseo }) => {
    try {
      const models = await listAvailableModels(paseo);
      return { models: models.map(({ provider, id, label }) => ({ provider, id, label })), error: null };
    } catch (error) {
      return { models: [], error: message(error) };
    }
  });

  server.handle(commitsRpc, async ({ workspaceId }, { paseo }) => {
    try {
      const directory = await resolveWorkspaceDirectory(paseo, workspaceId);
      return { commits: await listRecentCommits(directory), error: null };
    } catch (error) {
      return { commits: [], error: message(error) };
    }
  });

  server.handle(settingsRpc, async ({ workspaceId }) => {
    await requireStorage();
    return { settings: await readWorkspaceSettings(dir, workspaceId) };
  });

  server.handle(saveSettingsRpc, async ({ workspaceId, settings }) => {
    await requireStorage();
    return { settings: await writeWorkspaceSettings(dir, workspaceId, settings) };
  });

  server.handle(generateRpc, async ({ workspaceId, scope, commit, model, language }, { paseo }) => {
    await requireStorage();
    const remembered = await readWorkspaceSettings(dir, workspaceId);
    const jobId = service.start(paseo, {
      workspaceId,
      scope: scope ?? remembered.scope,
      commit: scope === undefined ? commit ?? remembered.commit : commit,
      model: model === undefined ? remembered.model : model,
      language: language ?? remembered.language,
    });
    return { jobId };
  });

  server.handle(statusRpc, async ({ workspaceId, jobId }, { paseo }) => {
    await requireStorage();
    return service.status(paseo, workspaceId, jobId);
  });

  server.handle(cancelRpc, async ({ workspaceId, jobId }) => service.cancel(workspaceId, jobId));

  return async () => {
    await service.shutdown();
    await ready;
  };
}
