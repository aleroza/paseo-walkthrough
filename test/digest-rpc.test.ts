import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { diffRpc, generateRpc, statusRpc } from "../shared/contracts";
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

const git = (dir: string, args: string[]) =>
  new Promise<void>((done, fail) => {
    execFile("git", args, { cwd: dir }, (error) => (error ? fail(error) : done()));
  });

async function createRepo(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-repo-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

interface AgentCreation {
  config: { provider: string; systemPrompt: string };
  cwd: string;
}

interface FakePaseo {
  paseo: PaseoApi;
  prompts: string[];
  creations: AgentCreation[];
  release(answer: string): void;
  promptCount(): number;
}

/** The daemon the plugin talks to: the model is stubbed at the agent boundary. */
function fakePaseo(directory: string): FakePaseo {
  const prompts: string[] = [];
  const creations: AgentCreation[] = [];
  let queued: string | null = null;
  let waiting: ((answer: string) => void) | null = null;

  const workspace = { id: "ws-1", workspaceDirectory: directory };
  const handle = {
    id: workspace.id,
    get directory() {
      return workspace.workspaceDirectory;
    },
    current: () => workspace,
    refresh: async () => workspace,
  };

  const paseo = {
    workspaces: {
      ref: () => handle,
      list: async () => ({ entries: [workspace], pageInfo: {}, requestId: "r" }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "test", available: true }], requestId: "r" }),
      listModels: async () => ({
        provider: "test",
        models: [{ provider: "test", id: "model-1", label: "Model 1", isDefault: true, isSelectable: true }],
        requestId: "r",
      }),
    },
    agents: {
      create: async (options: AgentCreation) => {
        creations.push(options);
        return {
          id: `agent-${creations.length}`,
          async run(text: string) {
            prompts.push(text);
            const answer =
              queued !== null
                ? queued
                : await new Promise<string>((resolve) => {
                    waiting = resolve;
                  });
            queued = null;
            return { status: "idle", final: null, error: null, lastMessage: answer };
          },
          async archive() {
            return { archivedAt: "2026-01-01T00:00:00.000Z" };
          },
        };
      },
    },
  } as unknown as PaseoApi;

  return {
    paseo,
    prompts,
    creations,
    release(answer: string) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(answer);
        return;
      }
      queued = answer;
    },
    promptCount: () => prompts.length,
  };
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

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

const handlerFor = (handlers: Map<string, Handler>, name: string): Handler => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface StatusView {
  job: { id: string; state: string; stages: string[]; error: string | null } | null;
  document: {
    chapters: { stops: { hunkIds: string[] }[] }[];
    uncoveredHunkIds: string[];
    droppedAnchors: number;
  } | null;
}

const callStatus = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string): Promise<StatusView> =>
  (await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, { paseo })) as StatusView;

const waitFor = async (
  handlers: Map<string, Handler>,
  paseo: PaseoApi,
  jobId: string,
  ready: (status: StatusView) => boolean,
): Promise<StatusView> => {
  let last: StatusView | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await callStatus(handlers, paseo, jobId);
    last = status;
    if (ready(status)) return status;
    await sleep(5);
  }
  throw new Error(`the job never reached the expected state: ${JSON.stringify(last)}`);
};

const waitForTerminal = (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string) =>
  waitFor(handlers, paseo, jobId, (status) => status.job?.state === "done" || status.job?.state === "failed" || status.job?.state === "cancelled");

/** The prompt reaches the agent a moment after the job says it is asking. */
const waitForPrompt = async (fake: FakePaseo) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fake.promptCount() > 0) return fake.prompts[0] ?? "";
    await sleep(5);
  }
  throw new Error("the model was never asked");
};

interface DigestFile {
  path: string;
  oldPath?: string;
  status: string;
  scope?: string;
  binary?: true;
  hunks: { alias: string; header: string; oldLines: string; newLines: string; added: number; deleted: number; patch: string }[];
}

interface Digest {
  files: DigestFile[];
}

/** The digest the model is given, read back from the prompt that carries it. */
const digestOf = (prompt: string): Digest => {
  const marker = "Change digest:\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("the prompt carries no digest");
  return JSON.parse(prompt.slice(start + marker.length)) as Digest;
};

const answer = (aliases: string[]) =>
  JSON.stringify({
    title: "The change",
    focus: "The panel now walks through the change.",
    chapters: [
      {
        title: "The change",
        icon: "doc",
        blurb: "One stop for the hunks that changed.",
        stops: [
          {
            title: "The value moved",
            hunks: aliases,
            importance: "normal",
            prose: "The constant now holds the new value.",
            observations: [],
          },
        ],
      },
    ],
    routine: [],
  });

describe("the digest the model reads", () => {
  it("lets a walkthrough anchor both sides of a reversed staged edit", async () => {
    const repo = await createRepo({ "app.ts": "const a = 1;\n" });
    await writeFile(join(repo, "app.ts"), "const a = 2;\n");
    await git(repo, ["add", "app.ts"]);
    await writeFile(join(repo, "app.ts"), "const a = 1;\n");

    const { handlers, cleanup } = load();
    onTestFinished(cleanup);
    const fake = fakePaseo(repo);
    const request = { workspaceId: "ws-1", scope: "all" };
    const context = { paseo: fake.paseo };
    const diff = diffRpc.output.parse(await handlerFor(handlers, diffRpc.name)(request, context));
    const [staged, unstaged] = diff.diff!.files.map(({ hunks }) => hunks[0]);
    const { jobId } = generateRpc.output.parse(await handlerFor(handlers, generateRpc.name)(request, context));
    const digest = digestOf(await waitForPrompt(fake));
    expect(digest.files.map(({ path, scope }) => [path, scope])).toEqual([["app.ts", "staged"], ["app.ts", "unstaged"]]);

    fake.release(answer(["h2", "h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.chapters[0]?.stops[0]?.hunkIds).toEqual([unstaged.id, staged.id]);

    const readStatus = async () => statusRpc.output.parse(
      await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, context),
    );
    const current = await readStatus();
    expect(current.hunks).toEqual([staged, unstaged]);
    expect(current.staleness?.stale).toBe(false);

    await writeFile(join(repo, "app.ts"), "const a = 2;\n");
    const after = await readStatus();
    expect(after.hunks).toEqual([staged, unstaged]);
    expect(after.staleness).toMatchObject({
      stale: true,
      staleStopIds: ["stop-1-1"],
      missingHunkIds: [unstaged.id],
      uncoveredHunkIds: [],
      outdatedHunkIds: [unstaged.id],
      currentUncoveredHunks: [],
    });
  });

  it("aliases the hunks h1 to hn in a stable order, with the file path and the body of each hunk", async () => {
    const repo = await createRepo({
      "app.ts": "const a = 1;\nconst b = 2;\n",
      "lib.ts": "export const lib = 1;\n",
    });
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\n");
    await writeFile(join(repo, "lib.ts"), "export const lib = 2;\n");

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    const prompt = await waitForPrompt(fake);
    const digest = digestOf(prompt);

    expect(digest.files.map((file) => file.path)).toEqual(["app.ts", "lib.ts"]);
    expect(digest.files.flatMap((file) => file.hunks.map((hunk) => hunk.alias))).toEqual(["h1", "h2"]);
    expect(digest.files[0]?.hunks[0]?.patch).toContain("+const b = 22;");
    expect(digest.files[0]?.hunks[0]?.patch).toContain("-const b = 2;");
    expect(digest.files[0]?.hunks[0]?.header).toContain("@@");
    expect(digest.files[1]?.hunks[0]?.patch).toContain("+export const lib = 2;");
    expect(digest.files[0]?.status).toBe("modified");
  });

  it("gives the model the digest and the contract, and not the raw diff", async () => {
    const repo = await createRepo({ "app.ts": "const a = 1;\n" });
    await writeFile(join(repo, "app.ts"), "const a = 2;\n");

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    const prompt = await waitForPrompt(fake);
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toMatch(/^index /m);
    expect(prompt).not.toContain("--- a/app.ts");
    expect(prompt).toContain("Change digest:");
    expect(prompt).toContain("app.ts");
    expect(prompt).toContain("h1");

    // The contract the answer has to follow travels with the digest.
    const system = fake.creations[0]?.config.systemPrompt ?? "";
    expect(system).toContain("hunk aliases from the digest");
    expect(system).toContain('"chapters"');
    expect(system).toContain('"observations"');
  });

  it("keeps generated files and lock files out of the digest, but shows them to the reviewer", async () => {
    const repo = await createRepo({
      "app.ts": "const a = 1;\n",
      "package-lock.json": '{ "lockfileVersion": 1 }\n',
      "generated/schema.json": '{ "type": "object" }\n',
    });
    await writeFile(join(repo, "app.ts"), "const a = 2;\n");
    await writeFile(join(repo, "package-lock.json"), '{ "lockfileVersion": 2 }\n');
    await writeFile(join(repo, "generated/schema.json"), '{ "type": "string" }\n');

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const diff = (await handlerFor(handlers, diffRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as {
      diff: { files: { path: string }[]; generatedPaths: string[] } | null;
    };

    // The reviewer still sees every file of the change.
    expect(diff.diff?.files.map((file) => file.path)).toEqual(["app.ts", "generated/schema.json", "package-lock.json"]);
    expect(diff.diff?.generatedPaths).toEqual(["generated/schema.json", "package-lock.json"]);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    const prompt = await waitForPrompt(fake);
    const digest = digestOf(prompt);
    expect(digest.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(digest.files.flatMap((file) => file.hunks.map((hunk) => hunk.alias))).toEqual(["h1"]);
    expect(prompt).not.toContain("package-lock.json");
    expect(prompt).not.toContain("generated/schema.json");
  });

  it("resolves the alias of a stop back to the file and the hunk it came from", async () => {
    const repo = await createRepo({
      "app.ts": "const a = 1;\n",
      "lib.ts": "export const lib = 1;\n",
    });
    await writeFile(join(repo, "app.ts"), "const a = 2;\n");
    await writeFile(join(repo, "lib.ts"), "export const lib = 2;\n");

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const diff = (await handlerFor(handlers, diffRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as {
      diff: { files: { path: string; hunks: { id: string }[] }[] } | null;
    };
    const libHunk = diff.diff?.files.find((file) => file.path === "lib.ts")?.hunks[0]?.id ?? "";

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(answer(["h2"]));

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.chapters[0]?.stops[0]?.hunkIds).toEqual([libHunk]);
    expect(libHunk).toContain("lib.ts");
  });

  it("says the change is empty instead of asking the model to read nothing", async () => {
    const repo = await createRepo({ "package-lock.json": '{ "lockfileVersion": 1 }\n' });
    await writeFile(join(repo, "package-lock.json"), '{ "lockfileVersion": 2 }\n');

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);

    expect(finished.job?.state).toBe("failed");
    expect(finished.job?.error).toContain("generated");
    expect(finished.document).toBeNull();
    expect(fake.promptCount()).toBe(0);
    expect(fake.creations).toHaveLength(0);
  });

  it("does not blame generated files for a change that holds no hunks to read", async () => {
    const repo = await createRepo({ "logo.bin": Buffer.from([0, 1, 2]) });
    await writeFile(join(repo, "logo.bin"), Buffer.from([0, 3, 4]));

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const diff = (await handlerFor(handlers, diffRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as {
      diff: { files: { path: string; binary: boolean; hunks: unknown[] }[]; generatedPaths: string[] } | null;
    };
    expect(diff.diff?.files).toHaveLength(1);
    expect(diff.diff?.files[0]?.binary).toBe(true);
    expect(diff.diff?.files[0]?.hunks).toHaveLength(0);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);

    expect(finished.job?.state).toBe("failed");
    expect(finished.job?.error).not.toContain("generated");
    expect(finished.job?.error).toContain("hunks");
    expect(fake.promptCount()).toBe(0);
  });
});
