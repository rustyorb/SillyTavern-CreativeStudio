import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, balancedSpan } from '../src/ai/json.js';
import { validate, coerce } from '../src/ai/schema.js';
import { runStructured, describeRoute, AiError } from '../src/ai/gateway.js';

test('extractJson handles prose, fences, reasoning, trailing commas, raw newlines, truncation', () => {
    assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
    assert.deepEqual(extractJson('Sure! Here you go:\n```json\n{"a": [1,2,],}\n```\nEnjoy').value, { a: [1, 2] });
    assert.deepEqual(extractJson('<think>hmm {not json}</think>{"x":"y"}').value, { x: 'y' });
    assert.deepEqual(extractJson('{"t": "line one\nline two"}').value, { t: 'line one\nline two' });
    assert.deepEqual(extractJson('Result: {"a": {"b": "c"}} and more text {"z":1}').value, { a: { b: 'c' } });
    const trunc = extractJson('{"items": [{"n": "a"}, {"n": "b');
    assert.ok(trunc.ok);
    assert.equal(trunc.value.items[0].n, 'a');
    assert.ok(trunc.repaired.some(r => r.includes('truncated')));
    assert.equal(extractJson('no json here').ok, false);
    assert.equal(balancedSpan('x {"a":"}"} y'), '{"a":"}"}');
});

const SCHEMA = {
    type: 'object',
    required: ['candidates'],
    properties: {
        candidates: {
            type: 'array', minItems: 1,
            items: { type: 'object', required: ['name', 'score'], properties: { name: { type: 'string' }, score: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } } },
        },
    },
};

test('validate and coerce', () => {
    const bad = { candidates: [{ name: 'A', score: '7', tags: 'x', ok: 'yes' }] };
    assert.ok(validate(SCHEMA, bad).length > 0);
    const fixed = coerce(SCHEMA, bad);
    assert.deepEqual(fixed.candidates[0], { name: 'A', score: 7, tags: ['x'], ok: true });
    assert.deepEqual(validate(SCHEMA, fixed), []);
    assert.deepEqual(validate(SCHEMA, { candidates: [] }).map(e => e.message), ['needs at least 1 items']);
});

function mockCtx({ mainApi = 'openai', responses = [], profiles = [] } = {}) {
    const calls = [];
    return {
        calls,
        mainApi,
        onlineStatus: 'model-x',
        getChatCompletionModel: () => 'model-x',
        extensionSettings: { connectionManager: { profiles } },
        CONNECT_API_MAP: { openai: { selected: 'openai' }, ooba: { selected: 'textgenerationwebui' } },
        extractMessageFromData: raw => raw.choices?.[0]?.message?.content ?? '',
        generateRaw: async args => {
            calls.push({ route: 'main', args });
            return responses.shift();
        },
        ConnectionManagerRequestService: {
            getProfile: id => profiles.find(p => p.id === id),
            sendRequest: async (id, msgs, max, custom, override) => {
                calls.push({ route: 'profile', id, msgs, max, custom, override });
                const r = responses.shift();
                if (r instanceof Error) throw new Error('API request failed', { cause: r });
                return r;
            },
        },
    };
}

test('main route passes jsonSchema (CC) with returnInvalid and parses result', async () => {
    const ctx = mockCtx({ responses: ['{"candidates":[{"name":"Mira","score":8}]}'] });
    const r = await runStructured(ctx, { system: 'sys', user: 'u', schema: SCHEMA, schemaName: 'cands' });
    assert.equal(r.value.candidates[0].name, 'Mira');
    assert.equal(ctx.calls[0].args.jsonSchema.returnInvalid, true);
    assert.equal(r.meta.mode, 'main');
    assert.equal(r.meta.attempts, 1);
});

test('text completion main route: no jsonSchema, prompted JSON parsed leniently', async () => {
    const ctx = mockCtx({ mainApi: 'textgenerationwebui', responses: ['Here:\n```json\n{"candidates":[{"name":"B","score":"3",}]}\n```'] });
    const r = await runStructured(ctx, { system: 'sys', user: 'u', schema: SCHEMA });
    assert.equal(ctx.calls[0].args.jsonSchema, null);
    assert.equal(r.value.candidates[0].score, 3);
    assert.ok(r.meta.repaired.length > 0);
    assert.match(ctx.calls[0].args.prompt[0].content, /JSON Schema/);
});

test('profile route: CC sends json_schema override, extractData:false, reads raw text', async () => {
    const profiles = [{ id: 'p1', name: 'Creator', api: 'openai', model: 'gpt-x', preset: 'Default' }];
    const ctx = mockCtx({ profiles, responses: [{ choices: [{ message: { content: '{"candidates":[{"name":"C","score":1}]}' } }] }] });
    const r = await runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA, profileId: 'p1', maxTokens: 999 });
    const call = ctx.calls[0];
    assert.equal(call.route, 'profile');
    assert.equal(call.custom.extractData, false);
    assert.equal(call.override.json_schema.name, 'result');
    assert.equal(call.max, 999);
    assert.equal(r.meta.profileName, 'Creator');
    assert.equal(r.value.candidates[0].name, 'C');
});

test('profile route: Claude tool_use payload is read', async () => {
    const profiles = [{ id: 'p1', name: 'Claude', api: 'openai' }];
    const ctx = mockCtx({ profiles, responses: [{ content: [{ type: 'tool_use', input: { candidates: [{ name: 'T', score: 2 }] } }] }] });
    const r = await runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA, profileId: 'p1' });
    assert.equal(r.value.candidates[0].name, 'T');
});

test('repair round-trip is used when first output is invalid', async () => {
    const ctx = mockCtx({ responses: ['{"candidates": []}', '{"candidates":[{"name":"Fixed","score":5}]}'] });
    const r = await runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA });
    assert.equal(r.meta.attempts, 2);
    assert.equal(r.value.candidates[0].name, 'Fixed');
    assert.ok(r.meta.repaired.includes('model repair round-trip'));
    assert.match(ctx.calls[1].args.prompt[3].content, /needs at least 1 items/);
});

test('unparsable output raises AiError with raw text preserved', async () => {
    const ctx = mockCtx({ responses: ['I cannot do that.', 'Still no JSON.'] });
    await assert.rejects(runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA }), e => e instanceof AiError && e.raw === 'I cannot do that.');
});

test('a call that never answers times out (main route) and aborts the request (profile route)', async () => {
    const hang = mockCtx();
    hang.generateRaw = () => new Promise(() => {});
    await assert.rejects(runStructured(hang, { system: 's', user: 'u', schema: SCHEMA, timeoutMs: 40 }), e => e instanceof AiError && e.timeout === true && /No answer after/.test(e.message));
    const profiles = [{ id: 'p1', name: 'X', api: 'openai' }];
    const ctx = mockCtx({ profiles });
    let aborted = false;
    ctx.ConnectionManagerRequestService.sendRequest = (id, msgs, max, custom) => new Promise(() => custom.signal.addEventListener('abort', () => { aborted = true; }));
    await assert.rejects(runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA, profileId: 'p1', timeoutMs: 40 }), e => e.timeout === true);
    assert.equal(aborted, true);
});

test('request failures and cancellation surface as AiError', async () => {
    const profiles = [{ id: 'p1', name: 'X', api: 'openai' }];
    const ctx = mockCtx({ profiles, responses: [new Error('401 bad key')] });
    await assert.rejects(runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA, profileId: 'p1' }), /401 bad key/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(runStructured(mockCtx(), { system: 's', user: 'u', schema: SCHEMA, signal: ac.signal }), /Cancelled/);
    assert.equal(describeRoute(mockCtx(), 'missing').ok, false);
});

test('reasoning-only output produces actionable errors', async () => {
    const { runChat } = await import('../src/ai/gateway.js');
    const ctx = mockCtx({ responses: ['<think>I will think forever about this', '<think>still thinking'] });
    await assert.rejects(runStructured(ctx, { system: 's', user: 'u', schema: SCHEMA }), /reasoning/);
    const ctx2 = mockCtx({ responses: ['<think>only thoughts</think>   '] });
    await assert.rejects(runChat(ctx2, { messages: [{ role: 'user', content: 'hi' }] }), /no reply text/);
    const ctx3 = mockCtx({ responses: ['<think>plan</think>Hello there.'] });
    assert.equal((await runChat(ctx3, { messages: [{ role: 'user', content: 'hi' }] })).text, 'Hello there.');
});
