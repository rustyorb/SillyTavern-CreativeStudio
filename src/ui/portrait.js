// Recover a character's existing portrait without generating a new face or changing its card text.
import { findArtifact, upsertArtifact } from '../core/project.js';
import { embeddedPath } from '../core/charx.js';
import { isPng } from '../core/png.js';
import { listStCharacters, getStCharacter, exportStCharacterPng } from '../st/live.js';
import { saveMedia } from './media.js';

const requests = new WeakMap();
const live = { list: listStCharacters, read: getStCharacter, png: exportStCharacterPng };
const filename = value => typeof value === 'string' && /^[^/\\]+\.png$/i.test(value) ? value : '';

/** A legacy PNG/JSON import may lack an ST link. Require matching card content, never just its name. */
export function sameImportedCharacter(character, stored) {
    if (character.origin?.kind !== 'import') return false;
    const original = character.topLevelExtras ?? {};
    const card = character.card.data;
    const source = stored.data ?? stored;
    return ['name', 'description', 'first_mes'].every(field => {
        const value = original[field] ?? card[field];
        return typeof value === 'string' && value.trim().length > 0 && value === source[field];
    });
}

function linkedPortrait(project, character) {
    const icons = (character.card.data.assets ?? []).filter(a => a.type === 'icon');
    const mainIcon = icons.find(a => a.name === 'main') ?? (icons.length === 1 ? icons[0] : null);
    const iconId = mainIcon && character.assetFiles?.[embeddedPath(mainIcon.uri)];
    const icon = iconId && findArtifact(project, 'media', iconId);
    if (icon?.kind === 'image') return icon;
    const portraits = project.media.filter(m => m.kind === 'image' && m.role === 'avatar' && character.links?.media?.includes(m.id));
    return portraits.length === 1 ? portraits[0] : null;
}

async function portraitSource(character, source) {
    const explicit = filename(character.origin?.kind === 'st' && character.origin.avatar) || filename(character.stAvatar)
        || filename(character.portraitSource?.avatar) || filename(character.topLevelExtras?.avatar);
    if (explicit) return explicit;
    if (character.origin?.kind !== 'import') return '';
    const name = character.topLevelExtras?.name ?? character.card.data.name;
    const candidates = (await source.list()).filter(c => c.name === name && filename(c.avatar));
    const matches = [];
    for (const candidate of candidates) {
        if (sameImportedCharacter(character, await source.read(candidate.avatar))) matches.push(candidate.avatar);
    }
    // Identical names or duplicate cards with different pictures are not enough to choose a face.
    return matches.length === 1 ? matches[0] : '';
}

/**
 * One automatic attempt per character per store session (including after Undo), shared by both Pictures views.
 * Explicit Retry can try again. A deliberate picture deletion blocks automatic restoration across reloads.
 */
export function ensureCharacterPortrait(store, env, projectId, characterId, { retry = false, source = live } = {}) {
    let attempts = requests.get(store);
    if (!attempts) requests.set(store, attempts = new Map());
    const key = `${projectId}/${characterId}`;
    const previous = attempts.get(key);
    if (previous && (previous.pending || !retry)) return previous.promise;
    const request = { pending: true, invalidated: false };
    const invalidate = () => {
        request.invalidated = true;
        if (attempts.get(key) === request) attempts.delete(key);
    };
    request.promise = recoverPortrait(store, env, projectId, characterId, source, invalidate)
        .finally(() => { request.pending = false; if (request.invalidated) invalidate(); });
    attempts.set(key, request);
    return request.promise;
}

async function recoverPortrait(store, env, projectId, characterId, source, invalidate) {
    const project = store.get();
    const character = findArtifact(project, 'characters', characterId);
    if (project.id !== projectId || !character || character.portraitAutoLoadBlocked) return null;
    const existing = findArtifact(project, 'media', character.avatarMediaId);
    if (existing) return existing;
    let cancelled = false;
    const eligible = p => p.id === projectId && p.characters.some(c => c.id === characterId
        && c.avatarMediaId === character.avatarMediaId && !c.portraitAutoLoadBlocked);
    // Remember intervening deletion/project changes even if the user returns before the request finishes.
    const unsubscribe = store.subscribe(p => { if (!eligible(p)) { cancelled = true; invalidate(); } });
    try {
        let media = linkedPortrait(project, character);
        let saved;
        let avatar = '';
        if (!media) {
            avatar = await portraitSource(character, source);
            if (!avatar || cancelled) return null;
            const png = await source.png(avatar);
            if (!isPng(png)) throw new Error('SillyTavern did not return a PNG portrait.');
            if (cancelled) return null;
            saved = await saveMedia(env, project, png, { name: `${character.card.data.name} portrait`, role: 'avatar', mime: 'image/png' });
            media = saved.media;
        }
        if (cancelled || !eligible(store.get())) return null;
        // Our own successful attachment changes avatarMediaId; it must not invalidate the completed attempt.
        unsubscribe();
        store.update(p => {
            const current = findArtifact(p, 'characters', characterId);
            return upsertArtifact(saved ? saved.apply(p) : p, 'characters', {
                ...current, avatarMediaId: media.id,
                links: { ...current.links, media: [...new Set([...(current.links?.media ?? []), media.id])] },
                ...(avatar ? { portraitSource: { kind: 'st', avatar, mediaId: media.id } } : {}),
            }, { action: 'edit', summary: 'Loaded existing character portrait' });
        }, 'load existing portrait', { merge: false });
        return media;
    } finally { unsubscribe(); }
}
