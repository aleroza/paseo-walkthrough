import type { DiffFile, Hunk, SourceRequest, Staleness, WalkthroughDocument } from "../shared/types";
import { collectDiff } from "./diff";
import { isGeneratedArtifact } from "./generated";
import type { PaseoApi } from "./host-types";
import { resolveWorkspaceDirectory } from "./workspace";

type HunkLocation = Pick<Hunk, "id" | "path" | "header">;
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
  return new Map(files.filter((file) => !isGeneratedArtifact(file.path)).map((file) => [file.path, file.hunks.map(snapshotHunk)]));
}

function overlaps(left: HunkSnapshot, right: HunkSnapshot): boolean {
  const start = Math.max(left.oldChangeStart, right.oldChangeStart);
  const end = Math.min(left.oldChangeEnd, right.oldChangeEnd);
  return start < end || (start === end && (left.oldChangeStart === left.oldChangeEnd || right.oldChangeStart === right.oldChangeEnd));
}

const locationOf = ({ hunk: { id, path, header } }: HunkSnapshot): HunkLocation => ({ id, path, header });

function compareStaleness(document: WalkthroughDocument, before: StalenessSnapshot, after: StalenessSnapshot): Staleness {
  const edited = new Set<string>();
  const missingHunks: HunkLocation[] = [];
  const uncoveredHunks: HunkLocation[] = [];

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const oldHunks = before.get(path) ?? [];
    const newHunks = after.get(path) ?? [];
    const oldIds = new Set(oldHunks.map(({ hunk }) => hunk.id));
    const newIds = new Set(newHunks.map(({ hunk }) => hunk.id));
    const gained = newHunks.filter(({ hunk }) => !oldIds.has(hunk.id));
    uncoveredHunks.push(...gained.map(locationOf));

    for (const hunk of oldHunks) {
      if (newIds.has(hunk.hunk.id)) continue;
      if (gained.some((replacement) => overlaps(hunk, replacement))) {
        edited.add(hunk.hunk.id);
      } else {
        missingHunks.push(locationOf(hunk));
      }
    }
  }

  const staleStopIds = document.chapters
    .flatMap((chapter) => chapter.stops)
    .filter((stop) => stop.hunkIds.some((id) => edited.has(id)))
    .map((stop) => stop.id);

  return {
    stale: edited.size > 0 || missingHunks.length > 0 || uncoveredHunks.length > 0,
    staleStopIds,
    uncoveredHunkIds: uncoveredHunks.map((hunk) => hunk.id),
    missingHunkIds: missingHunks.map((hunk) => hunk.id),
    uncoveredHunks,
    missingHunks,
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
