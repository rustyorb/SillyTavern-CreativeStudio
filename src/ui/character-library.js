import { html, Icon, Badge } from './kit.js';
import { characterProgress } from '../core/workflow.js';

export function CharacterLibrary({ project, characters = project.characters, select }) {
    return html`<div class="cs-character-library">${characters.map(c => {
        const progress = characterProgress(c);
        const avatar = project.media.find(m => m.id === c.avatarMediaId);
        return html`<button key=${c.id} class="cs-character-tile" onClick=${() => select('characters', c.id, progress.next?.tab ?? 'core')}>
            <div class="cs-character-portrait">${avatar ? html`<img src=${avatar.url} alt="" loading="lazy" />` : html`<${Icon} name=${c.kind === 'scenario' ? 'masks-theater' : 'user-pen'} />`}</div>
            <div class="cs-character-summary"><strong>${c.card.data.name || 'Unnamed character'}</strong>
                <p>${c.card.data.description?.trim().slice(0, 130) || 'A blank page. Start with who they are and what brings you together.'}</p>
                <span class="cs-character-next">${progress.ready ? 'Open character' : `Next: ${progress.next.label.toLowerCase()}`}</span>
            </div>
            <${Badge} kind=${progress.ready ? 'ok' : ''}>${progress.ready ? 'Ready to try' : `${progress.complete}/${progress.total} basics`}</${Badge}>
        </button>`;
    })}</div>`;
}
