// World Info (lorebook) model for SillyTavern 1.19.0: defaults, validation, character_book conversion,
// and an explainable activation simulator that mirrors checkWorldInfo (public/scripts/world-info.js).
// See docs/research/st-formats.md §B for the source-cited behaviour this implements.

import { clone } from './bytes.js';

export const POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };
export const POSITION_LABEL = {
    0: '↑ Before character definitions',
    1: '↓ After character definitions',
    2: "↑ Top of Author's Note",
    3: "↓ Bottom of Author's Note",
    4: '@ At chat depth',
    5: '↑ Before example messages',
    6: '↓ After example messages',
    7: '⇲ Outlet ({{outlet::name}})',
};
export const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const LOGIC_LABEL = { 0: 'AND ANY', 1: 'NOT ALL', 2: 'NOT ANY', 3: 'AND ALL' };
export const ROLE_LABEL = { 0: 'System', 1: 'User', 2: 'Assistant' };
export const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

/** newWorldInfoEntryTemplate (world-info.js:4082-4129) plus characterFilter back-fill. */
export const ENTRY_DEFAULTS = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true,
    selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '',
    groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
    useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
};

/** Shipped default World Info settings (default/content/settings.json) — what a fresh ST uses. */
export const WI_SETTINGS_DEFAULTS = {
    depth: 2, minActivations: 0, minActivationsDepthMax: 0, budget: 25, budgetCap: 0, includeNames: true,
    recursive: true, caseSensitive: false, matchWholeWords: true, useGroupScoring: false, maxRecursionSteps: 0,
};

export function emptyWorld() {
    return { entries: {} };
}

/** Lowest free uid in [0, 1e6), as ST does. */
export function nextUid(world) {
    const used = new Set(Object.keys(world.entries ?? {}).map(Number));
    for (let i = 0; i < 1e6; i++) if (!used.has(i)) return i;
    throw new Error('No free uid');
}

export function newEntry(world, overrides = {}) {
    const uid = nextUid(world);
    return { uid, ...clone(ENTRY_DEFAULTS), displayIndex: uid, ...clone(overrides), uid };
}

/** Add missing fields (like ST's addMissingWorldInfoFields) without touching unknown ones. */
export function normalizeWorld(world) {
    const out = clone(world ?? {});
    const report = [];
    if (Array.isArray(out.entries)) {
        report.push({ level: 'warn', path: 'entries', message: 'entries was an array (character_book shape); converted to a uid-keyed object.' });
        out.entries = Object.fromEntries(out.entries.map((e, i) => [String(e.uid ?? i), { ...e, uid: e.uid ?? i }]));
    }
    out.entries ??= {};
    for (const [k, e] of Object.entries(out.entries)) {
        for (const [f, v] of Object.entries(ENTRY_DEFAULTS)) if (e[f] === undefined) e[f] = clone(v);
        if (e.uid === undefined) e.uid = Number(k);
        if (String(e.uid) !== k) report.push({ level: 'warn', path: `entries.${k}.uid`, message: `uid ${e.uid} does not match its key ${k}` });
        if (e.displayIndex === undefined) e.displayIndex = e.uid;
    }
    return { world: out, report };
}

export function entriesOf(world) {
    return Object.values(world?.entries ?? {}).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
}

/** parseRegexFromString (world-info.js:2901-2926) — returns RegExp or null. */
export function parseRegexKey(input) {
    const match = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export function looksLikeRegexKey(k) {
    return /^\/.+\/[a-z]*$/.test(String(k));
}

function escapeRegex(s) {
    return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** matchKeys (world-info.js:337-366). */
export function matchKey(haystack, needle, entry, settings) {
    const re = parseRegexKey(needle);
    if (re) return re.test(haystack);
    const cs = entry.caseSensitive ?? settings.caseSensitive;
    const h = cs ? haystack : haystack.toLowerCase();
    const n = cs ? needle : needle.toLowerCase();
    const whole = entry.matchWholeWords ?? settings.matchWholeWords;
    if (whole) {
        if (n.split(/\s+/).length > 1) return h.includes(n);
        return new RegExp(`(?:^|\\W)(${escapeRegex(n)})(?:$|\\W)`).test(h);
    }
    return h.includes(n);
}

// ------------------------------------------------------------------------------------ validation

/**
 * Lint a world for common authoring problems.
 * @returns {{level: 'error'|'warn'|'info', path: string, message: string, uid?: number}[]}
 */
export function lintWorld(world) {
    const issues = [];
    const add = (level, uid, message, field = '') => issues.push({ level, uid, path: `#${uid}${field ? `.${field}` : ''}`, message });
    const keyOwners = new Map();
    for (const e of entriesOf(world)) {
        const u = e.uid;
        if (e.disable) continue;
        if (!e.constant && !(e.key ?? []).filter(k => String(k).trim()).length && e.position !== POSITION.outlet) add('warn', u, 'No primary keys and not constant: this entry can never activate (except via decorators or forced activation).', 'key');
        if (!String(e.content ?? '').trim()) add('warn', u, 'Empty content.', 'content');
        for (const k of [...(e.key ?? []), ...(e.keysecondary ?? [])]) {
            if (looksLikeRegexKey(k) && !parseRegexKey(k)) add('error', u, `Key "${k}" looks like a regex but does not parse (unescaped "/" or invalid syntax); it will be matched as plain text.`, 'key');
            if (!looksLikeRegexKey(k) && String(k).trim().length > 0 && String(k).trim().length < 3) add('info', u, `Very short key "${k}" may fire often.`, 'key');
            if (k !== String(k).trim()) add('info', u, `Key "${k}" has surrounding spaces; ST trims keys before matching.`, 'key');
        }
        for (const k of e.key ?? []) {
            const norm = String(k).trim().toLowerCase();
            if (!norm) continue;
            if (!keyOwners.has(norm)) keyOwners.set(norm, []);
            keyOwners.get(norm).push(u);
        }
        if (e.selective && e.keysecondary?.length && !(e.key ?? []).length) add('warn', u, 'Secondary keys without primary keys have no effect.', 'keysecondary');
        if (e.position === POSITION.outlet && !String(e.outletName ?? '').trim()) add('error', u, 'Outlet position without an outlet name is skipped by ST.', 'outletName');
        if (e.position !== POSITION.atDepth && e.depth !== 4 && e.depth != null) add('info', u, `Depth ${e.depth} only matters for position "At chat depth".`, 'depth');
        if (e.useProbability && (e.probability < 0 || e.probability > 100)) add('error', u, 'Probability must be 0–100.', 'probability');
        if (e.useProbability && e.probability === 0) add('warn', u, 'Probability 0: never activates.', 'probability');
        if (e.constant && e.sticky) add('info', u, 'Sticky has no extra effect on a constant entry.', 'sticky');
        if (e.excludeRecursion && e.delayUntilRecursion) add('error', u, 'Exclude-recursion and delay-until-recursion together make the entry unreachable.', 'delayUntilRecursion');
        const decos = String(e.content ?? '').match(/^@@[^\n]*/gm) ?? [];
        for (const d of decos) {
            if (!/^@@(activate|dont_activate)\b/.test(d)) add('warn', u, `Decorator "${d.trim()}" is not supported by SillyTavern 1.19; the line is stripped and ignored.`, 'content');
        }
        if (String(e.content ?? '').length > 4000) add('info', u, 'Long entry: consider splitting so budget is spent only on relevant parts.', 'content');
    }
    for (const [k, uids] of keyOwners) {
        if (uids.length > 2) issues.push({ level: 'info', path: `key:${k}`, message: `Key "${k}" is shared by ${uids.length} entries (#${uids.join(', #')}); they will activate together.` });
    }
    return issues;
}

// ------------------------------------------------------------------------------------ card conversion

/** Card → WI: convertCharacterBook (world-info.js:5617-5674). */
export function characterBookToWorld(book) {
    const out = { entries: {}, originalData: clone(book) };
    (book?.entries ?? []).forEach((entry, index) => {
        const x = entry.extensions ?? {};
        const id = entry.id ?? index;
        out.entries[id] = {
            uid: id,
            key: clone(entry.keys ?? []),
            keysecondary: clone(entry.secondary_keys ?? []),
            comment: entry.comment || '',
            content: entry.content ?? '',
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order ?? 100,
            position: x.position ?? (entry.position === 'before_char' ? POSITION.before : POSITION.after),
            excludeRecursion: x.exclude_recursion ?? false,
            preventRecursion: x.prevent_recursion ?? false,
            delayUntilRecursion: x.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: x.display_index ?? index,
            probability: x.probability ?? 100,
            useProbability: x.useProbability ?? true,
            depth: x.depth ?? 4,
            selectiveLogic: x.selectiveLogic ?? 0,
            outletName: x.outlet_name ?? '',
            group: x.group ?? '',
            groupOverride: x.group_override ?? false,
            groupWeight: x.group_weight ?? 100,
            scanDepth: x.scan_depth ?? null,
            caseSensitive: x.case_sensitive ?? null,
            matchWholeWords: x.match_whole_words ?? null,
            useGroupScoring: x.use_group_scoring ?? null,
            automationId: x.automation_id ?? '',
            role: x.role ?? 0,
            vectorized: x.vectorized ?? false,
            sticky: x.sticky ?? null,
            cooldown: x.cooldown ?? null,
            delay: x.delay ?? null,
            matchPersonaDescription: x.match_persona_description ?? false,
            matchCharacterDescription: x.match_character_description ?? false,
            matchCharacterPersonality: x.match_character_personality ?? false,
            matchCharacterDepthPrompt: x.match_character_depth_prompt ?? false,
            matchScenario: x.match_scenario ?? false,
            matchCreatorNotes: x.match_creator_notes ?? false,
            triggers: x.triggers ?? [],
            ignoreBudget: x.ignore_budget ?? false,
            extensions: clone(x),
        };
    });
    return out;
}

/**
 * WI → card: convertWorldInfoToCharacterBook (characters.js:663-722), with two studio improvements that are
 * spec-conformant and ignored by ST: use_regex reflects whether keys are actually regex, and book-level
 * settings from `bookMeta` are kept (ST would drop them on regeneration anyway).
 */
export function worldToCharacterBook(name, world, bookMeta = {}) {
    const entries = entriesOf(world).map(e => {
        const allKeys = [...(e.key ?? []), ...(e.keysecondary ?? [])];
        return {
            id: e.uid,
            keys: clone(e.key ?? []),
            secondary_keys: clone(e.keysecondary ?? []),
            comment: e.comment ?? '',
            content: e.content ?? '',
            constant: !!e.constant,
            selective: !!e.selective,
            insertion_order: e.order ?? 100,
            enabled: !e.disable,
            position: e.position === 0 ? 'before_char' : 'after_char',
            use_regex: allKeys.length > 0 && allKeys.every(looksLikeRegexKey),
            extensions: {
                ...(e.extensions ?? {}),
                position: e.position,
                exclude_recursion: e.excludeRecursion,
                display_index: e.displayIndex,
                probability: e.probability ?? null,
                useProbability: e.useProbability ?? false,
                depth: e.depth ?? 4,
                selectiveLogic: e.selectiveLogic ?? 0,
                outlet_name: e.outletName ?? '',
                group: e.group ?? '',
                group_override: e.groupOverride ?? false,
                group_weight: e.groupWeight ?? null,
                prevent_recursion: e.preventRecursion ?? false,
                delay_until_recursion: e.delayUntilRecursion ?? false,
                scan_depth: e.scanDepth ?? null,
                match_whole_words: e.matchWholeWords ?? null,
                use_group_scoring: e.useGroupScoring ?? false,
                case_sensitive: e.caseSensitive ?? null,
                automation_id: e.automationId ?? '',
                role: e.role ?? 0,
                vectorized: e.vectorized ?? false,
                sticky: e.sticky ?? null,
                cooldown: e.cooldown ?? null,
                delay: e.delay ?? null,
                match_persona_description: e.matchPersonaDescription ?? false,
                match_character_description: e.matchCharacterDescription ?? false,
                match_character_personality: e.matchCharacterPersonality ?? false,
                match_character_depth_prompt: e.matchCharacterDepthPrompt ?? false,
                match_scenario: e.matchScenario ?? false,
                match_creator_notes: e.matchCreatorNotes ?? false,
                triggers: e.triggers ?? [],
                ignore_budget: e.ignoreBudget ?? false,
            },
        };
    });
    const lost = [];
    for (const e of entriesOf(world)) if (e.characterFilter && (e.characterFilter.names?.length || e.characterFilter.tags?.length)) lost.push(`#${e.uid} character filter`);
    return { book: { name, extensions: {}, ...clone(bookMeta), entries }, lost };
}

// ------------------------------------------------------------------------------------ activation simulator

/**
 * Explainable simulation of one World Info scan.
 * @param {object} p
 * @param {{name: string, world: any}[]} p.books ordered as ST would sort sources (chat, persona, character/global strategy)
 * @param {{name: string, mes: string}[]} p.chat oldest → newest
 * @param {object} [p.settings] WI settings (WI_SETTINGS_DEFAULTS)
 * @param {number} [p.maxContext]
 * @param {(text: string) => number} [p.countTokens]
 * @param {object} [p.scanData] {personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes}
 * @param {string} [p.generationType]
 * @param {'assume'|'roll'} [p.probabilityMode] 'assume' treats probability rolls as successes (deterministic preview)
 * @param {() => number} [p.random]
 * @param {(s: string) => string} [p.macros] macro substitution for keys/content
 * @param {string} [p.characterName] file name without .png, for characterFilter
 */
export function simulateActivation(p) {
    const settings = { ...WI_SETTINGS_DEFAULTS, ...(p.settings ?? {}) };
    const countTokens = p.countTokens ?? (t => Math.ceil(String(t).length / 3.6));
    const macros = p.macros ?? (s => s);
    const random = p.random ?? Math.random;
    const genType = p.generationType ?? 'normal';
    const maxContext = p.maxContext ?? 8192;
    const scan = p.scanData ?? {};
    // newest first, "Name: mes"
    const messages = [...(p.chat ?? [])].reverse().map(m => (settings.includeNames && m.name ? `${m.name}: ${m.mes}` : String(m.mes)).trim());

    let budget = Math.round((settings.budget * maxContext) / 100) || 1;
    if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap;

    const all = [];
    for (const b of p.books ?? []) {
        const sorted = entriesOf(b.world).map(e => ({ ...ENTRY_DEFAULTS, ...e, world: b.name })).sort((a, c) => c.order - a.order);
        all.push(...sorted);
    }

    const log = [];
    const decisions = new Map(); // key world.uid → {status, reasons[]}
    const keyOf = e => `${e.world}.${e.uid}`;
    const note = (e, status, reason, extra = {}) => {
        const k = keyOf(e);
        const prev = decisions.get(k);
        decisions.set(k, { entry: e, status, reason, pass: extra.pass ?? prev?.pass, matched: extra.matched ?? prev?.matched ?? [], secondary: extra.secondary ?? prev?.secondary ?? [], history: [...(prev?.history ?? []), reason] });
    };

    const recurse = [];
    let skew = 0;
    let loop = 0;
    let state = 'initial'; // initial | recursion | minActivations
    const activated = new Map();
    const failedProbability = new Set();
    let allActivatedText = '';
    let overflowed = false;
    const firedGroups = new Set();
    const decorators = e => {
        const lines = String(e.content ?? '').match(/^@@[^\n]*/gm) ?? [];
        return lines.map(l => l.trim());
    };
    const stripDecorators = text => String(text ?? '').replace(/^(?:@@[^\n]*\n?)+/, '');

    const bufferFor = e => {
        const depth = e.scanDepth ?? settings.depth + skew;
        if (depth <= 0) return '';
        let text = '\x01' + messages.slice(0, Math.min(depth, 1000)).join('\n\x01');
        if (e.matchPersonaDescription && scan.personaDescription) text += '\n\x01' + scan.personaDescription;
        if (e.matchCharacterDescription && scan.characterDescription) text += '\n\x01' + scan.characterDescription;
        if (e.matchCharacterPersonality && scan.characterPersonality) text += '\n\x01' + scan.characterPersonality;
        if (e.matchCharacterDepthPrompt && scan.characterDepthPrompt) text += '\n\x01' + scan.characterDepthPrompt;
        if (e.matchScenario && scan.scenario) text += '\n\x01' + scan.scenario;
        if (e.matchCreatorNotes && scan.creatorNotes) text += '\n\x01' + scan.creatorNotes;
        if (recurse.length && state !== 'minActivations') text += '\n\x01' + recurse.join('\n\x01');
        return text;
    };

    const score = (e, buf) => {
        const pk = e.key ?? [];
        if (!pk.length) return 0;
        const ps = pk.filter(k => matchKey(buf, macros(String(k)).trim(), e, settings)).length;
        const sk = e.keysecondary ?? [];
        const ss = sk.filter(k => matchKey(buf, macros(String(k)).trim(), e, settings)).length;
        if (sk.length) {
            if (e.selectiveLogic === LOGIC.AND_ANY) return ps + ss;
            if (e.selectiveLogic === LOGIC.AND_ALL) return ss === sk.length ? ps + ss : ps;
        }
        return ps;
    };

    let keepGoing = true;
    while (keepGoing) {
        loop++;
        if (settings.maxRecursionSteps && loop > settings.maxRecursionSteps) break;
        const candidates = [];
        for (const e of all) {
            const k = keyOf(e);
            if (activated.has(k) || failedProbability.has(k)) continue;
            if (e.disable) { note(e, 'skipped', 'Disabled'); continue; }
            if (e.triggers?.length && !e.triggers.includes(genType)) { note(e, 'skipped', `Generation type "${genType}" not in triggers (${e.triggers.join(', ')})`); continue; }
            const cf = e.characterFilter;
            if (cf && (cf.names?.length || cf.tags?.length) && p.characterName != null) {
                const inNames = (cf.names ?? []).includes(p.characterName);
                if (cf.isExclude ? inNames : !inNames && cf.names?.length) { note(e, 'skipped', 'Filtered out by character filter'); continue; }
            }
            if (e.delay && (p.chat?.length ?? 0) < e.delay) { note(e, 'skipped', `Delay: needs at least ${e.delay} messages (chat has ${p.chat?.length ?? 0})`); continue; }
            const delayLevel = e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion || 0);
            if (delayLevel && state !== 'recursion') { note(e, 'skipped', `Delayed until recursion level ${delayLevel}`); continue; }
            if (e.excludeRecursion && state === 'recursion' && settings.recursive) { note(e, 'skipped', 'Excluded from recursion steps'); continue; }
            const decos = decorators(e);
            if (decos.some(d => /^@@activate\b/.test(d))) { candidates.push(e); note(e, 'candidate', 'Decorator @@activate', { pass: loop }); continue; }
            if (decos.some(d => /^@@dont_activate\b/.test(d))) { note(e, 'skipped', 'Decorator @@dont_activate'); continue; }
            if (e.constant) { candidates.push(e); note(e, 'candidate', 'Constant (always active)', { pass: loop }); continue; }
            const keys = (e.key ?? []).map(k => macros(String(k)).trim()).filter(Boolean);
            if (!keys.length) { note(e, 'skipped', 'No keys'); continue; }
            const buf = bufferFor(e);
            const matched = keys.filter(k => matchKey(buf, k, e, settings));
            if (!matched.length) { note(e, 'miss', `No primary key found in the last ${e.scanDepth ?? settings.depth + skew} message(s)${recurse.length && state !== 'minActivations' ? ' or recursion buffer' : ''}`, { matched: [] }); continue; }
            const sec = (e.keysecondary ?? []).map(k => macros(String(k)).trim()).filter(Boolean);
            if (e.selective && sec.length) {
                const hits = sec.filter(k => matchKey(buf, k, e, settings));
                const logic = e.selectiveLogic ?? 0;
                const ok = logic === LOGIC.AND_ANY ? hits.length > 0
                    : logic === LOGIC.NOT_ALL ? hits.length < sec.length
                        : logic === LOGIC.NOT_ANY ? hits.length === 0
                            : hits.length === sec.length;
                if (!ok) { note(e, 'miss', `Primary matched (${matched.join(', ')}) but secondary logic ${LOGIC_LABEL[logic]} failed (secondary hits: ${hits.join(', ') || 'none'})`, { matched, secondary: hits }); continue; }
                candidates.push(e);
                note(e, 'candidate', `Primary key ${matched.map(m => `"${m}"`).join(', ')} + ${LOGIC_LABEL[logic]} (${hits.join(', ') || 'no secondary hits'})`, { pass: loop, matched, secondary: hits });
                continue;
            }
            candidates.push(e);
            note(e, 'candidate', `Primary key ${matched.map(m => `"${m}"`).join(', ')}${state === 'recursion' ? ' (via recursion)' : ''}`, { pass: loop, matched });
        }

        // Inclusion groups.
        let accepted = [...candidates];
        const groups = new Map();
        for (const e of accepted) for (const g of String(e.group ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(e);
        }
        const removed = new Set();
        for (const [g, members] of groups) {
            if (firedGroups.has(g)) {
                for (const m of members) { removed.add(keyOf(m)); note(m, 'group-lost', `Inclusion group "${g}" already fired earlier in this scan`); }
                continue;
            }
            let pool = members.filter(m => !removed.has(keyOf(m)));
            if (pool.length <= 1) { if (pool.length) firedGroups.add(g); continue; }
            const scoring = settings.useGroupScoring || pool.some(m => m.useGroupScoring);
            if (scoring) {
                const scores = pool.map(m => score(m, bufferFor(m)));
                const max = Math.max(...scores);
                pool.forEach((m, i) => { if (scores[i] < max) { removed.add(keyOf(m)); note(m, 'group-lost', `Group "${g}" scoring: ${scores[i]} < best ${max}`); } });
                pool = pool.filter((_, i) => scores[i] === max);
            }
            const overrides = pool.filter(m => m.groupOverride);
            let winner;
            if (overrides.length) {
                winner = overrides.sort((a, b) => b.order - a.order)[0];
            } else {
                const total = pool.reduce((s, m) => s + (m.groupWeight ?? 100), 0);
                let r = random() * total;
                winner = pool[pool.length - 1];
                for (const m of pool) { r -= m.groupWeight ?? 100; if (r <= 0) { winner = m; break; } }
            }
            for (const m of pool) if (m !== winner) { removed.add(keyOf(m)); note(m, 'group-lost', `Group "${g}": "${winner.comment || `#${winner.uid}`}" won${overrides.length ? ' (override, highest order)' : ' (weighted random)'}`); }
            firedGroups.add(g);
        }
        accepted = accepted.filter(e => !removed.has(keyOf(e)));

        // Probability, budget.
        const newlyActivated = [];
        let accumulated = '';
        for (const e of accepted) {
            const k = keyOf(e);
            if (e.useProbability && e.probability !== 100) {
                const passed = p.probabilityMode === 'roll' ? random() * 100 <= e.probability : true;
                if (!passed) { failedProbability.add(k); note(e, 'probability-failed', `Failed ${e.probability}% probability roll`); continue; }
                if (p.probabilityMode !== 'roll') note(e, 'candidate', `${decisions.get(k)?.reason} · ${e.probability}% chance (assumed success)`);
            }
            const content = macros(stripDecorators(e.content));
            if (overflowed && !e.ignoreBudget) { note(e, 'budget', 'Budget already exhausted'); continue; }
            const tokens = countTokens(allActivatedText + accumulated + '\n' + content);
            if (!e.ignoreBudget && tokens >= budget) {
                overflowed = true;
                note(e, 'budget', `Would exceed the World Info budget (${tokens} ≥ ${budget} tokens)`);
                continue;
            }
            accumulated += '\n' + content;
            activated.set(k, { entry: e, content, pass: loop, state });
            newlyActivated.push(e);
            note(e, 'activated', decisions.get(k)?.reason ?? 'Activated', { pass: loop });
        }
        allActivatedText += accumulated;
        log.push({ loop, state, depth: settings.depth + skew, candidates: candidates.length, activated: newlyActivated.length });

        // Loop control.
        keepGoing = false;
        const recursable = newlyActivated.filter(e => !e.preventRecursion);
        if (settings.recursive && !overflowed && recursable.length) {
            recurse.push(...recursable.map(e => macros(stripDecorators(e.content))));
            state = 'recursion';
            keepGoing = true;
        } else if (settings.minActivations && activated.size < settings.minActivations) {
            skew++;
            const maxDepth = settings.minActivationsDepthMax > 0 ? settings.minActivationsDepthMax : messages.length;
            if (settings.depth + skew <= maxDepth && settings.depth + skew <= messages.length) {
                state = 'minActivations';
                keepGoing = true;
            }
        }
        if (loop > 50) break;
    }

    // Placement: sorted by order desc then unshifted ⇒ each list ascending by order.
    const placed = { 0: [], 1: [], 2: [], 3: [], 5: [], 6: [], 7: {}, 4: {} };
    const acts = [...activated.values()].sort((a, b) => b.entry.order - a.entry.order);
    for (const a of acts) {
        const e = a.entry;
        if (e.position === POSITION.atDepth) {
            const key = `${e.depth ?? 4}:${e.role ?? 0}`;
            (placed[4][key] ??= []).unshift(a);
        } else if (e.position === POSITION.outlet) {
            if (!e.outletName) continue;
            (placed[7][e.outletName] ??= []).unshift(a);
        } else {
            (placed[e.position] ??= []).unshift(a);
        }
    }
    const results = [...decisions.values()].map(d => ({ ...d, content: activated.get(keyOf(d.entry))?.content }));
    return {
        activated: acts.map(a => ({ world: a.entry.world, uid: a.entry.uid, comment: a.entry.comment, pass: a.pass, via: a.state, tokens: countTokens(a.content), position: a.entry.position })),
        results,
        placed,
        budget,
        usedTokens: countTokens(allActivatedText),
        overflowed,
        log,
        settings,
    };
}
