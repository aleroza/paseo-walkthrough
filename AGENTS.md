# AGENTS.md

Repository for the Paseo `walkthrough` plugin: it turns a git diff into a reading order
(chapters, stops anchored to hunks, and the observations worth attention).

## Layout

- `paseo-plugin.json` — plugin manifest (id `walkthrough`, requires Paseo >= 0.15.4).
- `index.server.ts` — server contribution: registers RPC handlers and the background job runner.
- `index.client.tsx` — client contribution: registers the workspace panel and the Command Center item.
- `shared/` — zod schemas, RPC contracts and the walkthrough document types shared by both halves.
- `server/` — git collection, digest building, prompt construction, model invocation, cache, jobs.
- `client/` — React Native panel.
- `test/` — vitest tests. The only seam is the server-side RPC boundary.
- `docs/agents/` — tracker conventions.
- `.scratch/walkthrough/` — the spec and the implementation tickets.

## Commands

- `npm run typecheck` — `tsc --noEmit`. Must be clean.
- `npm test` — `vitest run --dir test`. Must be green.
- `npm install` — dependencies; `@getpaseo/plugin` is pinned to the daemon version we target.

## Conventions

- TypeScript, ESM, `"type": "module"`. Strict mode, no `any` unless forced.
- RPC payloads are validated with zod and declared in `shared/` with `defineRpc`.
- The plugin server never writes to the user's repository. Git is invoked with a sanitised
  environment and optional locks disabled.
- Plugin data is persisted under `$PASEO_HOME/plugin-data/walkthrough`, falling back to
  `$XDG_STATE_HOME`.
- The client is React Native. The 0.15.4 UI kit has no diff viewer, so hunks render as text.
- Do not add comments unless they explain a non-obvious constraint.

## External references

- SDK surface notes for Paseo 0.15.4: `/tmp/opencode/walkthrough-notes/sdk-surface.md`
- The upstream feature being ported (MIT, OpenChamber):
  `/tmp/opencode/openchamber/packages/web/server/lib/walkthrough/`
- A reference plugin by the same author:
  `~/.paseo/plugins/turn-report/59e27752-20ae-4305-b71b-4fee6a1b8e6d/checkout/`
