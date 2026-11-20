import { z } from "zod";
import {
  CHAPTER_ICONS,
  JOB_STATES,
  LANGUAGES,
  OBSERVATION_KINDS,
  STOP_IMPORTANCE,
  WALKTHROUGH_SCOPE,
} from "./constants";

export const hunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  added: z.number().int(),
  deleted: z.number().int(),
  patch: z.string(),
});
export type Hunk = z.infer<typeof hunkSchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "deleted", "renamed", "modified"]),
  binary: z.boolean(),
  hunks: z.array(hunkSchema),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffSchema = z.object({
  files: z.array(diffFileSchema),
  hunkCount: z.number().int(),
  fileCount: z.number().int(),
  generatedPaths: z.array(z.string()),
  /** False when the workspace directory is not inside a git repository: the diff is empty, not broken. */
  repository: z.boolean(),
});
export type Diff = z.infer<typeof diffSchema>;

export const observationSchema = z.object({
  kind: z.enum(OBSERVATION_KINDS),
  note: z.string(),
  icon: z.enum(CHAPTER_ICONS).optional(),
});
export type Observation = z.infer<typeof observationSchema>;

export const stopSchema = z.object({
  id: z.string(),
  title: z.string(),
  hunkIds: z.array(z.string()),
  importance: z.enum(STOP_IMPORTANCE),
  prose: z.string(),
  observations: z.array(observationSchema),
});
export type Stop = z.infer<typeof stopSchema>;

export const chapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.enum(CHAPTER_ICONS),
  blurb: z.string(),
  stops: z.array(stopSchema),
});
export type Chapter = z.infer<typeof chapterSchema>;

export const routineNoteSchema = z.object({
  path: z.string(),
  note: z.string(),
});
export type RoutineNote = z.infer<typeof routineNoteSchema>;

export const documentSchema = z.object({
  title: z.string(),
  focus: z.string(),
  chapters: z.array(chapterSchema),
  routine: z.array(routineNoteSchema),
  droppedAnchors: z.number().int(),
});
export type WalkthroughDocument = z.infer<typeof documentSchema>;

export const stalenessSchema = z.object({
  stale: z.boolean(),
  staleStopIds: z.array(z.string()),
  uncoveredHunkIds: z.array(z.string()),
  missingHunkIds: z.array(z.string()),
});
export type Staleness = z.infer<typeof stalenessSchema>;

export const sourceRequestSchema = z.object({
  workspaceId: z.string(),
  scope: z.enum(WALKTHROUGH_SCOPE).default("all"),
  commit: z.string().optional(),
});
export type SourceRequest = z.infer<typeof sourceRequestSchema>;

export const jobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  state: z.enum(JOB_STATES),
  error: z.string().nullable(),
  startedAt: z.number(),
});
export type WalkthroughJob = z.infer<typeof jobSchema>;

export const jobStatusSchema = z.object({
  job: jobSchema.nullable(),
  document: documentSchema.nullable(),
  staleness: stalenessSchema.nullable(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const modelOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  label: z.string(),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

export const workspaceSettingsSchema = z.object({
  scope: z.enum(WALKTHROUGH_SCOPE).default("all"),
  model: z.string().nullable().default(null),
  language: z.enum(LANGUAGES).default("en"),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
