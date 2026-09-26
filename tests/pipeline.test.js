import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProject, findArtifact } from '../src/core/project.js';
import { newRun, runPipeline, retryable, discardRun, STEPS } from '../src/ai/pipeline.js';

const FAKE = {
    'project.premise': { title: 'The Salt Lantern', logline: 'A keeper hides smugglers.', premise: 'A storm-bound island…', setting: 'North isle', tone: 'tense', themes: ['loyalty'], user_role: 'coast guard inspector', central_conflict: 'duty vs family', card_type: 'character', cast: [{ name: 'Eirik', role: 'keeper' }] },
    'character.ideate': { candidates: [{ name: 'Eirik Grimsen', hook: 'Keeper with a secret', voice: 'clipped', contradiction: 'duty/family', motive: 'sister', dynamic: 'wary', pressure: 'storm', openings: ['a', 'b'], tags: ['mystery'] }] },
    'character.expand': { fields: { description: 'A gaunt keeper.', personality: 'wary', scenario: 'Storm night.', first_mes: 'The lamp gutters.', mes_example: '<START>\n{{char}}: Aye.', tags: ['mystery', 'island'] }, rationale: 'ok' },
    'character.greetings': { greetings: [{ situation: 'dawn', text: 'Dawn breaks.' }, { situation: 'group', text: 'All of you.', group_only: true }] },
    'lore.structure': { entries: [{ comment: 'North cove', keys: ['cove'], content: 'Smugglers land here.' }, { comment: 'Lantern', keys: ['lantern'], content: 'Its light signals.' }] },
    'preset.generate-cc': { prompts: [{ name: 'Main', role: 'system', content: 'You are {{char}}.', placement: 'main' }, { name: 'Style', role: 'system', content: 'Third person.', placement: 'in-chat', depth: 2 }], rationale: 'r' },
    'regex.generate': { scripts: [{ scriptName: 'Hide think', findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2], markdownOnly: true, tests: [{ input: '<think>x</think>Hi', expected: 'Hi' }] }] },
    'stscript.generate': { quickReplies: [{ label: 'Continue', message: '/trigger', explanation: 'nudge' }] },
    'media.prompts': { prompts: [{ purpose: 'avatar', prompt: 'gaunt keeper, lantern' }] },
    'character.critique': { strengths: ['voice'], issues: [{ field: 'scenario', severity: 'high', problem: 'thin', suggestion: 'add pressure', replacement: 'Storm night; the inspector arrives.' }, { field: 'lore', severity: 'low', problem: 'x', suggestion: 'y' }] },
};

function harness(overrides = {}) {
    let project = createProject('My first project');
    const calls = [];
    return {
        get project() { return project; },
        calls,
        opts: {
            getProject: () => project,
            update: (fn) => { project = fn(project); },
            runTask: async (task, args) => {
                calls.push({ task, args });
                if (overrides[task] instanceof Error) throw overrides[task];
                const v = typeof overrides[task] === 'function' ? overrides[task](args) : overrides[task];
                return { value: structuredClone(v ?? FAKE[task]), generation: { label: 'fake' } };
            },
        },
    };
}

test('full run builds a linked, complete project', async () => {
    const h = harness();
    const run = await runPipeline({ ...h.opts, run: newRun({ idea: 'lighthouse smugglers', dials: { genre: 'mystery / noir' } }) });
    assert.equal(run.status, 'done');
    const p = h.project;
    assert.equal(p.name, 'The Salt Lantern');
    assert.equal(p.characters.length, 1);
    const c = p.characters[0];
    assert.equal(c.card.data.name, 'Eirik Grimsen');
    assert.equal(c.card.data.description, 'A gaunt keeper.');
    assert.equal(c.card.data.scenario, 'Storm night; the inspector arrives.'); // revised by self-critique
    assert.deepEqual(c.card.data.alternate_greetings, ['Dawn breaks.']);
    assert.deepEqual(c.card.data.group_only_greetings, ['All of you.']);
    assert.equal(c.links.lorebooks.length, 1);
    assert.equal(Object.keys(findArtifact(p, 'lorebooks', c.links.lorebooks[0]).data.entries).length, 2);
    assert.equal(c.links.presets.length, 1);
    const preset = findArtifact(p, 'presets', c.links.presets[0]);
    assert.equal(preset.data.prompts.find(x => x.identifier === 'main').content, 'You are {{char}}.');
    assert.equal(c.card.data.extensions.regex_scripts.length, 1);
    assert.equal(p.regexFixtures.length, 1);
    assert.equal(c.links.qrSets.length, 1);
    assert.equal(c.imagePrompts.length, 1);
    assert.ok(c.critique.notes.length === 1);
    assert.ok(p.history.filter(h2 => h2.actor === 'ai').length > 10);
    assert.equal(p.generationRuns.at(-1).status, 'done');
    // the dials reached the premise task, and the premise reached later tasks
    assert.equal(h.calls[0].args.dials.genre, 'mystery / noir');
    assert.match(h.calls.find(c2 => c2.task === 'lore.structure').args.premise, /Salt Lantern/);
});

test('a failed step blocks its dependents but not independent steps; retry resumes', async () => {
    const h = harness({ 'preset.generate-cc': new Error('model timeout') });
    let run = await runPipeline({ ...h.opts, run: newRun() });
    assert.equal(run.status, 'partial');
    assert.equal(run.steps.preset.status, 'failed');
    assert.equal(run.steps.regex.status, 'blocked'); // depends on preset
    assert.equal(run.steps.lore.status, 'done');
    assert.equal(run.steps.qr.status, 'done');
    // retry with a working model
    const h2opts = { ...h.opts, runTask: async (task, args) => ({ value: structuredClone(FAKE[task]), generation: { label: 'fake' } }) };
    run = await runPipeline({ ...h2opts, run: retryable(run) });
    assert.equal(run.status, 'done');
    assert.equal(h.project.presets.length, 1);
    assert.equal(h.project.characters.length, 1, 'no duplicate character on retry');
});

test('a step that fails once is retried automatically before it counts as failed', async () => {
    let n = 0;
    const h = harness({ 'lore.structure': () => { if (n++ === 0) throw new Error('No answer after 240 s'); return FAKE['lore.structure']; } });
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card', 'lore'] }) });
    assert.equal(run.steps.lore.status, 'done');
    assert.equal(h.calls.filter(c => c.task === 'lore.structure').length, 2);
    assert.equal(h.project.lorebooks.length, 1);
});

test('skipped steps are not run; discard removes created artifacts', async () => {
    const h = harness();
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card', 'lore'] }) });
    assert.equal(run.status, 'done');
    assert.deepEqual(h.calls.map(c => c.task), ['project.premise', 'character.ideate', 'character.expand', 'lore.structure']);
    assert.equal(run.steps.preset.status, 'skipped');
    const after = discardRun(h.project, run);
    assert.equal(after.characters.length, 0);
    assert.equal(after.lorebooks.length, 0);
    assert.equal(after.generationRuns.at(-1).status, 'discarded');
});

test('cancellation stops before the next step', async () => {
    const h = harness();
    const ac = new AbortController();
    const opts = { ...h.opts, runTask: async (task, args) => { if (task === 'character.expand') ac.abort(); return h.opts.runTask(task, args); } };
    const run = await runPipeline({ ...opts, run: newRun(), signal: ac.signal });
    assert.equal(run.status, 'cancelled');
    assert.ok(STEPS.every(s => run.steps[s.id].status !== 'running'));
});

test('fields the model skipped are asked for again, and only those', async () => {
    const partial = { fields: { description: 'A gaunt keeper.', personality: 'wary', scenario: 'Storm night.', tags: ['x'] }, rationale: 'r' };
    const h = harness({
        'character.expand': args => (args.only ? { fields: { first_mes: 'The lamp gutters.', mes_example: '<START>\n{{char}}: Aye.', description: 'SHOULD NOT REPLACE' }, rationale: 'fix' } : partial),
    });
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card'] }) });
    assert.equal(run.steps.card.status, 'done');
    assert.equal(run.steps.card.warning, undefined);
    const expandCalls = h.calls.filter(c => c.task === 'character.expand');
    assert.equal(expandCalls.length, 2);
    assert.deepEqual(expandCalls[1].args.only, ['first_mes', 'mes_example']);
    const d = h.project.characters[0].card.data;
    assert.equal(d.first_mes, 'The lamp gutters.');
    assert.equal(d.description, 'A gaunt keeper.', 'repair pass fills gaps only');
});

test('a model that never writes a field leaves a visible warning, not an endless loop', async () => {
    const h = harness({ 'character.expand': { fields: { description: 'x', scenario: 'y', mes_example: 'z' }, rationale: 'r' } });
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card'] }) });
    assert.equal(run.steps.card.status, 'done');
    assert.match(run.steps.card.warning, /first_mes/);
    assert.equal(h.calls.filter(c => c.task === 'character.expand').length, 3);
});

test('lore titles: short title wins, a sentence-long title falls back to the first key', async () => {
    const { entryTitle } = await import('../src/ai/tasks.js');
    assert.equal(entryTitle({ title: "Serpent's Maw", keys: ['maw'] }), "Serpent's Maw");
    assert.equal(entryTitle({ comment: 'The clandestine mooring point used by the smugglers on moonless nights.', keys: ["Serpent's Maw"] }), "Serpent's Maw");
    assert.equal(entryTitle({ keys: ['cove'] }), 'cove');
});

test('fillOnly never overwrites fields that already have content', async () => {
    const { newCharacter, upsertArtifact } = await import('../src/core/project.js');
    const h = harness();
    const c = newCharacter('Kept Name');
    c.card.data.description = 'Author wrote this.';
    h.opts.update(p => upsertArtifact(p, 'characters', c));
    const run = newRun({ steps: ['card'] });
    run.steps.premise = { status: 'done' };
    run.steps.concept = { status: 'done' };
    run.state = { ...run.state, characterId: c.id, concept: { name: 'Kept Name' }, fillOnly: true };
    await runPipeline({ ...h.opts, run });
    assert.ok(!h.calls[0].args.only.includes('description'), 'only empty fields are requested');
    assert.ok(h.calls[0].args.only.includes('first_mes'));
    const d = h.project.characters[0].card.data;
    assert.equal(d.description, 'Author wrote this.');
    assert.equal(d.name, 'Kept Name');
    assert.equal(d.scenario, 'Storm night.'); // empty field filled
});

test('AI lore keys: "secondary" synonyms become primary keys, so an entry fires on any of them', async () => {
    const { entryKeys } = await import('../src/ai/tasks.js');
    const { simulateActivation, WI_SETTINGS_DEFAULTS } = await import('../src/core/lorebook.js');
    const h = harness({ 'lore.structure': { entries: [{ title: "Serpent's Maw", keys: ["Serpent's Maw"], secondary_keys: ['the Maw', 'hidden cove'], content: 'A cleft in the cliffs.' }] } });
    await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card', 'lore'] }) });
    const world = h.project.lorebooks[0].data;
    const e = Object.values(world.entries)[0];
    assert.deepEqual(e.key, ["Serpent's Maw", 'the Maw', 'hidden cove']);
    assert.deepEqual(e.keysecondary, []);
    const r = simulateActivation({ books: [{ name: 'b', world }], chat: [{ name: 'User', mes: 'Take me to the hidden cove.' }], settings: { ...WI_SETTINGS_DEFAULTS }, maxContext: 8192, generationType: 'normal', probabilityMode: 'assume', random: () => 0.5 });
    assert.equal(r.results.find(x => x.entry.uid === e.uid).status, 'activated');
    assert.deepEqual(entryKeys({ keys: ['a', ' a '], secondary_keys: ['b'] }), ['a', 'b']);
});

test('card drafting requires the fields it asks for (schema-constrained models return the minimum otherwise)', async () => {
    const { getTask, taskSchema, CORE_CARD_FIELDS } = await import('../src/ai/tasks.js');
    const { validate } = await import('../src/ai/schema.js');
    const task = getTask('character.expand');
    assert.deepEqual(taskSchema(task, {}).properties.fields.required, CORE_CARD_FIELDS);
    assert.deepEqual(taskSchema(task, { only: ['first_mes', 'mes_example'] }).properties.fields.required, ['first_mes', 'mes_example']);
    // the real DeepSeek answer that claimed to have written a first message
    const errs = validate(taskSchema(task, { only: ['first_mes', 'mes_example'] }), { fields: { name: 'Kaelen', tags: ['x'] }, rationale: 'The first_mes drops the user into a scene…' });
    assert.deepEqual(errs.map(e => e.path).sort(), ['$.fields.first_mes', '$.fields.mes_example']);
    assert.ok(validate(taskSchema(task, {}), { fields: { description: '', personality: 'p', scenario: 's', first_mes: 'f', mes_example: 'm', tags: ['t'] }, rationale: '' }).some(e => /description/.test(e.path)), 'empty strings fail too');
    // tasks without a per-call schema keep their static one
    assert.equal(taskSchema(getTask('lore.structure'), {}), getTask('lore.structure').schema);
});

test('tags are tidied (no meta tags, no duplicates, at most 8) and greetings ask for the requested count', async () => {
    const { tidyTags, MAX_TAGS, getTask, taskSchema } = await import('../src/ai/tasks.js');
    const many = ['Cyberpunk', 'cyberpunk', ' AI ', 'Thriller', 'SillyTavern', 'Character Card', 'V3', 'Noir', 'Rain', 'Heist', 'Corporate', 'Hunted', 'Paranoia', 'Glitch', 'Extra'];
    const t = tidyTags(many);
    assert.equal(t.length, MAX_TAGS);
    assert.deepEqual(t.slice(0, 3), ['Cyberpunk', 'Thriller', 'Noir']);
    assert.ok(!t.some(x => /sillytavern|card|^v3$|^ai$/i.test(x)));
    assert.equal(taskSchema(getTask('character.greetings'), { count: 3 }).properties.greetings.minItems, 3);
    assert.equal(getTask('character.greetings').schema.properties.greetings.minItems, 1, 'static schema untouched');
    const h = harness({ 'character.expand': { fields: { ...FAKE['character.expand'].fields, tags: many }, rationale: 'r' } });
    await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card'] }) });
    assert.equal(h.project.characters[0].card.data.tags.length, MAX_TAGS);
});

test('review fixes: polish never overwrites an existing character in fill-only mode; its fixes wait as proposals', async () => {
    const { newCharacter, upsertArtifact } = await import('../src/core/project.js');
    const h = harness();
    const c = newCharacter('Kept');
    Object.assign(c.card.data, { description: 'Author text.', scenario: 'Author scenario.', first_mes: 'Hi.', mes_example: '<START>\n{{char}}: Hm.' });
    h.opts.update(p => upsertArtifact(p, 'characters', c));
    const run = newRun({ steps: ['polish'] });
    for (const s of ['premise', 'concept', 'card', 'greetings']) run.steps[s] = { status: 'done' };
    run.state = { ...run.state, characterId: c.id, fillOnly: true };
    await runPipeline({ ...h.opts, run });
    const d = h.project.characters[0].card.data;
    assert.equal(d.scenario, 'Author scenario.');
    const pending = h.project.proposals.filter(p => p.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].target.path, 'card.data.scenario');
});

test('review fixes: a failing repair call keeps what the card step wrote and does not block later steps', async () => {
    const h = harness({
        'character.expand': args => { if (args.only) throw new Error('No answer after 500 s'); return { fields: { description: 'D', personality: 'P', scenario: 'S', first_mes: 'F', tags: ['t'] }, rationale: 'r' }; },
    });
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card', 'greetings'] }) });
    assert.equal(run.steps.card.status, 'done');
    assert.match(run.steps.card.warning, /mes_example.*No answer/);
    assert.equal(run.steps.greetings.status, 'done');
    assert.equal(h.project.characters[0].card.data.description, 'D');
});

test('review fixes: discarding a run removes its links from characters that stay', async () => {
    const { newCharacter, upsertArtifact } = await import('../src/core/project.js');
    const h = harness();
    const c = newCharacter('Kept');
    Object.assign(c.card.data, { description: 'x', scenario: 'y', first_mes: 'z', mes_example: 'm', alternate_greetings: ['a', 'b'] });
    h.opts.update(p => upsertArtifact(p, 'characters', c));
    const run = newRun({ steps: ['lore', 'preset', 'qr'] });
    for (const s of ['premise', 'concept', 'card', 'greetings']) run.steps[s] = { status: 'done' };
    run.state = { ...run.state, characterId: c.id, fillOnly: true };
    const done = await runPipeline({ ...h.opts, run });
    assert.equal(h.project.characters[0].links.lorebooks.length, 1);
    const after = discardRun(h.project, done);
    const links = after.characters[0].links;
    assert.deepEqual([links.lorebooks.length, links.presets.length, links.qrSets.length], [0, 0, 0]);
    assert.equal(after.characters.length, 1, 'the existing character stays');
});

test('review fixes: retrying one step does not re-run other failed steps', async () => {
    const h = harness({ 'lore.structure': new Error('down'), 'media.prompts': new Error('down') });
    let run = await runPipeline({ ...h.opts, run: newRun() });
    assert.equal(run.steps.lore.status, 'failed');
    assert.equal(run.steps.images.status, 'failed');
    const calls = [];
    const ok = { ...h.opts, runTask: async (task, args) => { calls.push(task); return { value: structuredClone(FAKE[task]), generation: {} }; } };
    run = await runPipeline({ ...ok, run: retryable(run, 'lore') });
    assert.deepEqual(calls, ['lore.structure']);
    assert.equal(run.steps.images.status, 'failed');
    assert.equal(run.status, 'partial');
    assert.equal(run.retryOnly, undefined);
});

test('review fixes: no automatic retry after a timeout on the main connection (ST cannot abort that request)', async () => {
    const err = Object.assign(new Error('No answer after 240 s'), { timeout: true, meta: { mode: 'main' } });
    const h = harness({ 'lore.structure': err });
    const run = await runPipeline({ ...h.opts, run: newRun({ steps: ['premise', 'concept', 'card', 'lore'] }) });
    assert.equal(run.steps.lore.status, 'failed');
    assert.equal(h.calls.filter(c => c.task === 'lore.structure').length, 1);
});

test('review fixes: discarding a run that painted a kept character\'s portrait leaves no pointer to it', async () => {
    const { newCharacter, upsertArtifact } = await import('../src/core/project.js');
    const c = newCharacter('Kept', null, { avatarMediaId: 'med_p' });
    c.links.media = ['med_p'];
    let p = upsertArtifact(upsertArtifact(createProject('d'), 'media', { id: 'med_p', name: 'Kept — avatar' }), 'characters', c);
    p = { ...p, generationRuns: [{ id: 'r1', status: 'done' }] };
    const after = discardRun(p, { id: 'r1', state: { created: [{ type: 'media', id: 'med_p' }] } });
    assert.equal(after.media.length, 0);
    assert.equal(after.characters[0].avatarMediaId, '', 'the kept character no longer points at the discarded portrait');
    assert.deepEqual(after.characters[0].links.media, []);
});
