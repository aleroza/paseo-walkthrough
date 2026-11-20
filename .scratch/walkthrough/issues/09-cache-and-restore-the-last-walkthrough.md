# 09: Cache and restore the last walkthrough

**What to build:** A reviewer who reopens the panel finds the walkthrough they were reading, instantly and for free, as long as neither the change nor the settings moved. A fresh generation replaces it.

**Blocked by:** 04 (Full document shape).

**Status:** resolved

- [x] The cache key covers the repository root, the source, the model, the language, and the set of changed files and hunks.
- [x] With the same key, the panel shows the cached document without a model call.
- [x] With a different key, the plugin generates a new document.
- [x] The pointer to the previous document is kept per workspace, so reopening the panel restores what the reviewer was reading.
- [x] The cache and the pointer live under the plugin data directory, falling back to the XDG state directory.
- [x] The cache does not grow without bound: old entries for the same repository and source are dropped.
- [x] A server-side test drives the RPC boundary and asserts the cache hit, the cache miss, and that a second request with the same key makes no model call.

## Comments

- The reusable cache keeps one record per repository and scope. Each workspace keeps one copy of its last document, so replacing a reusable record in another workspace preserves the original workspace's restore.
- Reloading the plugin is covered at the RPC boundary. The tests also change a hunk and return it to its previous contents to check replacement of an older cache record.
