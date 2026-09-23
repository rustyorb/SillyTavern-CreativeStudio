import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROVIDERS, providerById, providerForProfile, storeKey, listModels, saveProfile, removeProfile, studioProfiles, profileName,
    connectionManagerAvailable,
} from '../src/st/providers.js';

let ctx;
let calls;
let secrets;

/** A fake SillyTavern: context + the secrets and status endpoints the module uses. */
beforeEach(() => {
    calls = [];
    secrets = { api_key_openrouter: [{ id: 'old', label: 'mine', active: true, value: '***' }] };
    ctx = {
        extensionSettings: { connectionManager: { profiles: [{ id: 'u1', name: 'User profile', mode: 'cc', api: 'openai' }], selectedProfile: null }, disabledExtensions: [] },
        saveSettingsDebounced: () => calls.push({ url: 'saveSettings' }),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.fetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        calls.push({ url, body });
        const json = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) });
        if (url === '/api/secrets/read') return json(secrets);
        if (url === '/api/secrets/write') {
            const list = (secrets[body.key] ??= []);
            list.forEach(s => { s.active = false; });
            list.push({ id: 'new1', label: body.label, active: true, value: '***' });
            return json({ id: 'new1' });
        }
        if (url === '/api/secrets/rotate') {
            secrets[body.key].forEach(s => { s.active = s.id === body.id; });
            return { ok: true, status: 204, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
        }
        if (url === '/api/secrets/delete') {
            secrets[body.key] = secrets[body.key].filter(s => s.id !== body.id);
            return { ok: true, status: 204, headers: { get: () => '' }, json: async () => ({}), text: async () => '' };
        }
        if (url === '/api/backends/chat-completions/status') {
            if (body.chat_completion_source === 'custom' && !body.custom_url) return json({ error: true });
            return json({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] });
        }
        return { ok: false, status: 404, headers: { get: () => '' }, text: async () => 'nope' };
    };
});

test('catalog covers the big clouds and local servers, each mapped to a real ST source and secret key', () => {
    for (const id of ['openrouter', 'openai', 'claude', 'makersuite', 'deepseek', 'mistralai', 'groq', 'xai', 'lmstudio', 'ollama', 'custom']) assert.ok(providerById(id), id);
    for (const p of PROVIDERS) {
        assert.match(p.secretKey, /^api_key_/);
        if (p.kind !== 'cloud') assert.equal(p.source, 'custom');
    }
    assert.equal(providerById('lmstudio').url, 'http://127.0.0.1:1234/v1');
});

test('storing a key keeps SillyTavern\'s previously active key active', async () => {
    const id = await storeKey(providerById('openrouter'), '  sk-or-test  ', 'Creative Studio · OpenRouter');
    assert.equal(id, 'new1');
    const write = calls.find(c => c.url === '/api/secrets/write');
    assert.equal(write.body.value, 'sk-or-test', 'trimmed');
    assert.equal(write.body.key, 'api_key_openrouter');
    assert.deepEqual(calls.find(c => c.url === '/api/secrets/rotate').body, { key: 'api_key_openrouter', id: 'old' });
    assert.equal(secrets.api_key_openrouter.find(s => s.active).id, 'old');
});

test('with no previous key, nothing is rotated', async () => {
    await storeKey(providerById('groq'), 'gsk', 'x');
    assert.ok(!calls.some(c => c.url === '/api/secrets/rotate'));
});

test('models come from SillyTavern\'s status endpoint with the secret id (deduped, sorted)', async () => {
    const models = await listModels(providerById('openrouter'), { secretId: 'new1' });
    assert.deepEqual(models, ['a-model', 'z-model']);
    const req = calls.find(c => c.url === '/api/backends/chat-completions/status').body;
    assert.equal(req.chat_completion_source, 'openrouter');
    assert.equal(req.secret_id, 'new1');
    assert.equal(req.custom_url, undefined);
    await assert.rejects(listModels(providerById('lmstudio'), { url: '' }), /not reachable/);
});

test('profiles hold the secret id, never the key; removing can delete the key the studio stored', async () => {
    await storeKey(providerById('openrouter'), 'sk-or-test', 'x'); // → 'new1', rotated back so not active
    const p = saveProfile(ctx, { name: profileName(ctx, providerById('openrouter'), 'deepseek/deepseek-v3.1'), provider: providerById('openrouter'), model: 'deepseek/deepseek-v3.1', secretId: 'new1' });
    assert.equal(p.name, 'Studio · OpenRouter · deepseek-v3.1');
    assert.equal(p['secret-id'], 'new1');
    assert.ok(!JSON.stringify(ctx.extensionSettings).includes('sk-'), 'no key material in settings');
    assert.deepEqual(studioProfiles(ctx).map(x => x.id), [p.id]);
    assert.equal(providerForProfile(p).id, 'openrouter');
    // same name again gets a suffix
    assert.equal(profileName(ctx, providerById('openrouter'), 'deepseek/deepseek-v3.1'), 'Studio · OpenRouter · deepseek-v3.1 (2)');
    const local = saveProfile(ctx, { name: 'L', provider: providerById('lmstudio'), model: 'qwen', url: 'http://127.0.0.1:1234/v1' });
    assert.equal(local['api-url'], 'http://127.0.0.1:1234/v1');
    assert.equal(providerForProfile(local).id, 'lmstudio');
    await removeProfile(ctx, p.id, { deleteKey: true });
    assert.ok(!ctx.extensionSettings.connectionManager.profiles.some(x => x.id === p.id));
    assert.deepEqual(calls.find(c => c.url === '/api/secrets/delete').body, { key: 'api_key_openrouter', id: 'new1' });
    assert.equal(ctx.extensionSettings.connectionManager.profiles.find(x => x.id === 'u1').name, 'User profile', 'user profiles untouched');
});

test('Connection Manager availability', () => {
    assert.equal(connectionManagerAvailable(ctx), true);
    ctx.extensionSettings.disabledExtensions = ['connection-manager'];
    assert.equal(connectionManagerAvailable(ctx), false);
});

test('a key the user added in SillyTavern is never offered for deletion; a studio key is, unless shared or active', async () => {
    const { keyIsDisposable, removeProfile: remove } = await import('../src/st/providers.js');
    // profile bound to the user's own stored key ("old", active)
    const mine = saveProfile(ctx, { name: 'A', provider: providerById('openrouter'), model: 'm', secretId: 'old' });
    assert.equal(await keyIsDisposable(ctx, mine), false);
    const r1 = await remove(ctx, mine.id, { deleteKey: true });
    assert.equal(r1.keyDeleted, false);
    assert.ok(secrets.api_key_openrouter.some(s => s.id === 'old'), 'user key kept');
    // a key the studio stored (rotated back, so not active)
    const id = await storeKey(providerById('openrouter'), 'sk-new', 'x');
    const p1 = saveProfile(ctx, { name: 'B', provider: providerById('openrouter'), model: 'm', secretId: id });
    const p2 = saveProfile(ctx, { name: 'C', provider: providerById('openrouter'), model: 'm2', secretId: id });
    assert.equal(await keyIsDisposable(ctx, p1), false, 'shared by another profile');
    await remove(ctx, p2.id);
    assert.equal(await keyIsDisposable(ctx, p1), true);
    const r2 = await remove(ctx, p1.id, { deleteKey: true });
    assert.equal(r2.keyDeleted, true);
    assert.ok(!secrets.api_key_openrouter.some(s => s.id === id));
    assert.ok(!ctx.extensionSettings.creativeStudio.secretIds.includes(id));
});

test('if SillyTavern cannot switch back to the user\'s key, the new key is removed and nothing changes', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url !== '/api/secrets/rotate') return realFetch(url, init);
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: false, status: 500, headers: { get: () => '' }, text: async () => 'boom' };
    };
    await assert.rejects(storeKey(providerById('openrouter'), 'sk-x', 'x'), /could not switch back/);
    assert.equal(calls.filter(c => c.url === '/api/secrets/rotate').length, 2, 'rotate retried once');
    assert.ok(calls.some(c => c.url === '/api/secrets/delete' && c.body.id === 'new1'));
    assert.deepEqual(secrets.api_key_openrouter.map(s => s.id), ['old']);
    assert.ok(!ctx.extensionSettings.creativeStudio.secretIds.includes('new1'));
});
