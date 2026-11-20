import { execFile } from "node:child_process";
import { externalEnv } from "./env";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment git runs in: every GIT_* variable of the daemon is dropped, so a GIT_DIR or a GIT_CONFIG
 * pointing somewhere else cannot redirect the read, and the ones git needs to stay passive are set explicitly.
 */
function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = externalEnv(base);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_") || key.toUpperCase() === "LC_ALL") delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_NO_LAZY_FETCH = "1";
  env.LC_ALL = "C";
  return env;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      // A repository's config can name an fsmonitor hook, which any command that reads the index would start, and the
      // ext transport, which would run a command of the repository's config. Neither can reach a read-only invocation.
      ["--no-pager", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv() },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== "number" || error?.killed) {
          reject(new Error(`Git ${args[0]} failed: ${error?.message ?? "unknown error"}`));
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

export function gitOutput(result: GitResult, command: string, allowedCode = 0): string {
  if (result.code !== 0 && result.code !== allowedCode) {
    throw new Error(`Git ${command} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  return result.stdout;
}
