// One picture of the project: what it is, which characters show it, and removing it from every place at once.
import { html, useState, Button, Icon, Section, Empty, cx } from '../kit.js';
import { findArtifact, mediaUsage, unusedMedia, removeMedia } from '../../core/project.js';
import { workingCharacter } from '../../core/pictures.js';
import { CharacterPictures } from '../character-pictures.js';

const HOW = { avatar: 'avatar', gallery: 'gallery picture' };
const ORIGIN = { avatar: 'Portrait', generated: 'Generated in the studio', sprite: 'Expression sprite', 'charx-asset': 'File from a CHARX card', image: 'Added picture' };

/** "avatar", "sprite: joy", "CHARX file assets/…": how one character uses the picture. */
export const usageLabel = u => (u.how === 'sprite' ? `sprite: ${u.label}` : u.how === 'asset' ? `CHARX file ${u.path}` : HOW[u.how]);

const size = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n ?? 0) / 1024))} KB`);

export function PicturesArea(props) {
    const { project, selection, setSelection, select, setArea } = props;
    const ch = workingCharacter(project);
    if (selection?.type === 'media' && findArtifact(project, 'media', selection.id)) return html`<${MediaView} ...${props} />`;
    if (selection?.type === 'picture-library') return html`<${PictureLibrary} ...${props} />`;
    const avatar = ch && findArtifact(project, 'media', ch.avatarMediaId);
    return html`<div class="cs-area-head"><h3><${Icon} name="images" /> Pictures</h3><div class="cs-spacer"></div>
        <${Button} icon="folder-open" label="Project picture library" onClick=${() => setSelection({ type: 'picture-library' })} /></div>
        <div class="cs-area-body">
            ${ch ? html`<div class="cs-picture-context" aria-label="Working character">
                ${avatar && html`<img src=${avatar.url} alt="" />`}
                <div><span class="cs-muted cs-small">Working on</span><strong>${ch.card.data.name || 'Unnamed character'}</strong><span class="cs-muted cs-small">Prompts, pictures and expressions stay with this character.</span></div>
                <div class="cs-spacer"></div><${Button} small label="Back to character" onClick=${() => select('characters', ch.id)} />
                <${Button} small label="Change character" onClick=${() => { setSelection(null); setArea('characters'); }} />
            </div><${CharacterPictures} ...${props} ch=${ch} key=${ch.id} />`
            : html`<${Empty} icon="user" title="Choose the character you’re working on">Pictures will stay with that character as you move around the studio.
                <div class="cs-row"><${Button} kind="primary" label="Choose a character" onClick=${() => { setSelection(null); setArea('characters'); }} /></div>
            </${Empty}>`}
        </div>`;
}

function PictureLibrary(props) {
    const { project, select, store, env } = props;
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const unused = new Set(unusedMedia(project).map(m => m.id));
    const pictures = project.media.filter(m => {
        const uses = mediaUsage(project, m.id);
        const match = `${m.name} ${uses.map(u => u.name).join(' ')}`.toLowerCase().includes(query.toLowerCase());
        return match && (filter === 'all' || (filter === 'unused' ? unused.has(m.id) : uses.some(u => u.how === 'sprite')));
    });
    return html`<div class="cs-area-head"><${Button} small icon="arrow-left" label="Back to character pictures" onClick=${() => props.setSelection(null)} /><h3>Project picture library</h3><div class="cs-spacer"></div>
        <${Button} icon="broom" label=${`Remove unused (${unused.size})`} disabled=${!unused.size} onClick=${() => removeUnusedPictures(store, env)} /></div>
        <div class="cs-area-body"><p class="cs-page-intro">Pictures from every character in this project. Open one to see where it is used or remove it. Your working character stays selected.</p>
            <div class="cs-picture-toolbar"><input class="text_pole" aria-label="Search pictures" placeholder="Find a picture or character…" value=${query} onInput=${e => setQuery(e.currentTarget.value)} />
                <div class="cs-row" role="group" aria-label="Filter pictures">${[['all', 'All pictures'], ['sprites', 'Expressions'], ['unused', 'Unused']].map(([id, label]) => html`<button class=${cx('cs-btn', filter === id && 'cs-btn-primary')} aria-pressed=${filter === id} onClick=${() => setFilter(id)}>${label}</button>`)}</div>
            </div>
            <div class="cs-picture-grid">${pictures.map(m => html`<button key=${m.id} class="cs-picture-tile" onClick=${() => select('media', m.id)}>
                ${m.kind === 'image' ? html`<img src=${m.url} alt="" loading="lazy" />` : html`<div class="cs-picture-file"><${Icon} name="file" /></div>`}
                <strong>${m.name}</strong><span>${unused.has(m.id) ? 'Unused' : [...new Set(mediaUsage(project, m.id).map(u => u.name))].join(', ')}</span>
            </button>`)}</div>
            ${!pictures.length && html`<${Empty} icon="image" title=${project.media.length ? 'No pictures match' : 'Your picture collection starts with a character'}>${project.media.length ? 'Try another search or choose All pictures.' : 'Import a card with an avatar, or open a character to add pictures.'}<div class="cs-row"><${Button} label="Open characters" onClick=${() => { props.setSelection(null); props.setArea('characters'); }} /></div></${Empty}>`}
        </div>`;
}

/** Remove every picture no character uses, as one undo step. */
export async function removeUnusedPictures(store, env) {
    const unused = unusedMedia(store.get());
    if (!unused.length) return;
    const names = unused.slice(0, 8).map(m => m.name).join(', ') + (unused.length > 8 ? `, and ${unused.length - 8} more` : '');
    const n = `${unused.length} unused picture${unused.length === 1 ? '' : 's'}`;
    if (!(await env.confirm(`Remove ${n}?`, `No character uses ${names}. Undo with Ctrl+Z.`))) return;
    store.update(p => unused.reduce((acc, m) => removeMedia(acc, m.id), p), 'remove unused pictures');
    env.toast(`Removed ${n}. Ctrl+Z brings them back.`, 'ok', 5000);
}

export function MediaView({ store, env, project, selection, setSelection, select, setArea }) {
    const m = findArtifact(project, 'media', selection.id); // the Characters area only shows this view while it exists
    const uses = mediaUsage(project, m.id);
    const others = unusedMedia(project).filter(x => x.id !== m.id);
    const remove = async () => {
        const where = uses.map(u => `${u.name || '(unnamed)'} (${usageLabel(u)})`).join(', ');
        const detail = uses.length ? `It is used by ${where}; those places will be left empty. Undo with Ctrl+Z.` : 'No character uses it. Undo with Ctrl+Z.';
        if (!(await env.confirm(`Remove ${m.name} from the project?`, detail))) return;
        store.update(p => removeMedia(p, m.id), 'remove picture');
        setSelection(null);
        env.toast(`Removed ${m.name}. Ctrl+Z brings it back.`, 'ok', 5000);
    };
    return html`<div class="cs-area-head">
            <${Button} small icon="arrow-left" label="Back to pictures" onClick=${() => { setSelection(null); setArea('media'); }} />
            <h3><${Icon} name=${m.kind === 'image' ? 'image' : 'file'} /> ${m.name}</h3>
            <div class="cs-spacer"></div>
            <${Button} icon="trash" kind="danger" label="Remove from project" onClick=${remove} />
        </div>
        <div class="cs-area-body">
            <div class="cs-media-view">
                <figure class="cs-media-preview">
                    ${m.kind === 'image' ? html`<img src=${m.url} alt=${m.name} />` : html`<${Icon} name="file" />`}
                </figure>
                <div class="cs-stack">
                    <${Section} title="Used by">
                        ${uses.length ? html`<ul class="cs-media-uses">${uses.map((u, i) => html`<li key=${i}>
                                <a href="#" onClick=${e => { e.preventDefault(); select('characters', u.characterId); }}>${u.name || '(unnamed)'}</a>
                                <span class="cs-muted">${usageLabel(u)}</span>
                            </li>`)}</ul>`
                            : html`<p class="cs-muted">No character uses this picture. Removing it changes nothing else.</p>`}
                    </${Section}>
                    <dl class="cs-media-facts">
                        <dt>Origin</dt><dd>${ORIGIN[m.role] ?? m.role ?? 'Unknown'}</dd>
                        <dt>Size</dt><dd>${size(m.size)}</dd>
                        <dt>Added</dt><dd>${m.created ? new Date(m.created).toLocaleString() : 'Unknown'}</dd>
                    </dl>
                    ${!uses.length && others.length > 0 && html`<div class="cs-row">
                        <span class="cs-muted">${others.length} other picture${others.length === 1 ? '' : 's'} in this project ${others.length === 1 ? 'is' : 'are'} unused too.</span>
                        <${Button} small icon="broom" label=${`Remove all ${others.length + 1} unused`} onClick=${() => removeUnusedPictures(store, env)} />
                    </div>`}
                </div>
            </div>
        </div>`;
}
