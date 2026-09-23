// Prompt & preset model for SillyTavern 1.19: kind detection, Chat Completion prompt manager model,
// lint, structural assembly preview and diffs. Text Completion rendering uses ST's own renderer in the
// browser (src/st/render.js); this module stays pure for tests.
// Sources: docs/research/st-formats.md §E; CC assembly semantics ported from PresetForge (verified vs openai.js).

import { clone, uid } from './bytes.js';
import { jsonDiff } from './diff.js';

export const KINDS = {
    cc: { label: 'Chat Completion preset', apiId: 'openai', icon: 'comments' },
    textgen: { label: 'Text Completion preset (samplers)', apiId: 'textgenerationwebui', icon: 'sliders' },
    instruct: { label: 'Instruct template', apiId: 'instruct', icon: 'align-left' },
    context: { label: 'Context template (story string)', apiId: 'context', icon: 'scroll' },
    sysprompt: { label: 'System prompt', apiId: 'sysprompt', icon: 'user-gear' },
    reasoning: { label: 'Reasoning template', apiId: 'reasoning', icon: 'brain' },
};

export const MARKERS = {
    chatHistory: 'Chat History', dialogueExamples: 'Chat Examples', worldInfoBefore: 'World Info (before)', worldInfoAfter: 'World Info (after)',
    charDescription: 'Char Description', charPersonality: 'Char Personality', scenario: 'Scenario', personaDescription: 'Persona Description',
};
export const CC_ORDER_ID = 100001;
export const LEGACY_ORDER_ID = 100000;
export const INJECTION = { RELATIVE: 0, ABSOLUTE: 1 };
export const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

const DEFAULT_ORDER = ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak'];
const CONNECTION_KEYS = ['chat_completion_source', 'openai_model', 'claude_model', 'openrouter_model', 'custom_model', 'custom_url', 'reverse_proxy', 'proxy_password', 'google_model', 'vertexai_model', 'mistralai_model', 'deepseek_model', 'xai_model', 'groq_model'];
const SENSITIVE_KEYS = ['reverse_proxy', 'proxy_password', 'custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'vertexai_region', 'vertexai_express_project_id', 'azure_base_url', 'azure_deployment_name', 'workers_ai_account_id'];

/**
 * Sniff the kind of a preset/template file (mirrors ST's master import sniffing, plus CC detection).
 * @returns {'cc'|'textgen'|'instruct'|'context'|'sysprompt'|'reasoning'|'master'|'prompt-export'|'unknown'}
 */
export function detectKind(json) {
    if (!json || typeof json !== 'object') return 'unknown';
    if (json.version && json.type && json.data?.prompts) return 'prompt-export';
    if (Array.isArray(json.prompts) || Array.isArray(json.prompt_order) || ('temperature' in json && 'openai_max_context' in json)) return 'cc';
    if ('name' in json && 'input_sequence' in json && 'output_sequence' in json) return 'instruct';
    if ('name' in json && 'story_string' in json) return 'context';
    if ('name' in json && 'content' in json && !('prompts' in json)) return 'sysprompt';
    if ('temp' in json && 'top_k' in json && 'top_p' in json && 'rep_pen' in json) return 'textgen';
    if ('name' in json && 'prefix' in json && 'suffix' in json && 'separator' in json) return 'reasoning';
    if (json.instruct || json.context || json.sysprompt || json.reasoning || json.preset) return 'master';
    return 'unknown';
}

/** Split an ST "master export" into individual template artifacts. */
export function splitMaster(json) {
    const out = [];
    if (json.instruct) out.push({ kind: 'instruct', name: json.instruct.name ?? 'Instruct', data: clone(json.instruct) });
    if (json.context) out.push({ kind: 'context', name: json.context.name ?? 'Context', data: clone(json.context) });
    if (json.sysprompt) out.push({ kind: 'sysprompt', name: json.sysprompt.name ?? 'System prompt', data: clone(json.sysprompt) });
    if (json.reasoning) out.push({ kind: 'reasoning', name: json.reasoning.name ?? 'Reasoning', data: clone(json.reasoning) });
    if (json.preset) out.push({ kind: 'textgen', name: json.preset.name ?? 'Text Completion preset', data: clone(json.preset) });
    return out;
}

export function emptyCcPreset() {
    return {
        temperature: 1, frequency_penalty: 0, presence_penalty: 0, top_p: 1, top_k: 0, top_a: 0, min_p: 0, repetition_penalty: 1,
        openai_max_context: 8192, openai_max_tokens: 400, names_behavior: 0, wi_format: '{0}', scenario_format: '{{scenario}}', personality_format: '{{personality}}',
        prompts: [
            { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.", injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false },
            { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [] },
            { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false },
            { identifier: 'enhanceDefinitions', name: 'Enhance Definitions', system_prompt: true, role: 'system', content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.", marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [] },
            ...Object.entries(MARKERS).map(([identifier, name]) => ({ identifier, name, system_prompt: true, marker: true })),
        ],
        prompt_order: [{ character_id: CC_ORDER_ID, order: DEFAULT_ORDER.map(identifier => ({ identifier, enabled: identifier !== 'enhanceDefinitions' })) }],
        extensions: {},
    };
}

/** Normalize a CC preset for editing: ensure prompts/order, keep everything else verbatim. */
export function normalizeCc(input) {
    const p = clone(input ?? {});
    const report = [];
    p.prompts ??= [];
    p.prompt_order ??= [];
    const has = id => p.prompt_order.find(o => Number(o.character_id) === id);
    if (!has(CC_ORDER_ID)) {
        const legacy = has(LEGACY_ORDER_ID);
        if (legacy) {
            p.prompt_order.push({ character_id: CC_ORDER_ID, order: clone(legacy.order) });
            report.push({ level: 'info', path: 'prompt_order', message: 'Copied the legacy order (100000) to 100001, which Chat Completion uses in 1.19.' });
        } else {
            p.prompt_order.push({ character_id: CC_ORDER_ID, order: DEFAULT_ORDER.filter(id => p.prompts.some(x => x.identifier === id)).map(identifier => ({ identifier, enabled: true })) });
            report.push({ level: 'warn', path: 'prompt_order', message: 'No prompt order found; created the default order.' });
        }
    }
    for (const [id, name] of Object.entries(MARKERS)) {
        if (!p.prompts.some(x => x.identifier === id)) {
            p.prompts.push({ identifier: id, name, system_prompt: true, marker: true });
            report.push({ level: 'info', path: `prompts.${id}`, message: `Added missing marker ${name} (ST re-adds it on load too).` });
        }
    }
    return { preset: p, report };
}

export function ccOrder(preset) {
    return preset.prompt_order?.find(o => Number(o.character_id) === CC_ORDER_ID)?.order
        ?? preset.prompt_order?.find(o => Number(o.character_id) === LEGACY_ORDER_ID)?.order ?? [];
}

export function setCcOrder(preset, order) {
    const p = clone(preset);
    const i = p.prompt_order.findIndex(o => Number(o.character_id) === CC_ORDER_ID);
    if (i >= 0) p.prompt_order[i] = { ...p.prompt_order[i], order };
    else p.prompt_order.push({ character_id: CC_ORDER_ID, order });
    return p;
}

export function newCustomPrompt(name = 'New prompt') {
    return { identifier: globalThis.crypto?.randomUUID?.() ?? uid(), name, role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false };
}

/** Whether a "marker" prompt is a real ST marker or a divider/placeholder (e.g. UUID markers used as section headers). */
export function markerKind(p) {
    if (!p.marker) return 'prompt';
    return MARKERS[p.identifier] ? 'marker' : 'divider';
}

/**
 * Lint a CC preset.
 * @returns {{level: 'error'|'warn'|'info', path: string, message: string, identifier?: string}[]}
 */
export function lintCc(preset) {
    const issues = [];
    const add = (level, path, message, identifier) => issues.push({ level, path, message, identifier });
    const ids = new Map();
    for (const p of preset.prompts ?? []) ids.set(p.identifier, (ids.get(p.identifier) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) add('error', `prompts.${id}`, `Identifier "${id}" is used by ${n} prompts; ST keeps only one.`, id);
    const order = ccOrder(preset);
    if (!order.length) add('error', 'prompt_order', 'No prompt order for 100001/100000: ST will fall back to its default order.');
    const inOrder = new Set(order.map(o => o.identifier));
    for (const o of order) if (!ids.has(o.identifier)) add('warn', `prompt_order.${o.identifier}`, `Order references a prompt that does not exist ("${o.identifier}").`, o.identifier);
    for (const p of preset.prompts ?? []) {
        if (!inOrder.has(p.identifier) && !p.marker && p.content) add('info', `prompts.${p.identifier}`, `"${p.name}" is not in the prompt order, so it is never sent.`, p.identifier);
        if (p.injection_position === INJECTION.RELATIVE && p.injection_depth != null && p.injection_depth !== 4) add('info', `prompts.${p.identifier}`, `"${p.name}": depth ${p.injection_depth} is ignored for relative position (only In-Chat uses depth).`, p.identifier);
        if (/\{\{getvar::[^}]*::\}\}/.test(p.content ?? '')) add('warn', `prompts.${p.identifier}`, `"${p.name}" has {{getvar::name::}} with a trailing "::", which does not resolve.`, p.identifier);
        if (p.forbid_overrides && !['main', 'jailbreak'].includes(p.identifier)) add('info', `prompts.${p.identifier}`, `"${p.name}": forbid_overrides only affects main and jailbreak.`, p.identifier);
        if ((p.injection_trigger ?? []).some(t => !TRIGGERS.includes(t))) add('warn', `prompts.${p.identifier}`, `"${p.name}" has unknown trigger(s).`, p.identifier);
        const opens = (p.content ?? '').match(/\{\{/g)?.length ?? 0;
        const closes = (p.content ?? '').match(/\}\}/g)?.length ?? 0;
        if (opens !== closes) add('warn', `prompts.${p.identifier}`, `"${p.name}" has unbalanced macro braces ({{ ${opens} vs }} ${closes}).`, p.identifier);
    }
    const enabled = new Set(order.filter(o => o.enabled).map(o => o.identifier));
    if (!enabled.has('chatHistory')) add('error', 'prompt_order.chatHistory', 'Chat History is disabled or missing: the chat and every In-Chat prompt will not be sent.');
    if (!enabled.has('main')) add('info', 'prompt_order.main', 'Main prompt is disabled.');
    for (const k of ['claude_use_sysprompt', 'use_makersuite_sysprompt', 'names_in_completion', 'image_inlining']) if (k in preset) add('info', k, `Legacy key "${k}" (ST migrates it on load).`);
    const conn = CONNECTION_KEYS.filter(k => k in preset);
    if (conn.length) add('info', 'connection', `Contains connection keys (${conn.slice(0, 4).join(', ')}${conn.length > 4 ? '…' : ''}); with "bind preset to connection" on they switch the user's API/model.`);
    const sens = SENSITIVE_KEYS.filter(k => preset[k]);
    if (sens.length) add('warn', 'sensitive', `Contains sensitive connection fields (${sens.join(', ')}). Strip them before sharing.`);
    if (preset.version && preset.data) add('error', '(root)', 'This looks like a prompt-only export {version,type,data}, not a preset; import it via the Prompt Manager, not the preset importer.');
    return issues;
}

/** Remove sensitive connection fields before sharing (mirrors ST's export option). */
export function stripSensitive(preset, { connection = false } = {}) {
    const p = clone(preset);
    for (const k of SENSITIVE_KEYS) delete p[k];
    if (connection) for (const k of CONNECTION_KEYS) delete p[k];
    return p;
}

/**
 * Structural preview of CC prompt assembly (not byte-exact; see "live dry run" for the real prompt).
 * Relative prompts in order; markers expanded from scene; chat with In-Chat prompts at depth.
 * Same-depth ordering matches openai.js populationInjectionPrompts: ascending injection_order,
 * then assistant → user → system.
 * @returns {{role: string, content: string, source: string, label: string, identifier?: string, depth?: number}[]}
 */
export function assembleCc(preset, scene, { generationType = 'normal', honorCardOverrides = true } = {}) {
    const byId = new Map((preset.prompts ?? []).map(p => [p.identifier, p]));
    const order = ccOrder(preset).filter(o => o.enabled);
    const fill = t => fillMacros(t, scene);
    const trig = p => !(p.injection_trigger?.length) || p.injection_trigger.includes(generationType);
    const blocks = [];
    const absolute = order.map(o => byId.get(o.identifier)).filter(p => p && p.injection_position === INJECTION.ABSOLUTE && !p.marker && p.content && trig(p));
    const pushChat = () => {
        const chat = scene.chat ?? [];
        const byGap = new Map();
        for (const p of absolute) {
            const depth = Math.min(Math.max(p.injection_depth ?? 4, 0), chat.length);
            const gap = chat.length - depth;
            byGap.set(gap, [...(byGap.get(gap) ?? []), p]);
        }
        const rank = { assistant: 0, user: 1, system: 2 };
        const emit = gap => {
            const ps = byGap.get(gap);
            if (!ps) return;
            ps.sort((a, b) => (a.injection_order ?? 100) - (b.injection_order ?? 100) || rank[a.role || 'system'] - rank[b.role || 'system']);
            for (const p of ps) blocks.push({ role: p.role || 'system', content: fill(p.content), source: 'injection', label: `${p.name} · @depth ${p.injection_depth ?? 4}`, identifier: p.identifier, depth: p.injection_depth ?? 4 });
        };
        for (let i = 0; i < chat.length; i++) {
            emit(i);
            blocks.push({ role: chat[i].role, content: fill(chat[i].text), source: 'chat', label: `chat ${i + 1}` });
        }
        emit(chat.length);
    };
    let chatDone = false;
    for (const o of order) {
        if (o.identifier === 'chatHistory') { pushChat(); chatDone = true; continue; }
        const p = byId.get(o.identifier);
        if (!p || !trig(p)) continue;
        if (p.marker) {
            const c = markerContent(p.identifier, scene);
            if (c) blocks.push({ role: 'system', content: fill(c), source: 'marker', label: MARKERS[p.identifier] ?? p.name ?? p.identifier, identifier: p.identifier });
            continue;
        }
        if (p.injection_position === INJECTION.ABSOLUTE) continue;
        let content = p.content ?? '';
        let label = p.name;
        if (honorCardOverrides && p.identifier === 'main' && scene.cardSystemPrompt && !p.forbid_overrides) {
            content = scene.cardSystemPrompt.replace(/\{\{original\}\}/gi, content);
            label = `${p.name} (replaced by card system prompt)`;
        }
        if (honorCardOverrides && p.identifier === 'jailbreak' && scene.cardPostHistory && !p.forbid_overrides) {
            content = scene.cardPostHistory.replace(/\{\{original\}\}/gi, content);
            label = `${p.name} (replaced by card post-history instructions)`;
        }
        if (!content) continue;
        blocks.push({ role: p.role || 'system', content: fill(content), source: 'prompt', label, identifier: p.identifier });
    }
    if (!chatDone) blocks.push({ role: 'system', content: 'Chat History is disabled or missing: the chat and all In-Chat prompts are NOT sent.', source: 'note', label: '⚠ no chat history' });
    return blocks;
}

function markerContent(id, s) {
    switch (id) {
        case 'charDescription': return s.description || null;
        case 'charPersonality': return s.personality ? `${s.char}'s personality: ${s.personality}` : null;
        case 'scenario': return s.scenario ? `Scenario: ${s.scenario}` : null;
        case 'personaDescription': return s.persona || null;
        case 'worldInfoBefore': return s.wiBefore || null;
        case 'worldInfoAfter': return s.wiAfter || null;
        case 'dialogueExamples': return s.examples || null;
        default: return null;
    }
}

export function fillMacros(text, s) {
    const v = { char: s.char, user: s.user, charIfNotGroup: s.char, description: s.description, personality: s.personality, scenario: s.scenario, persona: s.persona };
    return String(text ?? '').replace(/\{\{(char|user|charIfNotGroup|description|personality|scenario|persona)\}\}/gi, (m, k) => v[k.charAt(0).toLowerCase() + k.slice(1)] ?? v[k] ?? m);
}

/** Build a preview scene from a V3 card (or defaults). */
export function sceneFromCard(card, { user = 'User', persona = 'A curious traveler.', chat } = {}) {
    const d = card?.data ?? {};
    const name = d.name || 'Char';
    return {
        char: name, user, persona,
        description: d.description ?? '', personality: d.personality ?? '', scenario: d.scenario ?? '',
        examples: d.mes_example ?? '', cardSystemPrompt: d.system_prompt ?? '', cardPostHistory: d.post_history_instructions ?? '',
        wiBefore: '', wiAfter: '',
        chat: chat ?? [
            ...(d.first_mes ? [{ role: 'assistant', text: d.first_mes }] : [{ role: 'assistant', text: `*${name} looks up.* "Well?"` }]),
            { role: 'user', text: '*I step closer.* Tell me what happened here.' },
            { role: 'assistant', text: `*${name} hesitates, weighing how much to say.*` },
            { role: 'user', text: 'And what do we do next?' },
        ],
    };
}

/** Semantic diff of two CC presets: prompts by identifier, order, samplers/other keys. */
export function diffCc(a, b) {
    const pa = new Map((a.prompts ?? []).map(p => [p.identifier, p]));
    const pb = new Map((b.prompts ?? []).map(p => [p.identifier, p]));
    const prompts = [];
    for (const [id, p] of pb) {
        if (!pa.has(id)) prompts.push({ id, name: p.name, kind: 'added' });
        else {
            const d = jsonDiff(pa.get(id), p);
            if (d.length) prompts.push({ id, name: p.name, kind: 'changed', fields: d.map(x => x.path) });
        }
    }
    for (const [id, p] of pa) if (!pb.has(id)) prompts.push({ id, name: p.name, kind: 'removed' });
    const oa = ccOrder(a).map(o => `${o.identifier}:${o.enabled ? 1 : 0}`).join('|');
    const ob = ccOrder(b).map(o => `${o.identifier}:${o.enabled ? 1 : 0}`).join('|');
    const rest = jsonDiff(omit(a, ['prompts', 'prompt_order']), omit(b, ['prompts', 'prompt_order']));
    return { prompts, orderChanged: oa !== ob, settings: rest };
}

function omit(o, keys) {
    const c = { ...(o ?? {}) };
    for (const k of keys) delete c[k];
    return c;
}

// ------------------------------------------------------------------------------ TC templates (pure)

export const INSTRUCT_DEFAULT = {
    input_sequence: '### Instruction:', input_suffix: '', output_sequence: '### Response:', output_suffix: '', system_sequence: '', system_suffix: '',
    first_input_sequence: '', last_input_sequence: '', first_output_sequence: '', last_output_sequence: '', last_system_sequence: '',
    story_string_prefix: '', story_string_suffix: '', stop_sequence: '', user_alignment_message: '', wrap: true, macro: true,
    names_behavior: 'force', activation_regex: '', skip_examples: false, system_same_as_user: false, sequences_as_stop_strings: true, name: 'New instruct',
};
export const CONTEXT_DEFAULT = {
    story_string: "{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{trim}}",
    example_separator: '***', chat_start: '***', use_stop_strings: false, names_as_stop_strings: true, story_string_position: 0, story_string_depth: 1, story_string_role: 0,
    always_force_name2: true, trim_sentences: false, single_line: false, name: 'New context',
};
export const SYSPROMPT_DEFAULT = { name: 'New system prompt', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.", post_history: '' };
export const REASONING_DEFAULT = { name: 'New reasoning', prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n' };

/** Tiny Handlebars subset used only when ST's renderer is unavailable (tests/offline). */
export function renderStoryStringFallback(template, params) {
    let out = String(template ?? '');
    const ifRe = /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/;
    let guard = 0;
    while (ifRe.test(out) && guard++ < 200) out = out.replace(ifRe, (_, k, body) => (params[k] ? body : ''));
    out = out.replace(/\{\{(\w+)\}\}/g, (m, k) => (k === 'trim' ? '\u0000TRIM\u0000' : k in params ? String(params[k] ?? '') : m));
    out = out.replace(/\s*\u0000TRIM\u0000\s*/g, '');
    return out.replace(/^\n+/, '');
}

/** Pure TC preview (approximation of instruct formatting; the browser uses ST's own functions). */
export function assembleTcFallback({ context, instruct, sysprompt }, scene) {
    const ins = { ...INSTRUCT_DEFAULT, ...(instruct ?? {}) };
    const ctx = { ...CONTEXT_DEFAULT, ...(context ?? {}) };
    const story = renderStoryStringFallback(ctx.story_string, {
        system: sysprompt?.content ? fillMacros(sysprompt.content, scene) : '', description: scene.description, personality: scene.personality,
        scenario: scene.scenario, persona: scene.persona, char: scene.char, user: scene.user, wiBefore: scene.wiBefore, wiAfter: scene.wiAfter, loreBefore: scene.wiBefore, loreAfter: scene.wiAfter,
    });
    const nl = ins.wrap ? '\n' : '';
    const parts = [];
    parts.push(`${ins.story_string_prefix}${story}${ins.story_string_suffix}`);
    if (ctx.chat_start) parts.push(`${ctx.chat_start}${nl}`);
    for (const m of scene.chat ?? []) {
        const user = m.role === 'user';
        const seq = user ? ins.input_sequence : ins.output_sequence;
        const suf = user ? ins.input_suffix : ins.output_suffix;
        parts.push(`${seq}${nl}${user ? scene.user : scene.char}: ${fillMacros(m.text, scene)}${suf}${nl}`);
    }
    parts.push(`${ins.last_output_sequence || ins.output_sequence}${nl}${scene.char}:`);
    return parts.join('');
}

/** Merge AI-generated prompts into a CC preset copy. Returns preset + per-prompt metadata for selective acceptance. */
export function mergeGeneratedPrompts(data, gen) {
    const preset = clone(data);
    const order = [...ccOrder(preset)];
    const meta = [];
    const insertAfter = (anchor, id) => {
        const i = order.findIndex(o => o.identifier === anchor);
        order.splice(i >= 0 ? i + 1 : order.length, 0, { identifier: id, enabled: true });
    };
    const insertBefore = (anchor, id) => {
        const i = order.findIndex(o => o.identifier === anchor);
        order.splice(i >= 0 ? i : 0, 0, { identifier: id, enabled: true });
    };
    for (const g of gen.prompts ?? []) {
        if (g.placement === 'main' || g.placement === 'post-history') {
            const id = g.placement === 'main' ? 'main' : 'jailbreak';
            const p = preset.prompts.find(x => x.identifier === id);
            if (p) { p.content = g.content; p.role = g.role ?? p.role; }
            if (!order.some(o => o.identifier === id)) insertAfter(id === 'main' ? '' : 'chatHistory', id);
            else order.forEach(o => { if (o.identifier === id) o.enabled = true; });
            meta.push({ identifier: id, name: p?.name ?? id, placement: g.placement, purpose: g.purpose ?? '', replaced: true });
            continue;
        }
        const np = { ...newCustomPrompt(g.name), role: g.role ?? 'system', content: g.content, injection_position: g.placement === 'in-chat' ? 1 : 0, injection_depth: g.depth ?? 4 };
        preset.prompts.push(np);
        if (g.placement === 'before-char') insertBefore('charDescription', np.identifier);
        else if (g.placement === 'after-char') insertAfter('scenario', np.identifier);
        else insertBefore('chatHistory', np.identifier);
        meta.push({ identifier: np.identifier, name: g.name, placement: g.placement, purpose: g.purpose ?? '', depth: g.depth });
    }
    if (gen.sampler) for (const [k, v] of Object.entries(gen.sampler)) if (v != null) preset[k] = v;
    return { preset: setCcOrder(preset, order), meta: { prompts: meta, sampler: gen.sampler ?? null } };
}
