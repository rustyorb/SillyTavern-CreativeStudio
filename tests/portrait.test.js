import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, newCharacter, removeMedia, removeCharacter, editArtifactField } from '../src/core/project.js';
import { createStore } from '../src/ui/store.js';
import { ensureCharacterPortrait, sameImportedCharacter } from '../src/ui/portrait.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const image = { id: 'portrait', kind: 'image', role: 'avatar', url: '/portrait.png' };
function fixture() {
    const project = createProject('Portrait test');
    const character = newCharacter('Seraphina');
    character.card.data.description = 'A pink-haired knight.';
    character.card.data.first_mes = 'Hello, traveler.';
    character.origin = { kind: 'import', file: 'seraphina.png' };
    project.characters = [character, newCharacter('Other')];
    project.workspace = { characterId: character.id };
    const store = createStore(project, { sticky: ['workspace'] });
    const fetched = [];
    const source = {
        list: async () => [{ name: 'Seraphina', avatar: 'default_Seraphina.png' }],
        read: async () => ({ data: structuredClone(character.card.data) }),
        png: async avatar => { fetched.push(avatar); return png; },
    };
    const saved = [];
    const env = { storage: { saveMedia: async (projectId, id, ext, bytes) => {
        saved.push({ projectId, bytes }); return `user/files/${projectId}-${id}.${ext}`;
    } } };
    const load = options => ensureCharacterPortrait(store, env, project.id, character.id, { source, ...options });
    return { project, character, store, source, env, fetched, saved, load };
}

test('legacy imported Seraphina automatically gets her actual PNG, without changing card text', async () => {
    const f = fixture();
    f.character.topLevelExtras = { ...f.character.card.data, avatar: 'none' };
    f.character.card.data.first_mes = 'A new opening written in Studio.';
    f.source.read = async () => ({ data: f.character.topLevelExtras });
    const before = structuredClone(f.character.card);
    const media = await f.load();
    const result = f.store.get().characters[0];
    assert.deepEqual(f.fetched, ['default_Seraphina.png']);
    assert.equal(result.avatarMediaId, media.id);
    assert.deepEqual(result.links.media, [media.id]);
    assert.deepEqual(result.card, before);
    assert.equal(result.stAvatar, undefined); // recovering a picture does not link live writes
    assert.equal(result.portraitSource.avatar, 'default_Seraphina.png');
    assert.deepEqual(f.saved[0].bytes, png);
    assert.equal(f.store.get().characters[1].avatarMediaId, '');
});

test('an explicit ST avatar takes precedence over same-name candidates and edited card text', async () => {
    const f = fixture();
    f.character.origin = { kind: 'st', avatar: 'Seraphina2.png' };
    f.source.list = async () => { throw new Error('Must not search by name'); };
    await f.load();
    assert.deepEqual(f.fetched, ['Seraphina2.png']);
});

test('JSON avatar filenames can supply the existing PNG without guessing from the name', async () => {
    const f = fixture();
    f.character.topLevelExtras = { avatar: 'my-character.png' };
    await f.load();
    assert.deepEqual(f.fetched, ['my-character.png']);
});

test('matching a name alone, blank card fields, or a new character cannot borrow another face', async () => {
    const f = fixture();
    assert.equal(sameImportedCharacter(f.character, { data: { name: 'Seraphina' } }), false);
    f.source.read = async () => ({ data: { ...f.character.card.data, first_mes: 'Different character' } });
    assert.equal(await f.load(), null);
    assert.equal(f.saved.length, 0);
    f.character.origin = { kind: 'new' };
    assert.equal(sameImportedCharacter(f.character, f.character.card), false);
    assert.equal(await f.load({ retry: true }), null);
});

test('ambiguous identical ST cards do not silently select an arbitrary portrait', async () => {
    const f = fixture();
    f.source.list = async () => ['one.png', 'two.png'].map(avatar => ({ avatar, name: 'Seraphina' }));
    assert.equal(await f.load(), null);
    assert.equal(f.fetched.length, 0);
});

test('a user-selected portrait is preserved and an unambiguous owned avatar can repair a lost link', async () => {
    const f = fixture();
    f.project.media = [image];
    f.character.avatarMediaId = image.id;
    assert.equal((await f.load()).id, image.id);
    assert.equal(f.fetched.length, 0);
    f.character.avatarMediaId = '';
    f.character.links.media = [image.id];
    assert.equal((await f.load({ retry: true })).id, image.id);
    assert.equal(f.store.get().characters[0].avatarMediaId, image.id);
    assert.equal(f.saved.length, 0);
});

test('recovery never takes another project character’s gallery image', async () => {
    const f = fixture();
    f.project.media = [image];
    f.project.characters[1].links.media = [image.id];
    f.source.list = async () => [];
    assert.equal(await f.load(), null);
    assert.equal(f.store.get().characters[0].avatarMediaId, '');
});

test('concurrent Pictures views share one load and Undo is not immediately reversed by reopening', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.load(), f.load()]);
    assert.equal(a.id, b.id);
    assert.equal(f.saved.length, 1);
    f.store.undo();
    assert.equal(f.store.get().media.length, 0);
    await f.load();
    assert.equal(f.store.get().media.length, 0);
    f.store.redo();
    assert.equal(f.store.get().characters[0].avatarMediaId, a.id);
});

test('deleting a portrait keeps it deleted across reload; Undo restores the portrait and automatic behavior', async () => {
    const f = fixture();
    const media = await f.load();
    f.store.update(p => removeMedia(p, media.id), 'delete');
    const reopened = createStore(JSON.parse(JSON.stringify(f.store.get())));
    assert.equal(await ensureCharacterPortrait(reopened, f.env, f.project.id, f.character.id, { source: f.source }), null);
    assert.equal(f.saved.length, 1);
    f.store.undo();
    assert.equal(f.store.get().characters[0].avatarMediaId, media.id);
    assert.equal(f.store.get().characters[0].portraitAutoLoadBlocked, undefined);
});

test('a late portrait cannot overwrite a user replacement, even if that replacement is then deleted', async () => {
    const f = fixture();
    f.source.png = async () => {
        f.store.update(p => ({ ...p, media: [image] }), 'upload');
        f.store.update(p => editArtifactField(p, 'characters', f.character.id, 'avatarMediaId', image.id), 'choose');
        f.store.update(p => removeMedia(p, image.id), 'delete');
        return png;
    };
    assert.equal(await f.load(), null);
    assert.equal(f.saved.length, 0);
    assert.equal(f.store.get().characters[0].avatarMediaId, '');
});

test('project switches and character deletion during a save cancel attachment', async () => {
    for (const change of ['project', 'character']) {
        const f = fixture();
        f.env.storage.saveMedia = async () => {
            if (change === 'project') f.store.reset(createProject('Other project'));
            else f.store.update(p => removeCharacter(p, f.character.id), 'remove');
            return 'saved.png';
        };
        assert.equal(await f.load(), null);
        assert.equal(f.store.get().media.length, 0);
    }
});

test('switching the selected character during recovery keeps the portrait with its original owner', async () => {
    const f = fixture();
    f.source.png = async () => {
        f.store.update(p => ({ ...p, workspace: { characterId: p.characters[1].id } }), 'selection', { history: false });
        return png;
    };
    const media = await f.load();
    assert.equal(f.store.get().characters[0].avatarMediaId, media.id);
    assert.equal(f.store.get().characters[1].avatarMediaId, '');
});

test('returning to a project after a cancelled recovery starts a fresh automatic attempt', async () => {
    const f = fixture();
    f.source.png = async () => { f.store.reset(createProject('Other project')); return png; };
    assert.equal(await f.load(), null);
    f.store.reset(f.project);
    f.source.png = async () => png;
    const media = await f.load();
    assert.equal(f.store.get().characters[0].avatarMediaId, media.id);
    assert.equal(f.saved.length, 1);
});

test('fetch errors preserve the project and an explicit retry can recover; non-PNG responses are rejected', async () => {
    const f = fixture();
    f.source.png = async () => { throw new Error('HTTP 503'); };
    await assert.rejects(f.load(), /503/);
    assert.equal(f.store.get().media.length, 0);
    f.source.png = async () => new Uint8Array([1, 2, 3]);
    await assert.rejects(f.load({ retry: true }), /PNG/);
    f.source.png = async () => png;
    assert.ok((await f.load({ retry: true })).id);
    assert.equal(f.saved.length, 1);
});
