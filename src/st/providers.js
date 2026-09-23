// AI providers for creation: keys go into SillyTavern's own secret store (never extension settings), and each
// provider becomes a native Connection Manager profile that points at its key by secret id. Model lists come from
// SillyTavern's status endpoint (the provider's /models), never typed in.

import { stContext, stPost } from './env.js';

/** @typedef {{id: string, name: string, source: string, secretKey: string, kind: 'cloud'|'local'|'custom', url?: string, keyUrl?: string, note?: string}} Provider */

/** @type {Provider[]} */
export const PROVIDERS = [
    { id: 'openrouter', name: 'OpenRouter', source: 'openrouter', secretKey: 'api_key_openrouter', kind: 'cloud', keyUrl: 'https://openrouter.ai/keys', note: 'Hundreds of models (Claude, GPT, Gemini, DeepSeek, Llama…) behind one key.' },
    { id: 'openai', name: 'OpenAI', source: 'openai', secretKey: 'api_key_openai', kind: 'cloud', keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'claude', name: 'Anthropic Claude', source: 'claude', secretKey: 'api_key_claude', kind: 'cloud', keyUrl: 'https://console.anthropic.com/settings/keys' },
    { id: 'makersuite', name: 'Google AI Studio', source: 'makersuite', secretKey: 'api_key_makersuite', kind: 'cloud', keyUrl: 'https://aistudio.google.com/apikey', note: 'Gemini models.' },
    { id: 'deepseek', name: 'DeepSeek', source: 'deepseek', secretKey: 'api_key_deepseek', kind: 'cloud', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { id: 'mistralai', name: 'Mistral', source: 'mistralai', secretKey: 'api_key_mistralai', kind: 'cloud', keyUrl: 'https://console.mistral.ai/api-keys' },
    { id: 'groq', name: 'Groq', source: 'groq', secretKey: 'api_key_groq', kind: 'cloud', keyUrl: 'https://console.groq.com/keys', note: 'Very fast open models.' },
    { id: 'xai', name: 'xAI', source: 'xai', secretKey: 'api_key_xai', kind: 'cloud', keyUrl: 'https://console.x.ai', note: 'Grok models.' },
    { id: 'lmstudio', name: 'LM Studio', source: 'custom', secretKey: 'api_key_custom', kind: 'local', url: 'http://127.0.0.1:1234/v1', note: 'Start the server in LM Studio (Developer tab). No key needed.' },
    { id: 'ollama', name: 'Ollama', source: 'custom', secretKey: 'api_key_custom', kind: 'local', url: 'http://127.0.0.1:11434/v1', note: 'Uses Ollama\'s OpenAI-compatible endpoint. No key needed.' },
    { id: 'custom', name: 'Other OpenAI-compatible', source: 'custom', secretKey: 'api_key_custom', kind: 'custom', url: '', note: 'Any server that speaks the OpenAI chat API (vLLM, llama.cpp server, TabbyAPI, KoboldCpp…).' },
];

export const providerById = id => PROVIDERS.find(p => p.id === id) ?? null;

/** Which provider a Connection Manager profile uses (best guess for custom URLs). */
export function providerForProfile(profile) {
    if (!profile) return null;
    if (profile.api !== 'custom') return PROVIDERS.find(p => p.source === profile.api) ?? null;
    const url = String(profile['api-url'] ?? '');
    return PROVIDERS.find(p => p.kind === 'local' && p.url && url.startsWith(p.url.replace(/\/v1$/, ''))) ?? providerById('custom');
}

/** Connection Manager must be enabled: profiles are how the studio routes requests to a provider. */
export function connectionManagerAvailable(ctx = stContext()) {
    return !(ctx.extensionSettings?.disabledExtensions ?? []).includes('connection-manager') && !!ctx.extensionSettings?.connectionManager;
}

/** Stored keys per secret key name: [{ id, label, active, value (masked) }]. Values are never exposed by ST. */
export async function secretState() {
    const res = await stPost('/api/secrets/read', {});
    return res && typeof res === 'object' ? res : {};
}

/** Refresh SillyTavern's own view of the secret store so its UI shows keys added here. */
async function refreshStSecrets() {
    try {
        const mod = await import('../../../../../secrets.js');
        await mod.readSecretState?.();
    } catch { /* the store is still correct; ST's key list updates on reload */ }
}

/**
 * Store an API key in SillyTavern's secret store without changing which key SillyTavern itself uses:
 * writing makes the new key active, so the previously active key (if any) is re-activated right after.
 * @returns {Promise<string>} the new secret id
 */
export async function storeKey(provider, value, label) {
    const key = provider.secretKey;
    const before = (await secretState())[key] ?? [];
    const previous = Array.isArray(before) ? before.find(s => s.active) : null;
    const { id } = await stPost('/api/secrets/write', { key, value: String(value).trim(), label });
    if (!id) throw new Error('SillyTavern did not store the key.');
    rememberStudioSecret(id);
    if (previous?.id) {
        // Put SillyTavern's own key back in charge; if that cannot be done, take the new key out again.
        let restored = false;
        for (let attempt = 0; attempt < 2 && !restored; attempt++) {
            try { restored = (await stPost('/api/secrets/rotate', { key, id: previous.id }, { raw: true })).ok; } catch { restored = false; }
        }
        if (!restored) {
            await stPost('/api/secrets/delete', { key, id }, { raw: true }).catch(() => {});
            forgetStudioSecret(id);
            await refreshStSecrets();
            throw new Error('SillyTavern stored the key but could not switch back to your current key, so the new key was removed again. Nothing changed; please try once more.');
        }
    }
    await refreshStSecrets();
    return id;
}

/** Secret ids this studio created (ids are not secrets). Only these are ever offered for deletion. */
function rememberStudioSecret(id) {
    try {
        const s = studioSettings(stContext());
        if (!s.secretIds.includes(id)) s.secretIds.push(id);
        stContext().saveSettingsDebounced();
    } catch { /* no ST context (tests) */ }
}

function forgetStudioSecret(id) {
    try {
        const s = studioSettings(stContext());
        s.secretIds = s.secretIds.filter(x => x !== id);
        stContext().saveSettingsDebounced();
    } catch { /* no ST context */ }
}

/** Delete a key the studio stored but never saved into a profile (typed and then abandoned or corrected). */
export async function discardStoredKey(provider, id) {
    if (!id) return;
    await stPost('/api/secrets/delete', { key: provider.secretKey, id }, { raw: true }).catch(() => {});
    forgetStudioSecret(id);
    await refreshStSecrets();
}

/**
 * May the key behind a studio profile be deleted together with it? Only if the studio created it, no other
 * profile uses it, and it is not the key SillyTavern itself is currently using.
 */
export async function keyIsDisposable(ctx, profile) {
    const id = profile?.['secret-id'];
    if (!id || !studioSettings(ctx).secretIds.includes(id)) return false;
    if ((ctx.extensionSettings.connectionManager?.profiles ?? []).some(p => p.id !== profile.id && p['secret-id'] === id)) return false;
    const provider = providerForProfile(profile);
    const list = provider ? (await secretState())[provider.secretKey] : null;
    return !(Array.isArray(list) && list.some(s => s.id === id && s.active));
}

/** Keys already stored for a provider (so a key added in SillyTavern can be reused without retyping). */
export async function storedKeys(provider) {
    const list = (await secretState())[provider.secretKey];
    return Array.isArray(list) ? list.map(s => ({ id: s.id, label: s.label || 'Unlabeled', active: !!s.active })) : [];
}

/**
 * Models the provider offers, fetched through SillyTavern (which calls the provider's /models with the stored key).
 * Claude has no model endpoint in SillyTavern 1.19, so its list comes from SillyTavern's own Claude model menu.
 * @returns {Promise<string[]>}
 */
export async function listModels(provider, { secretId = '', url = '' } = {}) {
    if (provider.source === 'claude') {
        const opts = [...document.querySelectorAll('#model_claude_select option')].map(o => o.value).filter(Boolean);
        if (!opts.length) throw new Error('SillyTavern has no Claude model list loaded.');
        return [...new Set(opts)];
    }
    const res = await stPost('/api/backends/chat-completions/status', {
        chat_completion_source: provider.source,
        secret_id: secretId || undefined,
        custom_url: provider.source === 'custom' ? url : undefined,
    }, { raw: true });
    if (!res.ok) throw new Error(res.status === 400 ? 'The provider rejected the request: check the key (or the server URL).' : `Model list failed (HTTP ${res.status}).`);
    const data = await res.json().catch(() => null);
    if (data?.error) throw new Error(provider.kind === 'cloud' ? 'The provider rejected the key, or is unreachable.' : 'The server is not reachable at that URL. Is it running?');
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
    const ids = list.map(m => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Profiles this studio created (ids only; kept in extension settings, which never hold secrets). */
function studioSettings(ctx) {
    ctx.extensionSettings.creativeStudio ??= {};
    ctx.extensionSettings.creativeStudio.profileIds ??= [];
    ctx.extensionSettings.creativeStudio.secretIds ??= [];
    return ctx.extensionSettings.creativeStudio;
}

export function studioProfiles(ctx = stContext()) {
    const ids = new Set(studioSettings(ctx).profileIds);
    return (ctx.extensionSettings?.connectionManager?.profiles ?? []).filter(p => ids.has(p.id));
}

/**
 * Create (or update) a Chat Completion Connection Manager profile for a provider.
 * The profile stores the secret id, never the key.
 */
export function saveProfile(ctx, { id, name, provider, model, url = '', secretId = '' }) {
    const cm = ctx.extensionSettings.connectionManager;
    const profile = {
        id: id ?? (globalThis.crypto?.randomUUID?.() ?? `cs-${Date.now().toString(36)}`),
        mode: 'cc',
        name,
        api: provider.source,
        model,
        ...(provider.source === 'custom' ? { 'api-url': url } : {}),
        ...(secretId ? { 'secret-id': secretId } : {}),
    };
    const i = cm.profiles.findIndex(p => p.id === profile.id);
    if (i >= 0) cm.profiles[i] = { ...cm.profiles[i], ...profile };
    else cm.profiles.push(profile);
    const s = studioSettings(ctx);
    if (!s.profileIds.includes(profile.id)) s.profileIds.push(profile.id);
    ctx.saveSettingsDebounced();
    return profile;
}

/**
 * Remove a studio-created profile; optionally delete its key too, but only when keyIsDisposable says so
 * (never a key the user added in SillyTavern, one another profile uses, or the active one).
 */
export async function removeProfile(ctx, profileId, { deleteKey = false } = {}) {
    const cm = ctx.extensionSettings.connectionManager;
    const profile = cm.profiles.find(p => p.id === profileId);
    const disposable = deleteKey && profile ? await keyIsDisposable(ctx, profile) : false;
    cm.profiles = cm.profiles.filter(p => p.id !== profileId);
    if (cm.selectedProfile === profileId) cm.selectedProfile = null;
    const s = studioSettings(ctx);
    s.profileIds = s.profileIds.filter(x => x !== profileId);
    ctx.saveSettingsDebounced();
    if (disposable) {
        const provider = providerForProfile(profile);
        if (provider) await discardStoredKey(provider, profile['secret-id']);
    }
    return { keyDeleted: disposable };
}

/** Unique profile name, e.g. "Studio · OpenRouter · deepseek-v3.1". */
export function profileName(ctx, provider, model) {
    const short = String(model ?? '').split('/').pop();
    const base = `Studio · ${provider.name}${short ? ` · ${short}` : ''}`;
    const taken = new Set((ctx.extensionSettings?.connectionManager?.profiles ?? []).map(p => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}
