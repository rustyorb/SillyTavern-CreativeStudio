import { test } from 'node:test';
import assert from 'node:assert/strict';

// store.js imports Preact hooks from the vendored bundle; only createStore is exercised here.
const { createStore } = await import('../src/ui/store.js');

test('bookkeeping updates are not undo steps, and sticky keys survive undo/redo', () => {
    const s = createStore({ text: 'a', generationRuns: [] }, { sticky: ['generationRuns'] });
    s.update(p => ({ ...p, generationRuns: [{ id: 'r', status: 'running' }] }), 'generation progress', { history: false });
    assert.equal(s.canUndo(), false);
    s.update(p => ({ ...p, text: 'b' }), 'generate: card');
    s.update(p => ({ ...p, generationRuns: [{ id: 'r', status: 'done' }] }), 'generation progress', { history: false });
    assert.equal(s.undo(), 'generate: card');
    assert.equal(s.get().text, 'a');
    assert.equal(s.get().generationRuns[0].status, 'done', 'undo does not resurrect a "running" record');
    s.redo();
    assert.equal(s.get().text, 'b');
    assert.equal(s.get().generationRuns[0].status, 'done');
});

test('updates asked not to merge stay separate undo steps, even with the same label', () => {
    const s = createStore({ n: 0 });
    s.update(p => ({ n: p.n + 1 }), 'import card', { merge: false });
    s.update(p => ({ n: p.n + 1 }), 'import card', { merge: false });
    s.undo();
    assert.equal(s.get().n, 1);
});
