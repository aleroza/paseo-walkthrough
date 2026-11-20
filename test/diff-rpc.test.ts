import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { diffRpc } from "../shared/contracts";
import { PANEL_ID, PLUGIN_ID } from "../shared/constants";
import { gitEnv } from "../server/git";
import type { PaseoApi } from "../server/host-types";

let homeRoot = "";

beforeAll(async () => {
  homeRoot = await mkdtemp(join(tmpdir(), "walkthrough-home-"));
  vi.stubEnv("PASEO_HOME", join(homeRoot, "home"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(homeRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }, (error, stdout) => {
      if (error) fail(new Error(`git ${args.join(" ")} failed: ${error.message}`));
      else done(stdout);
    });
  });
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-repo-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function fakePaseo(directory: string): PaseoApi {
  const workspace = { id: "ws-1", workspaceDirectory: directory };
  const handle = {
    id: workspace.id,
    get directory() {
      return workspace.workspaceDirectory;
    },
    current: () => workspace,
    refresh: async () => workspace,
  };
  return {
    workspaces: {
      ref: () => handle,
      list: async () => ({ entries: [workspace], pageInfo: {}, requestId: "r" }),
    },
  } as unknown as PaseoApi;
}

/** The plugin as Paseo loads it: contribute() with a server that records the RPC handlers. */
function load() {
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "0", values: {} }), subscribe: () => () => {} }),
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    addHook: () => () => {},
    on: () => {},
  };
  const cleanup = contribute(server as never);
  return { handlers, cleanup };
}

async function callDiff(directory: string, input: Record<string, unknown> = {}) {
  const { handlers } = load();
  const handler = handlers.get(diffRpc.name);
  if (!handler) throw new Error(`no handler registered for ${diffRpc.name}`);
  return (await handler({ workspaceId: "ws-1", scope: "all", ...input }, { paseo: fakePaseo(directory) })) as {
    diff: { files: { path: string; status: string; hunks: { header: string; added: number; deleted: number; patch: string }[] }[]; hunkCount: number; fileCount: number; repository: boolean } | null;
    error: string | null;
  };
}

async function listTree(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await listTree(dir, name)));
    else names.push(name);
  }
  return names.sort();
}

describe("walkthrough.diff", () => {
  it("collects the changed files and their hunks from a git repository", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await writeFile(join(repo, "new.ts"), "export const one = 1;\nexport const two = 2;\n");

    const result = await callDiff(repo);

    expect(result.error).toBeNull();
    expect(result.diff?.repository).toBe(true);
    expect(result.diff?.fileCount).toBe(2);
    expect(result.diff?.hunkCount).toBe(2);

    const app = result.diff?.files.find((file) => file.path === "app.ts");
    expect(app?.status).toBe("modified");
    expect(app?.hunks).toHaveLength(1);
    expect(app?.hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(app?.hunks[0].added).toBe(1);
    expect(app?.hunks[0].deleted).toBe(1);
    expect(app?.hunks[0].patch).toContain("-const b = 2;");
    expect(app?.hunks[0].patch).toContain("+const b = 22;");

    const created = result.diff?.files.find((file) => file.path === "new.ts");
    expect(created?.status).toBe("added");
    expect(created?.hunks[0].added).toBe(2);
    expect(created?.hunks[0].deleted).toBe(0);
  });

  it("gives a project that is not a git repository an empty state, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "walkthrough-plain-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));

    const result = await callDiff(dir);

    expect(result.error).toBeNull();
    expect(result.diff?.repository).toBe(false);
    expect(result.diff?.files).toEqual([]);
    expect(result.diff?.fileCount).toBe(0);
    expect(result.diff?.hunkCount).toBe(0);
  });

  it("leaves the working tree exactly as it was", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    const treeBefore = await listTree(repo);

    await callDiff(repo);

    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await listTree(repo)).toEqual(treeBefore);
  });

  it("ignores the GIT_* variables of the daemon", async () => {
    const repo = await createRepo();
    const other = await createRepo();
    await writeFile(join(other, "app.ts"), "const a = 1;\nconst b = 222;\nconst c = 3;\n");
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    onTestFinished(() => {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    });

    const result = await callDiff(repo);

    expect(result.error).toBeNull();
    const app = result.diff?.files.find((file) => file.path === "app.ts");
    expect(app?.hunks[0].patch).toContain("+const b = 22;");
    expect(app?.hunks[0].patch).not.toContain("222");
  });

  it("runs git without the daemon's GIT_* variables and with the optional locks disabled", () => {
    const env = gitEnv({ GIT_DIR: "/elsewhere", GIT_WORK_TREE: "/elsewhere", GIT_TERMINAL_PROMPT: "1", PATH: "/usr/bin" });

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("writes nothing outside its own data directory", async () => {
    const { cleanup } = load();
    await cleanup();

    expect(await readdir(join(homeRoot, "home"))).toEqual(["plugin-data"]);
    const dir = join(homeRoot, "home", "plugin-data", PLUGIN_ID);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("is registered with Paseo under the id walkthrough", async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../paseo-plugin.json", import.meta.url)), "utf8")) as { id: string };

    expect(manifest.id).toBe(PLUGIN_ID);
    expect(PANEL_ID).toBe(PLUGIN_ID);
  });

  it("collects the staged changes for the staged scope and the rest for the unstaged scope", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 222;\nconst c = 3;\n");

    const staged = await callDiff(repo, { scope: "staged" });
    const unstaged = await callDiff(repo, { scope: "unstaged" });

    expect(staged.diff?.files[0].hunks[0].patch).toContain("+const b = 22;");
    expect(staged.diff?.files[0].hunks[0].patch).not.toContain("222");
    expect(unstaged.diff?.files[0].hunks[0].patch).toContain("+const b = 222;");
  });

  it("collects a single commit for the commit scope", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "second"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const result = await callDiff(repo, { scope: "commit", commit: head });

    expect(result.error).toBeNull();
    expect(result.diff?.fileCount).toBe(1);
    expect(result.diff?.files[0].hunks[0].patch).toContain("+const b = 22;");
  });

  it("reports an unknown commit as an error, not as an empty diff", async () => {
    const repo = await createRepo();

    const result = await callDiff(repo, { scope: "commit", commit: "0".repeat(40) });

    expect(result.diff).toBeNull();
    expect(result.error).toContain("not in this repository");
  });
});
