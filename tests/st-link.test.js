import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8 } from '../vendor/fflate.mjs';

import { createProject, newCharacter, upsertArtifact, cardForSt, stWorldName } from '../src/core/project.js';
import { buildBundle } from '../src/core/bundle.js';
import { importCardFile } from '../src/core/cardio.js';
import { spriteFolderFor, pickSprites } from '../src/core/sprites.js';

function withLorebook(name, origin) {
    let p = createProject('Coast');
    const c = newCharacter('Eirik');
    const lb = { id: 'lb1', name, data: { entries: {} }, ...(origin ? { origin } : {}) };
    c.links.lorebooks = ['lb1'];
    p = upsertArtifact(p, 'lorebooks', lb);
    p = upsertArtifact(p, 'characters', c);
    return { p, c: p.characters[0], lb };
}

test('stWorldName: the file name SillyTavern gives a lorebook; pulled books keep their ST name', () => {
    assert.equal(stWorldName({ name: 'Glitch: the World?' }), 'Glitch the World');
    assert.equal(stWorldName({ name: 'The Glitch That Gnaws — World' }), 'The Glitch That Gnaws — World');
    assert.equal(stWorldName({ name: 'Renamed here', origin: { kind: 'st', name: 'Eldoria' } }), 'Eldoria');
});

test('cardForSt: the first linked lorebook becomes the card\'s World Info link, without touching the project', () => {
    const { p, c } = withLorebook('Coast: North');
    const card = cardForSt(p, c);
    assert.equal(card.data.extensions.world, 'Coast North');
    assert.equal(c.card.data.extensions.world, undefined, 'project card unchanged');
});

test('cardForSt: a card that already names its lorebook, or has none linked, is left alone', () => {
    const { p, c } = withLorebook('Coast');
    const named = { ...c, card: { ...c.card, data: { ...c.card.data, extensions: { ...c.card.data.extensions, world: 'Eldoria' } } } };
    assert.equal(cardForSt(p, named).data.extensions.world, 'Eldoria');
    const alone = { ...c, links: { ...c.links, lorebooks: [] } };
    assert.equal(cardForSt(p, alone), alone.card);
    const dangling = { ...c, links: { ...c.links, lorebooks: ['gone'] } };
    assert.equal(cardForSt(p, dangling), dangling.card);
});

test('bundle: each card names its lorebook by the bundle file name and the README says the link is made', () => {
    const { p } = withLorebook('Coast: North');
    const { files, manifest } = buildBundle(p);
    const back = unzipSync(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]]))));
    const world = Object.keys(back).find(k => k.startsWith('worlds/'));
    const card = importCardFile(back['characters/Eirik.png'], 'Eirik.png').card;
    assert.equal(`worlds/${card.data.extensions.world}.json`, world);
    assert.deepEqual(manifest.entries.find(e => e.type === 'lorebook').linkedBy, ['Eirik']);
    assert.match(strFromU8(back['README.md']), /Eirik already names it as its lorebook/);
});

test('spriteFolderFor: the character name, unless Character Expressions has an override for the avatar file', () => {
    assert.equal(spriteFolderFor('Seraphina.png', 'Seraphina'), 'Seraphina');
    assert.equal(spriteFolderFor('default_Seraphina.png', 'Seraphina', [{ name: 'default_Seraphina', path: 'Sera/winter' }]), 'Sera/winter');
    assert.equal(spriteFolderFor('Other.png', 'Other', [{ name: 'default_Seraphina', path: 'Sera' }]), 'Other');
    assert.equal(spriteFolderFor('x.png', 'X', [{ name: 'x', path: '' }]), 'X');
});

test('pickSprites: one picture per expression, the plain file over its variants', () => {
    const got = pickSprites([
        { label: 'joy', path: '/characters/Sera/joy-2.png?t=1' },
        { label: 'joy', path: '/characters/Sera/joy.png?t=2' },
        { label: 'anger', path: '/characters/Sera/anger.expressive.webp' },
        { label: 'anger', path: '/characters/Sera/anger-1.png' },
        { label: '', path: '/characters/Sera/.png' },
        { label: 'fear' },
    ]);
    assert.deepEqual(got, { joy: '/characters/Sera/joy.png?t=2', anger: '/characters/Sera/anger.expressive.webp' });
});
