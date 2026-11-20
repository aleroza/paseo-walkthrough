# 06: Pick model and language

**What to build:** A reviewer chooses the model that writes the walkthrough and the language it is written in, sees which models are available, and finds the choice remembered the next time they open the panel in that workspace.

**Blocked by:** 03 (Generate a walkthrough end to end).

**Status:** ready-for-agent

- [x] The panel offers a language picker with at least the languages the walkthrough is ported for.
- [x] The panel offers a model picker populated from the models the daemon has available.
- [x] The chosen model and language are used for the next generation.
- [x] The choice is remembered per workspace and restored when the panel is reopened.
- [x] A workspace with no remembered choice falls back to a documented default model and language.
- [x] The per-workspace choice lives in the panel state, because the plugin settings API only supports host scope on daemon 0.15.4.
- [x] A server-side test drives the RPC boundary and asserts the model list and that the chosen model and language are carried into the job.

## Comments

- The choice (scope, model, language) lives in the panel state, through the host's `tab.setState` /
  `tab.state` and the SDK's `useTabState`. The host keeps that state per workspace: the workspace
  layout store holds `tab.state` per workspace key and persists it, so reopening the panel in the
  same workspace restores the choice and a different workspace never sees it.
- The server keeps a copy of the same choice under `$PASEO_HOME/plugin-data/walkthrough/settings`,
  keyed by workspace id, through the `walkthrough.settings` and `walkthrough.settings.save`
  contracts. The panel writes both, and a panel whose own state the host never wrote takes the
  server's copy, so the choice survives a lost panel state.
- `walkthrough.models` lists the models of the providers the daemon has ready, leaving out the
  ones the daemon marks as not selectable. A model is named `provider/id`, the name the daemon
  takes.
- A model the daemon does not have is refused: the job fails with "The model ... is not available.
  Pick another model for the walkthrough." instead of quietly writing the walkthrough with another
  model. The panel says the same thing before the reviewer presses Generate.
- The language reaches the prompt: `walkthrough.generate` carries it into the job and the prompt
  adds the language instruction when it is not English, so the aliases, the icons, the importance
  values and the observation kinds stay in English.
- The default of a workspace that chose nothing: every change, the daemon's default model of the
  first provider that has one, and English. `AGENTS.md` records it.
