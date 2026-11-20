import { git } from "./git";

export interface BranchBase {
  /** The ref the comparison starts from. */
  ref: string;
  /** The name the reviewer sees: "origin/main", "main" or "the first commit". */
  label: string;
}

const CONVENTIONAL_BASES = ["main", "master", "develop", "trunk"];

/**
 * Finds the branch the current branch was built on, so the reviewer never has to name it.
 * The default branch of the remote comes first, then a conventional local branch, and finally the
 * first commit of the repository, which is where a branch with no base of its own starts.
 */
export async function detectBaseBranch(directory: string): Promise<BranchBase | null> {
  const head = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code !== 0) return null;

  const remote = await remoteDefaultBranch(directory);
  if (remote) return remote;

  const current = await currentBranch(directory);
  for (const name of CONVENTIONAL_BASES) {
    if (name === current) continue;
    const found = await git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (found.code === 0) return { ref: `refs/heads/${name}`, label: name };
  }

  const root = await git(directory, ["rev-list", "--max-parents=0", "HEAD"]);
  const first = root.stdout.trim().split("\n")[0]?.trim();
  if (!first) return null;
  return { ref: first, label: "the first commit" };
}

/**
 * The branch the remote points its HEAD at, which is the branch the repository was forked from.
 * Ported from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn), packages/web/server/lib/git/service.ts.
 */
async function remoteDefaultBranch(directory: string): Promise<BranchBase | null> {
  const refs = await git(directory, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"]);
  if (refs.code !== 0) return null;

  for (const line of refs.stdout.split("\n")) {
    const [refname, symref] = line.split(" ");
    const match = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(refname ?? "");
    if (!match) continue;
    const remote = match[1] ?? "";
    const prefix = `refs/remotes/${remote}/`;
    if (!symref || !symref.startsWith(prefix)) continue;
    const branch = symref.slice(prefix.length);
    if (!branch) continue;
    return { ref: symref, label: `${remote}/${branch}` };
  }
  return null;
}

async function currentBranch(directory: string): Promise<string> {
  const named = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return named.code === 0 ? named.stdout.trim() : "";
}
