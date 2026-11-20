import type { PluginServerContext } from "@getpaseo/plugin/server";
import { collectDiff } from "./server/diff";
import { createWalkthroughService } from "./server/generate";
import { dataDirectory, ensurePrivateDirectory } from "./server/store";
import { resolveWorkspaceDirectory } from "./server/workspace";
import { cancelRpc, diffRpc, generateRpc, statusRpc } from "./shared/contracts";

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
      return { diff: null, error: error instanceof Error ? error.message : String(error), base: null };
    }
  });

  // The model call takes minutes, so it never happens inside a handler: the handler starts the
  // job and returns, and the panel polls the status.
  server.handle(generateRpc, async ({ workspaceId, scope, commit, model, language }, { paseo }) => {
    const jobId = service.start(paseo, { workspaceId, scope, commit, model, language });
    return { jobId };
  });

  server.handle(statusRpc, async ({ workspaceId, jobId }) => service.status(workspaceId, jobId));

  server.handle(cancelRpc, async ({ workspaceId, jobId }) => service.cancel(workspaceId, jobId));

  return async () => {
    await ready;
  };
}
