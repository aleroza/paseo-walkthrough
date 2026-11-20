# 08: Detect that the diff changed

**What to build:** A reviewer looking at a walkthrough while they keep editing sees the plugin say that the change moved under them: which stops are now stale, and which new changes no stop covers. The reviewer never reads an outdated document without being told.

**Blocked by:** 04 (Full document shape).

**Status:** ready-for-agent

- [ ] The plugin re-collects the diff and compares it to the one the document was built from.
- [ ] A hunk whose content changed makes the stops that cover it outdated, and the panel shows those stops as stale.
- [ ] A hunk that appeared with no covering stop is reported as an uncovered change.
- [ ] A hunk that disappeared is reported as removed rather than as stale.
- [ ] A document that is still current shows no staleness banner.
- [ ] The panel shows the staleness banner, the list of stale stops, and the list of uncovered changes.
- [ ] A server-side test drives the RPC boundary and asserts the stale stops and the uncovered changes for an edited working tree.
