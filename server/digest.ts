import type { DiffFile } from "../shared/types";
import { isGeneratedArtifact } from "./generated";

// Ported from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn), packages/web/server/lib/walkthrough/digest.ts.
// The model never sees the raw diff: it sees the hunks under short aliases, and the alias table
// maps every alias back to the stable hunk identity the document anchors its stops to.

export interface DigestHunk {
  alias: string;
  header: string;
  oldLines: string;
  newLines: string;
  added: number;
  deleted: number;
  patch: string;
}

export interface DigestFile {
  path: string;
  oldPath?: string;
  status: DiffFile["status"];
  scope?: string;
  binary?: true;
  hunks: DigestHunk[];
}

export interface Digest {
  files: DigestFile[];
}

export interface BuiltDigest {
  digest: Digest;
  /** Alias to hunk id: the model names a hunk by its alias, the document by its id. */
  idByAlias: Map<string, string>;
  hunkCount: number;
  fileCount: number;
  generatedPaths: string[];
}

const hunkBody = (patch: string) => patch.split("\n").slice(1).join("\n");

const lineRange = (start: number, count: number) => `${start}-${start + Math.max(0, count - 1)}`;

/** Builds the digest of a collected diff: the hunks the model may anchor a stop to. */
export function buildDigest(files: DiffFile[], scope: string): BuiltDigest {
  const idByAlias = new Map<string, string>();
  let counter = 0;

  const digestFiles: DigestFile[] = [];
  const generatedPaths = new Set<string>();

  for (const file of files) {
    if (isGeneratedArtifact(file.path)) {
      generatedPaths.add(file.path);
      continue;
    }

    const entry: DigestFile = {
      path: file.path,
      status: file.status,
      hunks: file.hunks.map((hunk) => {
        counter += 1;
        const alias = `h${counter}`;
        idByAlias.set(alias, hunk.id);
        return {
          alias,
          header: hunk.header,
          oldLines: lineRange(hunk.oldStart, hunk.oldLines),
          newLines: lineRange(hunk.newStart, hunk.newLines),
          added: hunk.added,
          deleted: hunk.deleted,
          patch: hunkBody(hunk.patch),
        };
      }),
    };
    if (file.oldPath) entry.oldPath = file.oldPath;
    if (file.binary) entry.binary = true;
    if (scope !== "branch") entry.scope = file.section ?? scope;
    digestFiles.push(entry);
  }

  return {
    digest: { files: digestFiles },
    idByAlias,
    hunkCount: counter,
    fileCount: new Set(digestFiles.map((file) => file.path)).size,
    generatedPaths: [...generatedPaths],
  };
}
