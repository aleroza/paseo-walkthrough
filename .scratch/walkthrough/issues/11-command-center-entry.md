# 11: Command Center entry

**What to build:** A reviewer starts a walkthrough from the Command Center, for the workspace they are in, without opening the panel first, and lands on the running generation.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [ ] The plugin contributes a Command Center entry that starts a walkthrough for the current workspace.
- [ ] The entry uses the source, model, and language remembered for that workspace.
- [ ] Starting from the Command Center opens the walkthrough and shows the generation stages.
- [ ] The entry is hidden or disabled when the workspace has no project to walk through.
- [ ] The entry does not start a second generation while one is already running for that workspace.
- [ ] A server-side test drives the RPC boundary and asserts that the entry starts a job with the remembered settings.
