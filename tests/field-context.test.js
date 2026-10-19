import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precedingFields, selectedContextFields, CHARACTER_FIELD_ORDER } from '../src/core/field-context.js';
import { buildTask } from '../src/ai/tasks.js';
import { createProject, newCharacter, editArtifactField } from '../src/core/project.js';
import { createStore } from '../src/ui/store.js';
import { characterContext } from '../src/ui/field-context.js';
import { STEPS } from '../src/ai/pipeline.js';

function fixture() {
    const project = createProject('Context test');
    const ch = newCharacter('Context name');
    for (const [field] of CHARACTER_FIELD_ORDER) ch.card.data[field] = `${field}_UNIQUE_VALUE`;
    ch.card.data.alternate_greetings = ['alternate_UNIQUE_VALUE'];
    ch.card.data.group_only_greetings = ['group_UNIQUE_VALUE'];
    ch.card.data.nickname = 'nickname_MUST_NOT_LEAK';
    project.characters = [ch, newCharacter('Other character')];
    return { project, ch, store: createStore(project) };
}

test('field generation defaults to every preceding field in authoring order for both card versions', () => {
    for (const spec of ['chara_card_v2', 'chara_card_v3']) {
        const { ch } = fixture();
        ch.card.spec = spec;
        for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) {
            const previous = precedingFields(field).map(([key]) => key);
            assert.deepEqual(selectedContextFields(ch, field), previous);
            for (const task of ['character.rewrite-field', 'character.extend-field']) {
                const { user } = buildTask(task, { card: ch.card, field, instruction: 'MY_DIRECTION', count: 3 });
                for (const [key] of CHARACTER_FIELD_ORDER.filter(([key]) => typeof ch.card.data[key] === 'string')) {
                    assert.equal(user.includes(ch.card.data[key]), previous.includes(key) || key === field, `${spec}, ${task}, ${field}: ${key}`);
                }
                assert.ok(user.includes('MY_DIRECTION'));
                assert.ok(!user.includes(ch.card.data.nickname));
            }
        }
    }
});

test('unchecked, unknown and later fields cannot leak through a full-card digest; no-context is intentional', () => {
    const { ch } = fixture();
    for (const task of ['character.rewrite-field', 'character.extend-field']) {
        for (const contextFields of [[], ['personality', 'first_mes', 'nickname', 'unknown']]) {
            const { user } = buildTask(task, { card: ch.card, field: 'scenario', contextFields, instruction: 'MY_DIRECTION' });
            assert.ok(!user.includes(ch.card.data.name));
            assert.ok(!user.includes(ch.card.data.description));
            assert.ok(!user.includes(ch.card.data.first_mes));
            assert.ok(!user.includes(ch.card.data.nickname));
            assert.equal(user.includes(ch.card.data.personality), contextFields.includes('personality'));
            assert.ok(user.includes(ch.card.data.scenario));
            assert.ok(user.includes('MY_DIRECTION'));
        }
    }
});

test('selected fields are sent in full rather than silently shortened', () => {
    const { ch } = fixture();
    ch.card.data.description = 'Long backstory. '.repeat(600) + 'END_OF_DESCRIPTION';
    const { user } = buildTask('character.rewrite-field', { card: ch.card, field: 'personality', contextFields: ['description'] });
    assert.ok(user.includes(ch.card.data.description));
    assert.equal(user.split('END_OF_DESCRIPTION').length, 2);
});

test('field context survives save/reopen, is isolated by field and character, and reads latest edits when sent', () => {
    const { project, ch, store } = fixture();
    const context = characterContext({ store, project, ch, field: 'scenario' });
    store.update(p => editArtifactField(p, 'characters', ch.id, 'aiContextExcluded.scenario', ['description']), 'context');
    store.update(p => editArtifactField(p, 'characters', ch.id, 'card.data.personality', 'LATEST_TEXT'), 'edit personality');
    const reopened = JSON.parse(JSON.stringify(store.get()));
    assert.deepEqual(selectedContextFields(reopened.characters[0], 'scenario'), ['name', 'personality']);
    assert.deepEqual(selectedContextFields(reopened.characters[0], 'personality'), ['name', 'description']);
    assert.deepEqual(selectedContextFields(reopened.characters[1], 'scenario'), ['name', 'description', 'personality']);
    assert.equal(context.args().card.data.personality, 'LATEST_TEXT');
    assert.deepEqual(context.args().contextFields, ['name', 'personality']);
    assert.equal(reopened.characters[0].card.data.aiContextExcluded, undefined);
    store.reset(createProject('Other project'));
    assert.throws(() => context.args(), /no longer open/);
});

test('alternate opening generation uses selected earlier fields and current openings without later metadata', () => {
    const { ch } = fixture();
    const { user } = buildTask('character.greetings', { card: ch.card, contextFields: ['description'], direction: 'MY_DIRECTION' });
    assert.ok(user.includes(ch.card.data.description));
    assert.ok(user.includes(ch.card.data.alternate_greetings[0]));
    assert.ok(user.includes('MY_DIRECTION'));
    assert.ok(!user.includes(ch.card.data.name));
    assert.ok(!user.includes(ch.card.data.first_mes));
    assert.ok(!user.includes(ch.card.data.group_only_greetings[0]));
    assert.ok(!user.includes(ch.card.data.nickname));
});

test('priority voice direction reaches dialogue rewrites, additions and openings independently of context boxes', () => {
    const { ch, store, project } = fixture();
    const voiceDirection = 'Clipped London accent. End questions with yeah?';
    store.update(p => editArtifactField(p, 'characters', ch.id, 'voiceDirection', voiceDirection), 'voice');
    for (const field of ['mes_example', 'first_mes']) {
        const args = characterContext({ store, project, ch, field }).args();
        for (const task of ['character.rewrite-field', 'character.extend-field']) {
            const { system, user } = buildTask(task, { ...args, contextFields: [], instruction: 'A tense reunion', count: 3 });
            assert.match(system, /VOICE DIRECTION — highest priority/);
            assert.match(system, /takes precedence over conflicting accent/);
            assert.ok(system.includes(voiceDirection));
            assert.ok(user.includes('A tense reunion'));
            assert.ok(!user.includes(ch.card.data.description));
        }
    }
    const greetings = buildTask('character.greetings', characterContext({ store, project, ch, field: 'alternate_greetings' }).args());
    assert.ok(greetings.system.includes(voiceDirection));
    const personality = buildTask('character.rewrite-field', { card: ch.card, field: 'personality', voiceDirection });
    assert.ok(!personality.system.includes(voiceDirection));
    assert.ok(!buildTask('character.rewrite-field', { card: ch.card, field: 'mes_example', voiceDirection: '  ' }).system.includes('VOICE DIRECTION'));
    const reopened = JSON.parse(JSON.stringify(store.get()));
    assert.equal(reopened.characters[0].voiceDirection, voiceDirection);
    assert.equal(reopened.characters[1].voiceDirection, undefined);
    assert.equal(reopened.characters[0].card.data.voiceDirection, undefined);
});

test('developing an existing character carries its priority voice into card drafts and alternate openings', () => {
    const { project, ch } = fixture();
    ch.voiceDirection = 'VOICE_RULE: Questions end with yeah?';
    ch.aiContextExcluded = { alternate_greetings: ['description'] };
    for (const stepId of ['card', 'greetings']) {
        const step = STEPS.find(s => s.id === stepId);
        const args = step.build({ characterId: ch.id, fillOnly: true, concept: {} }, project, {});
        const { system, user } = buildTask(step.task, args);
        assert.ok(system.includes(ch.voiceDirection));
        if (stepId === 'greetings') assert.ok(!user.includes(ch.card.data.description));
    }
});
