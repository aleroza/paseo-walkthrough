# 05: Feed the model a digest, not the raw diff

**What to build:** The model receives a compact digest of the change instead of the raw diff: the hunks are aliased h1 through hn, and generated files and lock files are filtered out. The model spends its budget on the changed code rather than on context noise, and the stops in the document refer to those aliases.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [ ] The digest aliases hunks h1 through hn in a stable order and includes the file path and the hunk body for each.
- [ ] Generated files and lock files are excluded from the digest.
- [ ] The prompt carries the digest and the contract, not the raw diff.
- [ ] A stop refers to the hunks it explains by their digest alias, and the panel resolves an alias back to the file and hunk it came from.
- [ ] A change with no eligible hunks produces a clear empty state instead of a model call with nothing to read.
- [ ] A server-side test drives the RPC boundary and asserts the digest content, the filtering, and the alias resolution.
