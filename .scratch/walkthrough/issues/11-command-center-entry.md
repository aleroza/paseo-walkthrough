# 11: Command Center entry

**What to build:** A reviewer starts a walkthrough from the Command Center, for the workspace they are in, without opening the panel first, and lands on the running generation.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [x] The plugin contributes a Command Center entry that starts a walkthrough for the current workspace.
- [x] The entry uses the source, model, and language remembered for that workspace.
- [x] Starting from the Command Center opens the walkthrough and shows the generation stages.
- [ ] The entry is hidden or disabled when the workspace has no project to walk through.
- [x] The entry does not start a second generation while one is already running for that workspace.
- [x] A server-side test drives the RPC boundary and asserts that the entry starts a job with the remembered settings.

## Comments

- Paseo 0.15.4 supports workspace-scoped Command Center entries. Its contribution type has no visibility or disabled predicate, so the entry remains visible in non-Git workspaces. Selecting it there exits before calling the server or opening the panel.
- The command uses the saved revision when the source is a single commit. Applying a commit in the panel now remembers its hash alongside the other workspace settings.
