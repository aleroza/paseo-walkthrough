import type { PaseoApi } from "./host-types";

/** The directory of a workspace: the handle knows it only once a snapshot arrived, so the snapshot is fetched first. */
export async function resolveWorkspaceDirectory(paseo: PaseoApi, workspaceId: string): Promise<string> {
  let directory: string | null = null;
  try {
    const handle = paseo.workspaces.ref(workspaceId);
    const snapshot = await handle.refresh();
    directory = handle.directory ?? snapshot?.workspaceDirectory ?? null;
  } catch {
    directory = null;
  }
  if (directory) return directory;

  const listed = await paseo.workspaces.list();
  const entry = listed.entries.find((item) => item.id === workspaceId);
  if (entry?.workspaceDirectory) return entry.workspaceDirectory;
  throw new Error(`Workspace ${workspaceId} has no directory yet.`);
}
