# 03: Generate a walkthrough end to end

**What to build:** A reviewer presses Generate walkthrough and watches the generation move through visible stages - collecting, asking, assembling, done - and then reads the resulting document in the panel: one chapter holding stops, each stop naming the hunks it explains and saying what changed. The model runs in an agent the reviewer never sees, never sees the repository, and receives the diff in the prompt.

**Blocked by:** 01 (Scaffold the plugin and show the working-tree diff).

**Status:** ready-for-agent

- [ ] Pressing Generate starts a background job and returns immediately; the panel polls the status and shows the current stage.
- [ ] The stages are collecting, asking, retrying, assembling, done, failed, and cancelled, and the panel renders the current one.
- [ ] The model runs in an agent the user never sees: on daemon 0.16.2 and newer the agent is created as a background agent in the workspace, on daemon 0.15.4 a background workspace is created and the agent runs inside it.
- [ ] The model never gets repository access: the agent works in a plugin-owned scratch directory and receives the diff in the prompt.
- [ ] Every stop names the hunks it explains, by a stable identity of scope, path, and hunk content.
- [ ] A malformed answer is retried up to two times with the validation errors as feedback; a third failure ends the job as failed with a readable message.
- [ ] A server-side test drives the RPC boundary with a stubbed model and asserts the job states, the resulting document, and the retry path.
