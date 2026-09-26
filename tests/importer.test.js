import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createStore } from '../src/ui/store.js';
import { importCard, importAnyFile, dragDecision } from '../src/ui/importer.js';
import { createProject, newCharacter, upsertArtifact } from '../src/core/project.js';
import { blankPng } from '../src/core/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const seraphina = () => new Uint8Array(readFileSync(join(here, 'fixtures', 'seraphina.png')));

/** Just enough of the studio environment for imports: pictures "upload" to a made-up URL, toasts are recorded. */
function fakeEnv() {
    const toasts = [];
    return {
        toasts,
        toast: (text, kind) => toasts.push({ text, kind }),
        storage: { saveMedia: async (pid, mid, ext) => `user/files/cstudio-m-${pid}-${mid}.${ext}`, listProjects: async () => [] },
        saveNow: async () => {},
    };
}

test('importing a card adds the character and its picture as one undo step', async () => {
    const store = createStore(createProject('t'));
    const c = await importCard(store, fakeEnv(), seraphina(), 'seraphina.png');
    const p = store.get();
    assert.equal(c.card.data.name, 'Seraphina');
    assert.deepEqual(p.characters.map(x => x.id), [c.id]);
    assert.equal(p.media.length, 1);
    assert.equal(p.characters[0].avatarMediaId, p.media[0].id);
    store.undo();
    assert.equal(store.get().characters.length, 0);
    assert.equal(store.get().media.length, 0, 'undo takes the picture out together with the character');
});

test('an import takes the place of an untouched blank character, never of one with work in it', async () => {
    const blank = newCharacter('New character');
    const named = newCharacter('Mira');
    const store = createStore(upsertArtifact(upsertArtifact(createProject('t'), 'characters', blank), 'characters', named));
    await importCard(store, fakeEnv(), seraphina(), 'seraphina.png', { replaceId: blank.id });
    assert.deepEqual(store.get().characters.map(x => x.card.data.name), ['Mira', 'Seraphina']);
    await importCard(store, fakeEnv(), seraphina(), 'seraphina.png', { replaceId: named.id });
    assert.ok(store.get().characters.some(x => x.id === named.id), 'a named character is never replaced');
});

test('a file that is not a card changes nothing and says what the studio can open', async () => {
    const store = createStore(createProject('t'));
    const env = fakeEnv();
    const before = store.get();
    assert.equal((await importAnyFile(store, env, new File([blankPng()], 'photo.png'))).kind, 'image');
    assert.equal((await importAnyFile(store, env, new File(['{"entries":{}}'], 'world.json'))).kind, 'unknown');
    assert.equal(store.get(), before);
    assert.deepEqual(env.toasts.map(t => t.kind), ['error', 'error']);
    assert.match(env.toasts[0].text, /no character card inside/);
    assert.match(env.toasts[1].text, /character cards \(PNG, CHARX or JSON\)/);
});

test('a dropped card file goes to the card importer', async () => {
    const store = createStore(createProject('t'));
    const r = await importAnyFile(store, fakeEnv(), new File([seraphina()], 'seraphina.png'));
    assert.equal(r.kind, 'card');
    assert.equal(r.character.card.data.name, 'Seraphina');
});

test('a damaged card or an unreadable file gets a toast, never an exception, and changes nothing', async () => {
    const store = createStore(createProject('t'));
    const env = fakeEnv();
    const before = store.get();
    await importAnyFile(store, env, new File([seraphina().slice(0, 200)], 'half.png'));
    await importAnyFile(store, env, { name: 'Cards folder', arrayBuffer: () => Promise.reject(new Error('it is a folder')) });
    assert.equal(store.get(), before);
    assert.deepEqual(env.toasts.map(t => t.kind), ['error', 'error']);
    assert.match(env.toasts[0].text, /half\.png/);
    assert.match(env.toasts[1].text, /Cards folder/);
});

test('each import is its own undo step, even two in a row', async () => {
    const store = createStore(createProject('t'));
    await importCard(store, fakeEnv(), seraphina(), 'a.png');
    await importCard(store, fakeEnv(), seraphina(), 'b.png');
    assert.equal(store.get().characters.length, 2);
    store.undo();
    assert.equal(store.get().characters.length, 1, 'one Ctrl+Z takes out only the last card');
});

test('an import never replaces a blank that a running build points at', async () => {
    const blank = newCharacter('New character');
    const start = upsertArtifact(createProject('t'), 'characters', blank);
    const store = createStore({ ...start, generationRuns: [{ id: 'r', status: 'running', state: { characterId: blank.id } }] });
    await importCard(store, fakeEnv(), seraphina(), 'seraphina.png', { replaceId: blank.id });
    assert.ok(store.get().characters.some(c => c.id === blank.id));
});

test("drag policy: SillyTavern never sees a drag over the studio; files are the studio's, text into a field is the browser's", () => {
    assert.deepEqual(dragDecision({ files: true, editable: false }), { stop: true, prevent: true, accept: true });
    assert.deepEqual(dragDecision({ files: true, editable: true }), { stop: true, prevent: true, accept: true });
    assert.deepEqual(dragDecision({ files: false, editable: false }), { stop: true, prevent: true, accept: false }, 'a link dropped on the studio goes nowhere');
    assert.deepEqual(dragDecision({ files: false, editable: true }), { stop: true, prevent: false, accept: false }, 'text dragged into a field lands there');
});
