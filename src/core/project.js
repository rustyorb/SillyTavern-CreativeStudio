// The PROJECT is the studio's first-class object: characters/scenarios, lorebooks, prompt & sampler
// presets, connection-profile references, regex scripts, Quick Reply sets, media, playtests, AI
// proposals, history (provenance) and snapshots. All functions here are pure: they return new objects.

import { clone, uid, stableStringify, hashString } from './bytes.js';
import { emptyCardV3 } from './card.js';
import { getPath, setPath, jsonDiff } from './diff.js';

export const PROJECT_SCHEMA = 'st-creative-studio/project';
export const PROJECT_VERSION = 1;

/** Artifact collections in a project and what they hold. */
export const COLLECTIONS = {
    characters: 'Characters & scenarios (Character Card V3)',
    lorebooks: 'World Info / lorebooks (SillyTavern world format)',
    presets: 'Prompt & sampler presets (Chat Completion, Text Completion, instruct, context, system prompt, reasoning)',
    connectionProfiles: 'Connection profiles (references to presets/APIs, never secrets)',
    regexScripts: 'Regex scripts (global, character-scoped or preset-scoped)',
    qrSets: 'Quick Reply sets and STscript',
    media: 'Images and other media',
};

export function now() {
    return new Date().toISOString();
}

/** @returns {any} a new, empty project */
export function createProject(name = 'Untitled project') {
    const t = now();
    return {
        schema: PROJECT_SCHEMA,
        version: PROJECT_VERSION,
        id: uid('prj'),
        name,
        premise: '',
        notes: '',
        created: t,
        modified: t,
        characters: [],
        lorebooks: [],
        presets: [],
        connectionProfiles: [],
        regexScripts: [],
        qrSets: [],
        media: [],
        playtests: [],
        proposals: [],
        history: [],
        liveBackups: [],
        regexFixtures: [],
        playtestScenarios: [],
        settings: { creationProfileId: '', roleplayProfileId: '' },
    };
}

/** Upgrade/repair a loaded project document, keeping unknown keys. */
export function migrateProject(doc) {
    if (!doc || doc.schema !== PROJECT_SCHEMA) throw new Error('Not a Creative Studio project file');
    const p = clone(doc);
    const base = createProject(p.name);
    for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
    if (p.version > PROJECT_VERSION) p._newerVersionWarning = `Saved by a newer studio (v${p.version}); unknown data is preserved but may not be editable.`;
    return p;
}

/** Find an artifact anywhere in a project. */
export function findArtifact(project, type, id) {
    return project[type]?.find(a => a.id === id) ?? null;
}

/** Log an entry in project history (provenance). */
export function logHistory(project, entry) {
    const last = project.history[project.history.length - 1];
    const full = { id: uid('h'), time: now(), actor: 'user', ...entry };
    // Coalesce a burst of manual edits to the same field (typing) into one history entry.
    if (last && full.action === 'edit' && last.action === 'edit' && full.actor === 'user' && last.actor === 'user'
        && last.path === full.path && last.target?.id === full.target?.id && Date.parse(full.time) - Date.parse(last.time) < 60_000) {
        return { ...project, history: [...project.history.slice(0, -1), { ...last, time: full.time }] };
    }
    const p = { ...project, history: [...project.history, full] };
    // Keep history bounded; snapshots cover long-term restore.
    if (p.history.length > 2000) p.history = p.history.slice(-2000);
    return p;
}

/** Insert or replace an artifact; returns the new project. */
export function upsertArtifact(project, type, artifact, historyEntry) {
    if (!COLLECTIONS[type]) throw new Error(`Unknown artifact type ${type}`);
    const list = project[type];
    const idx = list.findIndex(a => a.id === artifact.id);
    const next = idx >= 0 ? list.map(a => (a.id === artifact.id ? artifact : a)) : [...list, artifact];
    let p = { ...project, [type]: next, modified: now() };
    if (historyEntry) p = logHistory(p, { target: { type, id: artifact.id }, ...historyEntry });
    return p;
}

export function removeArtifact(project, type, id, historyEntry) {
    let p = { ...project, [type]: project[type].filter(a => a.id !== id), modified: now() };
    // Drop links pointing at the removed artifact.
    p.characters = p.characters.map(c => ({
        ...c,
        links: Object.fromEntries(Object.entries(c.links ?? {}).map(([k, ids]) => [k, (ids ?? []).filter(x => x !== id)])),
    }));
    if (historyEntry) p = logHistory(p, { target: { type, id }, action: 'remove', ...historyEntry });
    return p;
}

/** New character artifact wrapper. */
export function newCharacter(name = 'New character', card = null, extras = {}) {
    return {
        id: uid('chr'),
        kind: 'character', // or 'scenario' (narrator/multi-character scenario card)
        card: card ?? emptyCardV3(name),
        topLevelExtras: {},
        origin: { kind: 'new' },
        avatarMediaId: '',
        links: { lorebooks: [], presets: [], regexScripts: [], qrSets: [], media: [], connectionProfiles: [] },
        ...extras,
    };
}

/** Update a field of an artifact by path with provenance. */
export function editArtifactField(project, type, id, path, value, meta = {}) {
    const art = findArtifact(project, type, id);
    if (!art) throw new Error(`No ${type} ${id}`);
    const before = getPath(art, path);
    if (stableStringify(before) === stableStringify(value)) return project;
    const updated = setPath(clone(art), path, clone(value));
    return upsertArtifact(project, type, updated, { action: 'edit', path, summary: meta.summary ?? `Edited ${path}`, actor: meta.actor ?? 'user', proposalId: meta.proposalId });
}

// ---------------------------------------------------------------------------------------------
// AI proposals: reviewable at field or artifact level, never applied automatically.
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.task task id that produced it (e.g. 'character.rewrite-field')
 * @param {{type: string, id: string|null, path: string|null}} p.target null id = create new artifact
 * @param {any} p.after proposed value (field value, or whole artifact when path is null)
 * @param {string} [p.rationale]
 * @param {string} [p.title]
 * @param {object} [p.generation] {profileId, api, model, preset, promptHash, raw}
 */
export function createProposal(project, { task, target, after, rationale = '', title = '', generation = {}, group = null }) {
    let before;
    if (target.id) {
        const art = findArtifact(project, target.type, target.id);
        before = art ? (target.path ? getPath(art, target.path) : art) : undefined;
    }
    return {
        id: uid('prop'),
        created: now(),
        status: 'pending', // pending | accepted | rejected | superseded
        task,
        title,
        group, // proposals produced together (e.g. several candidates) share a group id
        target: { type: target.type, id: target.id ?? null, path: target.path ?? null },
        before: clone(before),
        after: clone(after),
        rationale,
        generation: { ...generation, promptHash: generation.promptHash ?? (generation.prompt ? hashString(generation.prompt) : undefined) },
        consequences: [],
    };
}

export function addProposals(project, proposals) {
    return { ...project, proposals: [...project.proposals, ...proposals], modified: now() };
}

/** Did the target change since the proposal was generated? (stale proposal detection) */
export function isProposalStale(project, proposal) {
    if (!proposal.target.id) return false;
    const art = findArtifact(project, proposal.target.type, proposal.target.id);
    if (!art) return true;
    const current = proposal.target.path ? getPath(art, proposal.target.path) : art;
    return stableStringify(current) !== stableStringify(proposal.before);
}

/**
 * Accept a proposal, optionally with the user's revised value.
 * @returns {any} new project
 */
export function acceptProposal(project, proposalId, revisedValue) {
    const prop = project.proposals.find(x => x.id === proposalId);
    if (!prop) throw new Error('Unknown proposal');
    if (prop.status !== 'pending') throw new Error(`Proposal is already ${prop.status}`);
    const value = revisedValue === undefined ? prop.after : revisedValue;
    const revised = revisedValue !== undefined && stableStringify(revisedValue) !== stableStringify(prop.after);
    let p = project;
    const summary = `${revised ? 'Accepted (revised)' : 'Accepted'} AI proposal: ${prop.title || prop.task}`;
    if (!prop.target.id) {
        const artifact = { ...clone(value), id: value?.id ?? uid(prop.target.type.slice(0, 3)) };
        p = upsertArtifact(p, prop.target.type, artifact, { action: 'create', actor: 'ai', summary, proposalId });
    } else if (prop.target.path) {
        p = editArtifactField(p, prop.target.type, prop.target.id, prop.target.path, value, { actor: 'ai', summary, proposalId });
    } else {
        p = upsertArtifact(p, prop.target.type, { ...clone(value), id: prop.target.id }, { action: 'replace', actor: 'ai', summary, proposalId });
    }
    // Alternatives for the same field are superseded; "create" candidates (several concepts) stay open.
    const siblingsSuperseded = prop.group && prop.target.id
        ? p.proposals.map(x => (x.group === prop.group && x.id !== prop.id && x.status === 'pending' && sameTarget(x, prop) ? { ...x, status: 'superseded', decided: now() } : x))
        : p.proposals;
    return {
        ...p,
        proposals: siblingsSuperseded.map(x => (x.id === proposalId ? { ...x, status: 'accepted', decided: now(), revised, finalValue: revised ? clone(value) : undefined } : x)),
    };
}

function sameTarget(a, b) {
    return a.target.type === b.target.type && a.target.id === b.target.id && a.target.path === b.target.path;
}

export function rejectProposal(project, proposalId, reason = '') {
    return {
        ...project,
        proposals: project.proposals.map(x => (x.id === proposalId ? { ...x, status: 'rejected', decided: now(), reason } : x)),
    };
}

/** Field-level diff of a proposal (for the review UI). */
export function proposalDiff(proposal) {
    return jsonDiff(proposal.before, proposal.after, proposal.target.path ?? '');
}

// ---------------------------------------------------------------------------------------------
// Snapshots: whole-project restore points (stored separately by the storage layer).
// ---------------------------------------------------------------------------------------------

export function makeSnapshot(project, label = '', kind = 'manual') {
    const { proposals, history, ...content } = project;
    return { id: uid('snap'), projectId: project.id, time: now(), label, kind, hash: hashString(stableStringify(content)), project: clone(project) };
}

/** Restore a snapshot, recording the restore in history (history itself is kept, not rolled back). */
export function restoreSnapshot(current, snapshot) {
    const restored = clone(snapshot.project);
    restored.history = current.history;
    restored.proposals = current.proposals;
    return logHistory({ ...restored, modified: now() }, { action: 'restore', summary: `Restored snapshot "${snapshot.label || snapshot.time}"` });
}

// ---------------------------------------------------------------------------------------------
// Dependencies and manifest
// ---------------------------------------------------------------------------------------------

/**
 * Compute what a roleplay setup expects, per character.
 * @returns {{ characterId: string, name: string, needs: {type: string, id: string, name: string, how: string}[], missing: string[] }[]}
 */
export function dependencyReport(project) {
    const byId = (type, id) => findArtifact(project, type, id);
    return project.characters.map(c => {
        const needs = [];
        const missing = [];
        const links = c.links ?? {};
        for (const [type, ids] of Object.entries(links)) {
            for (const id of ids ?? []) {
                const a = byId(type, id);
                if (!a) missing.push(`${type}:${id}`);
                else needs.push({ type, id, name: artifactName(type, a), how: installHint(type, a) });
            }
        }
        if (c.card?.data?.character_book?.entries?.length) needs.push({ type: 'embedded', id: `${c.id}:book`, name: c.card.data.character_book.name || 'Embedded lorebook', how: 'Travels inside the card; SillyTavern offers to import it on character import.' });
        const scoped = project.regexScripts.filter(r => r.scope === 'character' && r.ownerId === c.id);
        for (const r of scoped) if (!(links.regexScripts ?? []).includes(r.id)) needs.push({ type: 'regexScripts', id: r.id, name: artifactName('regexScripts', r), how: installHint('regexScripts', r) });
        const extNames = Object.keys(c.card?.data?.extensions ?? {}).filter(k => !['talkativeness', 'fav', 'world', 'depth_prompt', 'regex_scripts'].includes(k));
        for (const k of extNames) needs.push({ type: 'extension-data', id: k, name: k, how: 'Card carries data for this extension; the extension must be installed for it to do anything.' });
        return { characterId: c.id, name: c.card?.data?.name ?? '(unnamed)', needs, missing };
    });
}

export function artifactName(type, a) {
    switch (type) {
        case 'characters': return a.card?.data?.name || '(unnamed character)';
        case 'lorebooks': return a.name || '(unnamed lorebook)';
        case 'presets': return `${a.name || '(unnamed preset)'} [${a.kind}]`;
        case 'connectionProfiles': return a.name || a.data?.name || '(profile)';
        case 'regexScripts': return a.script?.scriptName || '(unnamed regex)';
        case 'qrSets': return a.data?.name || a.name || '(QR set)';
        case 'media': return a.name || '(media)';
        default: return a.name || a.id;
    }
}

export function installHint(type, a) {
    switch (type) {
        case 'lorebooks': return 'World Info panel → Import (JSON). Then link it to the character (globe icon) or enable globally.';
        case 'presets': return {
            cc: 'AI Response Configuration (Chat Completion) → Import preset.',
            textgen: 'AI Response Configuration (Text Completion) → Import preset.',
            instruct: 'Advanced Formatting → Instruct Template → Import.',
            context: 'Advanced Formatting → Context Template → Import.',
            sysprompt: 'Advanced Formatting → System Prompt → Import.',
            reasoning: 'Advanced Formatting → Reasoning → Import.',
        }[a.kind] ?? 'Import through the matching preset panel.';
        case 'connectionProfiles': return 'Recreate in Connection Profiles (profiles reference presets by name; API keys are never exported).';
        case 'regexScripts': return a.scope === 'character' ? 'Travels in the card (data.extensions.regex_scripts); SillyTavern asks to allow scoped scripts on first use.'
            : a.scope === 'preset' ? 'Travels inside the Chat Completion preset it is scoped to.' : 'Extensions → Regex → Import script (global).';
        case 'qrSets': return 'Extensions → Quick Reply → Import set (JSON), then enable it globally, per chat or per character.';
        case 'media': return 'Copy into the character gallery or backgrounds as described in the bundle README.';
        default: return '';
    }
}
