# 07: Cancel a running generation

**What to build:** A reviewer who no longer wants a long walkthrough can stop it. The generation ends, the model call does not continue, and the panel says the job was cancelled.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [ ] A cancel control is available while a job is running and absent otherwise.
- [ ] Cancelling moves the job to the cancelled state and stops the model call.
- [ ] A cancel request for a job that already finished does not change the finished result.
- [ ] A cancel request for an unknown job id returns a clear error.
- [ ] Cancelling does not leave a running agent behind.
- [ ] A server-side test drives the RPC boundary and asserts the cancelled state and that no model call continues afterwards.
