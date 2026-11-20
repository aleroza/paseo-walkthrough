import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_NAMES, MAX_CHAPTERS, MAX_CHAPTER_TITLE_CHARS, MAX_HUNKS_PER_STOP, MAX_OBSERVATIONS, MAX_STOPS, OBSERVATION_KINDS } from "../shared/constants";
import type { WalkthroughLanguage, WalkthroughScope } from "../shared/constants";
import type { Digest } from "./digest";

// Ported from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn), packages/web/server/lib/walkthrough/prompt.ts.

/** The language of the prose: an unsupported tag falls back to the base tag, then to English. */
export function normalizeLanguage(value: string): WalkthroughLanguage {
  if ((LANGUAGES as readonly string[]).includes(value)) return value as WalkthroughLanguage;

  const normalized = value.toLowerCase().replace(/_/g, "-");
  const match = LANGUAGES.find((tag) => tag.toLowerCase() === normalized || normalized.startsWith(`${tag.toLowerCase()}-`));
  if (match) return match;

  const base = normalized.split("-")[0] ?? "";
  return LANGUAGES.find((tag) => tag.toLowerCase() === base) ?? DEFAULT_LANGUAGE;
}

const SYSTEM = `You are writing a walkthrough of a code change for the engineer who is about to read it. They did not write it: it came from a colleague, a contributor, or a coding agent, and they need to understand what it does and what they take on by accepting it.

A walkthrough does three things.

1. Reading order. A diff is ordered by file path, which is almost never the order in which a change makes sense. Group related hunks, across files, into stops, and order the stops so each one is understandable given the ones before it: data shape and entry points before the code that consumes them. A test belongs in the stop of the code whose behavior it proves, unless the tests are the change.

2. Explanation. Each stop says, in two to four plain sentences, what the code now does differently, in terms of behavior, and why these hunks belong together. Do not restate the diff ("Renamed X to Y", "Added a parameter", "Updated the imports"); the reader can already see it. Prose explains and never tells the reader what to do: no "check that", "verify", "make sure", "consider", "review carefully".

3. Observations, rarely. An observation is a fact about the change that the reader is agreeing to and that the explanation alone would let them miss. It has exactly one of these kinds:
- "decision": a product or architecture call made here that could reasonably have gone another way, such as a platform left unsupported, a behavior changed for everyone, a new setting, or a new place data is kept.
- "cost": something the project carries from now on, such as code in another language or runtime, a new dependency or a pinned version, a native or build step, or a second implementation of something that already exists.
- "limitation": something users still cannot do, or will see fail, after this change, as the code or its docs state or as follows directly from the code.
- "asymmetry": two implementations or paths of the same thing that behave differently for the user, such as two platforms, two runtimes, or an old and a new path. Different libraries or APIs behind the same behavior are not an asymmetry.
- "unproven": the change's main promise has no test or check exercising it.
An observation is one or two sentences naming the concrete consequence for a user or for the people maintaining the code, and it rests on what the stop's own hunks show. It is never a guess at a bug, never style, naming, or placement, never advice, and never an instruction to the reader. Most stops have none. When in doubt, leave it out.

The focus line says what changes for the people using the software: what they can now do, or no longer run into, compared with before. Work it out from the code itself: user-facing strings, docs and README changes, tests and their names, error handling, and what the new code connects to. When the change has no user-facing effect, such as a refactor or internal tooling, say what it changes for the people working on the code. The focus line does not list risks.

Rules:
- Anchor every stop to hunk aliases from the digest, exactly as given (h1, h2, …). Never invent an alias.
- Anchor each hunk at most once, in the stop where it matters most.
- You do not have to cover every hunk. Mechanical changes are better left out than padded into a stop; whatever you omit is still shown to the reader separately, file by file.
- routine: for every file with hunks you left out of the stops, one entry {path, note}, path exactly as in the digest. The note is one short line on what changed there, so the reader can trust it without opening it: "Translations for the two new strings", "Snapshot updated for the renamed field", "Same rename as in the Android plugin". A file every hunk of which belongs to a stop gets no entry.
- importance: "critical" only for the stop or two that the rest of the change depends on or where its main behavior lives, "context" for supporting changes that are safe to skim (docs, wiring, translations, fixtures), "normal" otherwise.
- Stop titles name the thing the stop is about, not the act of reviewing it. "Hardware keyboard bridge" and "Overflow menu removed" tell a reader scanning the contents what they will find; "Exercise the boundaries" and "Describe the contract" do not.
- Write prose and observations as plain sentences. No markdown, no bullet lists, no code fences.

Respond with a single JSON object and nothing else. (Some providers refuse a structured-output request unless the word "json" appears in the request, which is why this is stated explicitly.)`;

const JSON_RESPONSE_INSTRUCTION = `
Return ONLY a JSON object, with no prose around it and no markdown fences, in exactly this shape:
{"title": string, "focus": string, "chapters": [{"title": string, "icon": "bug"|"wrench"|"path"|"flask"|"doc"|"gear", "blurb": string, "stops": [{"title": string, "hunks": [string], "importance": "critical"|"normal"|"context", "prose": string, "observations": [{"kind": ${OBSERVATION_KINDS.map((kind) => `"${kind}"`).join("|")}, "note": string}]}]}], "routine": [{"path": string, "note": string}]}`;

const languageInstruction = (language: WalkthroughLanguage) => `

Write all prose in ${LANGUAGE_NAMES[language]}: the walkthrough title, the focus line, chapter titles and blurbs, stop titles and prose, observation notes, and routine notes. The reader of this review reads ${LANGUAGE_NAMES[language]}.

Keep these in English exactly as given, regardless of the prose language: hunk aliases (h1, h2, …), the "icon" values, the "importance" values, and the observation "kind" values. Keep identifiers, file paths, and API names as they appear in the code — never translate them.`;

const sizing = (fileCount: number, hunkCount: number) => {
  const targetStops = Math.max(1, Math.min(MAX_STOPS, Math.round(hunkCount / 2.5) || 1));
  const targetChapters = hunkCount <= 4 ? 1 : Math.max(1, Math.min(MAX_CHAPTERS, Math.ceil(targetStops / 3)));
  const maxCritical = targetStops <= 3 ? 1 : targetStops <= 9 ? 2 : 3;
  const maxObservations = Math.max(1, Math.min(MAX_OBSERVATIONS, Math.ceil(targetStops / 3)));

  return `This change has ${fileCount} file(s) and ${hunkCount} reviewable hunk(s).

Aim for about ${targetStops} stop(s) across about ${targetChapters} chapter(s); never exceed ${MAX_STOPS} stops, ${MAX_CHAPTERS} chapters, or ${MAX_HUNKS_PER_STOP} hunks in one stop. Fewer, denser stops beat many thin ones.

Mark at most ${maxCritical} stop(s) "critical". Write at most ${maxObservations} observation(s) in the whole walkthrough, and none is a fine answer.

Chapter titles render in a narrow column: at most ${MAX_CHAPTER_TITLE_CHARS} characters, one or two words.`;
};

const sourceLine = (scope: WalkthroughScope, commit?: string) => {
  if (scope === "staged") return "Uncommitted local changes (staged).";
  if (scope === "unstaged") return "Uncommitted local changes (unstaged).";
  if (scope === "branch") return "All work on the current branch that is not in its base branch. Changes merged in from the base are already excluded.";
  if (scope === "commit") return `Only the changes introduced by commit ${commit ?? ""}, relative to its first parent (or the empty tree for a root commit).`;
  return "Uncommitted local changes (staged and unstaged).";
};

export interface PromptInput {
  digest: Digest;
  fileCount: number;
  hunkCount: number;
  scope: WalkthroughScope;
  commit?: string;
  language?: WalkthroughLanguage;
}

/** The prompt the model answers: what the change is, how long the answer should be, and the digest. */
export function buildPrompt({ digest, fileCount, hunkCount, scope, commit, language = DEFAULT_LANGUAGE }: PromptInput): { system: string; prompt: string } {
  const system = `${language === DEFAULT_LANGUAGE ? SYSTEM : `${SYSTEM}${languageInstruction(language)}`}\n${JSON_RESPONSE_INSTRUCTION}`;
  const prompt = `The change: ${sourceLine(scope, commit)}

${sizing(fileCount, hunkCount)}
Change digest:
${JSON.stringify(digest)}`;

  return { system, prompt };
}

/** The same prompt, with the reason the last answer was rejected. */
export function retryPrompt(prompt: string, problems: string): string {
  return `${prompt}

Your previous answer was rejected: ${problems}.

Answer again with a single JSON object in exactly the shape above, and anchor every stop to the hunk aliases of this digest.`;
}
