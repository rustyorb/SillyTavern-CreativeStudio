import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, buildTask, taskSchema } from '../src/ai/tasks.js';
import { newCharacter, createProject } from '../src/core/project.js';
import { createStore } from '../src/ui/store.js';
import { characterContext } from '../src/ui/field-context.js';

const core = await import('../src/core/remix.js').catch(() => ({}));
const runner = await import('../src/ai/remix.js').catch(() => ({}));
const sources = () => ['Mara', 'Orin'].map((name, i) => {
    const c = newCharacter(name);
    c.card.data.description = `Age: ${30 + i * 10}\nSpecies: Human\nGender: ${i ? 'Man' : 'Woman'}\nA keeper of strange secrets.`;
    c.card.data.personality = i ? 'Patient, ambitious, observant.' : 'Reckless, loyal, suspicious.';
    c.avatarMediaId = `portrait${i}`;
    c.sprites = { joy: `sprite${i}` };
    return c;
});
const fields = () => ({ name: 'Iris Vale', description: 'A keeper of forgotten promises.', personality: 'Quiet yet stubbornly curious.', scenario: 'A stranger waits by the door.', first_mes: '*A bell rings.* "You came back."', mes_example: '<START>\n{{user}}: Why?\n{{char}}: "Because I remember."', tags: ['mystery'] });
const options = (minimums = {}) => ({ age: { mode: 'average', a: 30, b: 40 }, species: { mode: 'a', a: 'Human' }, gender: { mode: 'custom', value: 'Woman' }, minimums: Object.fromEntries(Object.keys(core.REMIX_FIELDS ?? {}).map(k => [k, minimums[k] ?? 0])), direction: 'A reluctant leader.' });
const reply = value => ({ value: { fields: value, rationale: 'New identity.' }, generation: { task: 'character.remix' } });

test('remix task exists and carries both complete source cards, locks and minimums', () => {
    assert.ok(TASKS['character.remix'], 'The remix task must be registered');
    const cards = sources();
    cards[0].card.data.description += 'x'.repeat(4000) + ' UNIQUE END';
    const prompt = buildTask('character.remix', { sources: cards, locks: { age: 35, species: 'Human' }, minimums: { description: 250 }, direction: 'A reluctant leader.' }, { overrides: { 'character.remix': 'Distinct motives and voice.' } });
    assert.match(prompt.system, /Distinct motives and voice/);
    assert.match(prompt.user, /UNIQUE END/);
    assert.match(prompt.user, /Orin/);
    assert.match(prompt.user, /35/);
    assert.match(prompt.user, /250/);
    assert.match(prompt.user, /A reluctant leader/);
    assert.ok(taskSchema(TASKS['character.remix'], {}).properties.fields.required.includes('name'));
    assert.deepEqual(taskSchema(TASKS['character.remix'], { only: ['description'] }).properties.fields.required, ['description']);
});

test('age detection refuses ranges, conflicting ages and unrelated numbers', () => {
    assert.equal(typeof core.detectAge, 'function');
    for (const [text, expected] of [['Age: 30', 30], ['A 40-year-old sailor.', 40], ['Age: 30-40', null], ['Age: 30\nAge: 40', null], ['Has 35 books.', null], ['A 400-year-old elf.', 400], ['Age: unknown', null]]) {
        assert.equal(core.detectAge(text), expected, text);
    }
});

test('locked age is calculated locally, rounded, overridable and never inferred from an empty value', () => {
    assert.equal(typeof core.resolveLocks, 'function');
    assert.deepEqual(core.resolveLocks(options()), { age: 35, species: 'Human', gender: 'Woman' });
    assert.equal(core.resolveLocks({ age: { mode: 'average', a: 30, b: 41 } }).age, 36);
    assert.equal(core.resolveLocks({ age: { mode: 'custom', value: 52 } }).age, 52);
    assert.equal(core.resolveLocks({ age: { mode: 'b', b: 40 } }).age, 40);
    assert.throws(() => core.resolveLocks({ age: { mode: 'average', a: '', b: 40 } }), /age/i);
    assert.throws(() => core.resolveLocks({ species: { mode: 'a', a: '' } }), /species/i);
    assert.deepEqual(core.resolveLocks({ age: { mode: 'ai' } }), {});
});

test('minimum word counts ignore formatting and dialogue macros, and evaluate each alternate greeting', () => {
    assert.equal(typeof core.wordCount, 'function');
    assert.equal(core.wordCount('<START>\n{{char}}: "Don’t go."\n{{user}}: *Why not?*'), 4);
    const report = core.minimumReport({ description: 'one two', alternate_greetings: ['one two three', 'one'] }, { description: 3, alternate_greetings: 2 });
    assert.equal(report.find(x => x.field === 'description').short, true);
    assert.equal(report.find(x => x.field === 'alternate_greetings' && x.index === 0).short, false);
    assert.equal(report.find(x => x.field === 'alternate_greetings' && x.index === 1).short, true);
    assert.throws(() => core.normalizeMinimums({ description: -1 }), /minimum/i);
    assert.throws(() => core.normalizeMinimums({ description: 1.5 }), /minimum/i);
});

test('generation creates an independent full character and one undo restores both untouched originals', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    const original = sources();
    const snapshot = structuredClone(original);
    const result = await runner.generateRemix({ sources: original, options: options(), runTask: async () => reply(fields()) });
    assert.deepEqual(original, snapshot);
    assert.equal(result.character.card.data.name, 'Iris Vale');
    assert.match(result.character.card.data.description, /Age: 35/);
    assert.equal(result.character.avatarMediaId, '');
    assert.equal(result.character.sprites, undefined);
    assert.deepEqual(result.character.links.media, []);
    assert.deepEqual(result.character.remix.sources.map(s => s.name), ['Mara', 'Orin']);
    const p = { ...createProject('Original'), characters: original };
    const store = createStore(p);
    runner.saveRemix(store, result, p.id);
    assert.equal(store.get().characters.length, 3);
    store.undo();
    assert.deepEqual(store.get().characters, snapshot);
});

test('short fields get one targeted expansion with the complete new card as context', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    const requests = [];
    const result = await runner.generateRemix({ sources: sources(), options: options({ personality: 8 }), runTask: async (id, args) => {
        requests.push(args);
        return reply(args.only ? { personality: 'Quiet yet stubbornly curious she protects every broken promise.', scenario: 'UNWANTED CHANGE' } : fields());
    } });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].only, ['personality']);
    assert.equal(requests[1].current.name, 'Iris Vale');
    assert.equal(requests[1].locks.age, 35);
    assert.equal(result.character.card.data.scenario, fields().scenario);
    assert.equal(result.report.find(x => x.field === 'personality').short, false);
});

test('failed or insufficient expansion keeps the completed draft and reports the shortfall without looping', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    for (const fail of [false, true]) {
        let calls = 0;
        const result = await runner.generateRemix({ sources: sources(), options: options({ personality: 40 }), runTask: async () => {
            if (++calls > 1 && fail) throw new Error('Connection lost');
            return reply(fields());
        } });
        assert.equal(calls, 2);
        assert.equal(result.character.card.data.name, 'Iris Vale');
        assert.ok(result.report.find(x => x.field === 'personality').short);
        if (fail) assert.match(result.warnings.join(' '), /Connection lost/);
    }
});

test('cancellation and project switches never save late results', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    const ac = new AbortController();
    await assert.rejects(runner.generateRemix({ sources: sources(), options: options(), signal: ac.signal, runTask: async () => { ac.abort(); return reply(fields()); } }), /cancel/i);
    const store = createStore(createProject('Other'));
    assert.throws(() => runner.saveRemix(store, { character: newCharacter('Late') }, 'old-project'), /project/i);
    assert.equal(store.get().characters.length, 0);
});

test('same source, empty model output and copied source names cannot create a completed remix', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    const cards = sources();
    await assert.rejects(runner.generateRemix({ sources: [cards[0], cards[0]], options: options(), runTask: async () => reply(fields()) }), /different/i);
    await assert.rejects(runner.generateRemix({ sources: cards, options: options(), runTask: async () => reply({}) }), /missing|empty/i);
    await assert.rejects(runner.generateRemix({ sources: cards, options: options(), runTask: async () => reply({ ...fields(), name: 'Mara' }) }), /name/i);
});

test('an explicit age contradiction is repaired once or rejected rather than saved as a locked result', async () => {
    assert.equal(typeof runner.generateRemix, 'function');
    let calls = 0;
    const result = await runner.generateRemix({ sources: sources(), options: options(), runTask: async (id, args) => {
        calls++;
        return reply(args.only ? { description: 'A 35-year-old keeper of promises.' } : { ...fields(), description: 'A 22-year-old keeper of promises.' });
    } });
    assert.equal(calls, 2);
    assert.doesNotMatch(result.character.card.data.description, /22-year/);
    await assert.rejects(runner.generateRemix({ sources: sources(), options: options(), runTask: async () => reply({ ...fields(), description: 'Age: 22' }) }), /locked age/i);
});

test('later field edits carry the current minimum and locks even when earlier context is unchecked', () => {
    const ch = sources()[0];
    ch.remix = { minimums: { personality: 220 }, locks: { age: 35 } };
    ch.aiContextExcluded = { personality: ['name', 'description'] };
    const project = { ...createProject('Edit'), characters: [ch] };
    const store = createStore(project);
    const args = characterContext({ store, project, ch, field: 'personality' }).args();
    assert.equal(args.minimumWords, 220);
    assert.deepEqual(args.lockedFacts, { age: 35 });
    for (const id of ['character.rewrite-field', 'character.extend-field']) {
        const p = buildTask(id, { ...args, instruction: 'Keep the dry humor.' });
        assert.match(p.user, /220/);
        assert.match(p.user, /35/);
        assert.match(p.user, /Keep the dry humor/);
    }
});

test('expanding a short alternate greeting preserves the other greetings and never drops entries', async () => {
    const result = await runner.generateRemix({ sources: sources(), options: options({ alternate_greetings: 5 }), runTask: async (id, args) => reply(args.only
        ? { alternate_greetings: ['UNWANTED REWRITE of a finished opening.', 'A new letter arrived before dawn.'] }
        : { ...fields(), alternate_greetings: ['The original opening is already long enough.', 'Too short.', 'A third opening is also long enough.'] }) });
    assert.deepEqual(result.character.card.data.alternate_greetings, ['The original opening is already long enough.', 'A new letter arrived before dawn.', 'A third opening is also long enough.']);
});
