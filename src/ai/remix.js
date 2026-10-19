import { emptyCardV3, tidyExamples } from '../core/card.js';
import { newCharacter, upsertArtifact } from '../core/project.js';
import { REMIX_FIELDS, REQUIRED_REMIX_FIELDS, LIST_FIELDS, normalizeMinimums, resolveLocks, minimumReport, ageConflict, lockedFactsText, wordCount } from '../core/remix.js';
import { tidyTags } from './tasks.js';

const cancelled = signal => { if (signal?.aborted) throw new Error('Cancelled. No character was added.'); };
const cleanFields = (raw = {}) => Object.fromEntries(Object.keys(REMIX_FIELDS).filter(k => k in raw).map(k => [k,
    LIST_FIELDS.includes(k) ? (Array.isArray(raw[k]) ? raw[k].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : []) : typeof raw[k] === 'string' ? raw[k].trim() : '',
]));

/** One complete card, followed by at most one expansion per deficient field. No source writes or image jobs. */
export async function generateRemix({ sources, options = {}, runTask, signal, onStatus = () => {} }) {
    if (sources?.length !== 2 || !sources.every(c => c?.id && c.card?.data) || sources[0].id === sources[1].id) throw new Error('Choose two different characters from the library.');
    const originals = structuredClone(sources);
    const minimums = normalizeMinimums(options.minimums);
    const locks = resolveLocks(options);
    const direction = String(options.direction ?? '').trim();
    const args = { sources: originals, minimums, locks, direction };
    const generations = [];
    const warnings = [];
    cancelled(signal);
    onStatus('Creating one complete new character…');
    const first = await runTask('character.remix', { ...args, maxTokens: Math.min(16000, Math.max(6000, Math.ceil(Object.values(minimums).reduce((a, b) => a + b, 0) * 2.5 + 2000))) });
    cancelled(signal);
    if (!first?.value?.fields) throw new Error('The model returned no character. Nothing was added.');
    generations.push(first.generation);
    let fields = cleanFields(first.value.fields);
    const missing = REQUIRED_REMIX_FIELDS.filter(k => !fields[k]);
    if (missing.length) throw new Error(`The generated card is missing ${missing.map(k => REMIX_FIELDS[k]).join(', ')}. Nothing was added; try again.`);
    if (originals.some(c => c.card.data.name.trim().toLowerCase() === fields.name.toLowerCase())) throw new Error('The model reused a source name. Try again for a new identity.');
    fields.mes_example = tidyExamples(fields.mes_example, fields.name);
    const tags = tidyTags(first.value.fields.tags);
    const short = minimumReport(fields, minimums).filter(r => r.short).map(r => r.field);
    if (ageConflict(fields.description, locks)) short.unshift('description');
    for (const field of new Set(short)) {
        cancelled(signal);
        onStatus(`Checking and expanding ${REMIX_FIELDS[field].toLowerCase()}…`);
        try {
            const result = await runTask('character.remix', { ...args, current: { ...fields, tags }, only: [field],
                maxTokens: Math.min(16000, Math.max(2500, Math.ceil(minimums[field] * 2.5 + 1200))) });
            cancelled(signal);
            if (!result?.value?.fields) throw new Error('No expanded text returned.');
            let next = cleanFields(result.value.fields)[field];
            if (LIST_FIELDS.includes(field) && fields[field]?.length && Array.isArray(next)) {
                next = fields[field].map((old, i) => wordCount(old) < minimums[field] && wordCount(next[i]) >= wordCount(old) ? next[i] : old);
            }
            if (next?.length && (field !== 'name' || !originals.some(c => c.card.data.name.trim().toLowerCase() === next.toLowerCase()))) {
                const oldCount = minimumReport(fields, minimums).filter(r => r.field === field).reduce((n, r) => n + r.actual, 0);
                const nextCount = minimumReport({ ...fields, [field]: next }, minimums).filter(r => r.field === field).reduce((n, r) => n + r.actual, 0);
                // Keep useful first output when an attempted expansion shrinks it; age correction takes precedence.
                if (nextCount >= oldCount || (field === 'description' && ageConflict(fields.description, locks) && !ageConflict(next, locks))) fields = { ...fields, [field]: next };
            }
            generations.push(result.generation);
        } catch (e) {
            cancelled(signal);
            warnings.push(`${REMIX_FIELDS[field]} could not be expanded: ${e.message}`);
            // A failed connection should not trigger a series of further requests.
            break;
        }
    }
    cancelled(signal);
    if (ageConflict(fields.description, locks)) throw new Error('The generated description still contradicts the locked age. Nothing was added; try again.');
    fields.mes_example = tidyExamples(fields.mes_example, fields.name);
    // Put chosen facts into the exported card itself, rather than keeping them only in a UI preference.
    const facts = lockedFactsText(locks);
    if (facts) fields.description = `${facts}\n\n${fields.description}`;
    const card = emptyCardV3(fields.name);
    Object.assign(card.data, fields, { tags, creator: 'Creative Studio' });
    const report = minimumReport(card.data, minimums);
    const character = newCharacter(fields.name, card, {
        origin: { kind: 'remix' }, portraitAutoLoadBlocked: true,
        remix: { sources: originals.map(c => ({ id: c.id, name: c.card.data.name })), locks, minimums, direction, warnings, generations },
    });
    return { character, report, warnings };
}

export function saveRemix(store, result, projectId) {
    if (store.get().id !== projectId) throw new Error('The project changed. The new character was not added to another project.');
    store.update(p => upsertArtifact(p, 'characters', result.character, { action: 'create', actor: 'ai',
        summary: `Created ${result.character.card.data.name} from ${result.character.remix?.sources.map(s => s.name).join(' + ') ?? 'two characters'}` }), 'create remixed character', { merge: false });
}
