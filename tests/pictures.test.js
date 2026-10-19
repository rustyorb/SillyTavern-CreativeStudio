import test from 'node:test';
import assert from 'node:assert/strict';
import { pictureDraft, workingCharacter } from '../src/core/pictures.js';
import { createProject, newCharacter, removeCharacter, editArtifactField } from '../src/core/project.js';
import { createStore } from '../src/ui/store.js';
import { saveCharacterPicture } from '../src/ui/media.js';
import * as pictures from '../src/core/pictures.js';

function fixture() {
    const project = createProject('Picture test');
    project.characters = [newCharacter('Mara'), newCharacter('Sol')];
    project.workspace = { characterId: project.characters[0].id };
    const store = createStore(project, { sticky: ['workspace'] });
    return { project, store, a: project.characters[0], b: project.characters[1] };
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const env = { storage: { saveMedia: async (projectId, id, ext) => `user/files/${projectId}-${id}.${ext}` } };

test('choosing an avatar keeps both pictures, changes one character only, and supports Undo and Redo', () => {
    const { project, store, a, b } = fixture();
    project.media = ['old', 'new'].map(id => ({ id, kind: 'image', url: `${id}.png` }));
    a.avatarMediaId = 'old'; // Older imported avatars were not always in links.media.
    a.links.media = ['new'];
    a.sprites = { joy: 'old-expression' };
    const before = structuredClone(project);
    store.update(p => pictures.selectCharacterAvatar(p, project.id, a.id, 'new'), 'choose avatar', { merge: false });
    const chosen = store.get().characters[0];
    assert.equal(chosen.avatarMediaId, 'new');
    assert.deepEqual(new Set(chosen.links.media), new Set(['old', 'new']));
    assert.deepEqual(chosen.sprites, a.sprites);
    assert.deepEqual(store.get().characters[1], b);
    assert.deepEqual(store.get().media, before.media);
    assert.deepEqual(project, before, 'selection is immutable');
    assert.equal(pictures.selectCharacterAvatar(store.get(), project.id, a.id, 'new'), store.get(), 'reselecting is a no-op');
    store.undo();
    assert.deepEqual(store.get(), before);
    store.redo();
    assert.equal(store.get().characters[0].avatarMediaId, 'new');
    store.update(p => pictures.selectCharacterAvatar(p, project.id, a.id, 'old'), 'choose avatar', { merge: false });
    assert.equal(store.get().characters[0].avatarMediaId, 'old');
    assert.equal(store.get().characters[0].links.media.length, 2);
    store.undo();
    assert.equal(store.get().characters[0].avatarMediaId, 'new', 'each choice is a separate Undo step');
});

test('a stale avatar choice cannot change another project or select missing/non-image media', () => {
    const { project, a } = fixture();
    project.media = [{ id: 'text', kind: 'file', url: 'notes.txt' }];
    assert.throws(() => pictures.selectCharacterAvatar(project, 'other-project', a.id, 'text'), /project changed/);
    assert.throws(() => pictures.selectCharacterAvatar(project, project.id, 'removed', 'text'), /character was removed/);
    assert.throws(() => pictures.selectCharacterAvatar(project, project.id, a.id, 'missing'), /picture.*available/i);
    assert.throws(() => pictures.selectCharacterAvatar(project, project.id, a.id, 'text'), /image/i);
});

test('a generated portrait leaves the chosen avatar and existing expressions alone', async () => {
    const { project, store, a } = fixture();
    a.avatarMediaId = 'chosen';
    a.sprites = { joy: 'joy-picture' };
    const media = await saveCharacterPicture(env, store, project.id, a.id, png, { purpose: 'avatar' });
    assert.equal(store.get().characters[0].avatarMediaId, 'chosen');
    assert.deepEqual(store.get().characters[0].sprites, a.sprites);
    assert.ok(store.get().characters[0].links.media.includes(media.id));
});

test('pictures follow the working character, never the first of several or a replacement after deletion', () => {
    const { project, a, b } = fixture();
    assert.equal(workingCharacter(project).id, a.id);
    project.workspace.characterId = b.id;
    assert.equal(workingCharacter(project).id, b.id);
    project.characters = [a];
    assert.equal(workingCharacter(project), null);
    delete project.workspace;
    assert.equal(workingCharacter(project).id, a.id);
    project.characters.push(b);
    assert.equal(workingCharacter(project), null);
});

test('picture drafts stay separate, survive reopening, and preserve an intentionally empty prompt', () => {
    const { store, a, b } = fixture();
    a.imagePrompts = [{ purpose: 'avatar', prompt: 'Original portrait' }];
    assert.equal(pictureDraft(a).prompt, 'Original portrait');
    store.update(p => editArtifactField(p, 'characters', a.id, 'pictureDraft', { purpose: 'background', prompt: 'A moonlit library' }), 'draft');
    const reopened = JSON.parse(JSON.stringify(store.get()));
    assert.equal(pictureDraft(reopened.characters[0]).prompt, 'A moonlit library');
    assert.equal(pictureDraft(b).prompt, '');
    reopened.characters[0].pictureDraft.prompt = '';
    assert.equal(pictureDraft(reopened.characters[0]).prompt, '');
    store.undo();
    assert.equal(pictureDraft(store.get().characters[0]).prompt, 'Original portrait');
});

test('an image finishing after a character switch belongs only to the character that requested it', async () => {
    const { store, project, a, b } = fixture();
    const delayed = { storage: { saveMedia: async (...args) => {
        store.update(p => ({ ...p, workspace: { characterId: b.id } }), 'selection', { history: false });
        return env.storage.saveMedia(...args);
    } } };
    const media = await saveCharacterPicture(delayed, store, project.id, a.id, png, { purpose: 'avatar', prompt: 'Mara portrait', seed: 123 });
    assert.equal(store.get().characters[0].avatarMediaId, media.id);
    assert.deepEqual(store.get().characters[0].links.media, [media.id]);
    assert.deepEqual(store.get().characters[1].links.media, []);
    assert.equal(workingCharacter(store.get()).id, b.id);
    store.undo();
    assert.equal(store.get().media.length, 0);
    assert.equal(workingCharacter(store.get()).id, b.id);
    store.redo();
    assert.equal(store.get().characters[0].avatarMediaId, media.id);
});

test('changing projects while an image file saves cannot insert the result into the new project', async () => {
    const { store, project, a } = fixture();
    const other = createProject('Other project');
    other.characters = [structuredClone(a)]; // even an imported project with the same character ID
    const delayed = { storage: { saveMedia: async () => { store.reset(other); return 'saved.png'; } } };
    await assert.rejects(saveCharacterPicture(delayed, store, project.id, a.id, png, { purpose: 'avatar' }), /project changed/);
    assert.deepEqual(store.get(), other);
    assert.equal(store.get().media.length, 0);
});

test('deleting a character while a picture saves cannot attach the result to another character', async () => {
    const { store, project, a, b } = fixture();
    const delayed = { storage: { saveMedia: async () => { store.update(p => removeCharacter(p, a.id), 'delete'); return 'saved.png'; } } };
    await assert.rejects(saveCharacterPicture(delayed, store, project.id, a.id, png, { purpose: 'avatar' }), /character was removed/);
    assert.equal(store.get().media.length, 0);
    assert.equal(store.get().characters[0].id, b.id);
    assert.deepEqual(store.get().characters[0].links.media, []);
});

test('expression results share the same ownership checks and one-step Undo', async () => {
    const { store, project, a, b } = fixture();
    const media = await saveCharacterPicture(env, store, project.id, a.id, png, { label: 'joy', prompt: 'Smiling Mara' });
    assert.equal(store.get().characters[0].sprites.joy, media.id);
    assert.equal(store.get().characters[1].sprites?.joy, undefined);
    assert.equal(store.get().media[0].role, 'sprite');
    store.undo();
    assert.equal(store.get().characters[0].sprites?.joy, undefined);
    assert.equal(store.get().media.length, 0);
    assert.equal(workingCharacter(store.get()).id, a.id);
});
