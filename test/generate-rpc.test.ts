import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { cancelRpc, diffRpc, generateRpc, statusRpc } from "../shared/contracts";
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

interface AgentCreation {
  config: { systemPrompt: string };
  cwd: string;
  background?: boolean;
  workspaceId?: string;
  prompt?: string;
  outputSchema?: Record<string, unknown>;
}

type ModelReply = string | { error: string };

interface FakePaseo {
  paseo: PaseoApi;
  creations: AgentCreation[];
  prompts: string[];
  /** The ids of the agents the plugin archived. */
  archived: string[];
  release(answer: ModelReply): void;
  releaseModelResolution(): void;
  /** How many times the plugin asked the daemon which model to use. */
  modelResolutions(): number;
  promptCount(): number;
}

interface FakeOptions {
  provider?: string;
  /** 0.16.2 and newer accept a background agent inside a workspace; 0.15.4 refuses it. */
  backgroundAgentInWorkspace: boolean;
  /** The model resolution waits for the test, so a cancel can land while it is in flight. */
  holdModelResolution?: boolean;
}

/** The daemon the plugin talks to: the model is stubbed at the agent boundary. */
function fakePaseo(directory: string, options: FakeOptions): FakePaseo {
  const provider = options.provider ?? "test";
  const creations: AgentCreation[] = [];
  const prompts: string[] = [];
  const archived: string[] = [];
  let queued: ModelReply | null = null;
  let waiting: ((answer: ModelReply) => void) | null = null;
  let releaseModelResolution: (() => void) | null = null;
  let modelResolutions = 0;
  const modelResolution = options.holdModelResolution
    ? new Promise<void>((resolve) => {
        releaseModelResolution = resolve;
      })
    : Promise.resolve();

  // A queued answer is handed out once: leaving it queued would replay it on the next ask.
  const nextAnswer = () => {
    if (queued !== null) {
      const answer = queued;
      queued = null;
      return Promise.resolve(answer);
    }
    return new Promise<ModelReply>((resolve) => {
      waiting = resolve;
    });
  };
  const modelResult = async () => {
    const reply = await nextAnswer();
    return typeof reply === "string"
      ? { status: "idle", final: null, error: null, lastMessage: reply }
      : { status: "error", final: null, error: reply.error, lastMessage: null };
  };

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
      listAvailable: async () => {
        modelResolutions += 1;
        await modelResolution;
        return { providers: [{ provider, available: true }], requestId: "r" };
      },
      listModels: async () => ({
        provider,
        models: [{ provider, id: "model-1", label: "Model 1", isDefault: true, isSelectable: true }],
        requestId: "r",
      }),
    },
    agents: {
      create: async (agentOptions: AgentCreation) => {
        creations.push(agentOptions.workspaceId ? { ...agentOptions, cwd: directory } : agentOptions);
        if (agentOptions.workspaceId && !options.backgroundAgentInWorkspace) {
          throw new Error("background is workspace creation intent; configure the selected workspace at creation.");
        }
        if (agentOptions.prompt) prompts.push(agentOptions.prompt);
        const agentId = `agent-${creations.length}`;
        return {
          id: agentId,
          async run(text: string) {
            prompts.push(text);
            return modelResult();
          },
          waitForFinish: modelResult,
          async archive() {
            archived.push(agentId);
            return { archivedAt: "2026-01-01T00:00:00.000Z" };
          },
        };
      },
    },
  } as unknown as PaseoApi;

  return {
    paseo,
    creations,
    prompts,
    archived,
    release(answer: ModelReply) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(answer);
        return;
      }
      queued = answer;
    },
    releaseModelResolution() {
      releaseModelResolution?.();
      releaseModelResolution = null;
    },
    modelResolutions: () => modelResolutions,
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

const waitUntil = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await sleep(5);
  }
  throw new Error("the condition never became true");
};

interface JobStatusView {
  job: { id: string; state: string; stages: string[]; error: string | null } | null;
  staleness: { stale: boolean } | null;
  document: {
    title: string;
    focus: string;
    chapters: {
      id: string;
      title: string;
      icon: string;
      stops: { id: string; title: string; hunkIds: string[]; importance: string; prose: string; observations: { kind: string; note: string }[] }[];
    }[];
    routine: { path: string; note: string }[];
    droppedAnchors: number;
  } | null;
}

const callStatus = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string): Promise<JobStatusView> =>
  (await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, { paseo })) as JobStatusView;

const waitFor = async (
  handlers: Map<string, Handler>,
  paseo: PaseoApi,
  jobId: string,
  ready: (status: JobStatusView) => boolean,
): Promise<JobStatusView> => {
  let last: JobStatusView | null = null;
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

const modelAnswer = (aliases: string[], title = "The change") =>
  JSON.stringify({
    title,
    focus: "The panel can now show a walkthrough of the working tree.",
    chapters: [
      {
        title: "The new value",
        icon: "bug",
        blurb: "One stop for the line that changed.",
        stops: [
          {
            title: "The value moved",
            hunks: aliases,
            importance: "critical",
            prose: "The constant now holds the new value, and every caller reads it from this one place.",
            observations: [{ kind: "decision", note: "The value is kept in a single constant." }],
          },
        ],
      },
    ],
    routine: [{ path: "app.ts", note: "The changed line." }],
  });

describe("walkthrough cache", () => {
  it("restores a cached All stop with a hunk saved before sections were recorded", async () => {
    const repo = await createRepo();
    const workspaceId = "ws-legacy";
    const name = createHash("sha256").update(JSON.stringify(workspaceId)).digest("hex");
    const directory = join(homeRoot, "home", "plugin-data", "walkthrough", "cache", "workspaces");
    const hunk = {
      id: "all:app.ts:1a2b3c4d", path: "app.ts", header: "@@ -1 +1 @@",
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: 1, deleted: 1,
      patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
    };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.json`), JSON.stringify({
      key: "legacy",
      source: { scope: "all" },
      diff: {
        files: [{ path: hunk.path, oldPath: null, status: "modified", binary: false, hunks: [hunk] }],
        hunkCount: 1, fileCount: 1, generatedPaths: [], repository: true,
      },
      document: {
        title: "Cached walkthrough", focus: "The value changed.", routine: [], uncoveredHunkIds: [], droppedAnchors: 0,
        chapters: [{ id: "chapter", title: "Change", icon: "doc", blurb: "", stops: [{
          id: "stop", title: "New value", hunkIds: [hunk.id], importance: "normal", prose: "The constant changed.", observations: [],
        }] }],
      },
    }));

    const { handlers, cleanup } = load();
    onTestFinished(cleanup);
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });
    const restored = statusRpc.output.parse(
      await handlerFor(handlers, statusRpc.name)({ workspaceId, jobId: null }, { paseo: fake.paseo }),
    );
    expect(restored.document?.chapters[0].stops[0].hunkIds).toEqual([hunk.id]);
    expect(restored.hunks).toEqual([hunk]);
  });

  it("restores the workspace's document on reload and fulfills the same request without asking the model again", async () => {
    const repo = await createRepo();
    const path = join(repo, "app.ts");
    const initialChange = "const a = 1;\nconst b = 22;\nconst c = 3;\n";
    await writeFile(path, initialChange);
    const first = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });
    const request = { workspaceId: "ws-1", scope: "all" };
    const generated = (await handlerFor(first.handlers, generateRpc.name)(request, { paseo: fake.paseo })) as { jobId: string };
    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(first.handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    await first.cleanup();

    const reopened = load();
    const restore = handlerFor(reopened.handlers, statusRpc.name);
    const restored = (await restore({ workspaceId: "ws-1", jobId: null }, { paseo: fake.paseo })) as JobStatusView;
    expect(restored.document?.title).toBe("The change");
    expect(restored.staleness?.stale).toBe(false);
    const other = (await restore({ workspaceId: "ws-2", jobId: null }, { paseo: fake.paseo })) as JobStatusView;
    expect(other.document).toBeNull();

    await writeFile(path, "const a = 1;\nconst b = 23;\nconst c = 3;\n");
    const stale = (await restore({ workspaceId: "ws-1", jobId: null }, { paseo: fake.paseo })) as JobStatusView;
    expect(stale.document?.title).toBe("The change");
    expect(stale.staleness?.stale).toBe(true);

    await writeFile(path, initialChange);
    const reused = (await handlerFor(reopened.handlers, generateRpc.name)(request, { paseo: fake.paseo })) as { jobId: string };
    const hit = await waitForTerminal(reopened.handlers, fake.paseo, reused.jobId);
    expect(hit.job?.state).toBe("done");
    expect(hit.document).toEqual(finished.document);
    expect(fake.promptCount()).toBe(1);
    await reopened.cleanup();
  });

  it("asks the model after the diff changes and replaces the older cache entry", async () => {
    const repo = await createRepo();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });
    const { handlers, cleanup } = load();
    const generate = handlerFor(handlers, generateRpc.name);
    const request = { workspaceId: "ws-1", scope: "all" };
    const generateForValue = async (value: number, title: string) => {
      await writeFile(join(repo, "app.ts"), `const a = 1;\nconst b = ${value};\nconst c = 3;\n`);
      const { jobId } = await generate(request, { paseo: fake.paseo }) as { jobId: string };
      fake.release(modelAnswer(["h1"], title));
      return waitForTerminal(handlers, fake.paseo, jobId);
    };

    expect((await generateForValue(22, "First version")).document?.title).toBe("First version");
    expect((await generateForValue(23, "Second version")).document?.title).toBe("Second version");
    expect(fake.promptCount()).toBe(2);

    const reopened = load();
    const restored = await handlerFor(reopened.handlers, statusRpc.name)({ workspaceId: "ws-1", jobId: null }, { paseo: fake.paseo }) as JobStatusView;
    expect(restored.document?.title).toBe("Second version");
    expect((await generateForValue(22, "Recreated version")).document?.title).toBe("Recreated version");
    expect(fake.promptCount()).toBe(3);
    await cleanup();
    await reopened.cleanup();
  });
});

describe("walkthrough.generate", () => {
  it("passes a JSON Schema on the initial native structured turn and normalizes its answer", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { provider: "codex", backgroundAgentInWorkspace: false });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);
    const creation = fake.creations.at(-1);
    expect(creation?.prompt).toContain("Change digest:");
    expect(creation?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "focus", "chapters", "routine"],
      properties: { chapters: { type: "array", items: { type: "object", additionalProperties: false } } },
    });

    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.chapters[0]?.stops[0]?.hunkIds).toEqual([expect.stringMatching(/^unstaged:app\.ts:[0-9a-f]{8}$/)]);
  });

  it("retries rejected OpenCode structured output with feedback and the same schema", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { provider: "opencode", backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitUntil(() => fake.promptCount() === 1);
    fake.release({ error: "Invalid OpenCode structured output: data/chapters must be array" });

    const secondTurn = await waitFor(handlers, fake.paseo, generated.jobId, (status) => fake.promptCount() === 2 || status.job?.state === "failed");
    expect(secondTurn.job?.stages).toContain("retrying");
    expect(fake.creations[1]?.prompt).toContain("data/chapters must be array");
    expect(fake.creations[1]?.outputSchema).toEqual(fake.creations[0]?.outputSchema);

    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.title).toBe("The change");
  });

  it("starts a background job, shows its stages and answers with the document", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    expect(typeof generated.jobId).toBe("string");

    const asking = await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    expect(asking.job?.state).toBe("asking");

    fake.release(modelAnswer(["h1"]));

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.job?.error).toBeNull();
    expect(finished.job?.stages).toEqual(["collecting", "asking", "assembling", "done"]);
    expect(finished.document?.title).toBe("The change");
    expect(finished.document?.focus).toContain("walkthrough");
    expect(finished.document?.chapters[0]?.stops[0]?.prose).toContain("new value");
    expect(finished.document?.chapters[0]?.stops[0]?.observations[0]?.kind).toBe("decision");
  });

  it("names the hunks a stop explains by their stable identity", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const diff = (await handlerFor(handlers, diffRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as {
      diff: { files: { path: string; hunks: { id: string }[] }[] } | null;
    };
    const hunkId = diff.diff?.files[0]?.hunks[0]?.id ?? "";

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);

    expect(hunkId).toMatch(/^unstaged:app\.ts:[0-9a-f]{8}$/);
    expect(finished.document?.chapters[0]?.stops[0]?.hunkIds).toEqual([hunkId]);
  });

  it("retries a malformed answer with the validation errors and finishes on the next one", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { provider: "claude", backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release("this is not json at all");

    const retrying = await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.stages.includes("retrying") === true);
    expect(retrying.job?.stages).toContain("retrying");
    expect(fake.promptCount()).toBe(2);
    expect(fake.creations[0]?.outputSchema).toBeUndefined();
    expect(fake.creations[0]?.config.systemPrompt).toContain("Return ONLY a JSON object");
    expect(fake.prompts[1]).toContain("rejected");
    expect(fake.prompts[1]).toContain("no JSON object");

    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);

    expect(finished.job?.state).toBe("done");
    expect(finished.job?.stages).toEqual(["collecting", "asking", "assembling", "retrying", "asking", "assembling", "done"]);
    expect(finished.document?.chapters).toHaveLength(1);
  });

  it("fails with a readable message after a third malformed answer", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(handlers, fake.paseo, generated.jobId, (status) => fake.promptCount() > attempt);
      fake.release("this is not json at all");
    }

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("failed");
    expect(finished.job?.error).toContain("walkthrough");
    expect(finished.document).toBeNull();
    expect(fake.promptCount()).toBe(3);
  });

  it("reads a partial answer the way a reader would: the missing parts get their defaults", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(
      JSON.stringify({
        chapters: [{ title: "The value", stops: [{ title: "The value moved", hunks: ["h1"], prose: "The constant now holds the new value." }] }],
        routine: [],
      }),
    );

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.title).toBe("Change walkthrough");
    expect(finished.document?.focus).toBe("");
    expect(finished.document?.chapters[0]?.icon).toBe("doc");
    expect(finished.document?.chapters[0]?.stops[0]?.importance).toBe("normal");
    expect(finished.document?.chapters[0]?.stops[0]?.observations).toEqual([]);
    expect(finished.document?.chapters[0]?.stops[0]?.hunkIds).toHaveLength(1);
  });

  it("runs the model in a hidden agent that never sees the repository", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);

    const creation = fake.creations[0];
    expect(creation?.background).toBe(true);
    expect(creation?.cwd.startsWith(join(homeRoot, "home", "plugin-data", "walkthrough"))).toBe(true);
    expect(creation?.cwd).not.toContain(repo);
    expect(fake.prompts[0]).toContain("app.ts");
    expect(fake.prompts[0]).toContain("h1");
  });

  it("keeps the agent in scratch when the daemon can select an existing workspace", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);

    expect(fake.creations[0]?.workspaceId).toBeUndefined();
  });

  it("lets the daemon make a background workspace on a daemon that refuses a background agent in a workspace", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: false });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitUntil(() => fake.promptCount() > 0);

    expect(fake.creations).toHaveLength(1);
    expect(fake.creations[0]?.workspaceId).toBeUndefined();
    expect(fake.creations[0]?.background).toBe(true);
  });

  it("keeps a cancelled job cancelled, whatever the job was doing when the cancel landed", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true, holdModelResolution: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    // The cancel lands while the job is still resolving the model, before the agent exists.
    await waitUntil(() => fake.modelResolutions() > 0);
    const cancelled = (await handlerFor(handlers, cancelRpc.name)({ workspaceId: "ws-1", jobId: generated.jobId }, { paseo: fake.paseo })) as {
      cancelled: boolean;
      error: string | null;
    };
    expect(cancelled).toEqual({ cancelled: true, error: null });

    fake.releaseModelResolution();
    const status = await waitFor(handlers, fake.paseo, generated.jobId, (view) => view.job?.state === "cancelled");
    expect(status.job?.state).toBe("cancelled");

    await sleep(50);
    const later = await callStatus(handlers, fake.paseo, generated.jobId);
    expect(later.job?.state).toBe("cancelled");
    expect(fake.creations).toHaveLength(0);
    expect(fake.archived).toEqual([]);
  });

  it("archives the hidden agent when the job ends, whether it succeeded or failed", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");

    await waitUntil(() => fake.archived.length > 0);
    expect(fake.archived).toEqual(["agent-1"]);
  });

  it("archives the hidden agent after a failed job, so no agent is left running", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo, { backgroundAgentInWorkspace: true });

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(handlers, fake.paseo, generated.jobId, (status) => fake.promptCount() > attempt);
      fake.release("this is not json at all");
    }
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("failed");

    await waitUntil(() => fake.archived.length > 0);
    expect(fake.archived).toEqual(["agent-1"]);
  });
});
