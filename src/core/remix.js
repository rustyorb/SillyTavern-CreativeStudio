// Rules and measurable requirements for a new character inspired by two existing cards.
export const REMIX_FIELDS = {
    name: 'Name', description: 'Description', personality: 'Personality', scenario: 'Scenario',
    first_mes: 'First message', mes_example: 'Example dialogue', alternate_greetings: 'Alternate greetings (each)',
    group_only_greetings: 'Group-only greetings (each)', nickname: 'Nickname', creator_notes: 'Creator notes',
    system_prompt: 'System prompt', post_history_instructions: 'Post-history instructions',
};
export const DEFAULT_MINIMUMS = Object.fromEntries(Object.keys(REMIX_FIELDS).map(k => [k, ({ description: 150, personality: 80, scenario: 80, first_mes: 120, mes_example: 100 })[k] ?? 0]));
export const REQUIRED_REMIX_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
export const LIST_FIELDS = ['alternate_greetings', 'group_only_greetings'];

/** Only explicit numeric ages. Ambiguous ranges and multiple different ages need the author's input. */
export function detectAge(text = '') {
    const s = String(text);
    if (/(?:age\s*[:=]?\s*|\b)\d+\s*(?:[-–—/]\s*|to\s+)\d+(?:\s*years?|\b)/i.test(s)) return null;
    const ages = new Set([...s.matchAll(/\bage\s*[:=]\s*(\d+)\b|\b(\d+)[ -]years?[ -]old\b/gi)].map(m => Number(m[1] ?? m[2])));
    return ages.size === 1 ? [...ages][0] : null;
}

export function sourceFacts(character) {
    const text = character?.card?.data?.description ?? '';
    const labelled = label => text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:=]\\s*([^\\n;]+)`, 'i'))?.[1]?.trim() ?? '';
    return { age: detectAge(text), species: labelled('species'), gender: labelled('gender') };
}

export function resolveLocks(options = {}) {
    const locks = {};
    for (const field of ['age', 'species', 'gender']) {
        const rule = options[field] ?? { mode: 'ai' };
        if (!rule.mode || rule.mode === 'ai') continue;
        if (!['a', 'b', 'custom', ...(field === 'age' ? ['average'] : [])].includes(rule.mode)) throw new Error(`Choose a valid ${field} rule.`);
        const age = value => {
            if (value === '' || value == null || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error('Enter a whole-number age for each source used by the age rule.');
            return Number(value);
        };
        if (field === 'age') locks.age = rule.mode === 'average' ? Math.round((age(rule.a) + age(rule.b)) / 2) : age(rule.mode === 'custom' ? rule.value : rule[rule.mode]);
        else {
            const value = String(rule.mode === 'custom' ? rule.value ?? '' : rule[rule.mode] ?? '').trim();
            if (!value) throw new Error(`Enter the ${field} to lock, or choose Let AI choose.`);
            locks[field] = value;
        }
    }
    return locks;
}

export function normalizeMinimums(values = {}) {
    return Object.fromEntries(Object.keys(REMIX_FIELDS).map(field => {
        const n = Number(values[field] ?? DEFAULT_MINIMUMS[field]);
        if (!Number.isInteger(n) || n < 0 || n > 5000) throw new Error(`${REMIX_FIELDS[field]} minimum must be a whole number from 0 to 5000 words.`);
        return [field, n];
    }));
}

/** Count written words, excluding card macros, dialogue markers and punctuation-only tokens. */
export function wordCount(value) {
    const text = String(value ?? '').replace(/<START>|\{\{[^}]+\}\}/gi, ' ');
    return (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

export function minimumReport(fields, minimums) {
    return Object.entries(REMIX_FIELDS).flatMap(([field, label]) => {
        const minimum = minimums[field] ?? 0;
        const values = LIST_FIELDS.includes(field) ? (fields[field]?.length ? fields[field] : ['']) : [fields[field]];
        return values.map((value, index) => ({ field, label: LIST_FIELDS.includes(field) ? `${label} — ${index + 1}` : label, index,
            minimum, actual: wordCount(value), short: wordCount(value) < minimum }));
    });
}

export function ageConflict(description, locks) {
    if (locks.age == null) return false;
    const text = String(description ?? '');
    const ages = [...text.matchAll(/\bage\s*[:=]\s*(\d+)\b|\b(\d+)[ -]years?[ -]old\b/gi)].map(m => Number(m[1] ?? m[2]));
    return ages.some(n => n !== locks.age);
}

export function lockedFactsText(locks = {}) {
    return Object.entries(locks).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`).join('\n');
}
