// SillyTavern 1.19 Regex extension semantics, mirrored for previews, fixtures and linting.
// Sources: public/scripts/extensions/regex/engine.js (getRegexedString, runRegexScript, filterString),
// public/scripts/utils.js regexFromString. See docs/research/st-formats.md §C.

const uuid = () => globalThis.crypto.randomUUID(); // ST uses UUIDv4 ids for regex scripts

export const PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const PLACEMENT_LABEL = { 1: 'User input', 2: 'AI output', 3: 'Slash commands', 5: 'World Info', 6: 'Reasoning' };
export const SUBSTITUTE = { NONE: 0, RAW: 1, ESCAPED: 2 };
export const SUBSTITUTE_LABEL = { 0: "Don't substitute", 1: 'Substitute (raw)', 2: 'Substitute (escaped)' };
export const SCOPE_ORDER = ['global', 'preset', 'character']; // engine order: GLOBAL, PRESET, SCOPED

/** Defaults of a new script in ST's editor (index.js:798-868). */
export function defaultScript(name = '') {
    return {
        id: uuid(), scriptName: name, findRegex: '', replaceString: '', trimStrings: [], placement: [1],
        disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    };
}

/** Copy of ST's regexFromString (utils.js:1387-1402). Returns RegExp or undefined. */
export function regexFromString(input) {
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
            return RegExp(input);
        }
        return new RegExp(m[2], m[3]);
    } catch {
        return undefined;
    }
}

function sanitizeRegexMacro(x) {
    return x && typeof x === 'string'
        ? x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, s => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' }[s] ?? `\\${s}`))
        : x;
}

/** Minimal macro substitution for previews: {{char}}, {{user}} and caller-supplied values. */
export function makeMacros(values = {}) {
    const v = { char: 'Char', user: 'User', ...values };
    return (text, post = s => s) => String(text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, k) => (k in v ? post(String(v[k])) : m));
}

/**
 * runRegexScript mirror. Returns { output, matches, error }.
 * @param {object} script
 * @param {string} rawString
 * @param {{ macros?: Function }} [opts]
 */
export function runRegexScript(script, rawString, { macros = makeMacros() } = {}) {
    if (!script || script.disabled || !script.findRegex || !rawString) return { output: rawString, matches: [] };
    let regexString;
    switch (Number(script.substituteRegex)) {
        case SUBSTITUTE.RAW: regexString = macros(script.findRegex); break;
        case SUBSTITUTE.ESCAPED: regexString = macros(script.findRegex, sanitizeRegexMacro); break;
        default: regexString = script.findRegex;
    }
    const re = regexFromString(regexString);
    if (!re) return { output: rawString, matches: [], error: `Invalid regex: ${regexString}` };
    const matches = [];
    const output = rawString.replace(re, function (match) {
        const args = [...arguments];
        const offset = args.find((a, i) => i > 0 && typeof a === 'number');
        matches.push({ text: match, index: offset });
        const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
        const withGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            let m;
            if (num) m = args[Number(num)];
            else if (groupName) {
                const groups = args[args.length - 1];
                m = groups && typeof groups === 'object' && groups[groupName];
            }
            if (!m) return '';
            let filtered = m;
            for (const t of script.trimStrings ?? []) filtered = filtered.replaceAll(macros(t), '');
            return filtered;
        });
        return macros(withGroups);
    });
    return { output, matches };
}

/**
 * Eligibility of a script for one call site (getRegexedString gates, engine.js:334-381).
 * @returns {{ ok: boolean, reason: string }}
 */
export function eligibility(script, { placement, isMarkdown = false, isPrompt = false, isEdit = false, depth } = {}) {
    if (script.disabled) return { ok: false, reason: 'disabled' };
    const modeOk = (script.markdownOnly && isMarkdown) || (script.promptOnly && isPrompt) || (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
    if (!modeOk) {
        const kind = script.markdownOnly && script.promptOnly ? 'display+prompt' : script.markdownOnly ? 'display only' : script.promptOnly ? 'prompt only' : 'stored text';
        return { ok: false, reason: `mode: script is ${kind}` };
    }
    if (isEdit && !script.runOnEdit) return { ok: false, reason: 'does not run on edit' };
    if (typeof depth === 'number') {
        if (script.minDepth !== null && script.minDepth !== undefined && script.minDepth >= -1 && depth < script.minDepth) return { ok: false, reason: `depth ${depth} < min ${script.minDepth}` };
        if (script.maxDepth !== null && script.maxDepth !== undefined && script.maxDepth >= 0 && depth > script.maxDepth) return { ok: false, reason: `depth ${depth} > max ${script.maxDepth}` };
    }
    if (!(script.placement ?? []).includes(placement)) return { ok: false, reason: `placement ${PLACEMENT_LABEL[placement] ?? placement} not selected` };
    return { ok: true, reason: '' };
}

/**
 * Apply an ordered script list at one call site, tracing each step.
 * @param {{script: any, scope: string}[]} ordered already in engine order
 */
export function applyAt(ordered, text, site, opts = {}) {
    let cur = text;
    const trace = [];
    for (const { script, scope } of ordered) {
        const el = eligibility(script, site);
        if (!el.ok) { trace.push({ id: script.id, name: script.scriptName, scope, applied: false, reason: el.reason }); continue; }
        const r = runRegexScript(script, cur, opts);
        trace.push({ id: script.id, name: script.scriptName, scope, applied: true, changed: r.output !== cur, matches: r.matches.length, error: r.error, before: cur, after: r.output });
        cur = r.output;
    }
    return { output: cur, trace };
}

/** The call sites a creator cares about, with the options ST passes (engine call-site table). */
export const STAGES = [
    { id: 'user-saved', label: 'User message as saved', note: 'sendMessageAsUser: rewrites the stored chat text', site: { placement: 1 }, from: 'user' },
    { id: 'ai-saved', label: 'AI message as saved', note: 'cleanUpMessage: rewrites the stored chat text', site: { placement: 2 }, from: 'ai' },
    { id: 'user-display', label: 'User message display', note: 'messageFormatting (markdown) at depth', site: { placement: 1, isMarkdown: true }, from: 'user', depth: true },
    { id: 'ai-display', label: 'AI message display', note: 'messageFormatting (markdown) at depth', site: { placement: 2, isMarkdown: true }, from: 'ai', depth: true },
    { id: 'user-prompt', label: 'User message in prompt', note: 'Generate(): chat history sent to the model', site: { placement: 1, isPrompt: true }, from: 'user', depth: true },
    { id: 'ai-prompt', label: 'AI message in prompt', note: 'Generate(): chat history sent to the model', site: { placement: 2, isPrompt: true }, from: 'ai', depth: true },
    { id: 'ai-edit', label: 'AI message after manual edit', note: 'updateMessage with isEdit', site: { placement: 2, isEdit: true }, from: 'ai' },
    { id: 'wi-prompt', label: 'World Info content', note: 'Only prompt-only scripts apply', site: { placement: 5, isPrompt: true, isMarkdown: false }, from: 'wi' },
    { id: 'reasoning-display', label: 'Reasoning display', note: '', site: { placement: 6, isMarkdown: true }, from: 'reasoning' },
    { id: 'slash', label: 'Slash command output', note: '/sendas, /sys, /ask…', site: { placement: 3 }, from: 'slash' },
];

/**
 * Run a fixture through every stage.
 * The "saved" stages feed display/prompt stages (ST stores the rewritten text, then formats it).
 */
export function stageMatrix(ordered, fixture, { depth = 0, macros } = {}) {
    const opts = { macros: macros ?? makeMacros() };
    const out = {};
    const savedUser = applyAt(ordered, fixture.user ?? '', STAGES[0].site, opts);
    const savedAi = applyAt(ordered, fixture.ai ?? '', STAGES[1].site, opts);
    out['user-saved'] = savedUser;
    out['ai-saved'] = savedAi;
    for (const st of STAGES.slice(2)) {
        const src = st.from === 'user' ? savedUser.output : st.from === 'ai' ? savedAi.output : st.from === 'wi' ? fixture.wi ?? '' : st.from === 'reasoning' ? fixture.reasoning ?? '' : fixture.slash ?? '';
        out[st.id] = applyAt(ordered, src, { ...st.site, depth: st.depth ? depth : undefined }, opts);
    }
    return out;
}

/**
 * Lint a script list.
 * @returns {{level: 'error'|'warn'|'info', id: string, path: string, message: string}[]}
 */
export function lintScripts(list) {
    const issues = [];
    const add = (level, s, message) => issues.push({ level, id: s.id, path: s.scriptName || s.id, message });
    const names = new Map();
    for (const { script: s } of list) {
        if (!String(s.scriptName ?? '').trim()) add('error', s, 'Script name is required (ST refuses to save without one).');
        names.set(s.scriptName, (names.get(s.scriptName) ?? 0) + 1);
        if (!s.findRegex) { add('warn', s, 'Empty find regex: the script does nothing.'); continue; }
        const src = Number(s.substituteRegex) ? s.findRegex.replace(/\{\{[^}]+\}\}/g, 'x') : s.findRegex;
        const m = src.match(/^\/(.+)\/([a-z]*)$/is);
        if (m) {
            if (m[2] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[2])) add('error', s, `Flags "${m[2]}" are not accepted by ST (allowed: gmixXsuUAJ, no duplicates); the whole string is then treated as a pattern.`);
            try { new RegExp(m[1], m[2].replace(/[xXUAJ]/g, '')); } catch (e) { add('error', s, `Invalid regex: ${e.message}`); }
            if (!m[2].includes('g')) add('info', s, 'No g flag: only the first match is replaced.');
            if (/(\([^)]*[+*][^)]*\)[+*])|(\.\*){2,}/.test(m[1])) add('warn', s, 'Nested or repeated quantifiers can backtrack catastrophically on long messages.');
        } else {
            add('info', s, 'Bare pattern (no /…/flags): compiled without flags, so only the first match is replaced and matching is case-sensitive.');
            try { new RegExp(src); } catch (e) { add('error', s, `Invalid regex: ${e.message}`); }
        }
        if (/\$[&`'$]/.test(s.replaceString ?? '')) add('warn', s, "Replacement uses $&, $`, $' or $$: ST uses a function replacer, so these are output literally. Use {{match}} or $0 instead.");
        if (!(s.placement ?? []).length) add('warn', s, 'No placement selected: the script never runs.');
        if (!s.markdownOnly && !s.promptOnly) add('info', s, 'Neither “Alter Chat Display” nor “Alter Outgoing Prompt”: the script permanently rewrites stored chat messages.');
        if (s.markdownOnly && s.promptOnly) add('info', s, 'Both display and prompt: stored text is unchanged; display and prompt are altered.');
        if ((s.placement ?? []).includes(5) && !s.promptOnly) add('warn', s, 'World Info placement only applies to prompt-only scripts.');
        if (s.minDepth != null && s.maxDepth != null && s.minDepth > s.maxDepth && s.maxDepth >= 0) add('error', s, `Min depth ${s.minDepth} > max depth ${s.maxDepth}: never runs.`);
        if ((s.trimStrings ?? []).length && !/\$\d|\$</.test(s.replaceString ?? '') && !/{{match}}/i.test(s.replaceString ?? '')) add('info', s, 'Trim strings only apply to inserted capture groups/{{match}}, which this replacement does not use.');
        if ((s.placement ?? []).some(p => p === 0 || p === 4)) add('warn', s, 'Legacy placement value (0 or 4); ST migrates these for global scripts only.');
    }
    for (const [n, c] of names) if (c > 1 && n) issues.push({ level: 'warn', id: '', path: n, message: `${c} scripts share the name "${n}"; /regex name=… picks the first.` });
    return issues;
}

/**
 * Order sensitivity: scripts whose relative order changes the result on the given fixtures.
 * @returns {{a: string, b: string, stage: string}[]}
 */
export function orderConflicts(ordered, fixtures, stageIds = ['ai-display', 'ai-prompt', 'ai-saved']) {
    const conflicts = [];
    const opts = { macros: makeMacros() };
    for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
            for (const st of STAGES.filter(s => stageIds.includes(s.id))) {
                for (const f of fixtures) {
                    const text = st.from === 'user' ? f.user : f.ai;
                    if (!text) continue;
                    const ab = applyAt([ordered[i], ordered[j]], text, st.site, opts).output;
                    const ba = applyAt([ordered[j], ordered[i]], text, st.site, opts).output;
                    if (ab !== ba) {
                        conflicts.push({ a: ordered[i].script.scriptName, b: ordered[j].script.scriptName, stage: st.label });
                        break;
                    }
                }
            }
        }
    }
    return conflicts.filter((c, i, arr) => arr.findIndex(x => x.a === c.a && x.b === c.b) === i);
}

/** Parse an import file (single object or array); always assigns new ids like ST. */
export function parseRegexImport(json) {
    const list = Array.isArray(json) ? json : [json];
    return list.filter(s => s && typeof s === 'object' && s.scriptName).map(s => ({ ...defaultScript(), ...s, id: uuid() }));
}
