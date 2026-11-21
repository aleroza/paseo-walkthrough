# 05: Mark outdated stops and show uncovered hunks

**What to build:** A reviewer can see exactly where a walkthrough has gone out of date and find changes that no stop explains.

**Blocked by:** 01 (Use a compact reading layout in Explorer).

**Status:** ready-for-agent

- [ ] A stop is marked outdated when an anchored hunk changes or disappears. Stops whose hunks still match stay current.
- [ ] When an old patch is shown, its label identifies it as the previous version.
- [ ] The expandable Not covered section includes current hunks that were already uncovered and newly uncovered hunks. Each current hunk appears once.
- [ ] Server-side RPC tests exercise an edited anchor, a removed anchor, an unaffected stop, and newly uncovered changes.
