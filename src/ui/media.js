// Media helpers (browser only): store images in project media, convert to PNG for card export.
import { uid } from '../core/bytes.js';
import { isPng } from '../core/png.js';
import { upsertArtifact, editArtifactField, setSprite } from '../core/project.js';
import { pictureTarget } from '../core/pictures.js';

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

export function sniffImageMime(bytes) {
    if (isPng(bytes)) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    return 'application/octet-stream';
}

/** Convert any browser-decodable image to PNG bytes (card chunks can only live in PNG). */
export async function toPngBytes(bytes) {
    if (isPng(bytes)) return bytes;
    const blob = new Blob([bytes], { type: sniffImageMime(bytes) });
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const out = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return new Uint8Array(await out.arrayBuffer());
}

/**
 * Save bytes as a project media artifact (file lives in ST user files). Returns [nextProjectFn, media].
 * The caller applies the returned updater via store.update so it is undoable.
 */
export async function saveMedia(env, project, bytes, { name = 'image', role = 'image', mime } = {}) {
    const m = mime ?? sniffImageMime(bytes);
    const id = uid('med');
    const ext = EXT_BY_MIME[m] ?? 'bin';
    const url = `/${(await env.storage.saveMedia(project.id, id, ext, bytes)).replace(/^\//, '')}`;
    const media = { id, name, kind: m.startsWith('image/') ? 'image' : 'file', mime: m, url, role, size: bytes.length, created: new Date().toISOString() };
    return { media, apply: p => upsertArtifact(p, 'media', media, { action: 'create', summary: `Added media ${name}` }) };
}

export async function mediaBytes(env, media) {
    return env.storage.loadMediaBytes(media.url);
}

/** Keep async image results attached to their original project and character, including during file saves. */
export async function saveCharacterPicture(env, store, projectId, characterId, bytes, { purpose, prompt, seed, label, referenceMediaId, method } = {}) {
    const character = pictureTarget(store.get(), projectId, characterId);
    const { media, apply } = await saveMedia(env, store.get(), bytes, {
        name: `${character.card.data.name} — ${label ?? purpose}`, role: label ? 'sprite' : 'generated',
    });
    Object.assign(media, { purpose, prompt, seed, ...(label ? { label, referenceMediaId, method } : {}) });
    pictureTarget(store.get(), projectId, characterId);
    store.update(p => {
        const current = pictureTarget(p, projectId, characterId);
        let next = apply(p);
        if (label) return setSprite(next, characterId, label, media.id, { actor: 'ai', summary: `Generated ${label} expression` });
        next = editArtifactField(next, 'characters', characterId, 'links.media', [...new Set([...(current.links?.media ?? []), media.id])], { actor: 'ai', summary: `Generated ${purpose}` });
        if (/avatar|portrait/i.test(purpose) && !current.avatarMediaId) next = editArtifactField(next, 'characters', characterId, 'avatarMediaId', media.id, { actor: 'ai', summary: 'First generated portrait set as avatar' });
        return next;
    }, label ? 'generate expression' : 'generate picture', { merge: false });
    return media;
}
