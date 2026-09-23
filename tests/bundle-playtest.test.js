import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8 } from '../vendor/fflate.mjs';

import { createProject, newCharacter, upsertArtifact } from '../src/core/project.js';
import { buildBundle } from '../src/core/bundle.js';
import { buildSandboxTurn, processReply, newScenario } from '../src/core/playtest.js';
import { newEntry } from '../src/core/lorebook.js';
import { defaultScript } from '../src/core/regex.js';
import { emptyCcPreset } from '../src/core/preset.js';
import { newSet, addQr } from '../src/core/qr.js';
import { importCardFile } from '../src/core/cardio.js';

function sampleProject() {
    let p = createProject('Lighthouse');
    const c = newCharacter('Eirik');
    c.card.data.description = 'A lighthouse keeper.';
    c.card.data.first_mes = 'The lamp gutters. (OOC: hi)';
    c.card.data.extensions.regex_scripts = [{ ...defaultScript('hide ooc'), findRegex: '/\\(OOC:.*?\\)/g', replaceString: '', markdownOnly: false, promptOnly: false, placement: [2] }];
    const world = { entries: {} };
    const e = newEntry(world, { comment: 'Smugglers', key: ['smuggler'], content: 'Smugglers use the north cove.' });
    world.entries[e.uid] = e;
    const lb = { id: 'lb1', name: 'Coast', data: world };
    c.links.lorebooks = ['lb1'];
    p = upsertArtifact(p, 'characters', c);
    p = upsertArtifact(p, 'lorebooks', lb);
    p = upsertArtifact(p, 'presets', { id: 'pr1', kind: 'cc', name: 'RP', data: emptyCcPreset(), versions: [] });
    const qs = addQr(newSet('Tools'), { label: 'Roll', message: '/echo {{roll:d20}}' }).set;
    p = upsertArtifact(p, 'qrSets', { id: 'q1', name: 'Tools', data: qs, links: { global: true, characters: [c.id] } });
    p = upsertArtifact(p, 'regexScripts', { id: 'rx1', scope: 'global', script: defaultScript('g') });
    return { p, c };
}

test('bundle contains ST-native files, manifest and README that round-trip', () => {
    const { p } = sampleProject();
    const { files, manifest } = buildBundle(p, { includeCharx: true });
    const paths = Object.keys(files).sort();
    for (const want of ['characters/Eirik.png', 'characters/Eirik.charx', 'worlds/Coast.json', 'presets/OpenAI Settings/RP.json', 'quick-replies/Tools.json', 'regex/global-regex.json', 'manifest.json', 'README.md', 'project.studio.json']) {
        assert.ok(paths.includes(want), `bundle has ${want}`);
    }
    const back = unzipSync(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]]))));
    const card = importCardFile(back['characters/Eirik.png'], 'Eirik.png');
    assert.equal(card.card.data.name, 'Eirik');
    assert.equal(JSON.parse(strFromU8(back['worlds/Coast.json'])).entries[0].comment, 'Smugglers');
    const readme = strFromU8(back['README.md']);
    assert.match(readme, /World Info panel → Import/);
    assert.match(readme, /character “Eirik”/);
    assert.equal(manifest.entries.find(e => e.type === 'character').scopedRegex, 1);
});

test('sandbox turn: prompt-stage regex, lore activation and reproducible config', () => {
    const { p, c } = sampleProject();
    const base = { characterId: c.id, presetId: 'pr1' };
    // ST stores the greeting after the AI-output "saved" regex stage (script.js first-message call site).
    const greeting = processReply(p, base, c.card.data.first_mes).stored;
    const cfg = { ...base, chat: [{ role: 'assistant', text: greeting }, { role: 'user', text: 'Tell me about the smuggler boats.' }] };
    const t = buildSandboxTurn(p, cfg);
    assert.ok(t.activation.activated.some(a => a.comment === 'Smugglers'));
    assert.ok(t.messages.some(m => m.content.includes('Smugglers use the north cove.')));
    assert.ok(!t.messages.some(m => m.content.includes('(OOC: hi)')));
    assert.equal(t.config.preset.name, 'RP');
    assert.ok(t.config.character.cardHash);
    const r = processReply(p, cfg, 'Fine. (OOC: brb) The boats.');
    assert.equal(r.stored, 'Fine.  The boats.');
    assert.ok(newScenario('Opening', c.id).userTurns.length >= 2);
});
