import { stat } from "node:fs/promises";
import type { WalkthroughScope } from "../shared/constants";
import type { CommitOption, Diff, DiffFile } from "../shared/types";
import { detectBaseBranch } from "./branch";
import { git, gitOutput } from "./git";
import { isGeneratedArtifact } from "./generated";
import { parsePatch } from "./patch";

interface Section {
  scope: Exclude<WalkthroughScope, "all">;
  patch: string;
}

export interface SourceDiff {
  diff: Diff;
  root: string | null;
  /** The base the branch source compared against, when it found one. */
  base: string | null;
}

const emptyDiff = (repository: boolean): Diff => ({ files: [], hunkCount: 0, fileCount: 0, generatedPaths: [], repository });

// The commit reaches git as an argument, so it has to be a hash and nothing else: `git show --output=<file>`
// would otherwise write a file wherever the argument points.
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const PATCH_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

export async function listRecentCommits(directory: string): Promise<CommitOption[]> {
  const head = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code === 1) return [];
  gitOutput(head, "rev-parse");

  const result = await git(directory, ["log", "-50", "-z", "--no-show-signature", "--format=%H%x00%s", "HEAD", "--"]);
  const fields = gitOutput(result, "log").split("\0");
  const commits: CommitOption[] = [];
  for (let i = 0; i + 1 < fields.length - 1; i += 2) {
    commits.push({ hash: fields[i], subject: fields[i + 1] });
  }
  return commits;
}

/** Collects the working tree of a workspace with git. Nothing is written to the project. */
export async function collectDiff(directory: string, scope: WalkthroughScope, commit?: string): Promise<SourceDiff> {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`The workspace path ${directory} is not a directory.`);

  const repository = await git(directory, ["rev-parse", "--show-toplevel"]);
  if (repository.code === 128 && /^fatal: not a git repository\b/m.test(repository.stderr)) {
    return { diff: emptyDiff(false), base: null, root: null };
  }
  const root = gitOutput(repository, "rev-parse").replace(/\r?\n$/, "");

  const collected = await collectSections(directory, scope, commit);
  const files = mergeFiles(collected.sections.flatMap((section) => parsePatch(section.patch, section.scope)));
  const hunkCount = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const paths = [...new Set(files.map((file) => file.path))];

  return {
    diff: {
      files,
      hunkCount,
      fileCount: paths.length,
      generatedPaths: paths.filter(isGeneratedArtifact),
      repository: true,
    },
    base: collected.base,
    root,
  };
}

async function collectSections(directory: string, scope: WalkthroughScope, commit?: string): Promise<{ sections: Section[]; base: string | null }> {
  if (scope === "commit") {
    if (!commit) throw new Error("The commit source needs a commit hash.");
    if (!COMMIT_HASH.test(commit)) throw new Error("The commit source needs a full commit hash.");
    const shown = await git(directory, ["show", "--format=", "--patch", "--diff-merges=first-parent", "--relative", ...PATCH_OPTIONS, `${commit}^{commit}`, "--"]);
    if (shown.code === 128 && /^fatal: bad (?:object|revision) /m.test(shown.stderr)) {
      throw new Error(`Commit ${commit} is not in this repository.`);
    }
    return { sections: [{ scope, patch: gitOutput(shown, "show") }], base: null };
  }

  if (scope === "branch") return branchSections(directory);

  const sections = scope === "all" ? await allSections(directory) : await workingTreeSections(directory, scope);
  return { sections, base: null };
}

async function indexVersion(index: string): Promise<string | null> {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = await stat(index, { bigint: true });
    return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function allSections(directory: string): Promise<Section[]> {
  const path = await git(directory, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const index = gitOutput(path, "rev-parse").replace(/\r?\n$/, "");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Git replaces the index atomically. Both halves and untracked discovery must see the same version.
    const before = await indexVersion(index);
    const sections = await workingTreeSections(directory, "all");
    if (before === await indexVersion(index)) return sections;
  }
  throw new Error("The Git index kept changing while reading the diff. Try again once staging has finished.");
}

async function workingTreeSections(directory: string, scope: "all" | "staged" | "unstaged"): Promise<Section[]> {
  const sections: Section[] = [];
  if (scope !== "unstaged") {
    const staged = await git(directory, ["diff", "--relative", "--cached", ...PATCH_OPTIONS]);
    sections.push({ scope: "staged", patch: gitOutput(staged, "diff") });
  }

  if (scope !== "staged") {
    const unstaged = await git(directory, ["diff", "--relative", ...PATCH_OPTIONS]);
    sections.push({ scope: "unstaged", patch: gitOutput(unstaged, "diff") }, ...(await untrackedSections(directory)));
  }

  return sections;
}

/** The commits of the current branch that its base branch does not have. */
async function branchSections(directory: string): Promise<{ sections: Section[]; base: string | null }> {
  const base = await detectBaseBranch(directory);
  if (!base) return { sections: [], base: null };

  const mergeBase = await git(directory, ["merge-base", base.ref, "HEAD"]);
  if (mergeBase.code === 1) return { sections: [], base: base.label };

  const from = gitOutput(mergeBase, "merge-base").trim();
  const patch = await git(directory, ["diff", "--relative", ...PATCH_OPTIONS, from, "HEAD", "--"]);
  return { sections: [{ scope: "branch", patch: gitOutput(patch, "diff") }], base: base.label };
}

/** Untracked files are part of the working tree: git has no patch for them until they are staged, so they are diffed against nothing. */
async function untrackedSections(directory: string): Promise<Section[]> {
  const listed = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = gitOutput(listed, "ls-files").split("\0").filter(Boolean);

  const sections: Section[] = [];
  for (const path of paths) {
    const result = await git(directory, ["diff", ...PATCH_OPTIONS, "--no-index", "--", "/dev/null", path]);
    // With --no-index, Git returns 1 for a difference and for some errors.
    const differenceCode = /^(?:error|fatal):/m.test(result.stderr) ? 0 : 1;
    sections.push({ scope: "unstaged", patch: gitOutput(result, "diff", differenceCode) });
  }
  return sections;
}

function mergeFiles(files: DiffFile[]): DiffFile[] {
  const merged = new Map<string, DiffFile>();
  for (const file of files) {
    const key = `${file.section ?? ""}:${file.path}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, file);
      continue;
    }
    existing.hunks.push(...file.hunks);
    if (file.oldPath) existing.oldPath = file.oldPath;
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}
