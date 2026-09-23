// Bring SillyTavern characters into the studio with what belongs to them: the card and avatar, the lorebook the
// character is linked to, and its expression sprites. The studio works on a copy; SillyTavern changes only when
// the author applies it (Export & SillyTavern tab, or Project → Apply to SillyTavern); the previous version is backed up.
import { html, useState, useMemo, Icon, Badge, Empty, Modal, cx } from './kit.js';
import { listStCharacters, exportStCharacterPng, getStWorld, listStWorlds, stSpriteFolder, listStSprites } from '../st/live.js';
import { importCardFile } from '../core/cardio.js';
import { newCharacter, upsertArtifact, stWorldName } from '../core/project.js';
import { normalizeWorld } from '../core/lorebook.js';
import { pickSprites } from '../core/sprites.js';
import { uid } from '../core/bytes.js';
import { saveMedia } from './media.js';

const MAX_SHOWN = 150;

/** Ask the studio shell to open the picker (from an area, the generator or the command palette). */
export function openPullPicker() {
    globalThis.dispatchEvent(new CustomEvent('cs-pull-open'));
}

/** The project character that stands for a SillyTavern character (pulled from it, or created in it). */
export function characterFromSt(project, avatar) {
    return project.characters.find(c => (c.origin?.kind === 'st' ? c.origin.avatar : c.stAvatar) === avatar) ?? null;
}

/** One line for a toast: what came along with the character. */
export function pulledSummary(r) {
    const name = r.character.card.data.name;
    if (r.existing) return `${name} is already in this project; opened it.`;
    const extras = [r.lorebook && `lorebook “${r.lorebook}”`, r.sprites && `${r.sprites} expression sprite${r.sprites === 1 ? '' : 's'}`].filter(Boolean);
    return `Brought in ${name}${extras.length ? ` with ${extras.join(' and ')}` : ''}. ${r.notes.join(' ')}`.trim();
}

/**
 * Copy a SillyTavern character into the project together with its lorebook and sprites (one undo step).
 * A character already in the project is returned as it is, never duplicated.
 * @returns {Promise<{ character: object, existing?: boolean, lorebook: string, sprites: number, notes: string[] }>}
 */
export async function pullStCharacter(store, env, avatar, { onStep = () => {} } = {}) {
    const have = characterFromSt(store.get(), avatar);
    if (have) return { character: have, existing: true, lorebook: '', sprites: 0, notes: [] };
    const notes = [];
    onStep('Reading the card…');
    const png = await exportStCharacterPng(avatar);
    const imported = importCardFile(png, avatar);
    const name = imported.card.data.name;
    const at = new Date().toISOString();
    const art = newCharacter(name, imported.card, {
        topLevelExtras: imported.topLevelExtras,
        origin: { kind: 'st', avatar, format: imported.format, diagnostics: imported.diagnostics, at },
    });
    const media = [];
    const pic = await saveMedia(env, store.get(), png, { name: `${name} avatar`, role: 'avatar' });
    media.push(pic);
    art.avatarMediaId = pic.media.id;
    art.links.media = [pic.media.id];

    // Its lorebook: SillyTavern links a character to a World Info book by name.
    let lorebook = null;
    const worldName = String(imported.card.data.extensions?.world ?? '');
    if (worldName) {
        onStep(`Reading its lorebook “${worldName}”…`);
        const inProject = store.get().lorebooks.find(lb => stWorldName(lb) === worldName);
        if (inProject) art.links.lorebooks = [inProject.id];
        else {
            try {
                if (!(await listStWorlds()).includes(worldName)) throw new Error('it is not in SillyTavern any more');
                const { world } = normalizeWorld(await getStWorld(worldName));
                lorebook = { id: uid('lb'), name: worldName, data: world, origin: { kind: 'st', name: worldName, at } };
                art.links.lorebooks = [lorebook.id];
            } catch (e) {
                notes.push(`Its lorebook “${worldName}” could not be read: ${e.message}.`);
            }
        }
    }

    // Its expression sprites (Character Expressions folder, override respected).
    try {
        const found = Object.entries(pickSprites(await listStSprites(stSpriteFolder(avatar, name))));
        if (found.length) art.sprites = {};
        for (const [i, [label, path]] of found.entries()) {
            onStep(`Copying expression sprites… ${i + 1} of ${found.length}`);
            const res = await fetch(path);
            if (!res.ok) continue;
            const m = await saveMedia(env, store.get(), new Uint8Array(await res.arrayBuffer()), { name: `${name} — ${label}`, role: 'sprite' });
            m.media.label = label;
            media.push(m);
            art.sprites[label] = m.media.id;
        }
    } catch (e) {
        notes.push(`Its sprites could not be read: ${e.message}.`);
    }

    store.update(p => {
        let n = media.reduce((acc, m) => m.apply(acc), p);
        if (lorebook) n = upsertArtifact(n, 'lorebooks', lorebook, { action: 'create', actor: 'import', summary: `Pulled lorebook ${worldName} from SillyTavern` });
        return upsertArtifact(n, 'characters', art, { action: 'create', actor: 'import', summary: `Pulled ${name} from SillyTavern` });
    }, `Pulled ${name} from SillyTavern`);
    return { character: art, lorebook: art.links.lorebooks.length ? worldName : '', sprites: Object.keys(art.sprites ?? {}).length, notes };
}

/** The character library of SillyTavern: the character of the current chat first, then by most recent chat. */
export function StCharacterPicker({ store, env, project, onClose, onDone }) {
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(null); // { avatar, step }
    const list = useMemo(() => {
        let all = [];
        try { all = listStCharacters(); } catch { all = []; }
        return all.sort((a, b) => (b.current - a.current) || (b.lastChat - a.lastChat) || a.name.localeCompare(b.name));
    }, []);
    const needle = q.trim().toLowerCase();
    const matches = list.filter(c => !needle || `${c.name} ${c.tags.join(' ')}`.toLowerCase().includes(needle));
    const pick = async c => {
        if (busy) return;
        setBusy({ avatar: c.avatar, step: 'Starting…' });
        try {
            onDone(await pullStCharacter(store, env, c.avatar, { onStep: step => setBusy({ avatar: c.avatar, step }) }));
        } catch (e) {
            env.toast(`Could not bring in ${c.name}: ${e.message}`, 'error', 8000);
            setBusy(null);
        }
    };
    return html`<${Modal} title="Bring in a character from SillyTavern" onClose=${onClose}>
        <div class="cs-muted cs-small">Its lorebook and expression sprites come along. The studio works on a copy: SillyTavern changes only when you apply it, and its current version is kept as a backup.</div>
        <input class="text_pole" placeholder=${`Search ${list.length} character${list.length === 1 ? '' : 's'} by name or tag…`} value=${q}
            onInput=${e => setQ(e.currentTarget.value)} aria-label="Search characters" />
        ${matches.length ? html`<ul class="cs-pull-list">${matches.slice(0, MAX_SHOWN).map(c => {
            const inProject = !!characterFromSt(project, c.avatar);
            const working = busy?.avatar === c.avatar;
            const sub = working ? busy.step : [c.world && `lorebook: ${c.world}`, c.tags.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
            return html`<li key=${c.avatar}>
                <button type="button" class=${cx('cs-pull-item', working && 'is-busy')} onClick=${() => pick(c)} disabled=${!!busy && !working}
                    title=${inProject ? `Open ${c.name} (already in this project)` : `Bring in ${c.name}`}>
                    <img src=${`/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`} alt="" width="40" height="40" loading="lazy" />
                    <span class="cs-pull-text"><strong>${c.name}</strong>${sub && html`<span class="cs-muted cs-small">${sub}</span>`}</span>
                    ${working ? html`<span class="cs-spin"><${Icon} name="spinner" /></span>`
                        : inProject ? html`<${Badge} kind="ok">in project</${Badge}>`
                        : c.current ? html`<${Badge} kind="accent">current chat</${Badge}>` : c.fav ? html`<${Icon} name="star" />` : ''}
                </button>
            </li>`;
        })}</ul>
        ${matches.length > MAX_SHOWN && html`<div class="cs-muted cs-small">${matches.length - MAX_SHOWN} more: search to narrow the list.</div>`}`
        : html`<${Empty} icon="user" title=${list.length ? 'No character matches' : 'No characters in SillyTavern yet'} />`}
    </${Modal}>`;
}
