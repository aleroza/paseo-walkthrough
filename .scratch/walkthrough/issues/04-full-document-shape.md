# 04: Full document shape

**What to build:** The walkthrough reads as a document rather than a flat list: chapters with stops, observations attached to the stops they belong to, the files the walkthrough deliberately skipped with a one-line reason each, and the hunks no stop covered. The reviewer can see at a glance what needs attention and what is still theirs to read.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [x] The document has chapters, each with a title of at most 24 characters and a list of stops.
- [x] Each stop carries the hunks it explains, its explanation, and its observations.
- [x] Each observation has a kind (decision, cost, limitation, asymmetry, unproven), an icon (bug, wrench, path, flask, doc, gear), and an importance (critical, normal, context).
- [x] The document lists the skipped files with a one-line reason each.
- [x] The document lists the hunks that no stop covered.
- [x] The server enforces the limits: at most 6 chapters, 16 stops, 14 hunks per stop, 6 observations of which at most 2 per stop, and 200 routine notes. An answer outside the limits is treated as invalid and retried.
- [x] The panel renders the table of contents, the chapters with their stops and observations, the skipped files, and the uncovered hunks.
- [x] A server-side test drives the RPC boundary with a stubbed model and asserts the normalised document and the rejection of an over-limit answer.

## Comments

- An answer outside the limits is refused whole rather than trimmed: the model is asked again with
  the reason it was refused. A trimmed answer would silently hide a chapter the reader needed.
- The document carries `uncoveredHunkIds` next to `routine`, so the hunks no stop covers are the
  same set the skipped-file notes are drawn from.
- An observation takes its icon from its kind and its importance from the stop it belongs to.
