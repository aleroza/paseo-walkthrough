import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WalkthroughJobState, WalkthroughScope } from "../shared/constants";
import { DEFAULT_LANGUAGE, MAX_MODEL_ATTEMPTS } from "../shared/constants";
import type { JobStatus, WalkthroughDocument, WalkthroughJob } from "../shared/types";
import type { HiddenAgent } from "./agent";
import { createHiddenAgent } from "./agent";
import { collectDiff } from "./diff";
import { buildDigest } from "./digest";
import { InvalidWalkthroughError, modelOutputSchema, normalizeWalkthrough, readModelDocument } from "./document";
import type { PaseoApi } from "./host-types";
import { resolveModel } from "./models";
import { buildPrompt, normalizeLanguage, retryPrompt } from "./prompt";
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
  cancelled: boolean;
  /** The agent the model is running in, while there is one. */
  agent: HiddenAgent | null;
}

const GENERATION_TIMEOUT_BASE_MS = 120_000;
const GENERATION_TIMEOUT_PER_HUNK_MS = 1_000;
const GENERATION_TIMEOUT_MAX_MS = 900_000;

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

  // A terminal state is final: a job that is done, failed or cancelled never moves again.
  const setStage = (job: Job, state: WalkthroughJobState) => {
    if (isTerminal(job.state)) return;
    job.state = state;
    if (job.stages[job.stages.length - 1] !== state) job.stages.push(state);
  };

  const scratchDirectory = async (jobId: string) => {
    const directory = join(deps.dataDirectory, "scratch", jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  };

  const run = async (paseo: PaseoApi, job: Job, request: GenerationRequest) => {
    let agent: HiddenAgent | null = null;
    try {
      const directory = await resolveWorkspaceDirectory(paseo, request.workspaceId);
      const collected = await collectDiff(directory, request.scope, request.commit);
      const diff = collected.diff;
      if (!diff.repository) throw new Error("This workspace is not a git repository, so there is nothing to walk through.");

      const digest = buildDigest(diff.files, request.scope);
      if (digest.hunkCount === 0) throw new Error(emptyChangeMessage(diff.files.length, digest.generatedPaths.length));
      if (job.cancelled) return;

      const provider = await resolveModel(paseo, request.model ?? null);
      if (job.cancelled) return;
      // Daemon 0.15.4 advertises no structured output flag. Both OpenCode runtimes use the same provider id.
      const nativeOutput = /^(codex|opencode)\//.test(provider);
      const { system, prompt } = buildPrompt({
        digest: digest.digest,
        fileCount: digest.fileCount,
        hunkCount: digest.hunkCount,
        scope: request.scope,
        commit: request.commit,
        language: normalizeLanguage(request.language ?? DEFAULT_LANGUAGE),
      });

      const cwd = await scratchDirectory(job.id);

      let problems = "";
      for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
        if (job.cancelled) return;
        const turnPrompt = attempt === 1 ? prompt : retryPrompt(prompt, problems);
        setStage(job, "asking");
        if (!agent) {
          agent = await createHiddenAgent(paseo, {
            workspaceId: request.workspaceId,
            cwd,
            provider,
            systemPrompt: system,
            initialTurn: nativeOutput ? { prompt: turnPrompt, outputSchema: modelOutputSchema } : undefined,
          });
          job.agent = agent;
          if (job.cancelled) return;
        }
        try {
          const answer = await agent.ask(turnPrompt, generationTimeoutMs(digest.hunkCount));
          if (job.cancelled) return;
          setStage(job, "assembling");
          job.document = normalizeWalkthrough(readModelDocument(answer), digest.idByAlias, digest.digest.files);
          setStage(job, "done");
          return;
        } catch (error) {
          if (job.cancelled) return;
          if (!(error instanceof InvalidWalkthroughError)) throw error;
          problems = message(error);
          if (attempt >= MAX_MODEL_ATTEMPTS) {
            job.error = `The model did not return a usable walkthrough after ${MAX_MODEL_ATTEMPTS} attempts: ${problems}`;
            setStage(job, "failed");
            return;
          }
          setStage(job, "retrying");
          // The pinned SDK attaches outputSchema only to the initial turn.
          if (nativeOutput) {
            await agent.dispose();
            agent = null;
            job.agent = null;
          }
        }
      }
    } catch (error) {
      if (job.cancelled) {
        setStage(job, "cancelled");
        return;
      }
      job.error = message(error);
      setStage(job, "failed");
    } finally {
      job.agent = null;
      if (agent) await agent.dispose().catch(() => undefined);
    }
  };

  return {
    /** Starts the generation in the background and hands the reviewer a job to poll. */
    start(paseo: PaseoApi, request: GenerationRequest): string {
      const job: Job = {
        id: randomUUID(),
        workspaceId: request.workspaceId,
        state: "collecting",
        stages: ["collecting"],
        error: null,
        startedAt: Date.now(),
        document: null,
        cancelled: false,
        agent: null,
      };
      jobs.set(job.id, job);
      latest.set(request.workspaceId, job.id);
      void run(paseo, job, request).catch((error: unknown) => {
        if (isTerminal(job.state)) return;
        job.error = message(error);
        setStage(job, "failed");
      });
      return job.id;
    },

    status(workspaceId: string, jobId: string | null): JobStatus {
      const wanted = jobId ?? latest.get(workspaceId) ?? null;
      const job = wanted ? jobs.get(wanted) : undefined;
      if (!job || job.workspaceId !== workspaceId) return { job: null, document: null, staleness: null };

      const view: WalkthroughJob = {
        id: job.id,
        workspaceId: job.workspaceId,
        state: job.state,
        stages: job.stages,
        error: job.error,
        startedAt: job.startedAt,
      };
      return { job: view, document: job.document, staleness: null };
    },

    cancel(workspaceId: string, jobId: string): { cancelled: boolean; error: string | null } {
      const job = jobs.get(jobId);
      if (!job || job.workspaceId !== workspaceId) return { cancelled: false, error: "There is no walkthrough with that id." };
      if (job.state === "done" || job.state === "failed") return { cancelled: false, error: "That walkthrough has already finished." };
      job.cancelled = true;
      setStage(job, "cancelled");
      // The model call stops in the background: the reviewer does not wait for the daemon
      // to answer before the panel shows the job as cancelled.
      const agent = job.agent;
      if (agent) {
        void agent.stop().catch((error: unknown) => {
          console.error(`[walkthrough] the model call did not stop: ${message(error)}`);
        });
      }
      return { cancelled: true, error: null };
    },
  };
}
