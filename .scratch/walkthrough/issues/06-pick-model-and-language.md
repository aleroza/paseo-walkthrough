# 06: Pick model and language

**What to build:** A reviewer chooses the model that writes the walkthrough and the language it is written in, sees which models are available, and finds the choice remembered the next time they open the panel in that workspace.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [ ] The panel offers a language picker with at least the languages the walkthrough is ported for.
- [ ] The panel offers a model picker populated from the models the daemon has available.
- [ ] The chosen model and language are used for the next generation.
- [ ] The choice is remembered per workspace and restored when the panel is reopened.
- [ ] A workspace with no remembered choice falls back to a documented default model and language.
- [ ] The per-workspace choice lives in the panel state, because the plugin settings API only supports host scope on daemon 0.15.4.
- [ ] A server-side test drives the RPC boundary and asserts the model list and that the chosen model and language are carried into the job.
