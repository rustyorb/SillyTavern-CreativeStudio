import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jsonDiff, textDiff, getPath, setPath, parsePath, diffStats } from '../src/core/diff.js';
import {
    createProject, newCharacter, upsertArtifact, editArtifactField, createProposal, addProposals,
    acceptProposal, rejectProposal, isProposalStale, makeSnapshot, restoreSnapshot, dependencyReport, migrateProject, removeArtifact, setSprite,
} from '../src/core/project.js';

test('parsePath/getPath/setPath', () => {
    assert.deepEqual(parsePath('card.data.alternate_greetings[2]'), ['card', 'data', 'alternate_greetings', 2]);
    const o = { a: { b: [1, 2, 3] } };
    assert.equal(getPath(o, 'a.b[1]'), 2);
    setPath(o, 'a.c.d', 5);
    assert.equal(o.a.c.d, 5);
    setPath(o, 'a.b[0]', undefined);
    assert.deepEqual(o.a.b, [2, 3]);
});

test('jsonDiff reports added/removed/changed paths', () => {
    const d = jsonDiff({ a: 1, b: { c: 'x' }, list: [{ k: 1 }] }, { b: { c: 'y' }, n: true, list: [{ k: 2 }, { k: 3 }] });
    const s = d.map(x => `${x.kind}:${x.path}`).sort();
    assert.deepEqual(s, ['added:list[1]', 'added:n', 'changed:b.c', 'changed:list[0].k', 'removed:a']);
});

test('textDiff reconstructs both sides', () => {
    const a = 'The quick brown fox jumps over the lazy dog.';
    const b = 'The quick red fox leaps over the very lazy dog!';
    const segs = textDiff(a, b);
    assert.equal(segs.filter(s => s.op !== 'ins').map(s => s.text).join(''), a);
    assert.equal(segs.filter(s => s.op !== 'del').map(s => s.text).join(''), b);
    const st = diffStats(segs);
    assert.ok(st.insertedWords >= 3 && st.deletedWords >= 2);
});

test('proposal lifecycle with provenance and stale detection', () => {
    let p = createProject('Test');
    const c = newCharacter('Mira');
    p = upsertArtifact(p, 'characters', c, { action: 'create', summary: 'created' });
    const prop = createProposal(p, { task: 'character.rewrite-field', target: { type: 'characters', id: c.id, path: 'card.data.description' }, after: 'A tired cartographer.', rationale: 'Adds a hook', group: 'g1' });
    const alt = createProposal(p, { task: 'character.rewrite-field', target: { type: 'characters', id: c.id, path: 'card.data.description' }, after: 'A cheerful thief.', group: 'g1' });
    p = addProposals(p, [prop, alt]);
    assert.equal(isProposalStale(p, prop), false);
    p = acceptProposal(p, prop.id, 'A tired, sharp-eyed cartographer.');
    const ch = p.characters[0];
    assert.equal(ch.card.data.description, 'A tired, sharp-eyed cartographer.');
    const accepted = p.proposals.find(x => x.id === prop.id);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.revised, true);
    assert.equal(p.proposals.find(x => x.id === alt.id).status, 'superseded');
    const last = p.history[p.history.length - 1];
    assert.equal(last.actor, 'ai');
    assert.equal(last.proposalId, prop.id);
    // Any later proposal generated against the old text is stale now.
    assert.equal(isProposalStale(p, alt), true);
    assert.throws(() => acceptProposal(p, prop.id));
});

test('reject keeps artifact untouched; creating proposals add new artifacts', () => {
    let p = createProject('Test');
    const newArt = { name: 'World of Ash', data: { entries: {} } };
    const prop = createProposal(p, { task: 'lore.structure', target: { type: 'lorebooks', id: null }, after: newArt });
    const rej = createProposal(p, { task: 'lore.structure', target: { type: 'lorebooks', id: null }, after: { name: 'nope', data: { entries: {} } } });
    p = addProposals(p, [prop, rej]);
    p = rejectProposal(p, rej.id, 'tone');
    p = acceptProposal(p, prop.id);
    assert.equal(p.lorebooks.length, 1);
    assert.equal(p.lorebooks[0].name, 'World of Ash');
    assert.ok(p.lorebooks[0].id);
});

test('edit no-op does not log history; snapshots restore content but keep history', () => {
    let p = createProject('Test');
    const c = newCharacter('A');
    p = upsertArtifact(p, 'characters', c);
    const n = p.history.length;
    p = editArtifactField(p, 'characters', c.id, 'card.data.name', 'A');
    assert.equal(p.history.length, n);
    const snap = makeSnapshot(p, 'before rename');
    p = editArtifactField(p, 'characters', c.id, 'card.data.name', 'B');
    assert.equal(p.characters[0].card.data.name, 'B');
    p = restoreSnapshot(p, snap);
    assert.equal(p.characters[0].card.data.name, 'A');
    assert.ok(p.history.some(h => h.action === 'restore'));
    assert.ok(p.history.some(h => h.path === 'card.data.name'));
});

test('dependency report lists linked, embedded and missing pieces', () => {
    let p = createProject('Deps');
    const c = newCharacter('A');
    c.card.data.character_book = { name: 'Inner', entries: [{ keys: ['x'], content: 'y', enabled: true, insertion_order: 1 }] };
    c.card.data.extensions = { depth_prompt: {}, 'chub/something': {} };
    c.links.lorebooks = ['lb1', 'missing1'];
    p = upsertArtifact(p, 'characters', c);
    p = upsertArtifact(p, 'lorebooks', { id: 'lb1', name: 'World', data: { entries: {} } });
    const [rep] = dependencyReport(p);
    assert.deepEqual(rep.missing, ['lorebooks:missing1']);
    assert.ok(rep.needs.some(n => n.type === 'embedded'));
    assert.ok(rep.needs.some(n => n.type === 'extension-data' && n.name === 'chub/something'));
    p = removeArtifact(p, 'lorebooks', 'lb1');
    assert.deepEqual(p.characters[0].links.lorebooks, ['missing1']);
});

test('migrateProject fills new keys and rejects foreign files', () => {
    const p = createProject('M');
    delete p.media;
    p.futureKey = 42;
    const m = migrateProject(p);
    assert.deepEqual(m.media, []);
    assert.equal(m.futureKey, 42);
    assert.throws(() => migrateProject({ foo: 1 }));
});

test('a repainted sprite replaces the old picture, which leaves the project unless something else still shows it', () => {
    let p = createProject('x');
    const c = newCharacter('Sera');
    for (const id of ['old', 'new', 'avatar', 'new2']) p = upsertArtifact(p, 'media', { id, name: id });
    c.sprites = { joy: 'old', fear: 'avatar' };
    c.avatarMediaId = 'avatar';
    p = upsertArtifact(p, 'characters', c);
    p = setSprite(p, c.id, 'joy', 'new');
    assert.equal(p.characters[0].sprites.joy, 'new');
    assert.ok(!p.media.some(m => m.id === 'old'), 'the replaced sprite is gone');
    p = setSprite(p, c.id, 'fear', 'new2');
    assert.ok(p.media.some(m => m.id === 'avatar'), 'a picture still used as the avatar stays');
    p = setSprite(p, c.id, 'sadness', 'new2');
    assert.deepEqual(p.characters[0].sprites, { joy: 'new', fear: 'new2', sadness: 'new2' }, 'a new slot replaces nothing');
});
