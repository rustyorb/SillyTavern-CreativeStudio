// Catalog of AI creation tasks: prompt builders + output schemas + converters into reviewable proposals.
// Every task returns structured data; nothing is applied until the author accepts a proposal.

const S = { type: 'string' };
const SA = { type: 'array', items: { type: 'string' } };

const CRAFT = `You are a collaborator for a SillyTavern roleplay author. Write for interactive fiction, not prose novels:
- Serve the roleplay: give the model concrete, actionable material (behaviours, speech patterns, pressures, secrets), not adjectives.
- Prefer specific, surprising, internally consistent details over genre defaults. Avoid purple prose and stock phrases ("a mix of", "sends shivers", "barely above a whisper", "ministrations", "testament to").
- Keep {{char}} and {{user}} macros where a card would use them. Never write {{user}}'s actions, thoughts or dialogue in greetings or examples beyond a minimal hook.
- Roleplay formatting unless the author asks otherwise: third-person narration in *asterisks* or plain prose, and every spoken line in "double quotes". Greetings and examples are scenes, not summaries.
- Example dialogue (mes_example) format, exactly: blocks that start with a line <START>, then lines "{{user}}: ..." and "{{char}}: ..." (name, colon, text). There is no {{system}} macro; put scene-setting inside a {{char}} line as narration.
- Respect the author's stated premise, tone, rating and constraints exactly; if something is ambiguous, choose the most interesting reading and say so in the rationale.`;

export function cardDigest(card, { full = false } = {}) {
    const d = card?.data ?? {};
    const cut = (s, n) => (full || !s || s.length <= n ? s ?? '' : `${s.slice(0, n)}…`);
    return [
        `Name: ${d.name ?? ''}${d.nickname ? ` (nickname: ${d.nickname})` : ''}`,
        d.tags?.length ? `Tags: ${d.tags.join(', ')}` : '',
        `Description:\n${cut(d.description, 3000)}`,
        d.personality ? `Personality:\n${cut(d.personality, 1200)}` : '',
        d.scenario ? `Scenario:\n${cut(d.scenario, 1500)}` : '',
        d.first_mes ? `First message:\n${cut(d.first_mes, 1500)}` : '',
        d.alternate_greetings?.length ? `Alternate greetings: ${d.alternate_greetings.length}` : '',
        d.mes_example ? `Example dialogue:\n${cut(d.mes_example, 1500)}` : '',
        d.system_prompt ? `Card system prompt:\n${cut(d.system_prompt, 800)}` : '',
        d.post_history_instructions ? `Post-history instructions:\n${cut(d.post_history_instructions, 800)}` : '',
        d.creator_notes ? `Creator notes:\n${cut(d.creator_notes, 800)}` : '',
    ].filter(Boolean).join('\n\n');
}

/** Human-readable generation dials (shared by whole-project generation and per-area generators). */
export const DIALS = {
    genre: { label: 'Genre', options: ['', 'fantasy', 'science fiction', 'modern / slice of life', 'mystery / noir', 'horror', 'romance', 'historical', 'post-apocalyptic', 'comedy', 'cyberpunk', 'mythic / folklore'] },
    tone: { label: 'Tone', options: ['', 'cozy', 'dramatic', 'dark', 'lighthearted', 'tense', 'melancholic', 'whimsical', 'gritty'] },
    rating: { label: 'Content rating', options: ['', 'SFW', 'mature themes, no explicit content', 'unrestricted (the model decides)'] },
    pov: { label: 'Narration', options: ['', 'third person, past tense', 'second person ("you")', 'first person (character narrates)'] },
    length: { label: 'Reply length', options: ['', 'short (1-2 paragraphs)', 'medium (2-4 paragraphs)', 'long (4+ paragraphs)'] },
    cardType: { label: 'Card type', options: ['', 'single character', 'narrator / multi-character scenario'] },
    model: { label: 'Target model (for the preset)', options: ['', 'Claude', 'GPT', 'Gemini', 'DeepSeek', 'Mistral', 'Llama', 'Qwen', 'a small local model'] },
};

export function dialText(dials = {}) {
    const parts = Object.entries(DIALS).filter(([k]) => dials[k]).map(([k, d]) => `${d.label}: ${dials[k]}`);
    return parts.length ? `Author's choices:\n${parts.map(p => `- ${p}`).join('\n')}\n` : '';
}

/** Entries for a prompt. Long content is abbreviated with an explicit [...] marker so models don't mistake it for a defect. */
function loreDigest(entries, limit = 40, chars = 400) {
    return entries.slice(0, limit).map(e => {
        const c = String(e.content ?? '').replace(/\n/g, ' ');
        return `- [${e.uid}] ${e.comment || '(untitled)'} | keys: ${(e.key ?? []).join(', ')}${e.constant ? ' | constant' : ''}\n  ${c.length > chars ? `${c.slice(0, chars)} [...]` : c}`;
    }).join('\n');
}
const ABBREVIATED = 'Lore content may be shown abbreviated; "[...]" marks text omitted from this view, which is not a defect.';

export const CARD_FIELDS = {
    description: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    first_mes: 'First message',
    mes_example: 'Example dialogue',
    system_prompt: 'System prompt (card)',
    post_history_instructions: 'Post-history instructions',
    creator_notes: 'Creator notes',
};

/** Display labels for every card field an AI task may propose (CARD_FIELDS stays limited to rewritable text). */
export const FIELD_LABELS = { ...CARD_FIELDS, name: 'Name', tags: 'Tags', alternate_greetings: 'Alternate greetings', group_only_greetings: 'Group-only greetings', nickname: 'Nickname' };

/** The fields a playable card needs; card drafting asks for all of them and generation repairs any left empty. */
export const CORE_CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'tags'];

/** Tags are for browsing: a handful of genre/theme words, not a keyword dump. */
export const MAX_TAGS = 8;

/** Clean AI tags: trimmed, deduplicated (case-insensitive), no meta tags about the format itself, at most MAX_TAGS. */
export function tidyTags(tags) {
    const meta = /^(sillytavern|character ?card|v[123]|chara_card_v\d|roleplay|rp|interactive fiction|ai)$/i;
    const seen = new Set();
    const out = [];
    for (const t of tags ?? []) {
        const s = String(t).trim();
        if (!s || meta.test(s) || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** Card-field result schema with the wanted fields required (and non-empty). */
function cardFieldsSchema(required) {
    const text = { type: 'string', minLength: 1 };
    const list = { type: 'array', items: { type: 'string' } };
    const all = {
        name: text, description: text, personality: text, scenario: text, first_mes: text, alternate_greetings: list,
        mes_example: text, creator_notes: text, tags: { ...list, minItems: 1, maxItems: MAX_TAGS }, system_prompt: text, post_history_instructions: text,
    };
    return {
        type: 'object', required: ['fields', 'rationale'],
        properties: { fields: { type: 'object', required: [...required], properties: all }, rationale: { type: 'string' } },
    };
}

/** The schema for one call of a task (some tasks require different fields depending on the request). */
export function taskSchema(task, args) {
    return task.schemaFor?.(args ?? {}) ?? task.schema;
}

/**
 * Trigger keys from AI lore output. Models use "secondary keys" for synonyms, but in SillyTavern secondary keys are an
 * AND/NOT filter that stops the entry firing on its primary key alone; so every key becomes a primary key.
 */
export function entryKeys(e) {
    return [...new Set([...(e?.keys ?? []), ...(e?.secondary_keys ?? [])].map(k => String(k).trim()).filter(Boolean))];
}

/** A short entry title from AI lore output: title, else a short comment, else the first key. */
export function entryTitle(e) {
    const t = String(e?.title || e?.comment || '').trim();
    const key = (e?.keys ?? e?.key ?? [])[0];
    if (!t) return key || 'Entry';
    return t.length > 60 && key ? key : t;
}

export const TASKS = {
    // ---------------------------------------------------------------- characters
    'character.ideate': {
        label: 'Ideate distinct character concepts',
        area: 'characters',
        schemaName: 'character_concepts',
        maxTokens: 3500,
        schema: {
            type: 'object', required: ['candidates'],
            properties: {
                candidates: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object',
                        required: ['name', 'hook', 'voice', 'contradiction', 'motive', 'dynamic', 'pressure', 'openings'],
                        properties: {
                            name: S, hook: S, voice: S, sample_lines: SA, contradiction: S, motive: S, secret: S,
                            dynamic: S, pressure: S, openings: SA, replay: S, tags: SA,
                        },
                    },
                },
            },
        },
        build: ({ premise, count = 4, constraints = '' }) => ({
            system: `${CRAFT}\nYou generate DISTINCT character concepts. Each candidate must differ in at least three of: archetype, voice register, central contradiction, relationship stance toward {{user}}, and the kind of story it produces. Do not produce minor variations of one idea.`,
            user: `Premise from the author:\n${premise || '(none — surprise me, but make it playable)'}\n${constraints ? `\nConstraints: ${constraints}\n` : ''}\nGive ${count} candidates. For each:
- name; hook (one sentence pitch)
- voice: how they talk (rhythm, vocabulary, verbal tics) and 2-3 sample_lines in their voice
- contradiction: the tension inside them that makes scenes interesting
- motive and a secret the roleplay can uncover
- dynamic: the relationship stance toward {{user}} and how it can evolve
- pressure: what in the scenario forces decisions right now
- openings: 2-3 distinct opening situations (one line each)
- replay: why this is worth replaying (branches, secrets, moods)
- tags`,
        }),
    },

    'character.expand': {
        label: 'Draft card fields from a concept',
        area: 'characters',
        schemaName: 'card_fields',
        maxTokens: 5000,
        schema: cardFieldsSchema(CORE_CARD_FIELDS),
        // Schema-constrained decoding produces the smallest valid object, so the fields we need must be required.
        schemaFor: ({ only = null } = {}) => cardFieldsSchema(only?.length ? only : CORE_CARD_FIELDS),
        build: ({ concept, card, style = '', only = null }) => {
            const want = only?.length ? only : CORE_CARD_FIELDS;
            return {
                system: `${CRAFT}\nYou turn a concept into Character Card V3 field drafts. Description carries appearance, background, behaviour and speech patterns; scenario states the current situation; first_mes opens a scene with a hook and room for {{user}} to act (roughly 120-300 words); mes_example uses <START> blocks with {{char}}/{{user}} lines demonstrating voice, each speaker on its own line; tags are 3-${MAX_TAGS} short genre/theme words. Keep permanent fields (description+personality+scenario) within about 1500 tokens.`,
                user: `Concept:\n${typeof concept === 'string' ? concept : JSON.stringify(concept, null, 1)}\n${card ? `\nExisting card (keep what works, stay consistent with it):\n${cardDigest(card)}\n` : ''}${style ? `\nStyle requirements: ${style}\n` : ''}\n${only?.length ? `These fields are still EMPTY and must be written now: ${want.join(', ')}. Return exactly these fields, each non-empty.` : `Write every one of these fields, each non-empty: ${want.join(', ')}. You may add system_prompt or creator_notes if useful.`} Include a short rationale.`,
            };
        },
    },

    'character.rewrite-field': {
        label: 'Rewrite a field (variants)',
        area: 'characters',
        schemaName: 'field_variants',
        maxTokens: 3500,
        schema: {
            type: 'object', required: ['variants'],
            properties: { variants: { type: 'array', minItems: 1, items: { type: 'object', required: ['text', 'rationale'], properties: { label: S, text: S, rationale: S } } } },
        },
        build: ({ card, field, instruction, count = 3 }) => {
            const current = String(card?.data?.[field] ?? '').trim();
            const many = count > 1 ? `Give ${count} variants, each a meaningfully different approach with a label and a one-sentence rationale.` : 'Give exactly 1 variant: your best version, with a label and a one-sentence rationale.';
            return {
                system: `${CRAFT}\nYou ${current ? 'rewrite' : 'write'} one field of a character card so it fits everything else on the card.`,
                user: `Card:\n${cardDigest(card)}\n\nField: ${CARD_FIELDS[field] ?? field}\n${current ? `Current value:\n"""\n${current}\n"""` : 'The field is empty: write it from scratch, consistent with the rest of the card.'}\n\nAuthor's instruction: ${instruction || (current ? 'Make it stronger for roleplay.' : 'Write it well for roleplay.')}\n${many}`,
            };
        },
    },

    'character.greetings': {
        label: 'Alternate greetings with distinct openings',
        area: 'characters',
        schemaName: 'greetings',
        maxTokens: 4000,
        schema: {
            type: 'object', required: ['greetings'],
            properties: { greetings: { type: 'array', minItems: 1, items: { type: 'object', required: ['text', 'situation'], properties: { situation: S, mood: S, text: { type: 'string', minLength: 1 }, group_only: { type: 'boolean' } } } } },
        },
        // Ask for as many as requested: the smallest valid answer would otherwise be a single greeting.
        schemaFor: ({ count = 3 } = {}) => {
            const s = structuredClone(TASKS['character.greetings'].schema);
            s.properties.greetings.minItems = count;
            return s;
        },
        build: ({ card, count = 3, direction = '' }) => ({
            system: `${CRAFT}\nYou write alternate greetings. Each must open a DIFFERENT situation (place, time, mood, or relationship state), end with an opening for {{user}}, and stay consistent with the card.`,
            user: `Card:\n${cardDigest(card)}\n\nExisting greetings to avoid repeating: first message${card?.data?.alternate_greetings?.length ? ` and ${card.data.alternate_greetings.length} alternates` : ''}.\n${direction ? `Direction: ${direction}\n` : ''}Write ${count} greetings. Mark group_only true only if the greeting only makes sense in a group chat.`,
        }),
    },

    'character.critique': {
        label: 'Critique card for roleplay quality',
        area: 'characters',
        schemaName: 'critique',
        maxTokens: 3000,
        schema: {
            type: 'object', required: ['issues', 'strengths'],
            properties: {
                strengths: SA,
                issues: { type: 'array', items: { type: 'object', required: ['field', 'severity', 'problem', 'suggestion'], properties: { field: S, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, problem: S, suggestion: S, replacement: S } } },
            },
        },
        build: ({ card, lore = [] }) => ({
            system: `${CRAFT}\nYou are a strict but constructive card reviewer. Look for: contradictions between fields; vague adjectives instead of behaviour; greetings that act for {{user}}; missing scenario pressure; example dialogue that does not show the voice; wasted tokens; lore that contradicts the card. When a concrete fix is short, give it as replacement text for the field.`,
            user: `Card:\n${cardDigest(card, { full: true })}\n${lore.length ? `\nLinked lore entries (${ABBREVIATED}):\n${loreDigest(lore)}` : ''}\n\nList strengths and issues. Use field names from: ${Object.keys(CARD_FIELDS).join(', ')}, alternate_greetings, lore.`,
        }),
    },

    // ---------------------------------------------------------------- lore
    'lore.structure': {
        label: 'Propose world structure (lore entries)',
        area: 'lore',
        schemaName: 'lore_entries',
        maxTokens: 5000,
        schema: {
            type: 'object', required: ['entries'],
            properties: {
                overview: S,
                entries: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object', required: ['title', 'keys', 'content'],
                        properties: { title: S, keys: SA, content: S, constant: { type: 'boolean' }, category: S, rationale: S },
                    },
                },
            },
        },
        build: ({ premise, card, existing = [], count = 8 }) => ({
            system: `${CRAFT}\nYou design World Info (lorebook) entries for SillyTavern. Entries trigger when a key appears in recent chat, so:
- title is a short name for the entry (1-5 words: the place, person, faction or rule itself), not a sentence.
- keys are words/phrases that would naturally appear in chat when the topic is relevant (names, places, nicknames, plural forms); any one key activates the entry, so list every variant as a key; avoid overly common words.
- content is compact, factual, written for the model (not the reader); 40-150 words; one topic per entry.
- mark constant true only for short, always-relevant world rules.
- do not duplicate what the character card already says.`,
            user: `${premise ? `World premise:\n${premise}\n\n` : ''}${card ? `Character card:\n${cardDigest(card)}\n\n` : ''}${existing.length ? `Existing entries (do not duplicate):\n${loreDigest(existing)}\n\n` : ''}Propose ${count} entries covering the most useful places, factions, people, rules and history for roleplay. Give each a category and a one-line rationale.`,
        }),
    },

    'lore.extract': {
        label: 'Extract lore candidates from text',
        area: 'lore',
        schemaName: 'lore_candidates',
        maxTokens: 4500,
        schema: {
            type: 'object', required: ['entries'],
            properties: { entries: { type: 'array', items: { type: 'object', required: ['title', 'keys', 'content'], properties: { title: S, keys: SA, content: S, evidence: S, rationale: S } } } },
        },
        build: ({ text, existing = [] }) => ({
            system: `${CRAFT}\nYou extract facts that recur or matter from writing or chat logs and turn them into World Info entry candidates. Give each a short title (1-5 words, the thing itself). Quote a short evidence snippet for each. Skip one-off details.`,
            user: `Source text:\n"""\n${String(text).slice(0, 24000)}\n"""\n${existing.length ? `\nAlready covered:\n${loreDigest(existing)}` : ''}\n\nReturn candidate entries.`,
        }),
    },

    'lore.contradictions': {
        label: 'Find contradictions and gaps',
        area: 'lore',
        schemaName: 'lore_findings',
        maxTokens: 3500,
        schema: {
            type: 'object', required: ['findings'],
            properties: {
                findings: {
                    type: 'array',
                    items: { type: 'object', required: ['kind', 'summary'], properties: { kind: { type: 'string', enum: ['contradiction', 'gap', 'duplicate', 'key-problem', 'budget'] }, entry_uids: { type: 'array', items: { type: ['number', 'string'] } }, summary: S, suggestion: S } },
                },
            },
        },
        build: ({ entries, card }) => ({
            system: `${CRAFT}\nYou audit a lorebook. Report contradictions between entries (or with the card), duplicated coverage, important gaps, and key problems (keys too generic, missing obvious synonyms, keys that never appear in the entry's own topic).`,
            user: `${card ? `Card:\n${cardDigest(card)}\n\n` : ''}Entries (${ABBREVIATED}):\n${loreDigest(entries, 80, 800)}\n\nReport findings with the entry uids involved.`,
        }),
    },

    'lore.keys': {
        label: 'Suggest better activation keys',
        area: 'lore',
        schemaName: 'lore_keys',
        maxTokens: 1200,
        schema: { type: 'object', required: ['keys', 'rationale'], properties: { keys: SA, secondary_keys: SA, rationale: S } },
        build: ({ entry }) => ({
            system: `${CRAFT}\nYou choose World Info keys: words the chat will actually contain when this topic matters. Include name variants, nicknames, plurals, and common misspellings; avoid generic words that would fire constantly.`,
            user: `Entry "${entry.comment}":\n${entry.content}\n\nCurrent keys: ${(entry.key ?? []).join(', ') || '(none)'}\nPropose a better key list (and optional secondary keys for AND/NOT logic).`,
        }),
    },

    // ---------------------------------------------------------------- prompts & presets
    'preset.generate-cc': {
        label: 'Generate Chat Completion prompts from goals',
        area: 'prompts',
        schemaName: 'cc_prompts',
        maxTokens: 4500,
        schema: {
            type: 'object', required: ['prompts', 'rationale'],
            properties: {
                prompts: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object', required: ['name', 'role', 'content', 'placement'],
                        properties: {
                            name: S, identifier: S, role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: S,
                            placement: { type: 'string', enum: ['main', 'before-char', 'after-char', 'post-history', 'in-chat'] }, depth: { type: 'integer' }, purpose: S,
                        },
                    },
                },
                sampler: { type: 'object', properties: { temperature: { type: 'number' }, top_p: { type: 'number' }, frequency_penalty: { type: 'number' }, presence_penalty: { type: 'number' }, openai_max_tokens: { type: 'integer' } } },
                model_assumptions: S,
                rationale: S,
            },
        },
        build: ({ goals, samples = '', model = '', existing = '' }) => ({
            system: `You are an expert SillyTavern Chat Completion preset engineer. You write Prompt Manager prompts: a main prompt, optional post-history instructions (jailbreak slot), and custom prompts placed relative to character data or injected in-chat at a depth. Keep prompts direct, non-contradictory and model-appropriate; use {{char}}/{{user}} macros. Explain placement choices. Sampler suggestions must be conservative and justified by the model.`,
            user: `Author goals:\n${goals}\n${samples ? `\nSample outputs the author likes/dislikes (with notes):\n${samples}\n` : ''}${model ? `\nTarget model: ${model}\n` : ''}${existing ? `\nCurrent prompt set:\n${existing}\n` : ''}\nPropose prompts with placement (main | before-char | after-char | post-history | in-chat with depth) and optional sampler settings. State model assumptions.`,
        }),
    },

    'preset.generate-tc': {
        label: 'Generate Text Completion system prompt / story string',
        area: 'prompts',
        schemaName: 'tc_templates',
        maxTokens: 3000,
        schema: {
            type: 'object', required: ['system_prompt', 'rationale'],
            properties: { system_prompt: S, story_string_notes: S, stop_strings: SA, sampler: { type: 'object' }, instruct_family: S, rationale: S },
        },
        build: ({ goals, model = '' }) => ({
            system: `You are an expert in SillyTavern Text Completion setups (context template story string, instruct templates, system prompts, samplers). Recommend the instruct template family that matches the model's chat format and write a system prompt. Only suggest sampler keys that exist in SillyTavern text-generation presets (temp, top_p, top_k, min_p, rep_pen, rep_pen_range, dry_multiplier, xtc_probability...).`,
            user: `Goals:\n${goals}\n${model ? `Model: ${model}\n` : ''}Return a system prompt, notes for the story string, stop strings, sampler suggestions and the instruct family.`,
        }),
    },

    'preset.critique': {
        label: 'Critique an assembled prompt',
        area: 'prompts',
        schemaName: 'prompt_critique',
        maxTokens: 2500,
        schema: {
            type: 'object', required: ['findings'],
            properties: { findings: { type: 'array', items: { type: 'object', required: ['severity', 'problem', 'suggestion'], properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, where: S, problem: S, suggestion: S } } }, token_notes: S },
        },
        build: ({ assembled }) => ({
            system: `You review a fully assembled roleplay prompt as sent to the model. Find conflicting instructions, redundancy, instructions buried where the model will ignore them, formatting that may confuse the model, and token waste.`,
            user: `Assembled prompt (role-tagged blocks):\n${String(assembled).slice(0, 30000)}\n\nList findings.`,
        }),
    },

    // ---------------------------------------------------------------- regex
    'regex.generate': {
        label: 'Generate regex scripts from examples',
        area: 'regex',
        schemaName: 'regex_scripts',
        maxTokens: 2500,
        schema: {
            type: 'object', required: ['scripts'],
            properties: {
                scripts: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object', required: ['scriptName', 'findRegex', 'replaceString', 'placement'],
                        properties: {
                            scriptName: S, findRegex: S, replaceString: S, trimStrings: SA,
                            placement: { type: 'array', items: { type: 'integer' } }, markdownOnly: { type: 'boolean' }, promptOnly: { type: 'boolean' },
                            minDepth: { type: ['integer', 'null'] }, maxDepth: { type: ['integer', 'null'] }, explanation: S,
                            tests: { type: 'array', items: { type: 'object', required: ['input', 'expected'], properties: { input: S, expected: S } } },
                        },
                    },
                },
            },
        },
        build: ({ goal, samples = '' }) => ({
            system: `You write SillyTavern Regex extension scripts. findRegex uses JavaScript regex literal syntax "/pattern/flags" (include g when all matches should be replaced). replaceString may use $1..$n, $<name>, and {{match}} (the whole match). placement values: 1 = user input, 2 = AI output, 3 = slash commands, 5 = world info, 6 = reasoning. markdownOnly = display only (chat text unchanged), promptOnly = only in what is sent to the model; neither = the stored message text is rewritten. minDepth/maxDepth limit by message depth (0 = last message), null = no limit. Prefer the least destructive option and include test cases.`,
            user: `Goal: ${goal}\n${samples ? `Examples (before → after):\n${samples}\n` : ''}Return scripts with explanations and tests.`,
        }),
    },

    // ---------------------------------------------------------------- STscript / QR
    'stscript.generate': {
        label: 'Generate Quick Reply / STscript',
        area: 'scripts',
        schemaName: 'quick_replies',
        maxTokens: 3500,
        schema: {
            type: 'object', required: ['quickReplies'],
            properties: {
                quickReplies: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object', required: ['label', 'message', 'explanation'],
                        properties: {
                            label: S, title: S, message: S, explanation: S, isHidden: { type: 'boolean' },
                            executeOnStartup: { type: 'boolean' }, executeOnUser: { type: 'boolean' }, executeOnAi: { type: 'boolean' }, executeOnChatChange: { type: 'boolean' }, executeOnNewChat: { type: 'boolean' },
                            automationId: S, effects: SA,
                        },
                    },
                },
            },
        },
        build: ({ goal, commands = '', existing = '' }) => ({
            system: `You write SillyTavern STscript for Quick Replies. Syntax: commands start with /, pipe results with |, closures {: ... :}, named args name=value, unnamed args after, {{pipe}} is the previous result, variables via /setvar key=name value, /getvar name, /setglobalvar, macros {{getvar::name}}. /if left=... rule=eq right=... {: then :} else={: ... :}. Use only commands that exist (list provided). Keep scripts readable with one command per line where possible. In "effects", list every side effect (messages sent, variables written, chat modified, generation triggered) so the author can review before running.`,
            user: `Goal: ${goal}\n${commands ? `Available commands (subset):\n${commands}\n` : ''}${existing ? `Existing set:\n${existing}\n` : ''}Return quick replies with explanations and effects.`,
        }),
    },

    // ---------------------------------------------------------------- media
    'media.prompts': {
        label: 'Image prompts for the character',
        area: 'characters',
        schemaName: 'image_prompts',
        maxTokens: 1500,
        schema: { type: 'object', required: ['prompts'], properties: { prompts: { type: 'array', items: { type: 'object', required: ['purpose', 'prompt'], properties: { purpose: S, prompt: S, negative: S } } } } },
        build: ({ card, style = '' }) => ({
            system: 'You write concise image-generation prompts (comma-separated visual descriptors) consistent with a character card: portrait/avatar, full body, and a scene background. Visual facts only.',
            user: `Card:\n${cardDigest(card)}\n${style ? `Style: ${style}\n` : ''}Return prompts for avatar, full body and background.`,
        }),
    },

    // ---------------------------------------------------------------- whole-project generation
    'project.premise': {
        label: 'Invent or develop a premise',
        area: 'project',
        schemaName: 'premise',
        maxTokens: 2000,
        schema: {
            type: 'object', required: ['title', 'logline', 'premise', 'card_type'],
            properties: {
                title: S, logline: S, premise: S, setting: S, tone: S, themes: SA,
                user_role: S, central_conflict: S, card_type: { type: 'string', enum: ['character', 'scenario'] },
                cast: { type: 'array', items: { type: 'object', required: ['name', 'role'], properties: { name: S, role: S } } },
            },
        },
        build: ({ idea = '', dials = {} }) => ({
            system: `${CRAFT}\nYou invent the premise of a SillyTavern roleplay the author can start playing immediately. Make it specific and playable: a concrete setting, a central conflict already in motion, a clear role for {{user}}, and a hook for the first scene. card_type is "character" when one main character carries the story, "scenario" when a narrator should voice a setting and several characters.`,
            user: `${idea ? `Author's rough idea (develop it, keep what they asked for):\n${idea}\n` : 'The author has no idea yet: surprise them with something fresh and playable.\n'}${dialText(dials)}\nReturn a title, a one-line logline, a premise paragraph (120-220 words), setting, tone, themes, {{user}}'s role, the central conflict, 1-5 cast members, and the card type.`,
        }),
    },

    'playtest.scenarios': {
        label: 'Invent playtest scenarios',
        area: 'playtest',
        schemaName: 'scenarios',
        maxTokens: 2000,
        schema: {
            type: 'object', required: ['scenarios'],
            properties: { scenarios: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'userTurns', 'lookFor'], properties: { name: S, userTurns: SA, lookFor: S } } } },
        },
        build: ({ card, count = 3 }) => ({
            system: `${CRAFT}\nYou design short playtests for a roleplay card: each is 3-5 user messages that probe something (voice consistency, reaction to conflict, lore recall, handling a romance or refusal beat, pacing). User messages are short and in-world.`,
            user: `Card:\n${cardDigest(card)}\n\nDesign ${count} distinct playtest scenarios with what to look for in the replies.`,
        }),
    },

    // ---------------------------------------------------------------- playtest
    'playtest.user-turn': {
        label: 'Simulate a user turn',
        area: 'playtest',
        schemaName: 'user_turn',
        maxTokens: 600,
        schema: { type: 'object', required: ['message'], properties: { message: S, intent: S } },
        build: ({ transcript, persona = '', style = 'curious, cooperative' }) => ({
            system: `You play the USER in a roleplay test. Write the user's next message only (${style}). Keep it short (1-4 sentences), in character${persona ? ` as: ${persona}` : ''}.`,
            user: `Transcript so far:\n${transcript}\n\nWrite the next user message.`,
        }),
    },
};

export function getTask(id) {
    const t = TASKS[id];
    if (!t) throw new Error(`Unknown AI task ${id}`);
    return t;
}
