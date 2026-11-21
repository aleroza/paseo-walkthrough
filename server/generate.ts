import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WalkthroughJobState, WalkthroughScope } from "../shared/constants";
import { DEFAULT_LANGUAGE, MAX_MODEL_ATTEMPTS } from "../shared/constants";
import type { JobStatus, WalkthroughDocument, WalkthroughJob, WalkthroughSource } from "../shared/types";
import type { HiddenAgent } from "./agent";
import { createHiddenAgent } from "./agent";
import { createWalkthroughCache, identifyChange } from "./cache";
import { collectDiff } from "./diff";
import { buildDigest } from "./digest";
import { InvalidWalkthroughError, modelOutputSchema, normalizeWalkthrough, readModelDocument } from "./document";
import type { PaseoApi } from "./host-types";
import { resolveModel } from "./models";
import { buildPrompt, normalizeLanguage, retryPrompt } from "./prompt";
import { readStaleness, snapshotHunks } from "./staleness";
import { resolveWorkspaceDirectory } from "./workspace";

export interface GenerationRequest {
  workspaceId: string;
  scope: WalkthroughScope;
  commit?: string;
  model?: string | null;
  language?: string;
}

interface Job {
  id: string;
  workspaceId: string;
  state: WalkthroughJobState;
  stages: WalkthroughJobState[];
  error: string | null;
  startedAt: number;
  document: WalkthroughDocument | null;
  source: WalkthroughSource;
  builtHunks: ReturnType<typeof snapshotHunks> | null;
  cancellation: AbortController;
}

const GENERATION_TIMEOUT_BASE_MS = 120_000;
const GENERATION_TIMEOUT_PER_HUNK_MS = 1_000;
const GENERATION_TIMEOUT_MAX_MS = 900_000;
const MAX_RETAINED_JOBS = 16;

const generationTimeoutMs = (hunkCount: number) =>
  Math.min(GENERATION_TIMEOUT_MAX_MS, GENERATION_TIMEOUT_BASE_MS + Math.max(0, hunkCount) * GENERATION_TIMEOUT_PER_HUNK_MS);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const TERMINAL_STATES: WalkthroughJobState[] = ["done", "failed", "cancelled"];
const isTerminal = (state: WalkthroughJobState) => TERMINAL_STATES.includes(state);

/** Why the change holds nothing to walk through: the reviewer reads the reason, not a stack. */
const emptyChangeMessage = (fileCount: number, generatedFileCount: number) => {
  if (fileCount === 0) return "There are no changes to walk through.";
  if (generatedFileCount === fileCount) return "Only generated files changed, so there is nothing to walk through.";
  return "The changed files hold no hunks to read, so there is nothing to walk through.";
};

/** The generation of a walkthrough: a job the reviewer polls, never a call that blocks the panel. */
export function createWalkthroughService(deps: { dataDirectory: string }) {
  const jobs = new Map<string, Job>();
  const latest = new Map<string, string>();
  const cache = createWalkthroughCache(deps.dataDirectory);
  const running = new Set<Promise<void>>();
  const pendingCleanup = new Set<() => Promise<void>>();
  let closed = false;

  const setStage = (job: Job, state: WalkthroughJobState) => {
    if (isTerminal(job.state)) return;
    job.state = state;
    if (job.stages[job.stages.length - 1] !== state) job.stages.push(state);
  };

  const pruneJobs = () => {
    const completed = [...jobs.values()].filter(({ state }) => isTerminal(state));
    for (const { id, workspaceId } of completed.slice(0, Math.max(0, completed.length - MAX_RETAINED_JOBS))) {
      jobs.delete(id);
      if (latest.get(workspaceId) === id) latest.delete(workspaceId);
    }
  };

  const run = async (paseo: PaseoApi, job: Job, request: GenerationRequest) => {
    const signal = job.cancellation.signal;
    let agent: HiddenAgent | null = null;
    let scratch: string | null = null;
    const archiveAgent = async (interrupt = false) => {
      if (!agent) return;
      try {
        if (interrupt) await agent.stop();
        else await agent.dispose();
      } catch {
        if (interrupt) await agent.dispose();
        else await agent.stop();
      }
      agent = null;
    };
    const cleanUp = async () => {
      await archiveAgent(true);
      if (scratch) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 2 });
        scratch = null;
      }
    };

    try {
      const directory = await resolveWorkspaceDirectory(paseo, request.workspaceId);
      if (signal.aborted) return;
      const collected = await collectDiff(directory, request.scope, request.commit);
      const diff = collected.diff;
      if (!collected.root) throw new Error("This workspace is not a git repository, so there is nothing to walk through.");
      if (signal.aborted) return;

      const digest = buildDigest(diff.files, request.scope);
      if (digest.hunkCount === 0) throw new Error(emptyChangeMessage(diff.fileCount, digest.generatedPaths.length));
      const provider = await resolveModel(paseo, request.model ?? null);
      if (signal.aborted) return;
      const language = normalizeLanguage(request.language ?? DEFAULT_LANGUAGE);
      const { bucket, key } = identifyChange(collected.root, relative(collected.root, directory), job.source, collected.base, provider, language, diff);
      const canWrite = () => !signal.aborted && latest.get(job.workspaceId) === job.id;
      const finish = async (document: WalkthroughDocument, cacheHit: boolean) => {
        if (canWrite()) await cache.save(bucket, job.workspaceId, { key, source: job.source, diff, document }, canWrite, cacheHit);
        if (signal.aborted) return;
        job.document = document;
        job.builtHunks = snapshotHunks(diff.files);
        setStage(job, "done");
      };

      const cached = await cache.find(bucket, key);
      if (signal.aborted) return;
      if (cached) {
        await finish(cached.document, true);
        return;
      }

      // Daemon 0.15.4 advertises no structured output flag. Both OpenCode runtimes use the same provider id.
      const nativeOutput = /^(codex|opencode)\//.test(provider);
      const { system, prompt } = buildPrompt({
        digest: digest.digest,
        fileCount: digest.fileCount,
        hunkCount: digest.hunkCount,
        scope: request.scope,
        commit: request.commit,
        language,
      });

      const cwd = join(deps.dataDirectory, "scratch", job.id);
      await mkdir(cwd, { mode: 0o700 });
      scratch = cwd;

      let problems = "";
      for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
        if (signal.aborted) return;
        const turnPrompt = attempt === 1 ? prompt : retryPrompt(prompt, problems);
        setStage(job, "asking");
        if (!agent) {
          agent = await createHiddenAgent(paseo, {
            cwd,
            provider,
            systemPrompt: system,
            initialTurn: nativeOutput ? { prompt: turnPrompt, outputSchema: modelOutputSchema } : undefined,
          });
          if (signal.aborted) return;
        }
        try {
          const answer = await agent.ask(turnPrompt, generationTimeoutMs(digest.hunkCount), signal);
          if (signal.aborted) return;
          setStage(job, "assembling");
          const document = normalizeWalkthrough(readModelDocument(answer), digest.idByAlias, digest.digest.files);
          await archiveAgent();
          await cleanUp();
          await finish(document, false);
          return;
        } catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof InvalidWalkthroughError)) throw error;
          problems = message(error);
          if (attempt >= MAX_MODEL_ATTEMPTS) {
            job.error = `The model did not return a usable walkthrough after ${MAX_MODEL_ATTEMPTS} attempts: ${problems}`;
            setStage(job, "failed");
            return;
          }
          setStage(job, "retrying");
          // The pinned SDK attaches outputSchema only to the initial turn.
          if (nativeOutput) await archiveAgent();
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      job.error = message(error);
      setStage(job, "failed");
    } finally {
      try {
        await cleanUp();
      } catch (error) {
        pendingCleanup.add(cleanUp);
        const problem = `Walkthrough cleanup failed: ${message(error)}`;
        job.error = job.error ? `${job.error}\n${problem}` : problem;
        console.error(`[walkthrough] ${problem}`);
      }
    }
  };

  const cancelJob = (job: Job) => {
    setStage(job, "cancelled");
    job.cancellation.abort();
  };

  return {
    /** Starts the generation in the background and hands the reviewer a job to poll. */
    start(paseo: PaseoApi, request: GenerationRequest): string {
      if (closed) throw new Error("The walkthrough plugin is unloading.");
      const latestId = latest.get(request.workspaceId);
      const active = latestId ? jobs.get(latestId) : undefined;
      if (active && !isTerminal(active.state)) return active.id;

      const job: Job = {
        id: randomUUID(),
        workspaceId: request.workspaceId,
        state: "collecting",
        stages: ["collecting"],
        error: null,
        startedAt: Date.now(),
        document: null,
        source: request.scope === "commit" && request.commit
          ? { scope: request.scope, commit: request.commit.toLowerCase() }
          : { scope: request.scope },
        builtHunks: null,
        cancellation: new AbortController(),
      };
      jobs.set(job.id, job);
      latest.set(request.workspaceId, job.id);
      const task = run(paseo, job, request);
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        pruneJobs();
      });
      return job.id;
    },

    async status(paseo: PaseoApi, workspaceId: string, jobId: string | null): Promise<JobStatus> {
      const wanted = jobId ?? latest.get(workspaceId) ?? null;
      const job = wanted ? jobs.get(wanted) : undefined;
      if (job && job.workspaceId !== workspaceId) return { job: null, document: null, staleness: null, hunks: [] };
      const saved = jobId == null && (!job || (isTerminal(job.state) && !job.document))
        ? await cache.last(workspaceId)
        : null;
      const view: WalkthroughJob | null = job ? {
        id: job.id,
        workspaceId: job.workspaceId,
        state: job.state,
        stages: job.stages,
        error: job.error,
        startedAt: job.startedAt,
      } : null;
      const source = saved?.source ?? job?.source;
      const document = job?.document ?? saved?.document ?? null;
      const builtHunks = saved ? snapshotHunks(saved.diff.files) : job?.builtHunks;
      const staleness = source && document && builtHunks
        ? await readStaleness(paseo, { ...source, workspaceId }, document, builtHunks)
        : null;
      const hunks = builtHunks ? [...builtHunks.values()].flatMap((file) => file.map(({ hunk }) => hunk)) : [];
      return { job: view, document, staleness, hunks, ...(source ? { source } : {}) };
    },

    cancel(workspaceId: string, jobId: string): { cancelled: boolean; error: string | null } {
      const job = jobs.get(jobId);
      if (!job || job.workspaceId !== workspaceId) return { cancelled: false, error: "There is no walkthrough with that id." };
      if (job.state === "done" || job.state === "failed") return { cancelled: false, error: "That walkthrough has already finished." };
      cancelJob(job);
      return { cancelled: true, error: null };
    },

    async shutdown(): Promise<void> {
      closed = true;
      for (const job of jobs.values()) {
        if (!isTerminal(job.state)) cancelJob(job);
      }
      await Promise.allSettled(running);
      await Promise.all([...pendingCleanup].map(async (cleanUp) => {
        try {
          await cleanUp();
          pendingCleanup.delete(cleanUp);
        } catch (error) {
          console.error(`[walkthrough] Cleanup during unload failed: ${message(error)}`);
        }
      }));
    },
  };
}
