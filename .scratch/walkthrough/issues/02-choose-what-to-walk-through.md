# 02: Choose what to walk through

**What to build:** A reviewer picks what the walkthrough should cover - uncommitted changes as a whole, staged only, unstaged only, the current branch against its base branch, or a single commit given by hash - and the panel immediately shows the diff for that source. Pull requests are out of scope.

**Blocked by:** 01 (Scaffold the plugin and show the working-tree diff).

**Status:** ready-for-agent

- [x] The panel offers the five sources: all, staged, unstaged, branch, commit.
- [x] Choosing a source re-collects the diff and the panel shows the files and hunks of that source.
- [x] The branch source compares the current branch against its base branch, and the base branch is detected, not asked for.
- [x] The commit source takes a commit hash, and an unknown hash produces a clear error instead of an empty diff.
- [x] A repository with no commits, no base branch, or nothing staged falls back to a clear empty state.
- [x] A server-side test drives the RPC boundary against a temporary git repository and asserts the diff for each source.

## Comments

- The panel shows the five sources as pills above the diff. Choosing one re-collects through the
  existing `walkthrough.diff` contract, which already took a `scope`; the commit source adds a
  hash field and asks for it in the panel instead of guessing one.
- The base branch is detected, in this order: the default branch of the remote
  (`refs/remotes/<remote>/HEAD`), a conventional local branch (`main`, `master`, `develop`, `trunk`),
  and finally the first commit of the repository, which is where a branch with no base of its own
  starts. The branch source compares the merge base of that base against `HEAD`, so it shows the
  commits the branch has and its base does not.
- `walkthrough.diff` returns the base it compared against next to the diff, so the panel can say
  `compared against origin/main` instead of leaving the reviewer to guess.
- The branch source shows the committed work of the branch. The uncommitted work stays with the
  `all`, `staged` and `unstaged` sources, so the five sources never overlap.
- Every git call stays read-only: `rev-parse`, `symbolic-ref`, `for-each-ref`, `rev-list`,
  `merge-base`, `diff`, `show`. The test that the working tree stays exactly as it was now runs
  every source, not just the working tree.
