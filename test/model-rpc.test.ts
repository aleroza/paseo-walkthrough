import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { generateRpc, modelsRpc, saveSettingsRpc, settingsRpc, statusRpc } from "../shared/contracts";
import type { PaseoApi } from "../server/host-types";

let homeRoot = "";

beforeEach(async () => {
  homeRoot = await mkdtemp(join(tmpdir(), "walkthrough-models-home-"));
  vi.stubEnv("PASEO_HOME", join(homeRoot, "home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(homeRoot, { recursive: true, force: true });
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-models-repo-"));
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
  await writeFile(join(dir, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
  return dir;
}

interface DaemonModel {
  provider: string;
  id: string;
  label: string;
  isDefault?: boolean;
  isSelectable?: boolean;
}

interface FakeOptions {
  models?: DaemonModel[];
  /** The provider the daemon says is not ready. */
  unavailable?: string;
}

interface FakePaseo {
  paseo: PaseoApi;
  /** The provider and model of every agent the plugin created. */
  providers: string[];
  /** The system prompt of every agent the plugin created. */
  systemPrompts: string[];
  release(answer: string): void;
}

function fakePaseo(directory: string, options: FakeOptions = {}): FakePaseo {
  const models: DaemonModel[] = options.models ?? [
    { provider: "test", id: "model-1", label: "Model 1", isDefault: true, isSelectable: true },
    { provider: "test", id: "model-2", label: "Model 2", isSelectable: true },
    { provider: "test", id: "model-locked", label: "Locked Model", isSelectable: false },
  ];
  const providers: string[] = [];
  const systemPrompts: string[] = [];
  let queued: string | null = null;
  let waiting: ((answer: string) => void) | null = null;

  const nextAnswer = () => {
    if (queued !== null) {
      const answer = queued;
      queued = null;
      return Promise.resolve(answer);
    }
    return new Promise<string>((resolve) => {
      waiting = resolve;
    });
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
      listAvailable: async () => ({
        providers: [
          { provider: "test", available: true },
          ...(options.unavailable ? [{ provider: options.unavailable, available: false }] : []),
        ],
        requestId: "r",
      }),
      listModels: async (provider: string) => ({
        provider,
        models:
          provider === "test"
            ? models
            : [{ provider, id: "other-model", label: "Other Model", isSelectable: true }],
        requestId: "r",
      }),
    },
    agents: {
      create: async (agentOptions: { config: { provider: string; systemPrompt: string } }) => {
        providers.push(agentOptions.config.provider);
        systemPrompts.push(agentOptions.config.systemPrompt);
        return {
          id: `agent-${providers.length}`,
          async run() {
            const answer = await nextAnswer();
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
    providers,
    systemPrompts,
    release(answer: string) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(answer);
        return;
      }
      queued = answer;
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

interface JobView {
  job: { state: string; error: string | null } | null;
}

const callStatus = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string): Promise<JobView> =>
  (await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, { paseo })) as JobView;

const waitFor = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string, ready: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await callStatus(handlers, paseo, jobId);
    if (status.job && ready()) return status;
    await sleep(5);
  }
  throw new Error("the job never reached the expected state");
};

const isTerminal = (state: string) => state === "done" || state === "failed" || state === "cancelled";

const waitForTerminal = async (handlers: Map<string, Handler>, paseo: PaseoApi, jobId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await callStatus(handlers, paseo, jobId);
    if (status.job && isTerminal(status.job.state)) return status;
    await sleep(5);
  }
  throw new Error("the job never reached a terminal state");
};

const modelAnswer = (aliases: string[]) =>
  JSON.stringify({
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
            hunks: aliases,
            importance: "critical",
            prose: "The constant now holds the new value.",
            observations: [],
          },
        ],
      },
    ],
    routine: [],
  });

describe("walkthrough.models", () => {
  it("lists the models the daemon has available and the reviewer may pick", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const result = (await handlerFor(handlers, modelsRpc.name)({ workspaceId: "ws-1" }, { paseo: fake.paseo })) as {
      models: { provider: string; id: string; label: string }[];
      error: string | null;
    };

    expect(result.error).toBeNull();
    expect(result.models).toEqual([
      { provider: "test", id: "model-1", label: "Model 1" },
      { provider: "test", id: "model-2", label: "Model 2" },
    ]);
  });

  it("leaves out the models of a provider the daemon says is not ready", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo, { unavailable: "other" });

    const result = (await handlerFor(handlers, modelsRpc.name)({ workspaceId: "ws-1" }, { paseo: fake.paseo })) as {
      models: { provider: string }[];
    };

    expect(result.models.every((model) => model.provider === "test")).toBe(true);
  });
});

describe("walkthrough.generate with a chosen model and language", () => {
  it("starts from the Command Center with the workspace's remembered source, model, and language", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);
    const context = { paseo: fake.paseo };
    await handlerFor(handlers, saveSettingsRpc.name)(
      { workspaceId: "ws-1", settings: { scope: "unstaged", model: "test/model-2", language: "de" } },
      context,
    );

    const request = generateRpc.input.parse({ workspaceId: "ws-1" });
    const { jobId } = generateRpc.output.parse(await handlerFor(handlers, generateRpc.name)(request, context));
    fake.release(modelAnswer(["h1"]));
    await waitForTerminal(handlers, fake.paseo, jobId);
    const status = statusRpc.output.parse(await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, context));

    expect(status.document?.chapters[0]?.stops[0]?.hunkIds[0]).toMatch(/^unstaged:app\.ts:/);
    expect(fake.providers).toEqual(["test/model-2"]);
    expect(fake.systemPrompts[0]).toContain("Write all prose in German");
  });

  it("collects the remembered commit when starting from the Command Center", async () => {
    const repo = await createRepo();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const { handlers } = load();
    const fake = fakePaseo(repo);
    const context = { paseo: fake.paseo };
    await handlerFor(handlers, saveSettingsRpc.name)(
      saveSettingsRpc.input.parse({ workspaceId: "ws-1", settings: { scope: "commit", commit } }),
      context,
    );

    const request = generateRpc.input.parse({ workspaceId: "ws-1" });
    const { jobId } = generateRpc.output.parse(await handlerFor(handlers, generateRpc.name)(request, context));
    fake.release(modelAnswer(["h1"]));
    await waitForTerminal(handlers, fake.paseo, jobId);
    const status = statusRpc.output.parse(await handlerFor(handlers, statusRpc.name)({ workspaceId: "ws-1", jobId }, context));

    expect(status.document?.chapters[0]?.stops[0]?.hunkIds[0]).toMatch(/^commit:app\.ts:/);
  });

  it("returns the running job when the Command Center and panel both start a walkthrough", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);
    const handler = handlerFor(handlers, generateRpc.name);
    const context = { paseo: fake.paseo };

    const [fromPanel, fromCommand] = await Promise.all([
      handler(generateRpc.input.parse({ workspaceId: "ws-1", scope: "all" }), context),
      handler(generateRpc.input.parse({ workspaceId: "ws-1" }), context),
    ]);

    expect(fromCommand).toEqual(fromPanel);
    const { jobId } = generateRpc.output.parse(fromPanel);
    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, jobId);
    expect(finished.job?.state).toBe("done");
  });

  it("asks the model the reviewer picked and writes the walkthrough in the language they chose", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)(
      { workspaceId: "ws-1", scope: "all", model: "test/model-2", language: "de" },
      { paseo: fake.paseo },
    )) as { jobId: string };

    await waitFor(handlers, fake.paseo, generated.jobId, () => fake.providers.length > 0);
    expect(fake.providers[0]).toBe("test/model-2");
    expect(fake.systemPrompts[0]).toContain("Write all prose in German");

    fake.release(modelAnswer(["h1"]));
    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
  });

  it("refuses a model the daemon does not have instead of writing the walkthrough with another one", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)(
      { workspaceId: "ws-1", scope: "all", model: "test/model-gone", language: "en" },
      { paseo: fake.paseo },
    )) as { jobId: string };

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("failed");
    expect(finished.job?.error).toContain("model-gone");
    expect(fake.providers).toEqual([]);
  });

  it("uses the daemon's default model when explicitly chosen over a remembered model", async () => {
    const repo = await createRepo();
    const { handlers } = load();
    const fake = fakePaseo(repo);
    const context = { paseo: fake.paseo };
    await handlerFor(handlers, saveSettingsRpc.name)(
      saveSettingsRpc.input.parse({ workspaceId: "ws-1", settings: { model: "test/model-2" } }),
      context,
    );

    const request = generateRpc.input.parse({ workspaceId: "ws-1", scope: "all", model: null });
    const { jobId } = generateRpc.output.parse(await handlerFor(handlers, generateRpc.name)(request, context));

    await waitFor(handlers, fake.paseo, jobId, () => fake.providers.length > 0);
    fake.release(modelAnswer(["h1"]));
    await waitForTerminal(handlers, fake.paseo, jobId);
    expect(fake.providers[0]).toBe("test/model-1");
  });
});

describe("walkthrough.settings", () => {
  it("falls back to the documented default for a workspace that chose nothing", async () => {
    const { handlers } = load();
    const fake = fakePaseo("/tmp");

    const result = (await handlerFor(handlers, settingsRpc.name)({ workspaceId: "ws-empty" }, { paseo: fake.paseo })) as {
      settings: { scope: string; model: string | null; language: string };
    };

    expect(result.settings).toEqual({ scope: "all", model: null, language: "en" });
  });

  it("remembers the choice per workspace", async () => {
    const { handlers } = load();
    const fake = fakePaseo("/tmp");

    const saved = (await handlerFor(handlers, saveSettingsRpc.name)(
      { workspaceId: "ws-1", settings: { scope: "branch", model: "test/model-2", language: "de" } },
      { paseo: fake.paseo },
    )) as { settings: { scope: string; model: string | null; language: string } };
    expect(saved.settings).toEqual({ scope: "branch", model: "test/model-2", language: "de" });

    const read = (await handlerFor(handlers, settingsRpc.name)({ workspaceId: "ws-1" }, { paseo: fake.paseo })) as {
      settings: { scope: string; model: string | null; language: string };
    };
    expect(read.settings).toEqual({ scope: "branch", model: "test/model-2", language: "de" });

    const other = (await handlerFor(handlers, settingsRpc.name)({ workspaceId: "ws-2" }, { paseo: fake.paseo })) as {
      settings: { scope: string; model: string | null; language: string };
    };
    expect(other.settings).toEqual({ scope: "all", model: null, language: "en" });
  });
});
