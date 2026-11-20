import { stat } from "node:fs/promises";
import type { WalkthroughScope } from "../shared/constants";
import type { Diff, DiffFile } from "../shared/types";
import { git } from "./git";
import { isGeneratedArtifact } from "./generated";
import { parsePatch } from "./patch";

interface Section {
  scope: string;
  patch: string;
}

const emptyDiff = (repository: boolean): Diff => ({ files: [], hunkCount: 0, fileCount: 0, generatedPaths: [], repository });

/** Collects the working tree of a workspace with git. Nothing is written to the project. */
export async function collectDiff(directory: string, scope: WalkthroughScope, commit?: string): Promise<Diff> {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`The workspace directory ${directory} does not exist.`);

  const repository = await git(directory, ["rev-parse", "--show-toplevel"]);
  if (repository.code !== 0) return emptyDiff(false);

  const sections = await collectSections(directory, scope, commit);
  const files = mergeFiles(sections.flatMap((section) => parsePatch(section.patch, section.scope)));
  const hunkCount = files.reduce((sum, file) => sum + file.hunks.length, 0);

  return {
    files,
    hunkCount,
    fileCount: files.length,
    generatedPaths: files.filter((file) => isGeneratedArtifact(file.path)).map((file) => file.path),
    repository: true,
  };
}

async function collectSections(directory: string, scope: WalkthroughScope, commit?: string): Promise<Section[]> {
  if (scope === "commit") {
    if (!commit) throw new Error("The commit source needs a commit hash.");
    const shown = await git(directory, ["show", "--format=", "--patch", "--relative", "--no-color", "--no-ext-diff", commit]);
    if (shown.code !== 0) throw new Error(`Commit ${commit} is not in this repository.`);
    return [{ scope: "commit", patch: shown.stdout }];
  }

  if (scope === "staged") {
    const staged = await git(directory, ["diff", "--relative", "--cached", "--no-color", "--no-ext-diff"]);
    return [{ scope: "staged", patch: staged.stdout }];
  }

  if (scope === "unstaged") {
    const unstaged = await git(directory, ["diff", "--relative", "--no-color", "--no-ext-diff"]);
    return [{ scope: "unstaged", patch: unstaged.stdout }, ...(await untrackedSections(directory, "unstaged"))];
  }

  if (scope === "branch") throw new Error("The branch source needs a base branch, which the source picker detects.");

  // Everything in the working tree against HEAD: the state the reviewer would see in the app.
  const head = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const args = head.code === 0 ? ["diff", "--relative", "--no-color", "--no-ext-diff", "HEAD"] : ["diff", "--relative", "--cached", "--no-color", "--no-ext-diff"];
  const all = await git(directory, args);
  return [{ scope: "all", patch: all.stdout }, ...(await untrackedSections(directory, "all"))];
}

/** Untracked files are part of the working tree: git has no patch for them until they are staged, so they are diffed against nothing. */
async function untrackedSections(directory: string, scope: string): Promise<Section[]> {
  const listed = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listed.code !== 0) return [];

  const sections: Section[] = [];
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    const result = await git(directory, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-index", "--", "/dev/null", path]);
    if (result.code === 0 || result.code === 1) sections.push({ scope, patch: result.stdout });
  }
  return sections;
}

function mergeFiles(files: DiffFile[]): DiffFile[] {
  const merged = new Map<string, DiffFile>();
  for (const file of files) {
    const existing = merged.get(file.path);
    if (!existing) {
      merged.set(file.path, file);
      continue;
    }
    existing.hunks.push(...file.hunks);
    if (file.oldPath) existing.oldPath = file.oldPath;
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}
