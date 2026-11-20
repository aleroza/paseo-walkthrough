import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSettings } from "../shared/types";
import { workspaceSettingsSchema } from "../shared/types";

/** The choice a workspace falls back to: everything, the daemon's default model, English. */
export const DEFAULT_SETTINGS: WorkspaceSettings = { scope: "all", model: null, language: "en" };

const settingsDirectory = (dataDirectory: string) => join(dataDirectory, "settings");

/** A file name that says which workspace the settings belong to without leaking its id. */
const fileName = (workspaceId: string) => {
  const slug = workspaceId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return `${slug}-${hash}.json`;
};

/** The choice a workspace made, or the default one when it made none. */
export async function readWorkspaceSettings(dataDirectory: string, workspaceId: string): Promise<WorkspaceSettings> {
  try {
    const raw = await readFile(join(settingsDirectory(dataDirectory), fileName(workspaceId)), "utf8");
    const parsed = workspaceSettingsSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Remembers the choice a workspace made. */
export async function writeWorkspaceSettings(
  dataDirectory: string,
  workspaceId: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  const parsed = workspaceSettingsSchema.parse(settings);
  const directory = settingsDirectory(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, fileName(workspaceId));
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return parsed;
}
