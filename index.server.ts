import type { PluginServerContext } from "@getpaseo/plugin/server";
import { collectDiff } from "./server/diff";
import { dataDirectory, ensurePrivateDirectory } from "./server/store";
import { resolveWorkspaceDirectory } from "./server/workspace";
import { diffRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  // The plugin writes nothing but its own data directory, and nothing at all until a walkthrough is cached.
  const dir = dataDirectory();
  const ready = ensurePrivateDirectory(dir).catch((error: unknown) => {
    console.error(`[walkthrough] the data directory ${dir} is not usable: ${String(error)}`);
  });

  server.handle(diffRpc, async ({ workspaceId, scope, commit }, { paseo }) => {
    try {
      const directory = await resolveWorkspaceDirectory(paseo, workspaceId);
      const collected = await collectDiff(directory, scope, commit);
      return { diff: collected.diff, error: null, base: collected.base };
    } catch (error) {
      return { diff: null, error: error instanceof Error ? error.message : String(error), base: null };
    }
  });

  return async () => {
    await ready;
  };
}
