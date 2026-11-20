import { z } from "zod";
import {
  CHAPTER_ICONS,
  MAX_CHAPTERS,
  MAX_CHAPTER_TITLE_CHARS,
  MAX_HUNKS_PER_STOP,
  MAX_OBSERVATIONS,
  MAX_OBSERVATIONS_PER_STOP,
  MAX_ROUTINE_NOTES,
  MAX_STOPS,
  OBSERVATION_KINDS,
  STOP_IMPORTANCE,
} from "../shared/constants";
import type { Chapter, Observation, RoutineNote, Stop, WalkthroughDocument } from "../shared/types";
import type { DigestFile } from "./digest";

// Ported from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn), packages/web/server/lib/walkthrough/schema.ts.
// The answer of the model is read the way a reader would: the shape is checked, the parts that
// cannot be salvaged are dropped, and what is left is anchored to the hunks of this change.

export const modelObservationSchema = z.object({
  kind: z.string().default(""),
  note: z.string().default(""),
});

export const modelStopSchema = z.object({
  title: z.string().default(""),
  hunks: z.array(z.string()).default([]),
  importance: z.string().default("normal"),
  prose: z.string().default(""),
  observations: z.array(modelObservationSchema).default([]),
});

export const modelChapterSchema = z.object({
  title: z.string().default(""),
  icon: z.string().default("doc"),
  blurb: z.string().default(""),
  stops: z.array(modelStopSchema).default([]),
});

export const modelDocumentSchema = z.object({
  title: z.string().default(""),
  focus: z.string().default(""),
  chapters: z.array(modelChapterSchema).default([]),
  routine: z.array(z.object({ path: z.string().default(""), note: z.string().default("") })).default([]),
});

export type ModelDocument = z.infer<typeof modelDocumentSchema>;

const isChapterIcon = (value: string): value is Chapter["icon"] => CHAPTER_ICONS.some((icon) => icon === value);
const isStopImportance = (value: string): value is Stop["importance"] => STOP_IMPORTANCE.some((importance) => importance === value);
const isObservationKind = (value: string): value is Observation["kind"] => OBSERVATION_KINDS.some((kind) => kind === value);

const asString = (value: string, max?: number) => {
  const trimmed = value.trim();
  return max && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

export class InvalidWalkthroughError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    const shown = problems.slice(0, 8);
    super(shown.join("; ") || "The model returned no usable walkthrough");
    this.name = "InvalidWalkthroughError";
    this.problems = shown;
  }
}

/** Turns the answer of the model into the document, dropping what cannot be anchored or read. */
export function normalizeWalkthrough(raw: ModelDocument, idByAlias: Map<string, string>, digestFiles: DigestFile[]): WalkthroughDocument {
  const usedIds = new Set<string>();
  const problems: string[] = [];
  let droppedAnchors = 0;
  let stopCount = 0;
  let observationCount = 0;

  const chapters: Chapter[] = [];
  for (const [chapterIndex, rawChapter] of raw.chapters.entries()) {
    if (chapters.length >= MAX_CHAPTERS) break;

    const stops: Stop[] = [];
    for (const rawStop of rawChapter.stops) {
      if (stopCount >= MAX_STOPS) break;

      const hunkIds: string[] = [];
      for (const alias of rawStop.hunks) {
        const id = idByAlias.get(alias.trim());
        if (!id) {
          droppedAnchors += 1;
          problems.push(`the hunk alias ${alias} is not part of this change`);
          continue;
        }
        if (usedIds.has(id)) continue;
        if (hunkIds.length >= MAX_HUNKS_PER_STOP) break;
        usedIds.add(id);
        hunkIds.push(id);
      }

      const prose = asString(rawStop.prose);
      if (hunkIds.length === 0) {
        problems.push("a stop named no hunk of this change");
        continue;
      }
      if (!prose) {
        problems.push("a stop explained no hunk");
        continue;
      }

      const observations: Observation[] = [];
      for (const rawObservation of rawStop.observations) {
        if (observations.length >= MAX_OBSERVATIONS_PER_STOP || observationCount >= MAX_OBSERVATIONS) break;
        const note = asString(rawObservation.note);
        if (!note || !isObservationKind(rawObservation.kind)) continue;
        observationCount += 1;
        observations.push({ kind: rawObservation.kind, note });
      }

      stopCount += 1;
      stops.push({
        id: `stop-${chapterIndex + 1}-${stops.length + 1}`,
        title: asString(rawStop.title) || `Step ${stopCount}`,
        hunkIds,
        importance: isStopImportance(rawStop.importance) ? rawStop.importance : "normal",
        prose,
        observations,
      });
    }

    if (stops.length === 0) continue;

    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: asString(rawChapter.title, MAX_CHAPTER_TITLE_CHARS) || `Part ${chapters.length + 1}`,
      icon: isChapterIcon(rawChapter.icon) ? rawChapter.icon : "doc",
      blurb: asString(rawChapter.blurb),
      stops,
    });
  }

  if (chapters.length === 0) throw new InvalidWalkthroughError(problems);

  return {
    title: asString(raw.title) || "Change walkthrough",
    focus: asString(raw.focus),
    chapters,
    routine: normalizeRoutine(raw.routine, digestFiles, idByAlias, usedIds),
    droppedAnchors,
  };
}

/** The files the model left out: the ones that still have a hunk no stop covers. */
function normalizeRoutine(
  rawRoutine: { path: string; note: string }[],
  digestFiles: DigestFile[],
  idByAlias: Map<string, string>,
  usedIds: Set<string>,
): RoutineNote[] {
  const leftOut = new Set(
    digestFiles
      .filter((file) =>
        file.hunks.some((hunk) => {
          const id = idByAlias.get(hunk.alias);
          return id === undefined || !usedIds.has(id);
        }),
      )
      .map((file) => file.path),
  );

  const routine: RoutineNote[] = [];
  const seen = new Set<string>();
  for (const entry of rawRoutine) {
    if (routine.length >= MAX_ROUTINE_NOTES) break;
    const path = asString(entry.path);
    const note = asString(entry.note);
    if (!note || !leftOut.has(path) || seen.has(path)) continue;
    seen.add(path);
    routine.push({ path, note });
  }
  return routine;
}

/** Reads the JSON of the answer, whatever the model wrapped it in. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new InvalidWalkthroughError(["the model returned an empty answer"]);

  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    if (start === -1) throw new InvalidWalkthroughError(["the answer contained no JSON object"]);

    for (let end = withoutFence.lastIndexOf("}"); end > start; end = withoutFence.lastIndexOf("}", end - 1)) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        continue;
      }
    }

    throw new InvalidWalkthroughError(["the answer was not valid JSON"]);
  }
}

/** The answer of the model, checked against the shape the prompt asked for. */
export function readModelDocument(text: string): ModelDocument {
  const raw = parseModelJson(text);
  const result = modelDocumentSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "the answer"}: ${issue.message}`);
    throw new InvalidWalkthroughError(problems);
  }
  return result.data;
}
