# 02: Choose what to walk through

**What to build:** A reviewer picks what the walkthrough should cover - uncommitted changes as a whole, staged only, unstaged only, the current branch against its base branch, or a single commit given by hash - and the panel immediately shows the diff for that source. Pull requests are out of scope.

**Blocked by:** 01 (Scaffold the plugin and show the working-tree diff).

**Status:** ready-for-agent

- [ ] The panel offers the five sources: all, staged, unstaged, branch, commit.
- [ ] Choosing a source re-collects the diff and the panel shows the files and hunks of that source.
- [ ] The branch source compares the current branch against its base branch, and the base branch is detected, not asked for.
- [ ] The commit source takes a commit hash, and an unknown hash produces a clear error instead of an empty diff.
- [ ] A repository with no commits, no base branch, or nothing staged falls back to a clear empty state.
- [ ] A server-side test drives the RPC boundary against a temporary git repository and asserts the diff for each source.
