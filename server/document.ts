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
  OBSERVATION_ICONS,
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

/**
 * The limits the answer has to respect. An answer outside them is not a walkthrough to salvage:
 * the model is asked again, with the reason it was refused.
 */
function limitsBrokenBy(raw: ModelDocument, idByAlias: Map<string, string>): string[] {
  const problems: string[] = [];

  if (raw.chapters.length > MAX_CHAPTERS) {
    problems.push(`the walkthrough has ${raw.chapters.length} chapters, at most ${MAX_CHAPTERS} are allowed`);
  }

  const stops = raw.chapters.flatMap((chapter) => chapter.stops);
  if (stops.length > MAX_STOPS) {
    problems.push(`the walkthrough has ${stops.length} stops, at most ${MAX_STOPS} are allowed`);
  }

  let observations = 0;
  for (const stop of stops) {
    const hunks = new Set(stop.hunks.map((alias) => alias.trim()).filter((alias) => idByAlias.has(alias)));
    if (hunks.size > MAX_HUNKS_PER_STOP) {
      problems.push(`a stop names ${hunks.size} hunks, at most ${MAX_HUNKS_PER_STOP} are allowed`);
    }
    const valid = stop.observations.filter((observation) => observation.note.trim() !== "" && isObservationKind(observation.kind));
    if (valid.length > MAX_OBSERVATIONS_PER_STOP) {
      problems.push(`a stop has ${valid.length} observations, at most ${MAX_OBSERVATIONS_PER_STOP} are allowed`);
    }
    observations += valid.length;
  }
  if (observations > MAX_OBSERVATIONS) {
    problems.push(`the walkthrough has ${observations} observations, at most ${MAX_OBSERVATIONS} are allowed`);
  }

  if (raw.routine.length > MAX_ROUTINE_NOTES) {
    problems.push(`the walkthrough lists ${raw.routine.length} routine notes, at most ${MAX_ROUTINE_NOTES} are allowed`);
  }

  return problems;
}

/** Turns the answer of the model into the document, dropping what cannot be anchored or read. */
export function normalizeWalkthrough(raw: ModelDocument, idByAlias: Map<string, string>, digestFiles: DigestFile[]): WalkthroughDocument {
  const broken = limitsBrokenBy(raw, idByAlias);
  if (broken.length > 0) throw new InvalidWalkthroughError(broken);

  const usedIds = new Set<string>();
  const problems: string[] = [];
  let droppedAnchors = 0;
  let stopCount = 0;

  const chapters: Chapter[] = [];
  for (const [chapterIndex, rawChapter] of raw.chapters.entries()) {
    const stops: Stop[] = [];
    for (const rawStop of rawChapter.stops) {
      const hunkIds: string[] = [];
      for (const alias of rawStop.hunks) {
        const id = idByAlias.get(alias.trim());
        if (!id) {
          droppedAnchors += 1;
          problems.push(`the hunk alias ${alias} is not part of this change`);
          continue;
        }
        if (usedIds.has(id)) continue;
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

      const importance = isStopImportance(rawStop.importance) ? rawStop.importance : "normal";
      const observations: Observation[] = [];
      for (const rawObservation of rawStop.observations) {
        const note = asString(rawObservation.note);
        if (!note || !isObservationKind(rawObservation.kind)) continue;
        observations.push({ kind: rawObservation.kind, note, icon: OBSERVATION_ICONS[rawObservation.kind], importance });
      }

      stopCount += 1;
      stops.push({
        id: `stop-${chapterIndex + 1}-${stops.length + 1}`,
        title: asString(rawStop.title) || `Step ${stopCount}`,
        hunkIds,
        importance,
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

  const uncovered = uncoveredHunks(digestFiles, idByAlias, usedIds);

  return {
    title: asString(raw.title) || "Change walkthrough",
    focus: asString(raw.focus),
    chapters,
    routine: normalizeRoutine(raw.routine, uncovered.byPath),
    uncoveredHunkIds: uncovered.ids,
    droppedAnchors,
  };
}

/** The hunks of this change that no stop covers: the reader still has to read them. */
function uncoveredHunks(
  digestFiles: DigestFile[],
  idByAlias: Map<string, string>,
  usedIds: Set<string>,
): { ids: string[]; byPath: Map<string, string[]> } {
  const ids: string[] = [];
  const byPath = new Map<string, string[]>();

  for (const file of digestFiles) {
    for (const hunk of file.hunks) {
      const id = idByAlias.get(hunk.alias);
      if (!id || usedIds.has(id)) continue;
      ids.push(id);
      const ofPath = byPath.get(file.path) ?? [];
      ofPath.push(id);
      byPath.set(file.path, ofPath);
    }
  }

  return { ids, byPath };
}

/** The files the model left out: the ones that still have a hunk no stop covers. */
function normalizeRoutine(rawRoutine: { path: string; note: string }[], uncoveredByPath: Map<string, string[]>): RoutineNote[] {
  const routine: RoutineNote[] = [];
  const seen = new Set<string>();
  for (const entry of rawRoutine) {
    if (routine.length >= MAX_ROUTINE_NOTES) break;
    const path = asString(entry.path);
    const note = asString(entry.note);
    if (!note || !uncoveredByPath.has(path) || seen.has(path)) continue;
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
