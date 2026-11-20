# Change Walkthrough plugin for Paseo

Status: ready-for-agent

## Problem Statement

A reviewer opening a diff in Paseo today sees raw hunks: file paths, plus/minus lines, and
nothing about what the change means or how to read it. Understanding a large change means
reading every hunk and reconstructing the intent, the ordering, and the trade-offs by hand.
OpenChamber solved this with a Change Walkthrough: a language model writes a reading order
over the diff - chapters, stops anchored to specific hunks, prose explaining what changed, and
a short list of observations (decisions, costs, limitations, asymmetries, unproven promises) -
plus a list of mechanical changes the walkthrough deliberately did not cover.

Inside Paseo there is no equivalent. The user already has the diff in front of them, and the
daemon already has a provider, a model, and a structured-output-capable agent runtime - but
nothing composes them into a reading order.

What the user wants, concretely: in any Paseo workspace, ask for a walkthrough of the current
changes, and get back a document that says what the change does, in what order to read it, why
the author made the choices they made, what it costs, and what is still unproven - anchored to
the exact lines of the diff, so every claim can be checked against the code.

## Solution

A Paseo plugin, `walkthrough`, that turns a project's git diff into that document.

The plugin contributes a workspace panel, and a Command Center entry, where the reviewer picks
what to walk through - uncommitted changes as a whole, staged only, unstaged only, a branch
against its base, or a single commit - presses Generate walkthrough, and watches the generation
move through visible stages. When it finishes, the panel shows the walkthrough: a table of
contents of chapters, each chapter holding stops; every stop names the hunks it talks about,
explains the change in a few sentences, and carries any observations worth flagging; below that,
the files the walkthrough skipped with a one-line note each, and a list of changes that no stop
covered.

The plugin never touches the user's project: it reads the diff with git, sends the diff to a
model through a throwaway agent the user never sees, and writes only its own cache and
settings. If the diff changes while a walkthrough is on screen, the panel says so - which stops
are stale, and what appeared that nothing covers yet - instead of quietly showing an outdated
answer.

## User Stories

1. As a reviewer of a pull-request-sized change, I want the plugin to list every change in the working tree, staged or not, so I can pick what the walkthrough should cover.

2. As a reviewer, I want to select only the staged changes, or only the unstaged ones, so that I can walk through a specific slice of work.

3. As a reviewer, I want to walk through my branch against its base branch, so that I can review the whole feature rather than a single commit.

4. As a reviewer, I want to walk through a single commit, so that I can review one specific change in isolation.

5. As a reviewer, I want the walkthrough to be grouped into chapters, so that I get a reading order rather than a flat list of hunks.

6. As a reviewer, I want each stop to name the exact hunks it explains, so that every claim in the prose can be checked against the diff.

7. As a reviewer, I want each stop to carry a short explanation of what changed and why, so that I understand the change without reading the whole diff myself.

8. As a reviewer, I want each stop to carry observations, so that decisions, costs, limitations, asymmetries, and unproven promises surface where I read the change.

9. As a reviewer, I want each observation tagged with its kind and an icon, so that I can scan the walkthrough for the things that need my attention.

10. As a reviewer, I want the walkthrough to list the files it skipped, so that I know what I still have to read myself.

11. As a reviewer, I want each skipped file to carry a one-line reason, so that I can tell mechanical churn from something meaningful.

12. As a reviewer, I want the walkthrough to list the hunks no stop covered, so that I do not assume the document is exhaustive.

13. As a reviewer, I want to see the generation stages, so that I know whether the plugin is still collecting the diff, asking the model, retrying, or assembling the document.

14. As a reviewer, I want to cancel a running generation, so that a long walkthrough I no longer want does not keep burning tokens.

15. As a reviewer, I want the plugin to tell me when the diff changed under a walkthrough I am looking at, so that I do not review a stale document.

16. As a reviewer, I want to see which stops are stale, so that I know which parts to re-check.

17. As a reviewer, I want to see newly appeared changes that no stop covers, so that I know what the walkthrough is missing.

18. As a reviewer, I want to pick the model that writes the walkthrough, so that I can trade cost against quality per review.

19. As a reviewer, I want to pick the language the walkthrough is written in, so that I can read it in the language I think in.

20. As a reviewer, I want my model and language choice remembered per workspace, so that I do not re-pick them every time.

21. As a reviewer, I want the last walkthrough for a workspace to be restored when I reopen the panel, so that I can go back to what I was reading.

22. As a reviewer, I want a cached walkthrough to be reused when the diff and the settings did not change, so that re-opening the panel is instant and free.

23. As a reviewer, I want the plugin to use an OpenChamber-style digest of the diff instead of the raw diff, so that the model spends its budget on the changed code rather than on context noise.

24. As a reviewer, I want generated files and lock files excluded from the digest, so that the walkthrough describes the change rather than the tooling.

25. As a reviewer, I want hunks identified stably by their path and content hash, so that a stop keeps pointing at the same code across regeneration.

26. As a reviewer, I want the walkthrough to be generated by an agent the user never sees, so that the model call does not clutter my agent list.

27. As a reviewer, I want the plugin to keep working on daemon 0.15.4, where plugin RPC calls time out after 30 seconds, so that the long model call never blocks the panel.

28. As a reviewer, I want the generation to run as a background job with polling, so that I can close and reopen the panel and still see the progress.

29. As a reviewer, I want the plugin to work whether the model provider supports structured output natively or not, so that the walkthrough is always generated.

30. As a reviewer, I want a malformed model answer retried with feedback, so that a single bad generation does not fail the whole walkthrough.

31. As a reviewer, I want the plugin to never write to my repository, so that generating a walkthrough cannot dirty my working tree.

## Implementation Decisions

- The plugin id is `walkthrough`; the plugin lives in its own directory and is registered in
  the Paseo config with `plugins.walkthrough.source` set to `directory`.

- The scope of a walkthrough is one of: `all` (staged and unstaged changes in the working
  tree), `staged`, `unstaged`, `branch` (the current branch against its base branch), or
  `commit` (one commit, given by hash). Pull requests are out of scope.

- The server collects the diff itself with `git`, because the plugin SDK does not expose a
  diff API. Git is invoked with a sanitised environment (the `GIT_*` variables removed) and
  with optional locks disabled, following the precedent of the existing turn-report plugin.

- A hunk is identified by its scope, path, and a hash of the hunk header and body, so that a
  stop keeps pointing at the same code across regenerations of the same change.

- The server builds an OpenChamber-style digest instead of sending the raw diff: hunks are
  aliased h1 through hn, and generated files and lock files are filtered out. The digest, not
  the diff, is what goes into the model prompt.

- The model call runs in an agent the user never sees. On daemon 0.16.2 and newer the plugin
  creates the agent with the background flag inside the workspace. On daemon 0.15.4 the public
  agent API rejects the background flag together with a workspace id and rejects internal
  agents, so the plugin creates a background workspace and runs the agent inside it.

- The model never gets repository access: the agent works in a plugin-owned scratch
  directory and receives the digest in the prompt.

- Structured output is requested through the provider output schema when the provider
  supports it (Codex app-server, OpenCode v1 and v2). For providers without support the
  plugin asks for JSON in the prompt, validates the answer against the schema, and retries up
  to two times with the validation errors as feedback.

- The schema limits are: at most 6 chapters, 16 stops, 14 hunks per stop, 6 observations of
  which at most 2 per stop, and 200 routine notes. A chapter title is at most 24 characters.
  Importance is `critical`, `normal`, or `context`. An observation kind is `decision`, `cost`,
  `limitation`, `asymmetry`, or `unproven`. An observation icon is `bug`, `wrench`, `path`,
  `flask`, `doc`, or `gear`.

- The plugin RPC contract is: `walkthrough.state`, `walkthrough.generate` (returns a job id),
  `walkthrough.status`, `walkthrough.cancel`, `walkthrough.models`, `walkthrough.settings`.
  Every payload is validated with zod.

- The model call never happens inside an RPC handler, because plugin RPC calls time out after
  30 seconds on daemon 0.15.4. `walkthrough.generate` starts a background job and returns
  immediately; the client polls `walkthrough.status`.

- Job states are `collecting`, `asking`, `retrying`, `assembling`, `done`, `failed`, and
  `cancelled`. The client renders the state as the visible generation stages.

- The cache key is the repository root, the scope, the model, the language, and the set of
  changed files and hunks. A pointer to the previous document is kept per workspace so that
  reopening the panel restores it.

- The cache and settings live under the plugin data directory for the plugin, falling back to
  the XDG state directory.

- Staleness is computed by re-collecting the diff and comparing it to the one the document
  was built from: hunks whose content changed make their stops outdated, and hunks that
  appeared with no covering stop are reported as uncovered.

- Per-workspace choices (scope, model, language) live in the panel state, because the plugin
  settings API only supports host scope on daemon 0.15.4.

- The client is React Native. The plugin UI kit on daemon 0.15.4 has no diff viewer, so
  hunks are rendered as text with per-line colouring, using only the guaranteed theme colours
  (background, foreground, raised, control, border, muted foreground, and ring).

- The panel shows: a source picker, a model and language picker, a generate button, the stage
  indicator, a table of contents, the chapters with their stops, the skipped files, the
  uncovered hunks, and the staleness banner.

- The client polls the status endpoint while a job is running and stops polling once the job
  reaches a terminal state.

- The OpenChamber prompt, schema, digest, and hunk-anchor logic are ported. OpenChamber is
  MIT licensed (Copyright (c) 2025 Bohdan Triapitsyn), so the port carries an attribution
  notice.

## Testing Decisions

- The only test seam is the server-side RPC boundary. Pure client functions and the React
  Native rendering are not covered by automated tests.

- The server tests cover the RPC contract end to end against a temporary git repository:
  collecting the diff for each scope, building the digest, running the job, caching the
  result, detecting staleness, and cancelling a running job.

- Model output is stubbed in tests. The stub returns a valid document for the happy path, an
  invalid document to exercise the retry path, and an invalid document on every attempt to
  exercise the failure path.

## Out of Scope

- Editing the diff or the repository in any way.
- A model that sees the repository. The model only ever sees the digest.
- Persisting the walkthrough into the repository, for example as a markdown file.
- Supporting more than one walkthrough per workspace at a time.
- Pull request walkthroughs.
- Backfilling a walkthrough for changes made before the plugin was installed.

## Further Notes

- The feature is tracked in this repository under the local markdown tracker. The tracker
  convention is documented in `docs/agents/issue-tracker.md` and the role vocabulary in
  `docs/agents/triage-labels.md`. GitHub Issues are not used because no GitHub host is
  authenticated on this machine.

- The implementation lives in `~/Work/paseo-walkthrough` and starts from a scaffolded plugin
  with the id `walkthrough`. The server half comes first, because the client half is defined
  by the RPC contract.
