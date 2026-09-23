# Creative Studio for SillyTavern

An AI-assisted creator's workbench for building a complete SillyTavern roleplay experience: characters and scenarios
(Character Card V3), World Info, prompts and presets, regex, Quick Replies and STscript, and the playtests that tie them
together. Targets **SillyTavern 1.19.0**.

The first-class object is a **project**. AI suggestions become **proposals** you review field by field (original,
proposal, rationale, diff), then accept, revise or reject. Every change is recorded with its provenance, and
nothing is written to SillyTavern until you apply it deliberately, with a backup of whatever it overwrites.

## Install

Requires SillyTavern 1.19.0 or newer with extensions enabled (default).

**Option A — from inside SillyTavern:** Extensions → Install extension → paste this repository's git URL.

**Option B — manually:** copy (or `git clone`) this folder to
`SillyTavern/data/<your-user>/extensions/creative-studio/` (per user) or
`SillyTavern/public/scripts/extensions/third-party/creative-studio/` (all users), then reload SillyTavern.

Open it from the **Extensions (wand) menu → Creative Studio**, with **Ctrl+Shift+S**, or with the slash command
`/studio [project|characters|lore|prompts|regex|scripts|playtest]`.

Recommended: enable the built-in **Connection Manager** and create a *creation profile* (a Chat Completion
connection whose model is good at structured JSON). Pick it in any workshop under “Creation model”. Your roleplay
connection stays untouched.

No server plugin, build step or `npm install` is needed. The project uses Preact + htm and fflate (vendored, see `vendor/`).

## Workshops

| Area | What you can do |
|---|---|
| **Project** | Premise and notes, health (every validator in one list), relationships & dependencies, **Publish bundle** (ST-native files + manifest + README + re-importable project), **Apply to SillyTavern** (reviewed plan, snapshot and per-item backups) |
| **Characters** | Ideate several *distinct* concepts from a premise; draft card fields from a concept; per-field AI variants; greetings with different openings; critique; full V3 editing (nickname, group-only greetings, multilingual notes, source, dates, assets, extensions); embedded lorebook ⇄ project lorebook; spec validation vs **ST 1.19 support matrix**; import PNG/CHARX/JSON (V1/V2/V3) and export PNG (ST-style or spec V3), CHARX, JSON; pull from / apply to / create in SillyTavern with fidelity read-back |
| **Lore** | All 1.19 entry controls (keys, secondary logic, position incl. @depth/outlet, order, recursion flags, groups & weights, scoring, timed effects, probability, triggers, scan sources, automation IDs); lint; **activation preview** that explains why each entry fires, what beat it, and what reaches the model; AI world design, extraction from text or the current chat, contradiction/gap audit, key suggestions |
| **Prompts & Presets** | Chat Completion Prompt Manager editor (order, enable, roles, relative/in-chat depth, triggers, forbid overrides, divider markers used by large community presets); samplers & formatting; assembled-prompt preview with card overrides and token estimates; **live dry run** of ST's real prompt; AI critique; versions & compare; Text Completion instruct/context/system-prompt/reasoning templates rendered by **SillyTavern's own functions**; connection profiles shown as *selections*, separate from preset contents; AI prompt generation from goals and sample outputs |
| **Regex Lab** | Global, preset-scoped and character-scoped scripts in engine order; full editor; **stage preview** (saved text, display, prompt, edit, World Info, reasoning, slash output) with fixtures, running in a worker with a timeout; lint (flags, literal `$&`, destructive mode, depth ranges…); order-sensitivity detection; AI generation from examples with tests |
| **Quick Replies & STscript** | Sets and buttons with every v2 option; source editor + readable outline; syntax check with **SillyTavern's real parser**; argument checks from the live command registry; side-effect and dependency panel (variables, generation, chat changes, calls, automation IDs); command reference; reviewed test run in the current chat; AI generation; live install through Quick Reply's own importer |
| **Playtest** | Sandbox runs built from project artifacts (card, lore activation, preset, prompt-stage regex) through any connection profile; AI-simulated user turns; scripted scenarios; inspect the exact prompt of each reply; capture the live ST chat with its active configuration and dry-run prompt; ratings, notes, side-by-side comparison. Every run records model, profile, preset (+hash), card hash, activated lore and regex |
| **Inspector** | Pending proposals (per selection or all), provenance history, snapshots, live-SillyTavern backups with restore |

Keyboard: `Alt+1…7` switch workshops, `Alt+I` toggles the inspector, `Ctrl+Z` / `Ctrl+Y` undo/redo (outside text
fields), `Ctrl+S` saves now, `Esc` closes.

## Where data lives

Projects are saved automatically to SillyTavern's user files (`data/<user>/user/files/cstudio-*.json`), with media next
to them. A browser copy is kept as a fallback if a server write fails. Snapshots are separate files. Use **Project →
Publish bundle** for a portable zip, and **Open project file…** to import one.

## Tests

```bash
npm test
```

Runs the unit tests (formats, lorebook engine, regex engine, presets, STscript/QR analysis, bundle, playtest,
AI gateway) against fixtures shipped with SillyTavern. The live integration suite runs inside a SillyTavern tab:

```js
const m = await import('/scripts/extensions/third-party/creative-studio/tests/live/live-integration.js');
await m.runLiveTests();
```

It creates and then removes `CSTEST_*` characters, World Info, presets and Quick Reply sets.

## Documentation

- `docs/ARCHITECTURE.md` — architecture decision and evidence
- `docs/COMPATIBILITY.md` — feature ↔ source/runtime evidence ↔ limitations
- `docs/STATUS.md` — feature status, verification results, known gaps

## License

AGPL-3.0 (same as SillyTavern). Vendored libraries keep their licenses (`vendor/LICENSE-*`).
