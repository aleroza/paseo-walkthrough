import type { DiffFile, Hunk, SourceRequest, Staleness, WalkthroughDocument } from "../shared/types";
import { collectDiff } from "./diff";
import { isGeneratedArtifact } from "./generated";
import type { PaseoApi } from "./host-types";
import { resolveWorkspaceDirectory } from "./workspace";

type HunkLocation = Pick<Hunk, "id" | "path" | "section" | "header">;
type HunkSnapshot = { hunk: Hunk; oldChangeStart: number; oldChangeEnd: number };
type StalenessSnapshot = Map<string, HunkSnapshot[]>;

function snapshotHunk(hunk: Hunk): HunkSnapshot {
  // Use the changed range in the original file so diff context and shifts on the new side do not decide which edits overlap.
  let oldLine = hunk.oldStart - Number(hunk.oldLines > 0);
  let oldChangeStart = Infinity;
  let oldChangeEnd = -Infinity;
  for (const line of hunk.patch.split("\n").slice(1)) {
    if (line.startsWith("+") || line.startsWith("-")) {
      oldChangeStart = Math.min(oldChangeStart, oldLine);
      oldChangeEnd = oldLine + Number(line.startsWith("-"));
    }
    if (line.startsWith(" ") || line.startsWith("-")) oldLine += 1;
  }
  return { hunk, oldChangeStart, oldChangeEnd };
}

export function snapshotHunks(files: DiffFile[]): StalenessSnapshot {
  return new Map(files.filter((file) => !isGeneratedArtifact(file.path)).map((file) => {
    // Older cached Staged and Unstaged snapshots only recorded the section in the hunk ID.
    const section = file.section ?? file.hunks[0]?.id.split(":", 1)[0] ?? "";
    return [`${section}:${file.path}`, file.hunks.map(snapshotHunk)];
  }));
}

function overlaps(left: HunkSnapshot, right: HunkSnapshot): boolean {
  const start = Math.max(left.oldChangeStart, right.oldChangeStart);
  const end = Math.min(left.oldChangeEnd, right.oldChangeEnd);
  return start < end || (start === end && (left.oldChangeStart === left.oldChangeEnd || right.oldChangeStart === right.oldChangeEnd));
}

const locationOf = ({ hunk: { id, path, section, header } }: HunkSnapshot): HunkLocation => ({ id, path, section, header });

function compareStaleness(document: WalkthroughDocument, before: StalenessSnapshot, after: StalenessSnapshot): Staleness {
  const outdatedHunkIds = new Set<string>();
  const missingHunks: HunkLocation[] = [];
  const uncoveredHunks: HunkLocation[] = [];
  const currentUncoveredHunks = new Map<string, Hunk>();
  for (const entries of after.values()) {
    for (const { hunk } of entries) currentUncoveredHunks.set(hunk.id, hunk);
  }

  // Older All caches have one combined patch per path. An exact match in one current section can still anchor the stop.
  const legacyMatches = new Map<string, string>();
  const liveSectionsByLegacyKey = new Map<string, HunkSnapshot[]>();
  for (const [key, oldHunks] of before) {
    if (!key.startsWith("all:")) continue;
    const path = key.slice("all:".length);
    const liveHunks = [...(after.get(`staged:${path}`) ?? []), ...(after.get(`unstaged:${path}`) ?? [])];
    for (const { hunk: old } of oldHunks) {
      const identical = liveHunks.filter(({ hunk }) => hunk.patch === old.patch);
      if (identical.length === 1) legacyMatches.set(old.id, identical[0].hunk.id);
    }
    liveSectionsByLegacyKey.set(key, liveHunks);
  }
  const matchedCurrentIds = new Set(legacyMatches.values());

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldHunks = before.get(key) ?? [];
    const newHunks = after.get(key) ?? [];
    const oldIds = new Set(oldHunks.map(({ hunk }) => hunk.id));
    const newIds = new Set(newHunks.map(({ hunk }) => hunk.id));
    const gained = newHunks.filter(({ hunk }) => !oldIds.has(hunk.id) && !matchedCurrentIds.has(hunk.id));
    uncoveredHunks.push(...gained.map(locationOf));

    const replacements = liveSectionsByLegacyKey.get(key) ?? gained;
    for (const hunk of oldHunks) {
      if (newIds.has(hunk.hunk.id) || legacyMatches.has(hunk.hunk.id)) continue;
      outdatedHunkIds.add(hunk.hunk.id);
      if (!replacements.some((replacement) => overlaps(hunk, replacement))) {
        missingHunks.push(locationOf(hunk));
      }
    }
  }

  const stops = document.chapters.flatMap((chapter) => chapter.stops);
  const staleStopIds = stops
    .filter((stop) => stop.hunkIds.some((id) => outdatedHunkIds.has(id)))
    .map((stop) => stop.id);
  for (const stop of stops) {
    for (const id of stop.hunkIds) currentUncoveredHunks.delete(legacyMatches.get(id) ?? id);
  }

  return {
    stale: outdatedHunkIds.size > 0 || uncoveredHunks.length > 0,
    staleStopIds,
    uncoveredHunkIds: uncoveredHunks.map((hunk) => hunk.id),
    missingHunkIds: missingHunks.map((hunk) => hunk.id),
    uncoveredHunks,
    missingHunks,
    outdatedHunkIds: [...outdatedHunkIds],
    currentUncoveredHunks: [...currentUncoveredHunks.values()],
  };
}

export async function readStaleness(
  paseo: PaseoApi,
  source: SourceRequest,
  document: WalkthroughDocument,
  builtHunks: StalenessSnapshot,
): Promise<Staleness | null> {
  try {
    const directory = await resolveWorkspaceDirectory(paseo, source.workspaceId);
    const { diff } = await collectDiff(directory, source.scope, source.commit);
    if (!diff.repository) return null;
    return compareStaleness(document, builtHunks, snapshotHunks(diff.files));
  } catch {
    return null;
  }
}
