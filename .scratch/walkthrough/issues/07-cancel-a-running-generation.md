# 07: Cancel a running generation

**What to build:** A reviewer who no longer wants a long walkthrough can stop it. The generation ends, the model call does not continue, and the panel says the job was cancelled.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [x] A cancel control is available while a job is running and absent otherwise.
- [x] Cancelling moves the job to the cancelled state and stops the model call.
- [x] A cancel request for a job that already finished does not change the finished result.
- [x] A cancel request for an unknown job id returns a clear error.
- [x] Cancelling does not leave a running agent behind.
- [x] A server-side test drives the RPC boundary and asserts the cancelled state and that no model call continues afterwards.

## Comments

- The panel shows a "Cancel walkthrough" button only while the job is in a running stage, and the
  stage indicator reads "Cancelled" once the cancel lands.
- The daemon gives a plugin no call that cancels a turn on 0.15.4: `PaseoApi` has no `cancel`,
  and sending with `activeTurnBehavior: "interrupt"` replaces the running turn with a new one,
  which starts another model call. The closest thing is reloading the agent, which the daemon
  answers by interrupting the running turn before it reopens the session. The plugin reloads the
  hidden agent and then archives it, which closes the provider session and kills the call.
- The cancel handler answers as soon as the job is cancelled; the interrupt and the archive happen
  in the background, so the reviewer does not wait for the daemon.
- The job registry stays in memory; ticket 09 owns the persistence. A cancel works on the
  in-memory registry only.
