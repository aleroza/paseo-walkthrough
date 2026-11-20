import { createHash } from "node:crypto";
import type { DiffFile, Hunk } from "../shared/types";

// Ported from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn), packages/web/server/lib/walkthrough/hunks.ts.
// A hunk is identified by its scope, its path and a hash of its header and body, so that a stop keeps pointing at the
// same code after the file is edited around it.

const FILE_HEADER = /^diff --git /;
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

const shortHash = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 8);

const parsePathsFromFileHeader = (line: string) => {
  const match = /^diff --git (?:\"?a\/(.+?)\"?) (?:\"?b\/(.+?)\"?)$/.exec(line);
  if (!match) return null;
  return { oldPath: match[1] ?? "", newPath: match[2] ?? "" };
};

const statusFromHeaderLines = (lines: string[]): DiffFile["status"] => {
  if (lines.some((line) => line.startsWith("new file mode"))) return "added";
  if (lines.some((line) => line.startsWith("deleted file mode"))) return "deleted";
  if (lines.some((line) => line.startsWith("rename from"))) return "renamed";
  return "modified";
};

const isBinaryHeader = (lines: string[]) => lines.some((line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"));

interface PendingHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  deleted: number;
  lines: string[];
}

/** Parses a unified diff into the files and hunks the walkthrough talks about. */
export function parsePatch(patch: string, scope: string): DiffFile[] {
  if (!patch.trim()) return [];

  const lines = patch.split(/\r?\n/);
  const files: DiffFile[] = [];
  let current: (DiffFile & { digests: Map<string, number> }) | null = null;
  let headerLines: string[] = [];
  let hunk: PendingHunk | null = null;

  const closeHunk = () => {
    if (!current || !hunk) return;
    // The patch ends with a newline, which splits into an empty last line that is not part of the hunk.
    if (hunk.lines.length > 0 && hunk.lines[hunk.lines.length - 1] === "") hunk.lines.pop();
    const body = hunk.lines.join("\n");
    const digest = shortHash(`${hunk.header}\n${body}`);
    const seen = current.digests.get(digest) ?? 0;
    current.digests.set(digest, seen + 1);
    const suffix = seen === 0 ? "" : `-${seen + 1}`;
    const entry: Hunk = {
      id: `${scope}:${current.path}:${digest}${suffix}`,
      path: current.path,
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      added: hunk.added,
      deleted: hunk.deleted,
      patch: `${hunk.header}\n${body}\n`,
    };
    current.hunks.push(entry);
    hunk = null;
  };

  const closeFile = () => {
    closeHunk();
    if (!current) return;
    current.binary = current.binary || isBinaryHeader(headerLines);
    const { digests: _digests, ...file } = current;
    files.push(file);
    current = null;
  };

  for (const line of lines) {
    if (FILE_HEADER.test(line)) {
      closeFile();
      headerLines = [line];
      const paths = parsePathsFromFileHeader(line);
      current = {
        path: paths?.newPath || paths?.oldPath || "",
        oldPath: paths && paths.oldPath !== paths.newPath ? paths.oldPath : null,
        status: "modified",
        binary: false,
        hunks: [],
        digests: new Map(),
      };
      continue;
    }

    if (!current) continue;

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      closeHunk();
      current.status = statusFromHeaderLines(headerLines);
      hunk = {
        header: line,
        oldStart: Number.parseInt(hunkMatch[1] ?? "", 10),
        oldLines: hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10),
        newStart: Number.parseInt(hunkMatch[3] ?? "", 10),
        newLines: hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10),
        added: 0,
        deleted: 0,
        lines: [],
      };
      continue;
    }

    if (!hunk) {
      headerLines.push(line);
      continue;
    }

    hunk.lines.push(line);
    if (line.startsWith("+")) hunk.added += 1;
    else if (line.startsWith("-")) hunk.deleted += 1;
  }

  closeFile();

  return files.filter((file) => file.path);
}

