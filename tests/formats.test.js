import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readCardChunks, writeCardChunks, extractChunks, blankPng, isPng } from '../src/core/png.js';
import { normalizeToV3, validateCardV3, toSpecV2, toSpecV3, toSillyTavernShape, detectCardVersion, emptyCardV3, splitExamples, joinExamples, tidyExamples } from '../src/core/card.js';
import { readCharx, writeCharx, suggestedAssetPath } from '../src/core/charx.js';
import { textToBase64, base64ToText, stableStringify } from '../src/core/bytes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => new Uint8Array(readFileSync(join(here, 'fixtures', name)));

test('base64 utf8 round trip handles non-Latin text', () => {
    const s = 'Seraphina — 森の守護者 🌲 "quotes"';
    assert.equal(base64ToText(textToBase64(s)), s);
});

test('reads SillyTavern default Seraphina card (ccv3 wins over chara)', () => {
    const png = fixture('seraphina.png');
    const meta = readCardChunks(png);
    assert.ok(meta.chara || meta.ccv3, 'card chunks present');
    const json = JSON.parse(meta.ccv3 ?? meta.chara);
    assert.equal(json.data?.name ?? json.name, 'Seraphina');
    if (meta.ccv3) assert.equal(meta.winner, 'ccv3');
});

test('PNG write replaces card chunks, preserves image chunks, and round-trips unicode', () => {
    const png = fixture('seraphina.png');
    const before = extractChunks(png).filter(c => c.name !== 'tEXt').map(c => [c.name, c.data.length]);
    const card = emptyCardV3('Ünïcødé 名前');
    card.data.first_mes = 'Hello 👋';
    const written = writeCardChunks(png, { chara: JSON.stringify(toSpecV2(card).card), ccv3: JSON.stringify(card) });
    assert.ok(isPng(written));
    const after = extractChunks(written);
    assert.deepEqual(after.filter(c => c.name !== 'tEXt').map(c => [c.name, c.data.length]), before);
    assert.ok(after.every(c => c.crcOk));
    const meta = readCardChunks(written);
    assert.equal(JSON.parse(meta.ccv3).data.name, 'Ünïcødé 名前');
    assert.equal(JSON.parse(meta.chara).spec, 'chara_card_v2');
    // exactly one of each chunk
    const kws = meta.textKeywords.map(k => k.toLowerCase());
    assert.equal(kws.filter(k => k === 'ccv3').length, 1);
    assert.equal(kws.filter(k => k === 'chara').length, 1);
});

test('blank PNG is valid and accepts card chunks', () => {
    const out = writeCardChunks(blankPng(), { ccv3: JSON.stringify(emptyCardV3('X')) });
    assert.equal(JSON.parse(readCardChunks(out).ccv3).data.name, 'X');
    assert.equal(readCardChunks(out).chara, null);
});

test('normalize preserves unknown fields, extensions and top-level extras (ST card)', () => {
    const meta = readCardChunks(fixture('seraphina.png'));
    const original = JSON.parse(meta.ccv3 ?? meta.chara);
    const { card, topLevelExtras } = normalizeToV3(original);
    assert.equal(card.spec, 'chara_card_v3');
    assert.deepEqual(card.data.extensions, original.data.extensions);
    // Exporting back to ST shape restores every original top-level key.
    const st = toSillyTavernShape(card, topLevelExtras);
    for (const k of Object.keys(original)) assert.ok(k in st, `top-level key ${k} kept`);
    for (const k of Object.keys(original.data)) assert.ok(k in st.data, `data key ${k} kept`);
    assert.deepEqual(st.data.character_book, original.data.character_book);
});

test('V1 cards upgrade to V3 with report', () => {
    const { card, sourceVersion, report } = normalizeToV3({ name: 'Old', description: 'd', first_mes: 'hi', personality: 'p', scenario: 's', mes_example: '', avatar: 'none' });
    assert.equal(sourceVersion, 'v1');
    assert.equal(card.data.name, 'Old');
    assert.deepEqual(card.data.group_only_greetings, []);
    assert.ok(report.some(r => r.message.includes('V1')));
});

test('detects versions', () => {
    assert.equal(detectCardVersion(emptyCardV3('a')), 'v3');
    assert.equal(detectCardVersion({ spec: 'chara_card_v2', data: { name: 'a' } }), 'v2');
    assert.equal(detectCardVersion({ foo: 1 }), 'unknown');
});

test('validation flags spec problems', () => {
    const c = emptyCardV3('A');
    c.data.creation_date = Date.now(); // milliseconds, spec wants seconds
    c.data.assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }, { type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'PNG' }];
    c.data.character_book = { entries: [{ keys: ['a'], content: 'x', enabled: true, insertion_order: 1, use_regex: 'yes' }] };
    const issues = validateCardV3(c);
    const paths = issues.map(i => `${i.level}:${i.path}`);
    assert.ok(paths.includes('warn:data.creation_date'));
    assert.ok(paths.includes('error:data.assets'));
    assert.ok(paths.includes('warn:data.assets[1].ext'));
    assert.ok(paths.includes('error:data.character_book.entries[0].use_regex'));
});

test('V2 export reports V3-only data it drops', () => {
    const c = emptyCardV3('A');
    c.data.nickname = 'Ace';
    c.data.group_only_greetings = ['hey all'];
    const { card, dropped } = toSpecV2(c);
    assert.equal(card.data.nickname, undefined);
    assert.deepEqual(dropped.sort(), ['group_only_greetings', 'nickname']);
});

test('spec V3 export defaults use_regex and extensions on book entries', () => {
    const c = emptyCardV3('A');
    c.data.character_book = { entries: [{ keys: ['k'], content: 'c', enabled: true, insertion_order: 0 }] };
    const v3 = toSpecV3(c);
    assert.equal(v3.data.character_book.entries[0].use_regex, false);
    assert.deepEqual(v3.data.character_book.entries[0].extensions, {});
});

test('CHARX round trip keeps card, assets and unknown files', () => {
    const c = emptyCardV3('Zip');
    const iconPath = suggestedAssetPath('icon', 'main', 'png');
    c.data.assets = [
        { type: 'icon', uri: `embeded://${iconPath}`, name: 'main', ext: 'png' },
        { type: 'background', uri: 'ccdefault:', name: 'main', ext: 'png' },
    ];
    c.data.extensions = { 'some/ext': { keep: true } };
    const icon = fixture('seraphina.png');
    const extra = new TextEncoder().encode('risu module bytes');
    const { bytes, diagnostics } = writeCharx(c, { [iconPath]: icon, 'module.risum': extra });
    assert.deepEqual(diagnostics, []);
    const back = readCharx(bytes);
    assert.equal(back.card.data.name, 'Zip');
    assert.deepEqual(back.card.data.extensions, { 'some/ext': { keep: true } });
    const iconAsset = back.assets.find(a => a.asset.type === 'icon');
    assert.equal(iconAsset.bytes.length, icon.length);
    assert.ok(back.files['module.risum']);
    assert.ok(back.diagnostics.some(d => d.includes('unreferenced')));
    // Stable re-export produces the same card JSON.
    const again = readCharx(writeCharx(back.card, back.files).bytes);
    assert.equal(stableStringify(again.card), stableStringify(back.card));
});

test('CHARX missing asset file is diagnosed, not fatal', () => {
    const c = emptyCardV3('Zip');
    c.data.assets = [{ type: 'icon', uri: 'embeded://assets/icon/images/nope.png', name: 'main', ext: 'png' }];
    const { bytes, diagnostics } = writeCharx(c, {});
    assert.equal(diagnostics.length, 1);
    const back = readCharx(bytes);
    assert.ok(back.diagnostics.some(d => d.includes('missing')));
});

test('example dialogue split/join', () => {
    const ex = '<START>\n{{user}}: hi\n{{char}}: yo\n<START>\n{{char}}: second';
    const parts = splitExamples(ex);
    assert.equal(parts.length, 2);
    assert.deepEqual(splitExamples(joinExamples(parts)), parts);
});

test('tidyExamples repairs the slips models make (real output from a DeepSeek run)', () => {
    const raw = "<START>\n{{system}} The lantern room during a storm.\n{{user}} I heard a radio transmission earlier.\n{{char}} My hand stills. \"Static. Fishing boats.\"\n<START>\n{{system}} Cillian is in the supply room.\n{{user}} The pantries are full.\nCillian: \"We look after our own.\"";
    const t = tidyExamples(raw, 'Cillian');
    assert.equal(t, '<START>\n{{char}}: *The lantern room during a storm.*\n{{user}}: I heard a radio transmission earlier.\n{{char}}: My hand stills. "Static. Fishing boats."\n<START>\n{{char}}: *Cillian is in the supply room.*\n{{user}}: The pantries are full.\n{{char}}: "We look after our own."');
    assert.ok(!/\{\{system\}\}/.test(t));
    // narration merges into a following {{char}} line; clean input is unchanged; missing <START> is added
    assert.equal(tidyExamples('{{system}}: Night.\n{{char}}: "Go."'), '<START>\n{{char}}: *Night.* "Go."');
    const clean = '<START>\n{{user}}: hi\n{{char}}: yo';
    assert.equal(tidyExamples(clean), clean);
    assert.equal(tidyExamples(''), '');
});

test('tidyExamples splits a speaker label glued onto the previous line (real DeepSeek output)', () => {
    const raw = '<START>\n{{user}}: Who are you? Why are you helping me?{{char}}: *Static.* I am Nexus.';
    assert.equal(tidyExamples(raw), '<START>\n{{user}}: Who are you? Why are you helping me?\n{{char}}: *Static.* I am Nexus.');
    assert.equal(tidyExamples('<START>\n{{user}}: A program.<br>\n{{char}}: No.'), '<START>\n{{user}}: A program.\n{{char}}: No.');
});

test('tidyExamples leaves prose that starts with a macro alone ("{{char}}\'s voice…")', () => {
    const raw = "<START>\n{{char}}: Hm.\n{{char}}'s voice is cold.\n{{user}}s bag falls.";
    assert.equal(tidyExamples(raw), raw);
});

test('detectImportKind tells character cards from studio projects and plain pictures', async () => {
    const { detectImportKind } = await import('../src/core/bundle.js');
    const { exportCard } = await import('../src/core/cardio.js');
    const { createProject } = await import('../src/core/project.js');
    const { zipSync } = await import('../vendor/fflate.mjs');
    const enc = o => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
    assert.equal(detectImportKind(fixture('seraphina.png'), 'seraphina.png'), 'card');
    assert.equal(detectImportKind(blankPng(), 'plain.png'), 'image', 'a PNG without card data is just a picture');
    assert.equal(detectImportKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]), 'photo.jpg'), 'image');
    assert.equal(detectImportKind(enc({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'A' } }), 'a.json'), 'card');
    assert.equal(detectImportKind(enc({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'A' } }), 'a.json'), 'card');
    assert.equal(detectImportKind(enc({ name: 'B', description: 'd', first_mes: 'hi' }), 'b.json'), 'card', 'V1 card');
    assert.equal(detectImportKind(exportCard('charx', { card: emptyCardV3('C') }).bytes, 'c.charx'), 'card');
    const project = enc(createProject('P'));
    assert.equal(detectImportKind(project, 'p.studio.json'), 'project');
    assert.equal(detectImportKind(zipSync({ 'project.studio.json': project }), 'bundle.zip'), 'project');
    assert.equal(detectImportKind(enc({ entries: {} }), 'world.json'), 'unknown');
    assert.equal(detectImportKind(enc('not json at all'), 'notes.txt'), 'unknown');
    assert.equal(detectImportKind(zipSync({ 'readme.txt': enc('x') }), 'other.zip'), 'unknown');
    assert.equal(detectImportKind(enc('name: C'), 'c.yaml'), 'card', 'YAML goes to the card importer, which explains how to bring it in');
});

test('detectImportKind: a damaged PNG goes to the card importer (which explains), a lorebook is not a card, a spec-less card is', async () => {
    const { detectImportKind } = await import('../src/core/bundle.js');
    const enc = o => new TextEncoder().encode(JSON.stringify(o));
    assert.equal(detectImportKind(fixture('seraphina.png').slice(0, 200), 'half.png'), 'card', 'no exception on a truncated PNG');
    assert.equal(detectImportKind(enc({ name: 'Eldoria', description: 'A world', entries: { 0: { key: ['x'] } } }), 'world.json'), 'unknown');
    assert.equal(detectImportKind(enc({ data: { name: 'Nia', description: 'd' } }), 'nia.json'), 'card');
});
