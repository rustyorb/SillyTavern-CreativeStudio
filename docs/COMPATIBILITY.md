# Compatibility ledger — SillyTavern 1.19.0

Legend — **Source**: file:line in the 1.19.0 release source (`docs/research/*.md` has the full citations).
**Runtime**: verified against a running ST 1.19.0 (`tests/live/live-integration.js`, browser runs) or ST's own modules.
**Unit**: covered by `tests/*.test.js` against ST-shipped fixtures. “Unverified” is stated where it applies.

| Feature | Evidence | ST | Limitation / note |
|---|---|---|---|
| PNG card read: `ccv3` tEXt wins over `chara` | Source `src/character-card-parser.js:54-78`; Unit (Seraphina) | 1.19.0 | iTXt/zTXt ignored by ST (studio warns) |
| PNG card write (ST style): same JSON in both chunks, ccv3 relabelled | Source `character-card-parser.js:15-46`; research VERIFIED-RUN | 1.19.0 | Studio also offers true V3 in ccv3 + V2 fallback |
| V3 PNG import keeps all V3 fields in storage | Runtime (live suite: 0 differences after import) | 1.19.0 | ST re-encodes the image (drops other chunks) |
| V3 fields used by ST (nickname, group_only_greetings, source, multilingual notes, dates) | Source grep: zero references | 1.19.0 | Kept but not used — shown per card in Compatibility |
| First in-app save rewrites spec to chara_card_v2 | Source `characters.js:596-597` | 1.19.0 | Studio re-exports V3 on publish |
| CHARX import (icon, emotion sprites, backgrounds) | Source `src/charx.js`; research VERIFIED-RUN with ST's parser | 1.19.0 | Non-image assets dropped; **no CHARX export in ST** (studio exports CHARX) |
| CHARX read/write (studio) | Unit (round trip, unknown files kept) | — | `embeded://` spelling per spec; `embedded://` accepted |
| Character apply via `/api/characters/merge-attributes` (arrays replaced, `__@@UNSET@@__` deletes) | Source `characters.js:1234-1300`, `util.js:507`; Runtime (apply + restore) | 1.19.0 | Renames are not applied (ST file name is the key) |
| Character create via `/api/characters/import` | Runtime | 1.19.0 | Name sanitized for file names |
| Embedded lorebook usage | Source `world-info.js:5691-5770`, `characters.js:628-722` | 1.19.0 | Inactive until imported as WI; regenerated (lossy) while a world is linked |
| `use_regex` in character_book | Source `characters.js:681`, `world-info.js:2901` | 1.19.0 | Ignored/forced true by ST; studio writes the honest value |
| Lorebook decorators | Source `world-info.js:100, 4652-4698` | 1.19.0 | Only `@@activate`/`@@dont_activate`; others stripped — studio lints |
| WI entry fields & defaults (all 1.19 fields) | Source `world-info.js:4082-4129`; Unit (Eldoria) | 1.19.0 | — |
| WI save through `saveWorldInfo` | Runtime (read back from disk) | 1.19.0 | — |
| WI activation simulator (keys, regex keys, whole words, secondary logic, recursion, groups, budget, placement order) | Source `world-info.js:337-366, 4709-5282`; Unit | 1.19.0 | Probability rolls assumed; sticky/cooldown need chat state (not simulated); delayUntilRecursion levels simplified |
| Live WI scan settings | Runtime (exported `let` bindings of `world-info.js`) | 1.19.0 | — |
| CC preset shape, prompt_order 100001 | Source `openai.js:696-699`, `PromptManager.js`; Unit (ST Default, Deus ex Machina 130 prompts/80 regex lossless) | 1.19.0 | — |
| CC assembly preview (order, in-chat depth, same-depth ordering, triggers, card overrides) | Source `openai.js populationInjectionPrompts`; Unit | 1.19.0 | Structural; exact text from the live dry run |
| Live dry-run prompt | Source `script.js:5318`; Runtime (5 messages, chat unchanged) | 1.19.0 | Uses the **active** ST preset; skips generate interceptors |
| Preset save `/api/presets/save` (openai, textgenerationwebui, instruct, context, sysprompt, reasoning) | Source `presets.js:16-58`; Runtime (openai) | 1.19.0 | ST lists newly saved presets after reload |
| TC preview via `renderStoryString` + `formatInstructMode*` with custom templates | Runtime | 1.19.0 | Examples/WI/AN omitted from the preview |
| Structured output `json_schema` | Source `chat-completions.js`; Runtime (custom OpenAI-compatible → Ollama) | 1.19.0 | Chat Completion only; TC uses prompted JSON; ST replaces unparsable JSON with `{}` so the studio reads raw text |
| Connection profile requests | Source `extensions/shared.js:392-500`; Runtime | 1.19.0 | Requires the connection-manager extension |
| Claude Fable 5.1 native structured output | Source (suspected client/server mismatch) | 1.19.0 | **Unverified**; gateway falls back to lenient text parsing |
| Regex engine semantics (function replacer, `{{match}}`, trim on groups, flags) | Source `engine.js:391-466`, `utils.js:1387`; Unit | 1.19.0 | `$&` is literal in ST |
| Regex order global → preset → character; gates (mode, edit, depth, placement) | Source `engine.js:98-133, 334-381`; Unit | 1.19.0 | Allow-lists for scoped/preset scripts are ST UI state |
| Global regex save | Source `engine.js:112-146` | 1.19.0 | Regex panel refreshes on reopen/reload |
| QR set v2 JSON, v1 migration | Source `QuickReplySet.js`, `index.js:65-92`; Unit | 1.19.0 | UI importer rejects v1; studio converts |
| QR live install via Quick Reply's importer | Runtime | 1.19.0 | ST asks before replacing an existing set |
| QR set save is debounced (200 ms) | Source `QuickReplySet.js:44-46`; Runtime (a delete right after install was undone by the pending save) | 1.19.0 | Wait for the debounce before deleting/re-saving a just-installed set |
| Studio CHARX accepted by ST's CHARX importer | Runtime | 1.19.0 | — |
| Bundle World Info JSON accepted by `/api/worldinfo/import` | Runtime | 1.19.0 | — |
| STscript `forceEnum` values from enum providers (e.g. `/setvar as=`) | Runtime (registry) | 1.19.0 | Providers needing live chat state may yield no values; those are not checked |
| STscript syntax check with `SlashCommandParser.parse` | Runtime | 1.19.0 | Parser does not check required args/enums — studio adds `argumentLint` |
| STscript scanner/effects (offline) | Unit (sample accepted by ST's real parser) | 1.19.0 | Heuristic effect table; unknown commands flagged |
| Macro engine | Source `power-user.js:302` | 1.19.0 | New engine default on; previews substitute only `{{char}}`/`{{user}}` offline |
| Project storage in `user/files` | Runtime (server log) | 1.19.0 | Filenames `[A-Za-z0-9_.-]`; IndexedDB fallback when the server write fails |
| Whole-roleplay generation over the main connection (`generateRaw` + `json_schema`) | Runtime (OpenRouter → DeepSeek V3.1: 10/10 steps, about 5.5 min); Unit (pipeline) | 1.19.0 | Models may skip fields: the card step re-asks for what is still empty (at most twice, then warns) |
| Provider that accepts a request and never answers | Runtime (OpenRouter call hung for more than 4 min); Unit (gateway timeout) | 1.19.0 | `generateRaw` cannot be aborted inside ST: the studio stops waiting after 240 s (the server request may still finish); profile requests are aborted. Each pipeline step retries once |
| WI secondary keys from AI output | Source `world-info.js:462` (selectiveLogic switch); Runtime (generated entries never fired); Unit | 1.19.0 | AND ANY with secondary keys needs both a primary and a secondary match; models use "secondary keys" for synonyms, so the studio makes all AI keys primary and lints AND entries |
| Example dialogue format | Source `script.js:3501` `parseMesExamples`, `openai.js:729` `parseExampleIntoIndividual`; Runtime (DeepSeek wrote `{{system}}` lines and dropped colons); Unit | 1.19.0 | There is no `{{system}}` macro; `tidyExamples` rewrites such lines as `{{char}}` narration |
| Provider keys via `/api/secrets/write` + `/rotate` | Source `src/endpoints/secrets.js:511-622` (write activates the new key; rotate re-activates by id); Runtime; Unit | 1.19.0 | The studio re-activates the key that was active before, so SillyTavern's own connection is unaffected |
| Profiles referencing a key by `secret-id` | Source `extensions/shared.js:450, 477` (`secret_id` passed to CC/TC requests), `connection-manager/index.js:38-70` | 1.19.0 | Runtime: OpenRouter profile test 1.4 s. Extension settings hold only the id |
| Model lists via `/api/backends/chat-completions/status` with `secret_id` / `custom_url` | Source `chat-completions.js:1778-2100`; Runtime (OpenRouter 456 models, Ollama) | 1.19.0 | Claude is not covered by the endpoint in 1.19: its list comes from ST's `#model_claude_select` |
| Schema-constrained output and optional fields | Runtime (DeepSeek returned only `name` + `tags` when nothing inside `fields` was required, and its rationale claimed otherwise) | 1.19.0 | Tasks build a per-call schema that requires exactly the fields asked for (`minLength: 1`) |
| ComfyUI through ST's proxy `/api/sd/comfy/{ping,models,samplers,schedulers,generate}` | Source `src/endpoints/stable-diffusion.js:385-632` (`generate` takes `{url, prompt: JSON string of {"prompt": workflow}}`, polls `/history`, returns base64); Runtime (ComfyUI 0.28.3) | 1.19.0 | `models` also lists UNet/GGUF diffusion models (text prefix `UNet:`/`GGUF:`); the studio leaves them out because CheckpointLoaderSimple cannot load them |
| ST image workflows with `%prompt%`-style placeholders | Source `public/scripts/extensions/stable-diffusion/index.js:4222-4290` | 1.19.0 | The studio fills the same placeholders when an imported workflow uses them |
| Expression sprites upload `/api/sprites/upload` (form: `name`, `label`, `spriteName`, `avatar` file) | Source `src/endpoints/sprites.js:239-290`; Runtime (8 sprites to `characters/Tinker/`) | 1.19.0 | Folder = the character's name (Character Expressions' default); overrides set in ST are not read |
| CHARX `emotion` assets become sprites on import | Source `src/charx.js`; Runtime (studio CHARX with 2 emotion assets → `characters/<name>/joy.png, anger.png`, byte-identical) | 1.19.0 | — |
| Stale tab overwrites settings | Runtime (a tab with ~2 h old settings rolled back the OpenRouter model, provider order, auto-connect, a Connection Manager profile and extension settings) | 1.19.0 | ST saves the whole settings file from each tab (last writer wins). The studio restores its own settings and profiles from `cstudio-settings.json`; ST's own settings are outside its reach |
| Installing from the GitHub URL (Extensions → Install extension) | Source `src/endpoints/extensions.js:25` (clone, manifest check); all imports are relative to the extension folder | 1.19.0 | Folder name follows the repository name; nothing assumes `creative-studio` |
