import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTask, PROMPT_DEFAULTS, PROMPT_INFO, ADULTS_ONLY, contentRule, promptReader, joinAddition, getTask, taskSchema, TASKS, loreEntryAsk } from '../src/ai/tasks.js';
import { contentFromRating, contentOf, imageRating, DEFAULT_CONTENT, CONTENT_LEVELS } from '../src/core/content.js';
import { composePrompt } from '../src/core/comfy.js';
import { emptyCardV3 } from '../src/core/card.js';

const card = () => {
    const c = emptyCardV3('Mira');
    c.data.description = 'A lighthouse keeper with salt in her hair.';
    return c;
};

test('content level: a project setting, else the generator\'s rating dial, else mature themes', () => {
    assert.equal(DEFAULT_CONTENT, 'mature');
    assert.equal(contentOf({}), 'mature');
    assert.equal(contentOf({ lastDials: { rating: 'SFW' } }), 'sfw');
    assert.equal(contentOf({ lastDials: { rating: 'unrestricted (the model decides)' } }), 'adult');
    assert.equal(contentOf({ lastDials: { rating: 'mature themes, no explicit content' } }), 'mature');
    assert.equal(contentOf({ settings: { content: 'adult' }, lastDials: { rating: 'SFW' } }), 'adult', 'the project setting wins');
    assert.equal(contentOf({ settings: { content: 'nonsense' } }), 'mature');
    assert.equal(contentFromRating('NSFW ok'), 'adult');
    assert.equal(contentFromRating(''), '');
    assert.deepEqual(['sfw', 'mature', 'adult'].map(imageRating), ['SFW', 'mature', 'unrestricted']);
    assert.deepEqual(Object.keys(CONTENT_LEVELS), ['sfw', 'mature', 'adult']);
});

test('every writing task carries the content rule; mature and adult always add the adults-only line', () => {
    for (const level of ['sfw', 'mature', 'adult']) {
        const { system } = buildTask('character.rewrite-field', { card: card(), field: 'description', instruction: 'x', count: 1 }, { content: level });
        assert.ok(system.includes(PROMPT_DEFAULTS[`content.${level}`]), level);
        assert.equal(system.includes(ADULTS_ONLY), level !== 'sfw', `${level}: adults-only line`);
        assert.ok(system.startsWith(PROMPT_DEFAULTS['shared.craft']), 'writing rules first');
    }
    assert.match(PROMPT_DEFAULTS['content.mature'], /do not tone the material down/);
    assert.match(PROMPT_DEFAULTS['character.critique'], /Judge craft, not morality/);
    const regex = buildTask('regex.generate', { goal: 'g' }, { content: 'adult' }).system;
    assert.ok(!regex.includes('Content rating'), 'technical tasks get no content rule');
    const images = buildTask('media.prompts', { card: card(), promptStyle: 'tags' }, { content: 'adult' }).system;
    assert.ok(images.includes(PROMPT_DEFAULTS['media.prompts.tags']) && images.includes(PROMPT_DEFAULTS['content.adult']));
});

test('the author\'s edited instructions replace the defaults; blank edits fall back; every listed instruction exists', () => {
    const mine = 'You rewrite fields like a pulp novelist.';
    const { system } = buildTask('character.rewrite-field', { card: card(), field: 'description', instruction: '', count: 1 }, { overrides: { 'character.rewrite-field': mine, 'content.mature': 'Anything goes, darling.' }, content: 'mature' });
    assert.ok(system.includes(mine));
    assert.ok(!system.includes(PROMPT_DEFAULTS['character.rewrite-field']));
    assert.ok(system.includes('Anything goes, darling.') && system.includes(ADULTS_ONLY), 'an edited content rule still gets the fixed line');
    assert.equal(promptReader({ 'lore.keys': '   ' })('lore.keys'), PROMPT_DEFAULTS['lore.keys']);
    assert.equal(contentRule(promptReader({}), 'sfw'), PROMPT_DEFAULTS['content.sfw']);
    for (const i of PROMPT_INFO) assert.ok(PROMPT_DEFAULTS[i.key], `${i.key} has a default`);
    for (const k of Object.keys(PROMPT_DEFAULTS)) assert.ok(PROMPT_INFO.some(i => i.key === k), `${k} is listed for the author`);
    // Tasks still build without the studio around them (defaults, mature).
    assert.ok(getTask('character.greetings').build({ card: card() }).system.includes(PROMPT_DEFAULTS['content.mature']));
    assert.ok(Object.values(TASKS).every(t => typeof t.build === 'function'));
});

test('add to a field: the model returns only the addition; what was there stays word for word', () => {
    const { user, system } = buildTask('character.extend-field', { card: card(), field: 'description', instruction: 'her fear of deep water' });
    assert.match(system, /Everything already in the field stays exactly/);
    assert.match(user, /A lighthouse keeper with salt in her hair\./);
    assert.match(user, /What to add: her fear of deep water/);
    assert.deepEqual(taskSchema(getTask('character.extend-field'), {}).required, ['addition', 'joiner', 'rationale']);
    const before = 'A lighthouse keeper with salt in her hair.';
    assert.equal(joinAddition(before, 'She cannot swim.', 'same paragraph'), `${before} She cannot swim.`);
    assert.equal(joinAddition(`${before}\n`, 'She cannot swim.', 'new paragraph'), `${before}\n\nShe cannot swim.`);
    assert.equal(joinAddition('[Traits: calm]', '[Fears: deep water]', 'new line'), '[Traits: calm]\n[Fears: deep water]');
    assert.equal(joinAddition('', 'Fresh text.'), 'Fresh text.');
    assert.equal(joinAddition(before, '  '), before);
    assert.equal(joinAddition(before, 'x', 'sideways'), `${before}\n\nx`, 'an unknown joiner becomes a new paragraph');
});

test('any text (lore entries): rewrite and add to it carry the context, the instruction and the content rule', () => {
    const ask = { what: 'the lorebook entry "Harbor" (keys: harbor, docks)', current: 'The harbor freezes in winter.', context: 'Lorebook "Saltmere".' };
    const add = buildTask('text.extend', { ...ask, instruction: 'the smugglers who use it' }, { content: 'adult' });
    assert.match(add.system, /Everything already there stays exactly/);
    assert.ok(add.system.includes(PROMPT_DEFAULTS['content.adult']) && add.system.includes(ADULTS_ONLY));
    assert.match(add.user, /Lorebook "Saltmere"/);
    assert.match(add.user, /The harbor freezes in winter\./);
    assert.match(add.user, /What to add: the smugglers who use it/);
    assert.deepEqual(taskSchema(getTask('text.extend'), {}).required, ['addition', 'joiner', 'rationale']);
    const three = buildTask('text.rewrite', { ...ask, instruction: '', count: 3 });
    assert.match(three.user, /Give 3 variants/);
    assert.match(three.user, /Make it stronger for roleplay/);
    const empty = buildTask('text.rewrite', { ...ask, current: '  ', instruction: '' });
    assert.match(empty.user, /It is empty: write it from scratch/);
    const mine = buildTask('text.rewrite', { ...ask, instruction: 'x' }, { overrides: { 'text.rewrite': 'Lore in the voice of a sea shanty.' } });
    assert.ok(mine.system.includes('Lore in the voice of a sea shanty.'));
});

test('a lore entry is asked about with its keys, the book\'s other entries and the characters linked to the book', () => {
    const mira = { id: 'c1', card: card(), links: { lorebooks: ['lb1'] } };
    const stranger = { id: 'c2', card: emptyCardV3('Stranger'), links: { lorebooks: [] } };
    const project = {
        characters: [mira, stranger],
        lorebooks: [{ id: 'lb1', name: 'Saltmere', data: { entries: {
            0: { uid: 0, comment: 'Harbor', key: ['harbor', 'docks'], content: 'The harbor   freezes\nin winter.' },
            1: { uid: 1, comment: 'Lighthouse', key: ['lighthouse'], content: 'Mira keeps the light.' },
        } } }],
    };
    const ask = loreEntryAsk(project, 'lb1', 0);
    assert.equal(ask.what, 'the lorebook entry "Harbor" (keys: harbor, docks)');
    assert.equal(ask.current, 'The harbor   freezes\nin winter.');
    assert.match(ask.context, /Lorebook "Saltmere"/);
    assert.match(ask.context, /Name: Mira/);
    assert.ok(!ask.context.includes('Stranger'), 'only characters linked to this book');
    assert.match(ask.context, /- Lighthouse \(lighthouse\): Mira keeps the light\./);
    assert.ok(!/- Harbor/.test(ask.context), 'the entry itself is not listed among the others');
    const fresh = loreEntryAsk({ characters: [], lorebooks: [{ id: 'lb2', name: 'Empty', data: { entries: { 5: { uid: 5, key: [], content: '' } } } }] }, 'lb2', 5);
    assert.match(fresh.what, /keys: none yet/);
    assert.match(buildTask('text.rewrite', { ...fresh, instruction: '' }).user, /It is empty: write it from scratch/);
});

test('pictures follow the content level: SFW keeps it safe, mature keeps out nudity only, adult keeps nothing out', () => {
    const sfw = composePrompt({ prompt: '1girl', family: 'pony', rating: imageRating('sfw') });
    assert.match(sfw.positive, /rating_safe/);
    assert.match(sfw.negative, /nsfw, nude/);
    const mature = composePrompt({ prompt: '1girl', family: 'pony', rating: imageRating('mature') });
    assert.ok(!/rating_safe/.test(mature.positive), 'mature is not forced to rating_safe');
    assert.match(mature.negative, /rating_explicit, nude, nipples/);
    assert.ok(!/nsfw/.test(mature.negative), 'suggestive is fine at mature');
    const adult = composePrompt({ prompt: '1girl', family: 'pony', rating: imageRating('adult') });
    assert.ok(!/rating_safe/.test(adult.positive) && !/nude|nsfw|rating_explicit/.test(adult.negative));
    const real = composePrompt({ prompt: 'a keeper', family: 'realistic', rating: imageRating('mature') });
    assert.match(real.negative, /^nude, nipples, explicit/);
});
