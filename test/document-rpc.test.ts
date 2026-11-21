import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { diffRpc, generateRpc, statusRpc } from "../shared/contracts";
import type { PaseoApi } from "../server/host-types";
import type { Hunk, Staleness } from "../shared/types";

let homeRoot = "";
const homeRoots: string[] = [];

beforeEach(async () => {
  homeRoot = await mkdtemp(join(tmpdir(), "walkthrough-home-"));
  homeRoots.push(homeRoot);
  vi.stubEnv("PASEO_HOME", join(homeRoot, "home"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homeRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createRepo(names: string[], contents: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "walkthrough-repo-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const git = (args: string[]) =>
    new Promise<void>((done, fail) => {
      execFile("git", args, { cwd: dir }, (error) => (error ? fail(error) : done()));
    });
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  for (const name of names) await writeFile(join(dir, name), contents[name] ?? `export const ${name.replace(/\W/g, "_")} = 1;\n`);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
  return dir;
}

interface FakePaseo {
  paseo: PaseoApi;
  prompts: string[];
  release(answer: string): void;
  promptCount(): number;
}

/** The daemon the plugin talks to: the model is stubbed at the agent boundary. */
function fakePaseo(directory: string): FakePaseo {
  const prompts: string[] = [];
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
      create: async () => ({
        id: "agent-1",
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
      }),
    },
  } as unknown as PaseoApi;

  return {
    paseo,
    prompts,
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

interface DocumentView {
  title: string;
  focus: string;
  chapters: {
    id: string;
    title: string;
    icon: string;
    stops: {
      id: string;
      title: string;
      hunkIds: string[];
      importance: string;
      prose: string;
      observations: { kind: string; note: string; icon: string; importance: string }[];
    }[];
  }[];
  routine: { path: string; note: string }[];
  uncoveredHunkIds: string[];
  droppedAnchors: number;
}

interface StatusView {
  job: { id: string; state: string; stages: string[]; error: string | null } | null;
  document: DocumentView | null;
  staleness: Staleness | null;
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

const hunkIdsOf = async (handlers: Map<string, Handler>, paseo: PaseoApi): Promise<string[]> => {
  const diff = (await handlerFor(handlers, diffRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo })) as {
    diff: { files: { path: string; hunks: { id: string }[] }[] } | null;
  };
  return (diff.diff?.files ?? []).flatMap((file) => file.hunks.map((hunk) => hunk.id));
};

const answer = (document: unknown) => JSON.stringify(document);

const oneStop = (hunks: string[], prose: string) => ({
  title: "A stop",
  hunks,
  importance: "critical",
  prose,
  observations: [],
});

describe("the walkthrough document", () => {
  it("marks edited and removed anchors outdated and returns every current uncovered patch once", async () => {
    const bContents = (first: number, last: number) =>
      `export const first = ${first};\n${"\n".repeat(12)}export const last = ${last};\n`;
    const repo = await createRepo(["a.ts", "b.ts", "d.ts", "e.ts", "f.ts"], { "b.ts": bContents(1, 1) });
    await writeFile(join(repo, "a.ts"), "export const a_ts = 2;\n");
    await writeFile(join(repo, "b.ts"), bContents(2, 1));
    await writeFile(join(repo, "d.ts"), "export const d_ts = 2;\n");
    await writeFile(join(repo, "e.ts"), "export const e_ts = 2;\n");
    await writeFile(join(repo, "f.ts"), "export const f_ts = 2;\n");
    const { handlers } = load();
    const fake = fakePaseo(repo);
    const original = await hunkIdsOf(handlers, fake.paseo);
    const { jobId } = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    fake.release(answer({
      chapters: [{
        stops: [
          oneStop(["h1"], "The value of a.ts moved."),
          oneStop(["h2"], "The value of b.ts moved."),
          oneStop(["h3"], "The value of d.ts moved."),
        ],
      }],
    }));
    const finished = await waitForTerminal(handlers, fake.paseo, jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.staleness?.stale).toBe(false);
    expect(finished.document?.uncoveredHunkIds).toEqual(original.slice(3));

    await writeFile(join(repo, "a.ts"), "export const a_ts = 3;\n");
    await writeFile(join(repo, "b.ts"), bContents(1, 2));
    await writeFile(join(repo, "c.ts"), "export const c_ts = 1;\n");
    await writeFile(join(repo, "f.ts"), "export const f_ts = 1;\n");
    const [changed, addedToExistingFile, added] = await hunkIdsOf(handlers, fake.paseo);
    expect(changed).toMatch(/^unstaged:a\.ts:/);
    expect(addedToExistingFile).toMatch(/^unstaged:b\.ts:/);
    expect(added).toMatch(/^unstaged:c\.ts:/);

    const edited = statusRpc.output.parse(await callStatus(handlers, fake.paseo, jobId));
    expect(edited.staleness).toMatchObject({
      stale: true,
      staleStopIds: ["stop-1-1", "stop-1-2"],
      uncoveredHunkIds: [changed, addedToExistingFile, added],
      missingHunkIds: [original[1], original[4]],
      outdatedHunkIds: [original[0], original[1], original[4]],
      currentUncoveredHunks: [
        { id: changed, path: "a.ts", patch: expect.stringContaining("+export const a_ts = 3;") },
        { id: addedToExistingFile, path: "b.ts", patch: expect.stringContaining("+export const last = 2;") },
        { id: added, path: "c.ts", patch: expect.stringContaining("+export const c_ts = 1;") },
        { id: original[3], path: "e.ts", patch: expect.stringContaining("+export const e_ts = 2;") },
      ],
    });
    expect(edited.hunks.slice(0, 3)).toEqual([
      expect.objectContaining<Partial<Hunk>>({ id: original[0], path: "a.ts", patch: expect.stringContaining("+export const a_ts = 2;") }),
      expect.objectContaining<Partial<Hunk>>({ id: original[1], path: "b.ts", patch: expect.stringContaining("+export const first = 2;") }),
      expect.objectContaining<Partial<Hunk>>({ id: original[2], path: "d.ts", patch: expect.stringContaining("+export const d_ts = 2;") }),
    ]);
  }, 30_000);

  it("reads as chapters of stops, with the observations, the skipped files and the hunks no stop covered", async () => {
    const repo = await createRepo(["app.ts", "lib.ts"]);
    await writeFile(join(repo, "app.ts"), "export const app_ts = 2;\n");
    await writeFile(join(repo, "lib.ts"), "export const lib_ts = 2;\n");

    const { handlers } = load();
    const fake = fakePaseo(repo);
    const ids = await hunkIdsOf(handlers, fake.paseo);
    expect(ids).toHaveLength(2);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(
      answer({
        title: "The change",
        focus: "The panel walks through the change.",
        chapters: [
          {
            title: "One useful chapter",
            icon: "bug",
            blurb: "The one thing that matters.",
            stops: [
              oneStop(["h1", "h2"], " "),
              {
                title: "The value moved",
                hunks: ["h1"],
                importance: "critical",
                prose: "The constant now holds the new value.",
                observations: [{ kind: "decision", note: "The value lives in one constant." }],
              },
            ],
          },
          {
            title: "Nothing to read",
            icon: "doc",
            blurb: "",
            stops: [oneStop(["h9"], "This stop points at a hunk of another change.")],
          },
        ],
        routine: [
          { path: "lib.ts", note: "The flag was renamed." },
          { path: "app.ts", note: "This file is fully covered, so it gets no note." },
        ],
      }),
    );

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    const document = finished.document;
    if (!document) throw new Error("the job returned no document");

    expect(document.chapters).toHaveLength(1);
    const chapter = document.chapters[0]!;
    expect(chapter.title).toBe("One useful chapter");
    expect(chapter.icon).toBe("bug");
    expect(chapter.stops).toHaveLength(1);

    const stop = chapter.stops[0]!;
    expect(stop.hunkIds).toEqual([ids[0]]);
    expect(stop.prose).toContain("new value");
    expect(stop.importance).toBe("critical");
    expect(stop.observations).toEqual([
      { kind: "decision", note: "The value lives in one constant.", icon: "gear", importance: "critical" },
    ]);

    expect(document.routine).toEqual([{ path: "lib.ts", note: "The flag was renamed." }]);
    expect(document.uncoveredHunkIds).toEqual([ids[1]]);
    expect(document.droppedAnchors).toBe(1);
  });

  it("rejects an answer outside the limits and asks the model again", async () => {
    const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
    const repo = await createRepo(names);
    for (const name of names) await writeFile(join(repo, name), `export const ${name.replace(/\W/g, "_")} = 2;\n`);

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.state === "asking");
    fake.release(
      answer({
        title: "Too much",
        focus: "",
        chapters: names.map((name, index) => ({
          title: `Chapter ${index + 1}`,
          icon: "doc",
          blurb: "",
          stops: [oneStop([`h${index + 1}`], "Something changed here.")],
        })),
        routine: [],
      }),
    );

    await waitFor(handlers, fake.paseo, generated.jobId, (status) => status.job?.stages.includes("retrying") === true);
    expect(fake.promptCount()).toBe(2);
    expect(fake.prompts[1]).toContain("rejected");
    expect(fake.prompts[1]).toContain("chapters");

    fake.release(
      answer({
        title: "The change",
        focus: "",
        chapters: [
          {
            title: "One chapter",
            icon: "doc",
            blurb: "",
            stops: [oneStop(["h1"], "Something changed here.")],
          },
        ],
        routine: [],
      }),
    );

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("done");
    expect(finished.document?.chapters).toHaveLength(1);
  });

  it("fails with a readable message when every answer is over the limit", async () => {
    const repo = await createRepo(["a.ts"]);
    await writeFile(join(repo, "a.ts"), "export const a_ts = 2;\n");

    const { handlers } = load();
    const fake = fakePaseo(repo);

    const generated = (await handlerFor(handlers, generateRpc.name)({ workspaceId: "ws-1", scope: "all" }, { paseo: fake.paseo })) as { jobId: string };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(handlers, fake.paseo, generated.jobId, (status) => fake.promptCount() > attempt);
      fake.release(
        answer({
          title: "Too much",
          focus: "",
          chapters: [{
            title: "A chapter title that does not fit the column",
            icon: "doc",
            blurb: "",
            stops: [oneStop(["h1"], "Something changed here.")],
          }],
          routine: [],
        }),
      );
    }

    const finished = await waitForTerminal(handlers, fake.paseo, generated.jobId);
    expect(finished.job?.state).toBe("failed");
    expect(finished.job?.error).toContain("24 characters");
    expect(finished.document).toBeNull();
  });
});
