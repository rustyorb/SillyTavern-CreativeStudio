import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, PROMPT_DEFAULTS } from '../src/ai/tasks.js';
import { emptyCardV3, tidyExamples } from '../src/core/card.js';

test('dialogue guidance reaches full-card, remix, rewrite and additive requests and remains editable', () => {
    assert.ok(PROMPT_DEFAULTS['shared.dialogue'], 'Dedicated example-dialogue guidance is required');
    const custom = 'For both speakers, vary the order of speech and action with the scene.';
    for (const [id, args] of [
        ['character.expand', { concept: 'A keeper', card: emptyCardV3('Mira') }],
        ['character.remix', { sources: [] }],
        ['character.rewrite-field', { card: emptyCardV3('Mira'), field: 'mes_example', instruction: 'More natural.', voiceDirection: 'Dry humor' }],
        ['character.extend-field', { card: emptyCardV3('Mira'), field: 'mes_example', instruction: 'Another exchange.' }],
    ]) {
        const normal = buildTask(id, args);
        assert.ok(normal.system.includes(PROMPT_DEFAULTS['shared.dialogue']), id);
        const edited = buildTask(id, args, { overrides: { 'shared.dialogue': custom } });
        assert.ok(edited.system.includes(custom), id);
        assert.ok(!edited.system.includes(PROMPT_DEFAULTS['shared.dialogue']), id);
    }
});

test('dialogue cleanup preserves mixed message structures for both speakers', () => {
    const varied = `<START>
{{user}}: *I fold the map.* "Which way?"
{{char}}: "East."
{{user}}: "You said west before." *I stop at the fork.* "What changed?"
{{char}}: *She points to the fresh tracks.*
{{user}}: "Oh."
{{char}}: "Keep close." *She steps off the road, listening.* "And leave that bell behind."
<START>
{{char}}: *The door stays shut.* "Come back tomorrow."
{{user}}: *I slide the letter underneath.*`;
    assert.equal(tidyExamples(varied, 'Mira'), varied);
});
