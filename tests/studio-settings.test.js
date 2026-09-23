import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studioSnapshot, healSettings } from '../src/st/studio-settings.js';

const profile = { id: 'p1', mode: 'cc', name: 'Studio · OpenRouter · deepseek', api: 'openrouter', model: 'deepseek/x', 'secret-id': 's1' };
const live = () => ({
    connectionManager: { profiles: [{ id: 'u1', name: 'Mine' }, { ...profile }] },
    creativeStudio: { profileIds: ['p1'], secretIds: [], defaultCreationProfileId: 'p1', image: { backend: 'comfy', url: 'http://x:8188', ckpt: 'a.safetensors' } },
});

test('snapshot holds the studio settings and only the profiles the studio made (secret ids, no keys)', () => {
    const s = studioSnapshot(live());
    assert.deepEqual(s.profiles.map(p => p.id), ['p1']);
    assert.equal(s.settings.image.ckpt, 'a.safetensors');
    assert.ok(!JSON.stringify(s).includes('sk-'));
});

test('a stale tab that wiped the studio settings and its profile gets both back; live values win', () => {
    const backup = studioSnapshot(live());
    // what a tab loaded before the profile existed saves: no creativeStudio, profile gone
    const es = { connectionManager: { profiles: [{ id: 'u1', name: 'Mine' }] } };
    const restored = healSettings(es, backup);
    assert.ok(restored.some(r => r.includes('profile')));
    assert.deepEqual(es.connectionManager.profiles.map(p => p.id), ['u1', 'p1']);
    assert.equal(es.creativeStudio.defaultCreationProfileId, 'p1');
    assert.equal(es.creativeStudio.image.url, 'http://x:8188');
    // live values are never overwritten
    const es2 = live();
    es2.creativeStudio.image.ckpt = 'newer.safetensors';
    assert.deepEqual(healSettings(es2, backup), []);
    assert.equal(es2.creativeStudio.image.ckpt, 'newer.safetensors');
});

test('a profile deleted in Connection Manager is not resurrected; the studio stops tracking it', () => {
    const backup = studioSnapshot(live());
    const es = live();
    es.connectionManager.profiles = es.connectionManager.profiles.filter(p => p.id !== 'p1');
    const restored = healSettings(es, backup);
    assert.deepEqual(restored, []);
    assert.deepEqual(es.connectionManager.profiles.map(p => p.id), ['u1']);
    assert.deepEqual(es.creativeStudio.profileIds, []);
    assert.equal(es.creativeStudio.defaultCreationProfileId, undefined);
});

test('no backup yet: nothing to restore, nothing breaks', () => {
    const es = { connectionManager: { profiles: [] } };
    assert.deepEqual(healSettings(es, null), []);
});
