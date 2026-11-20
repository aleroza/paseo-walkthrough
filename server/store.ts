import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// The SDK passes no data directory to a plugin, so this follows the convention $PASEO_HOME/plugin-data/<id>.
// Without PASEO_HOME it uses the user's state folder, never the shared temp dir.
export function dataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const paseoHome = env.PASEO_HOME?.replace(/^~(?=$|\/)/, home);
  if (paseoHome && isAbsolute(paseoHome)) return join(paseoHome, "plugin-data", "walkthrough");
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "paseo-walkthrough");
}

/** Creates `dir` with mode 0700, or checks an existing one: a real directory owned by this user, tightened to 0700. */
export async function ensurePrivateDirectory(dir: string, uid = process.getuid?.()): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0) await chmod(dir, 0o700);
}
