# Status — Creative Studio 0.2.0 for SillyTavern 1.19.0

## Verification summary

| Suite | Result | What it covers |
|---|---|---|
| Live AI, whole roleplay (ST → OpenRouter → DeepSeek V3.1 Terminus) | **10 / 10 steps**, about 5.5 min | One sentence → premise, character, card, 3 openings, 10-entry lorebook, preset, 2 regex scripts with passing tests, 4 Quick Replies, image prompts, self-critique. The run exposed five issues, all fixed and covered by unit tests: skipped card fields, a hung provider call, AI "secondary keys" that stopped entries firing, `{{system}}` lines in example dialogue, and sentence-long lore titles. *Build the rest for me* then filled only the two empty fields (30 s), and *Resume* recovered the interrupted run after a reload. Two later runs found three more issues, all fixed: optional schema fields came back empty, 54 tags, and one greeting where three were asked for. **Latest runs** (empty idea box, studio-created OpenRouter profile): *Prometheus in the Gloom*, 10/10 steps in 2 min 45 s, and *The Glitch That Gnaws*, 10/10 in 2 min 20 s. Neither had warnings; both had 7-8 tags, 3 openings and a lorebook whose preview fires through recursion passes |
| Independent code review of the generative release | **12 findings, all fixed**, each with a regression test | Key safety: only studio-created keys can be deleted with a profile, never a shared or active one; a failed rotate removes the new key; a corrected key replaces the stored one. Pipeline: Polish in fill-only mode proposes instead of overwriting; a failed repair keeps what was written; a failed repair round-trip keeps the first answer; discard cleans links; single-step Retry; no auto-retry after a main-connection timeout; the time limit scales with answer length; no double starts, and the live run is shown first. Undo leaves run records alone. `tidyExamples` keeps "{{char}}'s…" prose; the Quick Reply script check matches ST's `input[0] == '/'` |
| Install from the GitHub URL (`/api/extensions/install`, the call behind Extensions → Install extension) | **Works**; the live suite passes **13 / 13** from the installed copy | Cloned as `data/default-user/extensions/SillyTavern-CreativeStudio` (v0.2.0). Only that copy loaded (dev copy disabled), the studio opened the saved projects, and ST's delete endpoint removed it cleanly |
| Unit (`npm test`, Node 24) | **112 / 112 pass** | Provider setup (storing a key keeps ST's active key, model listing, profiles hold only secret ids); per-call schemas that require the requested card fields; generation pipeline (dependencies, retry, resume, discard, fill-only, missing-field repair, auto-retry), gateway timeouts, example-dialogue repair, AI lore key/title mapping; PNG chunks, V1/V2/V3 normalization, CHARX round trips, card export shapes; project/proposal/provenance/snapshot model; lorebook defaults, lint, card⇄world conversion, activation simulation (recursion, groups, budget, placement order) on ST's Eldoria; regex engine semantics, stage matrix, lint, order conflicts; CC preset lint/assembly/diff on ST's Default preset and the 130-prompt *Deus ex Machina* community preset (lossless); TC fallback rendering with ST's ChatML templates; STscript scanner on a script ST's real parser accepts; QR id quirk and v1 migration; bundle zip round trip; sandbox playtest assembly; AI gateway routes, lenient JSON, schema coercion and repair; storage save/load, snapshots, two-tab conflict, offline fallback |
| Live integration (`tests/live/live-integration.js`, in a running ST 1.19.0) | **13 / 13 pass**, leaves no `CSTEST_*` artifacts | ST context surface; reading ST cards; creating a character from a spec-V3 PNG with **zero stored differences**; merge-attributes apply (array replace, key unset) and backup restore; World Info save/read-back; preset save; studio CHARX accepted by ST's importer; bundle World Info accepted by `/api/worldinfo/import`; real STscript parser errors; Quick Reply live install; Text Completion preview rendered by ST's own functions; live WI settings; dry-run prompt capture |
| Live AI (ST → Custom OpenAI-compatible → Ollama qwen3:8b, CPU-bound) | Works end to end | Ideation via a separate **connection profile** with `json_schema` → 3 distinct concepts (438 s); concept → 11 field proposals (300 s); accepting a proposal updates the card and records provenance; **sandbox playtest turn** (card + 3 activated lore entries + Default preset, 5 messages) → in-character reply that uses the activated lore (178 s) |
| UI walkthrough (browser) | Every workshop opens and works | Pull from ST, compatibility matrix, embedded book → project lorebook, activation preview explaining recursion/whole-word effects, Prompt Manager + assembled preview + lint, regex stage preview in a worker, STscript live parse + effects + enum lint, bundle build with real avatar |

## Feature status

Legend: ✅ implemented and verified (unit and/or live) · 🟡 implemented, partially verified · ⬜ not implemented

### 0. Generative core (the AI does the creative work)
- ✅ **Generate a complete roleplay** (Project): an idea or nothing (*Surprise me*), optional dials (genre, tone, rating, narration, reply length, card type, target model) → 10 linked steps; live progress; Stop, Resume after reload, per-step Retry, Discard
- ✅ Hands-free mode (default): AI output lands directly with provenance, undo and a snapshot before each run; Review mode keeps everything as proposals; toggle in the top bar
- ✅ *Just build it for me* (Characters), *Build the rest for me* (only what the character lacks; never duplicates artifacts), *Write it* on empty fields, 3-take comparisons, *Critique & fix*
- ✅ One-click recipes: regex (added only if their own tests pass) and Quick Replies (added only if SillyTavern's parser accepts them; never run)
- ✅ Presets and worlds generate from the project when the goals are left empty and link themselves to the character; playtest scenarios can be invented
- ✅ Resilience: missing-field repair, a 240 s time limit per call, one automatic retry per step, dependency blocking, resumable runs
- ✅ **AI for creation** panel (plug icon, or *＋ Add a provider…* in any creation-model menu): OpenRouter, OpenAI, Claude, Google AI Studio, DeepSeek, Mistral, Groq, xAI, LM Studio, Ollama, other OpenAI-compatible. Keys go to SillyTavern's secret store with the previously active key restored, stored keys can be reused, model lists come from the provider through ST, and each provider becomes a native Connection Manager profile (secret id only) with a Test button. Verified live: OpenRouter (456 models, profile test 1.4 s), local Ollama listing, and the unreachable-server error

### 0b. Pictures (ComfyUI)
- ✅ **Images settings** (plug icon → Images): ComfyUI through SillyTavern's `/api/sd/comfy/*` proxy (no CORS), checkpoints from the server (UNet/GGUF-only models excluded), prompt style per checkpoint (Pony score tags, Illustrious tags, natural-language SDXL; DMD2/Lightning fast sampling), optional 1.5× second pass, own Export (API) workflow adopted automatically or ST `%placeholder%` workflows, test render; or SillyTavern's Image Generation extension. Verified live against ComfyUI 0.28.3 (RTX 5070 Ti Laptop, 14 checkpoints): test render 13 s
- ✅ **Images tab** per character: AI-written appearance + avatar / full-body / scene prompts in the checkpoint's style (appearance leads every character picture; "people" never in a character's negative); Paint / Paint all; first portrait becomes the avatar. Live: 3 pictures in 77 s
- ✅ **Expression sprites** (8 core or all 28 ST labels): base portrait cached by ComfyUI, then a 0.65-denoise re-sample per expression with the expression weighted first; transparent via ComfyUI Essentials' RemBG nodes (falls back to plain backgrounds). Live: 8 transparent sprites in 143 s, same face and outfit. Install into Character Expressions (`/api/sprites/upload`) and CHARX export as V3 emotion assets
- ✅ **Stage**: the painted scene as the set with the chosen sprite standing in it
- ✅ **Portrait step** in the generator (when images are set up)
- ✅ Content rating: SFW prompts and negatives unless the project's rating allows explicit content
- 🟡 Sprites share one face with each other; matching the separately painted avatar exactly would need IPAdapter/reference conditioning (a possible follow-up)
- 🟡 Flux / Z-Image and other diffusion-only (UNet) models are not used: they need their own loaders and workflows

### 0c. Settings safety
- ✅ SillyTavern saves its whole settings file from whichever tab saves last; in testing a stale tab rolled back the connection model, auto-connect, a Connection Manager profile and the studio's settings. The studio keeps `cstudio-settings.json` (its settings plus the profiles it created; secret ids only) and on open restores what a stale tab removed. It never resurrects a profile deleted on purpose in Connection Manager

### 1. Character & scenario workshop
- ✅ V3 editing: core fields, alternate & group-only greetings, examples (structured or raw), system prompt / post-history, character's note (depth_prompt), creator notes (+ multilingual), source, dates, assets, raw extensions (preserved), nickname, character vs scenario kind
- ✅ Ideation: several *distinct* concepts (voice, contradiction, motive, secret, dynamic, pressure, openings, replay) → develop → draft all fields as proposals
- ✅ Per-field AI variants, greetings with distinct openings, critique (replacements become proposals, notes become diagnostics)
- ✅ Import PNG (chara/ccv3), CHARX (assets and unknown files kept), JSON V1/V2/V3; export ST-style PNG, spec-V3 PNG, CHARX, JSON V3/V2/ST-shape; lossy conversions reported
- ✅ Spec validation vs **SillyTavern 1.19 support matrix** per card
- ✅ Pull from ST, review diff and apply (merge-attributes) with backup/restore, create in ST with fidelity read-back
- ✅ Image prompts + painting (ComfyUI verified live; SillyTavern Image Generation `/imagine` path implemented, not exercised: no backend configured there)
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
