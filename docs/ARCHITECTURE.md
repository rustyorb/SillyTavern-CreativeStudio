# Architecture decision record

## Decision

Creative Studio is a **SillyTavern UI extension** (no server plugin), written as plain ES modules with a vendored
Preact + htm renderer (no build step). Projects are stored as JSON in the user's SillyTavern `user/files` folder through
ST's own `/api/files/upload` endpoint.

## Why a UI extension (evidence)

| Need | Available to a UI extension in ST 1.19.0 | Evidence |
|---|---|---|
| Generate with the user's configured models | `generateRaw`, `ConnectionManagerRequestService.sendRequest(profileId, …)` (separate creation profile, cancellable, never switches the user's connection) | `public/scripts/st-context.js`, `public/scripts/extensions/shared.js:392-500`; exercised live (qwen3 via Ollama, custom OpenAI-compatible source) |
| Structured output | `json_schema` passed through to most Chat Completion sources | `src/endpoints/backends/chat-completions.js`; request body observed in the ST server log |
| Characters | `/api/characters/{get,import,export,merge-attributes,delete}` | live test suite (`tests/live/live-integration.js`) |
| World Info | `loadWorldInfo`/`saveWorldInfo` (cache + `WORLDINFO_UPDATED` stay coherent) | live test suite |
| Presets & templates | `getPresetManager`, `/api/presets/save` | live test suite |
| Regex | `extension_settings.regex`, `writeExtensionField(…'regex_scripts')`, preset `extensions.regex_scripts` | `public/scripts/extensions/regex/engine.js` |
| Quick Replies | `quickReplyApi` + the Quick Reply extension's own importer | live test suite |
| STscript syntax | `SlashCommandParser.parse()` is pure (no execution) | live test suite |
| Prompt preview | dry run `generate('normal', {}, true)` + `GENERATE_AFTER_DATA` | verified live (5 messages captured, chat unchanged) |
| Text Completion rendering | `renderStoryString`, `formatInstructMode*` accept custom templates | live test suite |
| Persistent storage without settings bloat | `/api/files/upload` → `data/<user>/user/files/` | server log `Uploaded file: /user/files/cstudio-…` |

Nothing required a server plugin. A plugin would add an install step (`enableServerPlugins: true`) for no capability we need.

## Why no build step

The official templates (Webpack/React) work, but every ST module the studio uses is reachable through
`SillyTavern.getContext()` or a relative ES import, and a no-build extension can be installed with ST's
"Install extension" (git URL) and debugged in place. Preact + htm (13 KB, MIT/Apache-2.0) and fflate (MIT, CHARX zips)
are vendored under `vendor/` with their licenses.

## Module boundaries

```
src/core/   pure logic, no DOM, no ST — unit-tested in Node (tests/*.test.js)
  bytes, png, card, charx, cardio, compat     formats & Character Card V1/V2/V3
  lorebook                                     WI model, lint, card⇄world conversion, activation simulator
  preset                                       CC Prompt Manager model, lint, assembly preview, diff, TC fallbacks
  regex, regex-worker                          engine mirror, stage matrix, lint, order conflicts (worker for previews)
  qr, stscript                                 Quick Reply v2 model; STscript scanner, effects, dependencies, lint
  project, diff, bundle, playtest              project/proposal/provenance model; diffs; publish bundle; sandbox turns
src/ai/     gateway (routes, lenient JSON, schema validate+repair), tasks (prompts+schemas), json, schema
src/st/     SillyTavern integration: env (context, REST, dialogs, autosave), storage, live (read/apply/backup),
            render (TC via ST functions), stscript-live (parser, registry, execute, QR install)
src/ui/     Preact components: app shell, workspace, inspector, proposals, kit, one module per workshop area
```

`core` never imports `st` or `ui`; `st` never imports `ui`. AI output only ever becomes a **proposal**
(`core/project.js`), applied through `acceptProposal` with provenance in project history.

## Safety rules the code follows

- Nothing is written to SillyTavern without an explicit user action; every write stores what it overwrote
  (Inspector → Snapshots → Live SillyTavern backups) and a project snapshot is taken before bulk applies.
- API secrets are never copied: connection profiles are stored without `secret-id`; preset exports strip
  sensitive connection fields by default.
- Regex previews run in a Web Worker with a 2 s timeout, so catastrophic patterns cannot freeze ST.
- STscript is analysed without running it. Test runs require reviewing the detected side effects first.
