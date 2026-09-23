// Character Card V1/V2/V3 model: detection, normalization to V3, validation and export shapes.
// Spec: https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
//
// Round-trip policy: we never rebuild a card from scratch when an original exists. The normalized
// card keeps every unknown key of `data` and `data.extensions`, and unknown top-level keys are kept
// in `topLevelExtras` so an export can put them back (SillyTavern writes V1 mirror fields at top level).

import { clone } from './bytes.js';

export const V3_SPEC = 'chara_card_v3';
export const V2_SPEC = 'chara_card_v2';

/** Fields defined by the V2 spec inside `data`. */
export const V2_DATA_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
    'character_book', 'tags', 'creator', 'character_version', 'extensions',
];

/** Fields added by V3 inside `data`. */
export const V3_ONLY_FIELDS = [
    'assets', 'nickname', 'creator_notes_multilingual', 'source',
    'group_only_greetings', 'creation_date', 'modification_date',
];

/** V1 top-level fields (also mirrored at top level by SillyTavern exports). */
export const V1_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

const STRING_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version'];
const STRING_ARRAY_FIELDS = ['alternate_greetings', 'tags', 'group_only_greetings'];

/**
 * @param {any} obj parsed JSON
 * @returns {'v3'|'v2'|'v1'|'unknown'}
 */
export function detectCardVersion(obj) {
    if (!obj || typeof obj !== 'object') return 'unknown';
    if (obj.spec === V3_SPEC && obj.data && typeof obj.data === 'object') return 'v3';
    if (obj.spec === V2_SPEC && obj.data && typeof obj.data === 'object') return 'v2';
    if (obj.data && typeof obj.data === 'object' && typeof obj.data.name === 'string') return 'v2';
    if (typeof obj.name === 'string' && ('description' in obj || 'first_mes' in obj || 'char_persona' in obj)) return 'v1';
    return 'unknown';
}

/** Empty V3 card with every required field present. */
export function emptyCardV3(name = '') {
    return {
        spec: V3_SPEC,
        spec_version: '3.0',
        data: {
            name,
            description: '',
            tags: [],
            creator: '',
            character_version: '',
            mes_example: '',
            extensions: {},
            system_prompt: '',
            post_history_instructions: '',
            first_mes: '',
            alternate_greetings: [],
            personality: '',
            scenario: '',
            creator_notes: '',
            group_only_greetings: [],
        },
    };
}

/**
 * Normalize any supported card JSON into a V3 card without dropping data.
 * @param {any} input
 * @returns {{ card: any, sourceVersion: string, topLevelExtras: Record<string, any>, report: {level: 'info'|'warn'|'error', path: string, message: string}[] }}
 */
export function normalizeToV3(input) {
    const report = [];
    const sourceVersion = detectCardVersion(input);
    const src = clone(input);
    let card;
    const topLevelExtras = {};

    if (sourceVersion === 'v3' || sourceVersion === 'v2') {
        card = { spec: V3_SPEC, spec_version: sourceVersion === 'v3' ? String(src.spec_version ?? '3.0') : '3.0', data: src.data };
        for (const [k, v] of Object.entries(src)) {
            if (k !== 'spec' && k !== 'spec_version' && k !== 'data') topLevelExtras[k] = v;
        }
        if (sourceVersion === 'v2') report.push({ level: 'info', path: 'spec', message: 'Upgraded from Character Card V2; V3-only fields were initialized empty.' });
        if (sourceVersion === 'v3' && card.spec_version !== '3.0') {
            report.push({ level: 'warn', path: 'spec_version', message: `spec_version "${card.spec_version}" is not "3.0"; treating as V3.` });
        }
    } else if (sourceVersion === 'v1') {
        const data = {};
        for (const k of V1_FIELDS) data[k] = src[k] ?? '';
        if (!src.description && src.char_persona) data.description = src.char_persona;
        card = { spec: V3_SPEC, spec_version: '3.0', data };
        for (const [k, v] of Object.entries(src)) {
            if (!V1_FIELDS.includes(k)) topLevelExtras[k] = v;
        }
        report.push({ level: 'info', path: 'spec', message: 'Upgraded from Character Card V1 (no spec field).' });
    } else {
        throw new Error('Not a recognizable character card (no spec/data or V1 fields).');
    }

    const d = card.data;
    for (const f of STRING_FIELDS) {
        if (d[f] === undefined || d[f] === null) {
            d[f] = '';
        } else if (typeof d[f] !== 'string') {
            report.push({ level: 'warn', path: `data.${f}`, message: `Expected string, got ${typeof d[f]}; converted.` });
            d[f] = String(d[f]);
        }
    }
    for (const f of STRING_ARRAY_FIELDS) {
        if (d[f] === undefined || d[f] === null) {
            d[f] = [];
        } else if (!Array.isArray(d[f])) {
            report.push({ level: 'warn', path: `data.${f}`, message: 'Expected an array of strings; wrapped value.' });
            d[f] = [String(d[f])];
        } else if (d[f].some(x => typeof x !== 'string')) {
            report.push({ level: 'warn', path: `data.${f}`, message: 'Non-string items converted to strings.' });
            d[f] = d[f].map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
        }
    }
    if (!d.extensions || typeof d.extensions !== 'object' || Array.isArray(d.extensions)) {
        if (d.extensions !== undefined) report.push({ level: 'warn', path: 'data.extensions', message: 'extensions was not an object; replaced with {} (old value kept under extensions._invalid).' });
        const old = d.extensions;
        d.extensions = {};
        if (old !== undefined) d.extensions._invalid = old;
    }
    return { card, sourceVersion, topLevelExtras, report };
}

/**
 * Validate a V3 card against the specification (not against SillyTavern support).
 * @returns {{level: 'error'|'warn'|'info', path: string, message: string}[]}
 */
export function validateCardV3(card) {
    const issues = [];
    const add = (level, path, message) => issues.push({ level, path, message });
    if (card?.spec !== V3_SPEC) add('error', 'spec', `spec must be "${V3_SPEC}"`);
    if (card?.spec_version !== '3.0') add('warn', 'spec_version', 'spec_version should be "3.0"');
    const d = card?.data;
    if (!d || typeof d !== 'object') {
        add('error', 'data', 'data object is missing');
        return issues;
    }
    for (const f of STRING_FIELDS) if (typeof d[f] !== 'string') add('error', `data.${f}`, 'required string field missing or not a string');
    for (const f of STRING_ARRAY_FIELDS) if (!Array.isArray(d[f])) add('error', `data.${f}`, 'required array field missing');
    if (!d.name?.trim()) add('warn', 'data.name', 'name is empty');
    if (!d.first_mes?.trim() && !(d.alternate_greetings?.length)) add('warn', 'data.first_mes', 'no greeting at all');
    if (d.nickname !== undefined && typeof d.nickname !== 'string') add('error', 'data.nickname', 'nickname must be a string');
    if (d.source !== undefined && (!Array.isArray(d.source) || d.source.some(s => typeof s !== 'string'))) add('error', 'data.source', 'source must be an array of strings');
    for (const f of ['creation_date', 'modification_date']) {
        if (d[f] === undefined) continue;
        if (typeof d[f] !== 'number' || !Number.isFinite(d[f])) add('error', `data.${f}`, 'must be a Unix timestamp in seconds (number)');
        else if (d[f] > 1e11) add('warn', `data.${f}`, 'looks like milliseconds; the spec uses seconds');
    }
    if (d.creator_notes_multilingual !== undefined) {
        const m = d.creator_notes_multilingual;
        if (!m || typeof m !== 'object' || Array.isArray(m) || Object.values(m).some(v => typeof v !== 'string')) {
            add('error', 'data.creator_notes_multilingual', 'must map ISO 639-1 codes to strings');
        } else {
            for (const k of Object.keys(m)) if (!/^[a-z]{2}$/.test(k)) add('warn', `data.creator_notes_multilingual.${k}`, 'key should be an ISO 639-1 two-letter code');
        }
    }
    if (d.assets !== undefined) {
        if (!Array.isArray(d.assets)) add('error', 'data.assets', 'assets must be an array');
        else {
            let mainIcons = 0;
            let mainBgs = 0;
            d.assets.forEach((a, i) => {
                const p = `data.assets[${i}]`;
                for (const f of ['type', 'uri', 'name', 'ext']) if (typeof a?.[f] !== 'string') add('error', `${p}.${f}`, 'required string');
                if (a?.type === 'icon' && a?.name === 'main') mainIcons++;
                if (a?.type === 'background' && a?.name === 'main') mainBgs++;
                if (typeof a?.ext === 'string' && a.ext !== a.ext.toLowerCase()) add('warn', `${p}.ext`, 'ext should be lowercase');
                if (typeof a?.uri === 'string' && !/^(https?:|data:|embeded:\/\/|embedded:\/\/|ccdefault:)/.test(a.uri)) add('warn', `${p}.uri`, 'URI scheme not recognized by the spec');
                if (typeof a?.uri === 'string' && a.uri.startsWith('embedded://')) add('info', `${p}.uri`, 'The V3 spec spells the scheme "embeded://" (single d); some apps also accept "embedded://".');
            });
            if (mainIcons > 1) add('error', 'data.assets', 'only one icon asset may be named "main"');
            if (mainBgs > 1) add('error', 'data.assets', 'only one background asset may be named "main"');
        }
    }
    if (d.character_book !== undefined) {
        const b = d.character_book;
        if (!b || typeof b !== 'object' || !Array.isArray(b.entries)) add('error', 'data.character_book', 'character_book must have an entries array');
        else {
            b.entries.forEach((e, i) => {
                const p = `data.character_book.entries[${i}]`;
                if (!Array.isArray(e?.keys)) add('error', `${p}.keys`, 'keys must be an array of strings');
                if (typeof e?.content !== 'string') add('error', `${p}.content`, 'content must be a string');
                if (typeof e?.enabled !== 'boolean') add('warn', `${p}.enabled`, 'enabled should be a boolean');
                if (typeof e?.insertion_order !== 'number') add('warn', `${p}.insertion_order`, 'insertion_order should be a number');
                if (e?.use_regex !== undefined && typeof e.use_regex !== 'boolean') add('error', `${p}.use_regex`, 'use_regex must be a boolean');
                if (e?.use_regex === undefined) add('info', `${p}.use_regex`, 'use_regex is required in V3 (defaults to false on export)');
                if (e?.position !== undefined && e.position !== 'before_char' && e.position !== 'after_char') add('warn', `${p}.position`, 'position must be "before_char" or "after_char"');
            });
        }
    }
    return issues;
}

/** Remove keys whose value is undefined (JSON would drop them anyway). */
function prune(obj) {
    for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
    return obj;
}

/**
 * Build a strict V3 card for export (spec-conformant JSON / ccv3 chunk / CHARX card.json).
 * Unknown data keys and extensions are preserved.
 */
export function toSpecV3(card) {
    const out = clone(card);
    out.spec = V3_SPEC;
    out.spec_version = '3.0';
    const d = out.data;
    if (d.character_book?.entries) {
        for (const e of d.character_book.entries) {
            if (e.use_regex === undefined) e.use_regex = false;
            if (!e.extensions) e.extensions = {};
        }
        if (!d.character_book.extensions) d.character_book.extensions = {};
    }
    return prune(out);
}

/**
 * Build a V2 card (for the legacy 'chara' PNG chunk). V3-only fields are dropped from `data`
 * and reported as lossy for V2-only readers.
 * @returns {{ card: any, dropped: string[] }}
 */
export function toSpecV2(card) {
    const src = clone(card.data);
    const data = {};
    const dropped = [];
    for (const [k, v] of Object.entries(src)) {
        if (V3_ONLY_FIELDS.includes(k)) {
            const empty = v === undefined || (Array.isArray(v) && v.length === 0);
            if (!empty) dropped.push(k);
            continue;
        }
        data[k] = v;
    }
    if (data.character_book?.entries) {
        for (const e of data.character_book.entries) {
            if (e.use_regex !== undefined) {
                if (e.use_regex) dropped.push('character_book.entries[].use_regex');
                delete e.use_regex;
            }
        }
    }
    return { card: { spec: V2_SPEC, spec_version: '2.0', data }, dropped: [...new Set(dropped)] };
}

/**
 * SillyTavern-flavoured export object: V2-shaped JSON plus V1 mirror fields at top level,
 * which is what SillyTavern 1.19.0 itself writes to both the 'chara' and 'ccv3' chunks.
 * Top-level extras from the original file are restored first so nothing is dropped.
 */
export function toSillyTavernShape(card, topLevelExtras = {}) {
    const { card: v2 } = toSpecV2(card);
    // ST keeps V3 keys inside data when present (it stores whatever JSON it was given), so keep them.
    for (const k of V3_ONLY_FIELDS) if (card.data[k] !== undefined) v2.data[k] = clone(card.data[k]);
    if (card.data.character_book !== undefined) v2.data.character_book = clone(card.data.character_book);
    const out = { ...clone(topLevelExtras) };
    for (const k of V1_FIELDS) out[k] = v2.data[k] ?? '';
    out.tags = clone(v2.data.tags ?? []);
    out.spec = V2_SPEC;
    out.spec_version = '2.0';
    out.data = v2.data;
    return out;
}

/** Word/character statistics used by the workshop to warn about oversized fields. */
export function fieldStats(text) {
    const s = String(text ?? '');
    return { chars: s.length, words: s.trim() ? s.trim().split(/\s+/).length : 0, lines: s ? s.split('\n').length : 0 };
}

/** Parse a mes_example block into individual example dialogues (split on <START>). */
export function splitExamples(mesExample) {
    const text = String(mesExample ?? '');
    if (!text.trim()) return [];
    return text.split(/<START>/i).map(s => s.trim()).filter(Boolean);
}

/** Inverse of splitExamples. */
export function joinExamples(examples) {
    return examples.filter(e => e.trim()).map(e => `<START>\n${e.trim()}`).join('\n');
}
