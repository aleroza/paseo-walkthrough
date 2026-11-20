# 01: Scaffold the plugin and show the working-tree diff

**What to build:** A reviewer opens the walkthrough panel in any Paseo workspace and sees the changes in the working tree: the list of changed files and the hunks in each. The plugin is installed and registered with Paseo under the id `walkthrough`. The diff is collected by the plugin itself with git, not by the daemon, and the plugin never writes to the project.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The plugin is registered with Paseo under the id `walkthrough` and contributes a workspace panel.
- [x] Git is invoked with a sanitised environment (the `GIT_*` variables removed) and with optional locks disabled.
- [x] The panel shows the changed files and the hunks of each, with added and removed lines distinguishable.
- [x] A project that is not a git repository produces a clear empty state rather than an error.
- [x] The plugin writes nothing outside its own data directory, and the working tree stays clean after using the panel.
- [x] A server-side test drives the RPC boundary against a temporary git repository and asserts the collected files and hunks.

## Comments

- The diff sits behind the existing `walkthrough.diff` contract. `Diff` gained one field,
  `repository: boolean`, so the panel tells "not a git repository" from "no changes" without an error.
- The server collects the working tree with `git diff HEAD` plus the untracked files, each diffed
  against nothing with `--no-index`, so a new file shows up as an added file.
- Hunk ids are `<scope>:<path>:<hash of the hunk header and body>`, the OpenChamber identity, so a
  later walkthrough keeps pointing at the same code.
- The plugin is installed with `paseo plugin install <checkout>`; the daemon logs
  `Loaded plugin ... "methods":["walkthrough.diff"]` when it picks it up.
