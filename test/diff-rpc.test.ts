import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { diffRpc } from "../shared/contracts";
import { PANEL_ID, PLUGIN_ID } from "../shared/constants";

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

async function createRepo(branch = "main"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-repo-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", branch, "."]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

/** A clone of a bare remote whose default branch is not a conventional name, so only the remote knows the base. */
async function createRepoWithRemote(): Promise<string> {
  const remote = await mkdtemp(join(tmpdir(), "walkthrough-remote-"));
  onTestFinished(() => rm(remote, { recursive: true, force: true }));
  await git(remote, ["init", "-q", "--bare", "-b", "release-base", "."]);

  const seed = await mkdtemp(join(tmpdir(), "walkthrough-seed-"));
  onTestFinished(() => rm(seed, { recursive: true, force: true }));
  await git(seed, ["init", "-q", "-b", "release-base", "."]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Test"]);
  await writeFile(join(seed, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-qm", "init"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-q", "-u", "origin", "release-base"]);

  const repo = await mkdtemp(join(tmpdir(), "walkthrough-clone-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  await git(repo, ["clone", "-q", remote, "."]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  return repo;
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
    base: string | null;
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
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    const treeBefore = await listTree(repo);

    await callDiff(repo);
    await callDiff(repo, { scope: "staged" });
    await callDiff(repo, { scope: "unstaged" });
    await callDiff(repo, { scope: "branch" });
    await callDiff(repo, { scope: "commit", commit: head });

    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await listTree(repo)).toEqual(treeBefore);
  });

  it.each(["GIT_DIR", "gIt_dIr"])("ignores the daemon's %s variable", async (key) => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "changed content\n");
    vi.stubEnv(key, join(repo, "missing.git"));
    try {
      const result = await callDiff(repo);
      expect(result.error).toBeNull();
      expect(result.diff?.files[0].hunks[0].patch).toContain("+changed content");
    } finally {
      vi.stubEnv(key, undefined);
    }
  });

  it("reports a Git failure instead of returning an empty diff", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".git", "config"), "[invalid config\n");
    const result = await callDiff(repo);
    expect(result.diff).toBeNull();
    expect(result.error).toMatch(/bad config/i);
  });

  it("reports an invalid index when a staged diff fails", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".git", "index"), "invalid");
    const result = await callDiff(repo, { scope: "staged" });
    expect(result.diff).toBeNull();
    expect(result.error).toMatch(/index file/i);
  });

  it("uses the working files before the first commit", async () => {
    const repo = await mkdtemp(join(tmpdir(), "walkthrough-unborn-"));
    onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await git(repo, ["init", "-q", "-b", "main", "."]);
    await writeFile(join(repo, "app.ts"), "staged content\n");
    await writeFile(join(repo, "removed.ts"), "staged only\n");
    await git(repo, ["add", "-A"]);
    await writeFile(join(repo, "app.ts"), "working content\n");
    await writeFile(join(repo, "new.ts"), "untracked content\n");
    await rm(join(repo, "removed.ts"));

    const result = await callDiff(repo);

    expect(result.error).toBeNull();
    expect(result.diff?.files.map(({ path }) => path)).toEqual(["app.ts", "new.ts"]);
    expect(result.diff?.files[0].hunks[0].patch).toContain("+working content");
  });

  it("honors standard patch paths even when the repo customizes its prefixes", async () => {
    const repo = await createRepo();
    await git(repo, ["config", "diff.noprefix", "true"]);
    await writeFile(join(repo, "app.ts"), "changed content\n");
    const result = await callDiff(repo);
    expect(result.error).toBeNull();
    expect(result.diff?.files[0].path).toBe("app.ts");
    expect(result.diff?.files[0].hunks[0].patch).toContain("+changed content");
  });

  it("compares a merge commit against its first parent", async () => {
    const repo = await createRepo();
    await git(repo, ["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "feature.ts"), "feature content\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "feature"]);
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const result = await callDiff(repo, { scope: "commit", commit });

    expect(result.error).toBeNull();
    expect(result.diff?.files.map(({ path }) => path)).toEqual(["feature.ts"]);
    expect(result.diff?.files[0].hunks[0].patch).toContain("+feature content");
  });

  it("writes nothing outside its own data directory", async () => {
    const { cleanup } = load();
    await cleanup();

    expect(await readdir(join(homeRoot, "home"))).toEqual(["plugin-data"]);
    const dir = join(homeRoot, "home", "plugin-data", PLUGIN_ID);
    const directory = await stat(dir);
    expect(directory.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(directory.mode & 0o777).toBe(0o700);
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

  it("refuses a commit that is not a hash, so it cannot become a git option", async () => {
    const repo = await createRepo();
    const target = join(repo, "written-by-git");

    const result = await callDiff(repo, { scope: "commit", commit: `--output=${target}` });

    expect(result.diff).toBeNull();
    expect(result.error).toContain("full commit hash");
    await expect(stat(target)).rejects.toThrow();
  });

  it("collects the diff of each of the five sources", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "second"]);
    const second = (await git(repo, ["rev-parse", "HEAD"])).trim();

    await git(repo, ["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 222;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "feature work"]);

    await writeFile(join(repo, "staged.ts"), "export const staged = 1;\n");
    await git(repo, ["add", "-A"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 2222;\nconst c = 3;\n");

    const all = await callDiff(repo, { scope: "all" });
    const staged = await callDiff(repo, { scope: "staged" });
    const unstaged = await callDiff(repo, { scope: "unstaged" });
    const branch = await callDiff(repo, { scope: "branch" });
    const commit = await callDiff(repo, { scope: "commit", commit: second });

    expect(all.error).toBeNull();
    expect(all.diff?.files.map((file) => file.path)).toEqual(["app.ts", "staged.ts"]);
    expect(staged.diff?.files.map((file) => file.path)).toEqual(["staged.ts"]);
    expect(unstaged.diff?.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(unstaged.diff?.files[0].hunks[0].patch).toContain("+const b = 2222;");
    expect(branch.diff?.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(branch.diff?.files[0].hunks[0].patch).toContain("+const b = 222;");
    expect(commit.diff?.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(commit.diff?.files[0].hunks[0].patch).toContain("+const b = 22;");
  });

  it("compares the current branch against the base branch it detects", async () => {
    const repo = await createRepo();
    await git(repo, ["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "feature work"]);

    const result = await callDiff(repo, { scope: "branch" });

    expect(result.error).toBeNull();
    expect(result.base).toBe("main");
    expect(result.diff?.fileCount).toBe(1);
    expect(result.diff?.files[0].hunks[0].patch).toContain("+const b = 22;");
  });

  it("detects the base branch from the default branch of the remote", async () => {
    const repo = await createRepoWithRemote();
    await git(repo, ["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "feature work"]);

    const result = await callDiff(repo, { scope: "branch" });

    expect(result.error).toBeNull();
    expect(result.base).toBe("origin/release-base");
    expect(result.diff?.fileCount).toBe(1);
    expect(result.diff?.files[0].hunks[0].patch).toContain("+const b = 22;");
  });

  it("gives a repository without a base branch an empty branch diff", async () => {
    const repo = await createRepo("solo");
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "second"]);

    const result = await callDiff(repo, { scope: "branch" });

    expect(result.error).toBeNull();
    expect(result.base).toBeNull();
    expect(result.diff?.fileCount).toBe(0);
    expect(result.diff?.hunkCount).toBe(0);
  });

  it("gives a repository without commits an empty branch diff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "walkthrough-empty-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    await git(dir, ["init", "-q", "-b", "main", "."]);

    const result = await callDiff(dir, { scope: "branch" });

    expect(result.error).toBeNull();
    expect(result.diff?.repository).toBe(true);
    expect(result.diff?.fileCount).toBe(0);
    expect(result.base).toBeNull();
  });

  it("gives a branch that matches its base an empty diff", async () => {
    const repo = await createRepo();
    await git(repo, ["checkout", "-qb", "feature"]);

    const result = await callDiff(repo, { scope: "branch" });

    expect(result.error).toBeNull();
    expect(result.base).toBe("main");
    expect(result.diff?.fileCount).toBe(0);
    expect(result.diff?.hunkCount).toBe(0);
  });

  it("does not let the repository config run a command of its own", async () => {
    const repo = await createRepo();
    const outside = await mkdtemp(join(tmpdir(), "walkthrough-hijack-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    const marker = join(outside, "hijacked");
    const hijack = join(outside, "hijack.sh");
    await writeFile(hijack, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    await chmod(hijack, 0o755);
    await git(repo, ["config", "core.pager", hijack]);
    await git(repo, ["config", "diff.external", hijack]);
    await git(repo, ["config", "diff.app.textconv", hijack]);
    await writeFile(join(repo, ".gitattributes"), "app.ts diff=app\n");
    await git(repo, ["add", "-A"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");

    const result = await callDiff(repo);

    expect(result.error).toBeNull();
    await expect(stat(marker)).rejects.toThrow();
    const app = result.diff?.files.find((file) => file.path === "app.ts");
    expect(app?.hunks[0].patch).toContain("+const b = 22;");
  });

  it("gives a repository with nothing staged an empty staged diff", async () => {
    const repo = await createRepo();

    const result = await callDiff(repo, { scope: "staged" });

    expect(result.error).toBeNull();
    expect(result.diff?.fileCount).toBe(0);
  });
});
