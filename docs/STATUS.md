# Status — Creative Studio 0.1.0 for SillyTavern 1.19.0

## Verification summary

| Suite | Result | What it covers |
|---|---|---|
| Unit (`npm test`, Node 24) | **64 / 64 pass** | PNG chunks, V1/V2/V3 normalization, CHARX round trips, card export shapes; project/proposal/provenance/snapshot model; lorebook defaults, lint, card⇄world conversion, activation simulation (recursion, groups, budget, placement order) on ST's Eldoria; regex engine semantics, stage matrix, lint, order conflicts; CC preset lint/assembly/diff on ST's Default preset and the 130-prompt *Deus ex Machina* community preset (lossless); TC fallback rendering with ST's ChatML templates; STscript scanner on a script ST's real parser accepts; QR id quirk and v1 migration; bundle zip round trip; sandbox playtest assembly; AI gateway routes, lenient JSON, schema coercion and repair; storage save/load, snapshots, two-tab conflict, offline fallback |
| Live integration (`tests/live/live-integration.js`, in a running ST 1.19.0) | **13 / 13 pass**, leaves no `CSTEST_*` artifacts | ST context surface; reading ST cards; creating a character from a spec-V3 PNG with **zero stored differences**; merge-attributes apply (array replace, key unset) and backup restore; World Info save/read-back; preset save; studio CHARX accepted by ST's importer; bundle World Info accepted by `/api/worldinfo/import`; real STscript parser errors; Quick Reply live install; Text Completion preview rendered by ST's own functions; live WI settings; dry-run prompt capture |
| Live AI (ST → Custom OpenAI-compatible → Ollama qwen3:8b, CPU-bound) | Works end to end | Ideation via a separate **connection profile** with `json_schema` → 3 distinct concepts (438 s); concept → 11 field proposals (300 s); accepting a proposal updates the card and records provenance; **sandbox playtest turn** (card + 3 activated lore entries + Default preset, 5 messages) → in-character reply that uses the activated lore (178 s) |
| UI walkthrough (browser) | Every workshop opens and works | Pull from ST, compatibility matrix, embedded book → project lorebook, activation preview explaining recursion/whole-word effects, Prompt Manager + assembled preview + lint, regex stage preview in a worker, STscript live parse + effects + enum lint, bundle build with real avatar |

## Feature status

Legend: ✅ implemented and verified (unit and/or live) · 🟡 implemented, partially verified · ⬜ not implemented

### 1. Character & scenario workshop
- ✅ V3 editing: core fields, alternate & group-only greetings, examples (structured or raw), system prompt / post-history, character's note (depth_prompt), creator notes (+ multilingual), source, dates, assets, raw extensions (preserved), nickname, character vs scenario kind
- ✅ Ideation: several *distinct* concepts (voice, contradiction, motive, secret, dynamic, pressure, openings, replay) → develop → draft all fields as proposals
- ✅ Per-field AI variants, greetings with distinct openings, critique (replacements become proposals, notes become diagnostics)
- ✅ Import PNG (chara/ccv3), CHARX (assets and unknown files kept), JSON V1/V2/V3; export ST-style PNG, spec-V3 PNG, CHARX, JSON V3/V2/ST-shape; lossy conversions reported
- ✅ Spec validation vs **SillyTavern 1.19 support matrix** per card
- ✅ Pull from ST, review diff and apply (merge-attributes) with backup/restore, create in ST with fidelity read-back
- 🟡 Image prompts + generation through ST's Image Generation extension (`/imagine`) — code path implemented; not exercised because no image backend is configured on the test install
- ⬜ Renaming an ST-linked character from the studio (ST's file-name key needs `/rename`; studio tells the user)

### 2. World & lore workshop
- ✅ All 1.19 entry fields, lint (unreachable entries, bad regex keys, unsupported decorators, outlet without name, …)
- ✅ Activation preview with reasons, competing books, inclusion groups, budget, recursion passes, placement ("what reaches the model"), live ST scan settings
- ✅ AI world design (per-entry selection), extraction from text or the current ST chat, contradiction/gap audit, key suggestions
- ✅ Import ST world / character_book / lorebook_v3; export ST world JSON and lorebook_v3; save to ST via `saveWorldInfo`
- 🟡 Simulator approximations: probability assumed, sticky/cooldown not simulated, `delayUntilRecursion` levels simplified (documented in the UI)

### 3. Prompt & preset workshop
- ✅ CC Prompt Manager: order, enable, roles, relative/in-chat depth & order, triggers, forbid overrides, divider markers; samplers & formatting; other keys preserved
- ✅ Assembled preview (card overrides, generation type) + **live dry run of ST's real prompt** + AI critique
- ✅ TC: instruct / context / system prompt / reasoning / sampler presets; preview rendered by ST's own `renderStoryString` + `formatInstructMode*`
- ✅ Versions & compare (prompt-level diff), import (incl. Advanced Formatting master export), export (sensitive fields stripped), save to ST
- ✅ Connection profiles shown as *selections*, never mixed with preset contents; secrets never copied
- ✅ AI prompt generation from goals + sample outputs with per-prompt selection; TC system prompt generation
- ✅ Token counts in the assembled preview and field editors come from SillyTavern’s active tokenizer (estimates shown only until counts arrive)

### 4. Regex laboratory
- ✅ Global / preset / character scopes in engine order, full editor, import/export (new ids like ST), pull/save global to ST (backup)
- ✅ Stage preview for saved text, display, prompt, edit, World Info, reasoning and slash output, with fixtures and match highlighting; runs in a worker with a 2 s timeout
- ✅ Lint (flags, literal `$&`, destructive "stored" mode, depth ranges, legacy placements, duplicate names) and order-sensitivity detection
- ✅ AI generation from goal + examples; model-supplied tests are checked locally and become fixtures
- ⬜ Direct toggling of ST's scoped/preset allow-lists (ST asks the user itself on first use)

### 5. Quick Reply & STscript workshop
- ✅ Sets and buttons (all v2 options, context menus, automation IDs, intended global/character links), v1 import conversion, single-QR import/export
- ✅ Source editor + readable outline; syntax check with **ST's real parser**; argument/enum lint from the live registry; offline lint for known traps
- ✅ Effects & dependency panel (variables, generation, chat changes, calls, macros); command reference
- ✅ Reviewed test run in the current chat; AI generation with parse/effects shown per candidate; live install via Quick Reply's importer; save file
- ⬜ Step debugger (ST's own QR editor has one)

### 6. Project assembly, testing & publishing
- ✅ Project tree, dependency/relationship report, health across all validators
- ✅ Publish bundle: ST-native files + `manifest.json` + install-order `README.md` + `project.studio.json`; re-import projects or bundles
- ✅ Apply to SillyTavern: reviewed plan with per-step opt-out, snapshot first, per-item backups and restore
- ✅ Snapshots, undo/redo, provenance history, multi-tab conflict protection
- ✅ Playtest: sandbox runs through any profile with full configuration capture, AI-played user, scripted scenarios, prompt inspection per reply, live ST chat capture with active config + dry-run prompt, ratings/notes, side-by-side compare
- ✅ Sandbox playtest turn verified against a real model (single turn; multi-turn scenarios use the same path, run time was CPU-bound)

## Known gaps and next steps
1. Exercise `/imagine` image generation with a configured Image Generation backend, and a multi-turn scenario on a GPU-backed model.
2. Claude Fable 5.1 native structured output in ST 1.19 may return `{}` (suspected ST client/server mismatch); the gateway already parses raw text, but this is unverified against the real API.
3. (Done) Assembled-preview token counts now use ST’s tokenizer.
4. The activation simulator does not track sticky/cooldown state across turns; playtests could feed turn-by-turn state.
5. Keyboard: Ctrl+K palette, Alt+1…7, Alt+I, undo/redo, save, Esc; list navigation inside editors is mouse-first.
6. i18n: UI strings are English only.
