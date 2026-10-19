// Project deletions share one confirmation and an undo action tied to that exact edit.
import { html, useState, Button, Modal } from './kit.js';
import { artifactName, findArtifact, removeArtifact, removeMedia, mediaUsage, removeCharacter } from '../core/project.js';

export function deleteWithUndo(store, env, update, label, onUndo) {
    const before = store.get();
    store.update(update, label, { merge: false });
    if (store.get() === before) return false;
    const revision = store.undoRevision();
    const available = () => store.undoRevision() === revision && store.canUndo();
    env.toast(label, 'ok', 20000, {
        label: 'Undo', available,
        run: () => {
            // Never undo a newer edit or a different project's history from an old notification.
            if (!available()) return;
            store.undo();
            onUndo?.();
            env.toast('Restored.', 'ok');
        },
    });
    return true;
}

export function DeleteButton({ name, label = 'Delete', detail, onDelete }) {
    const [open, setOpen] = useState(false);
    return html`<div class="cs-delete-control" onClick=${e => e.stopPropagation()}>
        <${Button} icon="trash" kind="danger" label=${label} title=${`Delete ${name}`} onClick=${() => setOpen(true)} />
        ${open && html`<${Modal} title="Delete from project?" onClose=${() => setOpen(false)} footer=${html`
            <${Button} label="Cancel" onClick=${() => setOpen(false)} />
            <${Button} icon="trash" kind="danger" label=${label} onClick=${() => { setOpen(false); onDelete(); }} />`}>
            <div class="cs-stack">
                <strong class="cs-delete-name">${name}</strong>
                ${detail && html`<div>${detail}</div>`}
                <div>This removes the project copy only. Anything already installed in SillyTavern stays there.</div>
                <div class="cs-muted">Changed your mind? Choose Undo afterward, or use Undo in the top bar.</div>
            </div>
        </${Modal}>`}
    </div>`;
}

export function DeleteArtifactButton({ store, env, type, item, label = 'Delete', onDeleted, onRestored }) {
    const name = artifactName(type, item);
    const count = type === 'qrSets' ? item.data?.qrList?.length ?? 0 : null;
    const detail = count !== null ? `The entire set and its ${count} Quick Reply button${count === 1 ? '' : 's'} will be removed.`
        : type === 'presets' ? 'The preset, its prompts and saved versions will be removed from this project.'
            : type === 'connectionProfiles' ? 'This removes the saved profile reference from this project.' : undefined;
    return html`<${DeleteButton} name=${name} label=${label} detail=${detail} onDelete=${() => {
        const removed = deleteWithUndo(store, env, p => findArtifact(p, type, item.id)
            ? removeArtifact(p, type, item.id, { summary: `Deleted ${name}` }) : p, `Deleted ${name}`, onRestored);
        if (removed) onDeleted?.();
    }} />`;
}

export function DeletePictureButton({ store, env, project, media, label = 'Delete picture' }) {
    const uses = mediaUsage(project, media.id);
    const names = [...new Set(uses.map(u => u.name))].join(', ');
    return html`<${DeleteButton} name=${media.name} label=${label}
        detail=${uses.length ? `This image will be removed wherever it is used in this project (${names}), including any portrait or expression slots.` : 'This image is unused.'}
        onDelete=${() => deleteWithUndo(store, env, p => p.id === project.id && findArtifact(p, 'media', media.id) ? removeMedia(p, media.id) : p, `Deleted ${media.name}`)} />`;
}

export function DeleteCharacterButton({ store, env, project, character, onDeleted }) {
    return html`<${DeleteButton} name=${character.card.data.name} label="Delete character"
        detail="This removes the entire character and pictures only it uses. To remove one picture, use Delete picture under that image instead."
        onDelete=${() => {
            const deleted = deleteWithUndo(store, env, p => p.id === project.id && findArtifact(p, 'characters', character.id) ? removeCharacter(p, character.id) : p, `Deleted character ${character.card.data.name}`);
            if (deleted) onDeleted?.();
        }} />`;
}
