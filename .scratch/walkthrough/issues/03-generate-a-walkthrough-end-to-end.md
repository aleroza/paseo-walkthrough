# 03: Generate a walkthrough end to end

**What to build:** A reviewer presses Generate walkthrough and watches the generation move through visible stages - collecting, asking, assembling, done - and then reads the resulting document in the panel: one chapter holding stops, each stop naming the hunks it explains and saying what changed. The model runs in an agent the reviewer never sees, never sees the repository, and receives the diff in the prompt.

**Blocked by:** 01 (Scaffold the plugin and show the working-tree diff).

**Status:** ready-for-agent

- [x] Pressing Generate starts a background job and returns immediately; the panel polls the status and shows the current stage.
- [x] The stages are collecting, asking, retrying, assembling, done, failed, and cancelled, and the panel renders the current one.
- [x] The model runs in a hidden agent in a separate background workspace.
- [x] The model never gets repository access: the agent works in a plugin-owned scratch directory and receives the diff in the prompt.
- [x] Every stop names the hunks it explains, by a stable identity of scope, path, and hunk content.
- [x] A malformed answer is retried up to two times with the validation errors as feedback; a third failure ends the job as failed with a readable message.
- [x] A server-side test drives the RPC boundary with a stubbed model and asserts the job states, the resulting document, and the retry path.

## Comments

- `walkthrough.generate` starts a job and returns its id; the model call never happens inside a
  handler, because a plugin RPC times out after 30 seconds on daemon 0.15.4. The panel polls
  `walkthrough.status` while the job runs and stops when it reaches a terminal state.
- The job carries the states it has been in (`stages`), so the panel can show the trail and the
  test can assert the path a job took: collecting, asking, assembling, done.
- The plugin sets the background flag and omits the workspace id on both supported daemon
  versions. Paseo 0.16.2 replaces the requested working directory when a workspace id is supplied.
- The agent works in `$PASEO_HOME/plugin-data/walkthrough/scratch/<job id>` (mode 0700) and never in
  the repository; the diff reaches it as the digest in the prompt, and the agent is archived when
  the job ends.
- The prompt, the digest and the normalizer are ported from OpenChamber (MIT, Copyright (c) 2025
  Bohdan Triapitsyn): the hunks are aliased h1, h2, ..., and every stop is anchored to the hunk
  identity of ticket 01 (`<scope>:<path>:<hash>`), so a stop keeps pointing at the same code.
- The answer is read the way a reader would: the JSON is parsed leniently, the shape is checked
  with zod, and what cannot be anchored or read is dropped. A malformed answer is asked again
  twice, with the validation errors in the prompt; the third failure ends the job with a readable
  message.
