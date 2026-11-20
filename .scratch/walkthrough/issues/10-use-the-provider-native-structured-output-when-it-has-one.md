# 10: Use the provider's native structured output when it has one

**What to build:** The walkthrough is generated the same way regardless of the model: on providers that support a structured output schema the answer is requested through it, and on providers that do not the answer is asked for as JSON and validated, so the reviewer always gets a document.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [x] The plugin asks for the answer through the provider output schema on providers that support it: the Codex app-server, OpenCode v1, and OpenCode v2.
- [x] On providers without structured output the plugin asks for JSON in the prompt and validates the answer against the schema.
- [x] The plugin detects the capability at run time rather than by a hardcoded list of model names.
- [x] A validated answer is normalised the same way on every provider, so the document does not depend on the provider.
- [x] An answer that fails validation is retried with the validation errors as feedback, up to two times.
- [x] A server-side test drives the RPC boundary against a provider without structured output and asserts the retry path, and against one with it and asserts the schema was passed.

## Comments

- Paseo 0.15.4 exposes no structured output capability flag. The plugin uses the daemon's resolved
  provider ID. The Codex app-server uses `codex` and both OpenCode runtimes use `opencode`.
- The pinned SDK accepts `outputSchema` only on agent creation, with the first prompt. A native
  retry starts a fresh agent with the same schema and the validation feedback.
  [Paseo 0.15.4 SDK](https://github.com/getpaseo/paseo/blob/v0.15.4/public-docs/sdk/agents.md#request-structured-output)
