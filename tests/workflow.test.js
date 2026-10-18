import test from 'node:test';
import assert from 'node:assert/strict';
import { characterProgress, GENERATION_PRESETS } from '../src/core/workflow.js';
import { newCharacter, createProject, upsertArtifact, migrateProject } from '../src/core/project.js';
import { createStore } from '../src/ui/store.js';
import { STEPS, DEFAULT_STEPS, newRun } from '../src/ai/pipeline.js';

test('workflow guides a blank character to name, writing, then its opening', () => {
    const c = newCharacter('New character');
    assert.equal(characterProgress(c).complete, 0);
    c.card.data.name = 'Mara';
    c.card.data.description = 'A night-shift archivist.';
    c.card.data.scenario = 'A visitor returns a book from tomorrow.';
    assert.equal(characterProgress(c).next.tab, 'greetings');
    c.card.data.first_mes = 'Where did you get that book?';
    assert.equal(characterProgress(c).ready, true);
    assert.equal(characterProgress(c).complete, 4);
    assert.ok(!c.avatarMediaId, 'pictures are not required');
    assert.deepEqual(c.links.lorebooks, [], 'world building is optional');
});

test('whitespace and placeholder names do not count as written basics', () => {
    const c = newCharacter('New scenario');
    c.card.data.description = '  \n  ';
    assert.equal(characterProgress(c).complete, 0);
    assert.equal(characterProgress(null).ready, false);
});

test('every generation preset includes all prerequisites and a valid runnable card path', () => {
    for (const preset of GENERATION_PRESETS) {
        const steps = preset.steps ?? DEFAULT_STEPS;
        for (const id of steps) {
            const step = STEPS.find(s => s.id === id);
            assert.ok(step, `${preset.id}: valid step ${id}`);
            for (const required of step.needs) assert.ok(steps.includes(required), `${preset.id}: ${id} needs ${required}`);
        }
        const run = newRun({ idea: 'A night-shift archivist.', steps });
        assert.equal(run.steps.card.status, 'pending');
        assert.equal(run.steps.premise.status, 'pending');
    }
});

test('generation draft and scope survive serialization and undo without altering characters', () => {
    const project = upsertArtifact(createProject('Draft'), 'characters', newCharacter('Existing'));
    const store = createStore(project);
    store.update(p => ({ ...p, generationDraft: 'A lost observatory', generationSteps: GENERATION_PRESETS[1].steps }), 'generation draft');
    const loaded = migrateProject(JSON.parse(JSON.stringify(store.get())));
    assert.equal(loaded.generationDraft, 'A lost observatory');
    assert.deepEqual(loaded.generationSteps, GENERATION_PRESETS[1].steps);
    assert.deepEqual(loaded.characters, project.characters);
    store.undo();
    assert.equal(store.get().generationDraft, undefined);
    assert.deepEqual(store.get().characters, project.characters);
});
