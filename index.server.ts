import type { PluginServerContext } from "@getpaseo/plugin/server";
import { collectDiff } from "./server/diff";
import { createWalkthroughService } from "./server/generate";
import { listAvailableModels } from "./server/models";
import { readWorkspaceSettings, writeWorkspaceSettings } from "./server/settings";
import { dataDirectory, ensurePrivateDirectory } from "./server/store";
import { resolveWorkspaceDirectory } from "./server/workspace";
import {
  cancelRpc,
  diffRpc,
  generateRpc,
  modelsRpc,
  saveSettingsRpc,
  settingsRpc,
  statusRpc,
} from "./shared/contracts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  // The plugin writes nothing but its own data directory, and nothing at all until a walkthrough is cached.
  const dir = dataDirectory();
  const ready = ensurePrivateDirectory(dir).catch((error: unknown) => {
    console.error(`[walkthrough] the data directory ${dir} is not usable: ${String(error)}`);
  });

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

  // The models the reviewer may pick: only the ones the daemon has ready and allows.
  server.handle(modelsRpc, async (_input, { paseo }) => {
    try {
      const models = await listAvailableModels(paseo);
      return { models: models.map(({ provider, id, label }) => ({ provider, id, label })), error: null };
    } catch (error) {
      return { models: [], error: message(error) };
    }
  });

  // The choice a workspace made: the panel keeps it in its own state, this is the copy the server
  // falls back to when a generation arrives without one.
  server.handle(settingsRpc, async ({ workspaceId }) => ({
    settings: await readWorkspaceSettings(dir, workspaceId),
  }));

  server.handle(saveSettingsRpc, async ({ workspaceId, settings }) => ({
    settings: await writeWorkspaceSettings(dir, workspaceId, settings),
  }));

  // The model call takes minutes, so it never happens inside a handler: the handler starts the
  // job and returns, and the panel polls the status.
  server.handle(generateRpc, async ({ workspaceId, scope, commit, model, language }, { paseo }) => {
    const remembered = await readWorkspaceSettings(dir, workspaceId);
    const jobId = service.start(paseo, {
      workspaceId,
      scope,
      commit,
      model: model ?? remembered.model,
      language: language ?? remembered.language,
    });
    return { jobId };
  });

  server.handle(statusRpc, async ({ workspaceId, jobId }, { paseo }) => service.status(paseo, workspaceId, jobId));

  server.handle(cancelRpc, async ({ workspaceId, jobId }) => service.cancel(workspaceId, jobId));

  return async () => {
    await ready;
  };
}
