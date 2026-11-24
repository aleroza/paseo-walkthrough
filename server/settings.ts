import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSettings } from "../shared/types";
import { workspaceSettingsSchema } from "../shared/types";
import { writePrivateFile } from "./store";

/** Initial settings for a workspace that has yet to choose a model. */
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
  const path = join(settingsDirectory(dataDirectory), fileName(workspaceId));
  await writePrivateFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}
