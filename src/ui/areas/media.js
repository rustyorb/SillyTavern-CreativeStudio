// One picture of the project: what it is, which characters show it, and removing it from every place at once.
import { html, Button, Icon, Section } from '../kit.js';
import { findArtifact, mediaUsage, unusedMedia, removeMedia } from '../../core/project.js';

const HOW = { avatar: 'avatar', gallery: 'gallery picture' };
const ORIGIN = { avatar: 'Came with an imported card', generated: 'Painted in the studio', sprite: 'Expression sprite', 'charx-asset': 'File from a CHARX card', image: 'Added picture' };

/** "avatar", "sprite: joy", "CHARX file assets/…": how one character uses the picture. */
export const usageLabel = u => (u.how === 'sprite' ? `sprite: ${u.label}` : u.how === 'asset' ? `CHARX file ${u.path}` : HOW[u.how]);

const size = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n ?? 0) / 1024))} KB`);

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

export function MediaView({ store, env, project, selection, setSelection, select }) {
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
