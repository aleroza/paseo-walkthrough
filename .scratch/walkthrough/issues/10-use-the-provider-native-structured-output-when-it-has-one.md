# 10: Use the provider's native structured output when it has one

**What to build:** The walkthrough is generated the same way regardless of the model: on providers that support a structured output schema the answer is requested through it, and on providers that do not the answer is asked for as JSON and validated, so the reviewer always gets a document.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [ ] The plugin asks for the answer through the provider output schema on providers that support it: the Codex app-server, OpenCode v1, and OpenCode v2.
- [ ] On providers without structured output the plugin asks for JSON in the prompt and validates the answer against the schema.
- [ ] The plugin detects the capability at run time rather than by a hardcoded list of model names.
- [ ] A validated answer is normalised the same way on every provider, so the document does not depend on the provider.
- [ ] An answer that fails validation is retried with the validation errors as feedback, up to two times.
- [ ] A server-side test drives the RPC boundary against a provider without structured output and asserts the retry path, and against one with it and asserts the schema was passed.
