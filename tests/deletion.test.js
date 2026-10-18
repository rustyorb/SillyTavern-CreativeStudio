import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/store.js';
import { deleteWithUndo } from '../src/ui/deletion.js';
import { createProject, newCharacter, upsertArtifact, removeArtifact } from '../src/core/project.js';

function fixture() {
    let p = createProject('Deletion checks');
    const c = newCharacter('Writer');
    c.links.presets = ['preset-a'];
    p = upsertArtifact(p, 'characters', c);
    p = upsertArtifact(p, 'presets', { id: 'preset-a', name: 'Draft', data: { prompts: [{ content: 'Keep this' }] }, versions: [{ id: 'v1' }] });
    p = upsertArtifact(p, 'presets', { id: 'preset-b', name: 'Other' });
    const store = createStore(p, { sticky: ['generationRuns'] });
    const notices = [];
    const env = { toast: (...args) => notices.push(args) };
    const remove = id => deleteWithUndo(store, env, state => removeArtifact(state, 'presets', id), 'Deleted preset');
    return { store, env, notices, remove, initial: p };
}

test('deleting and undoing a preset restores its prompts, versions and character links', () => {
    const { store, notices, remove, initial } = fixture();
    remove('preset-a');
    assert.deepEqual(store.get().presets.map(p => p.id), ['preset-b']);
    assert.deepEqual(store.get().characters[0].links.presets, []);
    const action = notices.at(-1)[3];
    assert.equal(action.available(), true);
    action.run();
    assert.deepEqual(store.get(), initial);
    action.run(); // A stale click cannot undo an earlier edit.
    assert.deepEqual(store.get(), initial);
});

test('consecutive deletions remain individual undo steps', () => {
    const { store, remove } = fixture();
    remove('preset-a');
    remove('preset-b');
    store.undo();
    assert.deepEqual(store.get().presets.map(p => p.id), ['preset-b']);
    store.undo();
    assert.equal(store.get().presets.length, 2);
});

test('delete notification cannot undo a later edit or a different project', () => {
    const { store, notices, remove } = fixture();
    remove('preset-a');
    const action = notices.at(-1)[3];
    store.update(p => ({ ...p, name: 'Newer edit' }), 'rename');
    assert.equal(action.available(), false);
    action.run();
    assert.equal(store.get().name, 'Newer edit');
    store.reset(createProject('Different project'));
    store.update(p => ({ ...p, name: 'Keep this edit' }), 'rename');
    action.run();
    assert.equal(store.get().name, 'Keep this edit');
});

test('background bookkeeping preserves deletion undo and no-op deletions have no notification', () => {
    const { store, env, notices, remove } = fixture();
    remove('preset-a');
    const action = notices.at(-1)[3];
    store.update(p => ({ ...p, generationRuns: [{ id: 'finished' }] }), 'progress', { history: false });
    assert.equal(action.available(), true);
    action.run();
    assert.equal(store.get().presets.length, 2);
    assert.equal(store.get().generationRuns[0].id, 'finished');
    const count = notices.length;
    assert.equal(deleteWithUndo(store, env, p => p, 'Missing item'), false);
    assert.equal(notices.length, count);
});
