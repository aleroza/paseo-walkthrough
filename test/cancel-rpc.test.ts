import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import contribute from "../index.server";
import { cancelRpc, generateRpc, statusRpc } from "../shared/contracts";
import type { PaseoApi } from "../server/host-types";

let homeRoot = "";
const homeRoots: string[] = [];

beforeEach(async () => {
  homeRoot = await mkdtemp(join(tmpdir(), "walkthrough-home-"));
  homeRoots.push(homeRoot);
  process.env.PASEO_HOME = join(homeRoot, "home");
});

afterAll(async () => {
  delete process.env.PASEO_HOME;
  await Promise.all(homeRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-repo-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { execFile } = await import("node:child_process");
  const git = (args: string[]) =>
    new Promise<void>((done, fail) => {
      execFile("git", args, { cwd: dir }, (error) => (error ? fail(error) : done()));
    });
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(join(dir, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
  return dir;
}

interface FakeOptions {
  /** The daemon ignores the interrupt and lets the model answer anyway. */
  ignoresInterrupt?: boolean;
  archiveFailures?: number;
}

interface FakePaseo {
  paseo: PaseoApi;
  prompts: string[];
  /** The agents whose running turn the plugin had interrupted. */
  interrupts: string[];
  /** The ids of the agents the plugin archived. */
  archived: string[];
  scratchDirectories: string[];
  promptCount(): number;
  release(answer: string): void;
}

/**
 * The daemon the plugin talks to: the model is stubbed at the agent boundary, and the stub
 * only answers when the test releases it.
 */
function fakePaseo(directory: string, options: FakeOptions = {}): FakePaseo {
  const prompts: string[] = [];
  const interrupts: string[] = [];
  const archived: string[] = [];
  const scratchDirectories: string[] = [];
  let archiveFailures = options.archiveFailures ?? 0;
  let settle: ((result: { status: string; final: null; error: null; lastMessage: string | null }) => void) | null = null;

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
      create: async ({ cwd }: { cwd: string }) => {
        const agentId = "agent-1";
        scratchDirectories.push(cwd);
        return {
          id: agentId,
          async run(text: string) {
            prompts.push(text);
            return new Promise<{ status: string; final: null; error: null; lastMessage: string | null }>((resolve) => {
              settle = resolve;
            });
          },
          // The daemon interrupts the running turn when the agent is reloaded.
          async reload() {
            interrupts.push(agentId);
            if (options.ignoresInterrupt) return null;
            const resolve = settle;
            settle = null;
            resolve?.({ status: "idle", final: null, error: null, lastMessage: null });
            return null;
          },
          async archive() {
            if (archiveFailures > 0) {
              archiveFailures -= 1;
              throw new Error("archive unavailable");
            }
            archived.push(agentId);
            return { archivedAt: "2026-01-01T00:00:00.000Z" };
          },
        };
      },
    },
  } as unknown as PaseoApi;

  return {
    paseo,
    prompts,
    interrupts,
    archived,
    scratchDirectories,
    promptCount: () => prompts.length,
    release(answer: string) {
      const resolve = settle;
      settle = null;
      resolve?.({ status: "idle", final: null, error: null, lastMessage: answer });
    },
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

const waitUntil = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await sleep(5);
  }
  throw new Error("the condition never became true");
};

interface JobStatusView {
  job: { id: string; state: string; stages: string[]; error: string | null } | null;
  document: { title: string } | null;
}

const callStatus = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string): Promise<JobStatusView> =>
  (await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, { paseo })) as JobStatusView;

const callCancel = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string) =>
  (await handlerFor(handlers, cancelRpc.name)({ workspaceId: "ws-1", jobId }, { paseo })) as {
    cancelled: boolean;
    error: string | null;
  };

const modelAnswer = JSON.stringify({
  title: "The change",
  focus: "The panel can now show a walkthrough of the working tree.",
  chapters: [
    {
      title: "The new value",
      icon: "bug",
      blurb: "One stop for the line that changed.",
      stops: [
        {
          title: "The value moved",
          hunks: ["h1"],
          importance: "critical",
          prose: "The constant now holds the new value.",
          observations: [],
        },
      ],
    },
  ],
  routine: [],
});

describe("walkthrough.cancel", () => {
  it("stops active turns and removes their scratch on plugin unload", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const b = 22;\n");
    const { handlers, cleanup } = load();
    const fake = fakePaseo(repo, { ignoresInterrupt: true });
    await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo });
    await waitUntil(() => fake.promptCount() > 0);

    await cleanup();

    expect(fake.interrupts).toEqual(["agent-1"]);
    expect(fake.archived).toEqual(["agent-1"]);
    await expect(stat(fake.scratchDirectories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an archive failure before publishing a finished walkthrough", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const b = 22;\n");
    const { handlers, cleanup } = load();
    const fake = fakePaseo(repo, { archiveFailures: 1 });
    const { jobId } = await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo }) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);
    fake.release(modelAnswer);
    await waitUntil(() => fake.archived.length > 0);
    let status = await callStatus(handlers, fake.paseo, jobId);
    for (let attempt = 0; attempt < 200 && status.job?.state === "assembling"; attempt += 1) {
      await sleep(5);
      status = await callStatus(handlers, fake.paseo, jobId);
    }
    expect(status.job?.state).toBe("done");
    expect(fake.interrupts).toEqual(["agent-1"]);
    expect(fake.archived).toEqual(["agent-1"]);
    await expect(stat(fake.scratchDirectories[0])).rejects.toMatchObject({ code: "ENOENT" });
    await cleanup();
  });

  it("reports a cancelled job's archive failure and retries on unload", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const b = 22;\n");
    const { handlers, cleanup } = load();
    const fake = fakePaseo(repo, { archiveFailures: 2, ignoresInterrupt: true });
    const { jobId } = await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo }) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);
    await callCancel(handlers, fake.paseo, jobId);

    let status = await callStatus(handlers, fake.paseo, jobId);
    for (let attempt = 0; attempt < 200 && !status.job?.error; attempt += 1) {
      await sleep(5);
      status = await callStatus(handlers, fake.paseo, jobId);
    }
    expect(status.job?.state).toBe("cancelled");
    expect(status.job?.error).toContain("Could not archive walkthrough agent");
    expect((await stat(fake.scratchDirectories[0])).isDirectory()).toBe(true);

    await cleanup();

    expect(fake.archived).toEqual(["agent-1"]);
    await expect(stat(fake.scratchDirectories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a running generation, stops the model call and leaves no agent running", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo })) as {
      jobId: string;
    };
    await waitUntil(() => fake.promptCount() > 0);

    const cancelled = await callCancel(handlers, fake.paseo, generated.jobId);
    expect(cancelled).toEqual({ cancelled: true, error: null });

    const status = await callStatus(handlers, fake.paseo, generated.jobId);
    expect(status.job?.state).toBe("cancelled");
    expect(status.document).toBeNull();

    // The daemon was asked to interrupt the running turn, so the model stops working on the answer.
    await waitUntil(() => fake.interrupts.length > 0);
    expect(fake.interrupts).toEqual(["agent-1"]);

    // And no agent is left running behind the cancelled job.
    await waitUntil(() => fake.archived.length > 0);
    expect(fake.archived).toEqual(["agent-1"]);

    await sleep(50);
    const later = await callStatus(handlers, fake.paseo, generated.jobId);
    expect(later.job?.state).toBe("cancelled");
    expect(later.document).toBeNull();
    expect(fake.promptCount()).toBe(1);
  });

  it("keeps the job cancelled when the model answers after the cancel", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { ignoresInterrupt: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo })) as {
      jobId: string;
    };
    await waitUntil(() => fake.promptCount() > 0);

    const cancelled = await callCancel(handlers, fake.paseo, generated.jobId);
    expect(cancelled).toEqual({ cancelled: true, error: null });

    // The model answers anyway: the answer must not turn the cancelled job into a document.
    fake.release(modelAnswer);
    await sleep(50);

    const later = await callStatus(handlers, fake.paseo, generated.jobId);
    expect(later.job?.state).toBe("cancelled");
    expect(later.document).toBeNull();
    expect(fake.promptCount()).toBe(1);
  });

  it("leaves a finished walkthrough alone", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all", model: "test/model-1" }, { paseo: fake.paseo })) as {
      jobId: string;
    };
    await waitUntil(() => fake.promptCount() > 0);
    fake.release(modelAnswer);

    let status = await callStatus(handlers, fake.paseo, generated.jobId);
    for (let attempt = 0; attempt < 200 && status.job?.state !== "done"; attempt += 1) {
      await sleep(5);
      status = await callStatus(handlers, fake.paseo, generated.jobId);
    }
    expect(status.job?.state).toBe("done");
    expect(status.document?.title).toBe("The change");

    const cancelled = await callCancel(handlers, fake.paseo, generated.jobId);
    expect(cancelled.cancelled).toBe(false);
    expect(cancelled.error).toContain("already finished");

    const later = await callStatus(handlers, fake.paseo, generated.jobId);
    expect(later.job?.state).toBe("done");
    expect(later.document?.title).toBe("The change");
  });

  it("says so when there is no walkthrough with that id", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const cancelled = await callCancel(handlers, fake.paseo, "job-that-never-existed");
    expect(cancelled.cancelled).toBe(false);
    expect(cancelled.error).toContain("no walkthrough with that id");
  });
});
