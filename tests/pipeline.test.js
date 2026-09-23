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
                return { value: structuredClone(overrides[task] ?? FAKE[task]), generation: { label: 'fake' } };
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
    const d = h.project.characters[0].card.data;
    assert.equal(d.description, 'Author wrote this.');
    assert.equal(d.name, 'Kept Name');
    assert.equal(d.scenario, 'Storm night.'); // empty field filled
});
