import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    normalizeWorld, newEntry, nextUid, lintWorld, characterBookToWorld, worldToCharacterBook, simulateActivation,
    matchKey, parseRegexKey, entriesOf, WI_SETTINGS_DEFAULTS, POSITION,
} from '../src/core/lorebook.js';

const here = dirname(fileURLToPath(import.meta.url));
const eldoria = JSON.parse(readFileSync(join(here, 'fixtures', 'eldoria-worldinfo.json'), 'utf8'));

test('normalize fills 1.19 defaults on the older shipped Eldoria book, keeping values', () => {
    const { world } = normalizeWorld(eldoria);
    const e = world.entries['0'];
    assert.equal(e.selectiveLogic, 0);
    assert.deepEqual(e.triggers, []);
    assert.deepEqual(e.key, eldoria.entries['0'].key);
    assert.equal(e.content, eldoria.entries['0'].content);
});

test('uid allocation is lowest free', () => {
    const w = { entries: { 0: { uid: 0 }, 2: { uid: 2 } } };
    assert.equal(nextUid(w), 1);
    assert.equal(newEntry(w, { comment: 'x' }).uid, 1);
});

test('regex keys and whole-word matching mirror ST', () => {
    const s = { ...WI_SETTINGS_DEFAULTS };
    assert.ok(parseRegexKey('/drag(on|ons)/i'));
    assert.equal(parseRegexKey('/a/b/'), null); // unescaped delimiter
    assert.equal(matchKey('\x01The Dragons fly', '/drag(on|ons)/i', {}, s), true);
    assert.equal(matchKey('\x01forestry club', 'forest', {}, s), false); // whole words on by default
    assert.equal(matchKey('\x01the forest, dark', 'forest', {}, s), true);
    assert.equal(matchKey('\x01forestry club', 'forest', { matchWholeWords: false }, s), true);
    assert.equal(matchKey('\x01magical forest here', 'magical forest', {}, s), true);
    assert.equal(matchKey('\x01Forest', 'forest', { caseSensitive: true }, s), false);
});

test('lint catches unreachable entries, bad regex, unsupported decorators, outlet w/o name', () => {
    const w = { entries: {} };
    w.entries[0] = newEntry(w, { comment: 'nokeys', content: 'x' });
    w.entries[1] = newEntry(w, { key: ['/bad/regex/'], content: 'y' });
    w.entries[2] = newEntry(w, { key: ['k'], content: '@@depth 3\nz' });
    w.entries[3] = newEntry(w, { key: ['kk'], content: 'q', position: POSITION.outlet });
    const msgs = lintWorld(w).map(i => `${i.level}:${i.path}`);
    assert.ok(msgs.includes('warn:#0.key'));
    assert.ok(msgs.includes('error:#1.key'));
    assert.ok(msgs.includes('warn:#2.content'));
    assert.ok(msgs.includes('error:#3.outletName'));
});

test('character_book <-> world round trip preserves ST fields', () => {
    const { world } = normalizeWorld(eldoria);
    const { book } = worldToCharacterBook('Eldoria', world);
    assert.equal(book.entries.length, Object.keys(world.entries).length);
    assert.equal(book.entries[0].use_regex, false); // plain keys → honest use_regex
    const back = characterBookToWorld(book);
    for (const [uid, e] of Object.entries(world.entries)) {
        const b = back.entries[uid];
        for (const f of ['key', 'keysecondary', 'comment', 'content', 'constant', 'order', 'position', 'disable', 'probability', 'depth', 'group', 'selectiveLogic']) {
            assert.deepEqual(b[f], e[f], `field ${f} of #${uid}`);
        }
    }
});

test('activation simulation explains hits, misses, recursion and budget', () => {
    const w = { entries: {} };
    const add = o => { const e = newEntry(w, o); w.entries[e.uid] = e; return e; };
    const forest = add({ comment: 'Forest', key: ['forest'], content: 'The forest hides the Shadowfang lair.', order: 50 });
    const fang = add({ comment: 'Shadowfangs', key: ['shadowfang'], content: 'Shadowfangs are wolves.', order: 60 });
    const rule = add({ comment: 'Rule', constant: true, content: 'Magic has a price.', order: 10 });
    const sec = add({ comment: 'Lake', key: ['lake'], keysecondary: ['bitter'], selectiveLogic: 0, content: 'The lake turned bitter.' });
    const off = add({ comment: 'Off', key: ['forest'], disable: true, content: 'nope' });
    const chat = [{ name: 'User', mes: 'I walk into the forest by the lake.' }];
    const r = simulateActivation({ books: [{ name: 'W', world: w }], chat, maxContext: 8000 });
    const status = uid => r.results.find(x => x.entry.uid === uid)?.status;
    assert.equal(status(forest.uid), 'activated');
    assert.equal(status(rule.uid), 'activated');
    assert.equal(status(fang.uid), 'activated'); // via recursion from forest content
    assert.equal(r.activated.find(a => a.uid === fang.uid).via, 'recursion');
    assert.equal(status(sec.uid), 'miss'); // secondary "bitter" absent
    assert.equal(status(off.uid), 'skipped');
    // placement: before-position list is ascending by order
    const before = r.placed[0].map(a => a.entry.order);
    assert.deepEqual(before, [...before].sort((a, b) => a - b));
    // Without recursion, Shadowfangs is not reached.
    const r2 = simulateActivation({ books: [{ name: 'W', world: w }], chat, settings: { recursive: false } });
    assert.equal(r2.results.find(x => x.entry.uid === fang.uid).status, 'miss');
    // Tiny budget → overflow reported.
    const r3 = simulateActivation({ books: [{ name: 'W', world: w }], chat, maxContext: 40, settings: { budget: 25 } });
    assert.ok(r3.overflowed);
    assert.ok(r3.results.some(x => x.status === 'budget'));
});

test('inclusion groups pick one winner (override by order)', () => {
    const w = { entries: {} };
    const add = o => { const e = newEntry(w, o); w.entries[e.uid] = e; return e; };
    const a = add({ comment: 'A', key: ['x'], group: 'g', groupOverride: true, order: 10, content: 'a' });
    const b = add({ comment: 'B', key: ['x'], group: 'g', groupOverride: true, order: 90, content: 'b' });
    const r = simulateActivation({ books: [{ name: 'W', world: w }], chat: [{ name: 'U', mes: 'x' }], settings: { recursive: false } });
    assert.equal(r.results.find(x => x.entry.uid === b.uid).status, 'activated');
    assert.equal(r.results.find(x => x.entry.uid === a.uid).status, 'group-lost');
});

test('Eldoria activates on its own keys', () => {
    const { world } = normalizeWorld(eldoria);
    const r = simulateActivation({ books: [{ name: 'Eldoria', world }], chat: [{ name: 'User', mes: 'Tell me about Eldoria.' }] });
    assert.ok(r.activated.length >= 1);
    assert.ok(entriesOf(world).length > r.activated.length || r.activated.length === entriesOf(world).length);
});
