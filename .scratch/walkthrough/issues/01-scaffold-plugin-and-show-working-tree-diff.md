# 01: Scaffold the plugin and show the working-tree diff

**What to build:** A reviewer opens the walkthrough panel in any Paseo workspace and sees the changes in the working tree: the list of changed files and the hunks in each. The plugin is installed and registered with Paseo under the id `walkthrough`. The diff is collected by the plugin itself with git, not by the daemon, and the plugin never writes to the project.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The plugin is registered with Paseo under the id `walkthrough` and contributes a workspace panel.
- [ ] Git is invoked with a sanitised environment (the `GIT_*` variables removed) and with optional locks disabled.
- [ ] The panel shows the changed files and the hunks of each, with added and removed lines distinguishable.
- [ ] A project that is not a git repository produces a clear empty state rather than an error.
- [ ] The plugin writes nothing outside its own data directory, and the working tree stays clean after using the panel.
- [ ] A server-side test drives the RPC boundary against a temporary git repository and asserts the collected files and hunks.
