import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createStore } from '../src/ui/store.js';
import { importCard, importAnyFile } from '../src/ui/importer.js';
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
