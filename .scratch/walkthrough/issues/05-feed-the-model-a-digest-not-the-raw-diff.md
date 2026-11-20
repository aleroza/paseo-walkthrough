# 05: Feed the model a digest, not the raw diff

**What to build:** The model receives a compact digest of the change instead of the raw diff: the hunks are aliased h1 through hn, and generated files and lock files are filtered out. The model spends its budget on the changed code rather than on context noise, and the stops in the document refer to those aliases.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** resolved

- [x] The digest aliases hunks h1 through hn in a stable order and includes the file path and the hunk body for each.
- [x] Generated files and lock files are excluded from the digest.
- [x] The prompt carries the digest and the contract, not the raw diff.
- [x] A stop refers to the hunks it explains by their digest alias, and the panel resolves an alias back to the file and hunk it came from.
- [x] A change with no eligible hunks produces a clear empty state instead of a model call with nothing to read.
- [x] A server-side test drives the RPC boundary and asserts the digest content, the filtering, and the alias resolution.

## Comments

- The digest machinery itself came from tickets 03 and 04; this ticket added the RPC-level test seam
  and the fix that tells an empty change apart from one that holds only generated files.
- Generated and lock files are excluded by name and by path pattern only, never by size, and they
  still reach the reviewer through `walkthrough.diff` as files marked generated.
- The alias is resolved on the server: the model answers with `h2`, the document keeps the real hunk
  id, and the panel shows the file of that hunk. The alias table is built per generation, so two
  generations never share aliases.
