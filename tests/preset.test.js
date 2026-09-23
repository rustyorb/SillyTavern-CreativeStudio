import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    detectKind, normalizeCc, ccOrder, lintCc, assembleCc, sceneFromCard, diffCc, emptyCcPreset, newCustomPrompt, setCcOrder,
    markerKind, stripSensitive, assembleTcFallback, renderStoryStringFallback,
} from '../src/core/preset.js';
import { emptyCardV3 } from '../src/core/card.js';
import { stableStringify } from '../src/core/bytes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = n => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'));
const DEM = join(here, '..', '..', '_refs', 'Deus-ex-machina', 'DEUS EX MACHINA V2.5 ST.json');

test('detects preset kinds like ST master import', () => {
    assert.equal(detectKind(fx('cc-default.json')), 'cc');
    assert.equal(detectKind(fx('instruct-chatml.json')), 'instruct');
    assert.equal(detectKind(fx('context-chatml.json')), 'context');
    assert.equal(detectKind({ name: 'x', content: 'y' }), 'sysprompt');
    assert.equal(detectKind({ temp: 1, top_k: 1, top_p: 1, rep_pen: 1 }), 'textgen');
    assert.equal(detectKind({ name: 'r', prefix: '<think>', suffix: '</think>', separator: '\n' }), 'reasoning');
    assert.equal(detectKind({ version: 1, type: 'full', data: { prompts: [] } }), 'prompt-export');
});

test('ST Default CC preset normalizes, lints clean of errors, and assembles in order', () => {
    const { preset } = normalizeCc(fx('cc-default.json'));
    assert.ok(ccOrder(preset).length >= 10);
    const errors = lintCc(preset).filter(i => i.level === 'error');
    assert.deepEqual(errors, []);
    const card = emptyCardV3('Mira');
    card.data.description = 'A cartographer.';
    card.data.first_mes = 'Hello.';
    const blocks = assembleCc(preset, sceneFromCard(card));
    assert.equal(blocks[0].identifier, 'main');
    assert.ok(blocks.some(b => b.content === 'A cartographer.'));
    assert.ok(blocks.some(b => b.source === 'chat'));
});

test('in-chat injections land at depth with ST same-depth ordering; triggers filter', () => {
    const p = emptyCcPreset();
    const a = { ...newCustomPrompt('A'), content: 'depth2-sys', injection_position: 1, injection_depth: 2, role: 'system', injection_order: 100 };
    const b = { ...newCustomPrompt('B'), content: 'depth2-asst', injection_position: 1, injection_depth: 2, role: 'assistant', injection_order: 100 };
    const c = { ...newCustomPrompt('C'), content: 'only-continue', injection_position: 0, injection_trigger: ['continue'] };
    p.prompts.push(a, b, c);
    const withOrder = setCcOrder(p, [...ccOrder(p), { identifier: a.identifier, enabled: true }, { identifier: b.identifier, enabled: true }, { identifier: c.identifier, enabled: true }]);
    const scene = sceneFromCard(emptyCardV3('X'));
    const blocks = assembleCc(withOrder, scene);
    const chatIdx = blocks.map((x, i) => (x.source === 'chat' ? i : -1)).filter(i => i >= 0);
    const inj = blocks.map((x, i) => (x.source === 'injection' ? i : -1)).filter(i => i >= 0);
    assert.equal(blocks[inj[0]].content, 'depth2-asst'); // assistant before system at same order
    assert.ok(inj[0] > chatIdx[chatIdx.length - 3] && inj[0] < chatIdx[chatIdx.length - 2]); // 2 messages from the end
    assert.ok(!blocks.some(x => x.content === 'only-continue'));
    assert.ok(assembleCc(withOrder, scene, { generationType: 'continue' }).some(x => x.content === 'only-continue'));
});

test('card system prompt overrides main unless forbid_overrides', () => {
    const p = emptyCcPreset();
    const card = emptyCardV3('X');
    card.data.system_prompt = 'CARD {{original}}';
    const blocks = assembleCc(p, sceneFromCard(card));
    assert.match(blocks[0].content, /^CARD Write X's next reply/);
    const p2 = structuredClone(p);
    p2.prompts.find(x => x.identifier === 'main').forbid_overrides = true;
    assert.doesNotMatch(assembleCc(p2, sceneFromCard(card))[0].content, /^CARD/);
});

test('lint flags disabled chat history, missing refs, getvar trailing ::, sensitive keys', () => {
    const p = emptyCcPreset();
    const order = ccOrder(p).map(o => (o.identifier === 'chatHistory' ? { ...o, enabled: false } : o));
    order.push({ identifier: 'ghost', enabled: true });
    let q = setCcOrder(p, order);
    q.prompts.find(x => x.identifier === 'main').content = 'x {{getvar::mood::}}';
    q.proxy_password = 'secret';
    const msgs = lintCc(q).map(i => i.message);
    assert.ok(msgs.some(m => m.startsWith('Chat History is disabled')));
    assert.ok(msgs.some(m => m.includes('"ghost"')));
    assert.ok(msgs.some(m => m.includes('trailing "::"')));
    assert.ok(msgs.some(m => m.includes('sensitive')));
    assert.equal(stripSensitive(q).proxy_password, undefined);
});

test('diffCc reports prompt-level changes', () => {
    const a = emptyCcPreset();
    const b = structuredClone(a);
    b.prompts.find(x => x.identifier === 'main').content = 'changed';
    b.prompts.push(newCustomPrompt('New'));
    b.temperature = 0.7;
    const d = diffCc(a, b);
    assert.ok(d.prompts.some(x => x.kind === 'changed' && x.id === 'main'));
    assert.ok(d.prompts.some(x => x.kind === 'added'));
    assert.ok(d.settings.some(x => x.path === 'temperature'));
});

test('TC fallback renders story string with ChatML templates', () => {
    const out = renderStoryStringFallback('{{#if description}}{{description}}\n{{/if}}{{#if scenario}}S: {{scenario}}\n{{/if}}{{trim}}', { description: 'D', scenario: '' });
    assert.equal(out, 'D');
    const text = assembleTcFallback({ context: fx('context-chatml.json'), instruct: fx('instruct-chatml.json'), sysprompt: { content: 'Be {{char}}.' } }, sceneFromCard(emptyCardV3('Mira')));
    assert.match(text, /<\|im_start\|>user/);
    assert.match(text, /Be Mira\./);
});

test('large community preset (Deus ex Machina) round-trips losslessly and assembles', { skip: !existsSync(DEM) && 'reference preset not present' }, () => {
    const raw = JSON.parse(readFileSync(DEM, 'utf8'));
    const { preset, report } = normalizeCc(raw);
    // Normalization adds nothing when the preset already has a 100001 order and all markers.
    assert.equal(report.filter(r => r.level !== 'info').length, 0);
    for (const k of Object.keys(raw)) assert.equal(stableStringify(preset[k]), stableStringify(raw[k]), `key ${k} unchanged`);
    const dividers = preset.prompts.filter(p => markerKind(p) === 'divider').length;
    assert.ok(dividers > 10);
    const blocks = assembleCc(preset, sceneFromCard(emptyCardV3('Mira')));
    assert.ok(blocks.length > 20);
    assert.equal(preset.extensions.regex_scripts.length, raw.extensions.regex_scripts.length);
    assert.equal(lintCc(preset).filter(i => i.level === 'error').length, 0);
});
