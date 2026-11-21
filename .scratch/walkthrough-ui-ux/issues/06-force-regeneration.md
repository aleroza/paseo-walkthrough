# 06: Regenerate an unchanged walkthrough

**What to build:** A reviewer can ask for a fresh walkthrough of the same diff and settings with Regenerate and keep reading the previous document while the model works.

**Blocked by:** 03 (Keep the previous document readable).

**Status:** ready-for-agent

- [ ] Regenerate calls the model even when an exact cached result exists. Generate may reuse an exact cached result.
- [ ] The previous document remains visible during the run and after cancellation or failure. Only a successful replacement updates the saved result.
- [ ] Repeated activation while a job is running does not start a duplicate model call.
- [ ] A server-side RPC test distinguishes a cache hit from a forced regeneration of the same request.
