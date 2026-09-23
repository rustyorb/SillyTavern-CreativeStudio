// Live SillyTavern integration: read and deliberately apply project artifacts to the running ST.
// Every write first captures what it will overwrite so it can be restored (see restoreLiveBackup).
// API facts are cited in docs/COMPATIBILITY.md.

import { stContext, stPost } from './env.js';
import { clone, stableStringify, uid } from '../core/bytes.js';
import { toSillyTavernShape, V3_ONLY_FIELDS } from '../core/card.js';
import { jsonDiff } from '../core/diff.js';

const UNSET = '__@@UNSET@@__';

// ------------------------------------------------------------------------------------ characters

export function listStCharacters() {
    const ctx = stContext();
    return (ctx.characters ?? []).map((c, index) => ({ index, avatar: c.avatar, name: c.name, shallow: !!c.shallow, tags: c.tags ?? [] }));
}

/** Full character JSON as stored by ST (top-level V1 mirror + data). */
export async function getStCharacter(avatar) {
    return stPost('/api/characters/get', { avatar_url: avatar });
}

/** PNG bytes of an ST character (keeps the avatar image). */
export async function exportStCharacterPng(avatar) {
    const res = await stPost('/api/characters/export', { avatar_url: avatar, format: 'png' }, { raw: true });
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

/**
 * Import a card file into ST (creates a new character). Returns the new avatar file name.
 * @param {Uint8Array} bytes
 * @param {'png'|'json'|'charx'} type
 */
export async function importIntoSt(bytes, type, fileName = `card.${type}`) {
    const ctx = stContext();
    const form = new FormData();
    form.append('avatar', new Blob([bytes]), fileName);
    form.append('file_type', type);
    form.append('user_name', ctx.name1 ?? 'User');
    const res = await fetch('/api/characters/import', { method: 'POST', headers: ctx.getRequestHeaders({ omitContentType: true }), body: form });
    if (!res.ok) throw new Error(`Import failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error || !json.file_name) throw new Error('SillyTavern rejected the card');
    await ctx.getCharacters?.();
    return `${json.file_name}.png`;
}

/**
 * Compare what we sent with what ST stored, to report lossy conversion honestly.
 * @returns {{ path: string, kind: string }[]} differences inside `data`
 */
export function fidelityReport(sentCard, stored) {
    const sent = clone(sentCard.data);
    const got = clone(stored?.data ?? {});
    // ST adds bookkeeping keys; ignore them.
    for (const k of ['avatar', 'chat', 'create_date']) delete got[k];
    return jsonDiff(sent, got, 'data').filter(d => !/^data\.extensions\.(talkativeness|fav|world|depth_prompt)$/.test(d.path) || d.kind !== 'added');
}

/**
 * Deliberately apply a project card onto an existing ST character via merge-attributes.
 * Keys removed in the project are unset in ST. Returns a backup of the previous ST data.
 */
export async function applyCardToSt(avatar, card, topLevelExtras = {}) {
    const ctx = stContext();
    const before = await getStCharacter(avatar);
    const shaped = toSillyTavernShape(card, topLevelExtras);
    const payload = { avatar, ...pickV1(shaped), tags: shaped.data.tags ?? [], data: clone(shaped.data) };
    // Unset data keys that exist in ST but not in the project (except ST bookkeeping extension keys).
    for (const k of Object.keys(before?.data ?? {})) {
        if (!(k in payload.data)) payload.data[k] = UNSET;
    }
    const beforeExt = before?.data?.extensions ?? {};
    for (const k of Object.keys(beforeExt)) {
        if (!(k in (payload.data.extensions ?? {})) && !['talkativeness', 'fav', 'world', 'depth_prompt'].includes(k)) {
            payload.data.extensions ??= {};
            payload.data.extensions[k] = UNSET;
        }
    }
    delete payload.data.name; // renames go through /rename; keep avatar key stable
    delete payload.name;
    await stPost('/api/characters/merge-attributes', payload);
    await ctx.getOneCharacter?.(avatar);
    const idx = (ctx.characters ?? []).findIndex(c => c.avatar === avatar);
    if (idx >= 0) await ctx.eventSource?.emit?.(ctx.eventTypes.CHARACTER_EDITED, { detail: { id: String(idx), character: ctx.characters[idx] } });
    const after = await getStCharacter(avatar);
    return { backup: { kind: 'character', avatar, data: before, time: new Date().toISOString(), id: uid('bk') }, fidelity: fidelityReport(card, after), renamed: card.data.name !== before?.data?.name };
}

function pickV1(shaped) {
    const out = {};
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) out[k] = shaped[k] ?? '';
    return out;
}

export async function restoreCharacterBackup(backup) {
    const ctx = stContext();
    const { avatar, data } = backup;
    const payload = { avatar, ...clone(data) };
    delete payload.json_data;
    const current = await getStCharacter(avatar);
    for (const k of Object.keys(current?.data ?? {})) if (!(k in (payload.data ?? {}))) payload.data[k] = UNSET;
    await stPost('/api/characters/merge-attributes', payload);
    await ctx.getOneCharacter?.(avatar);
}

// ------------------------------------------------------------------------------------ world info

export async function listStWorlds() {
    const ctx = stContext();
    if (ctx.getWorldInfoNames) return ctx.getWorldInfoNames();
    const list = await stPost('/api/worldinfo/list', {});
    return list.map(x => x.name);
}

export async function getStWorld(name) {
    const ctx = stContext();
    const data = ctx.loadWorldInfo ? await ctx.loadWorldInfo(name) : await stPost('/api/worldinfo/get', { name });
    return clone(data);
}

/** Save a lorebook to ST (creates or overwrites). Returns a backup of the previous content (or null if new). */
export async function saveStWorld(name, data) {
    const ctx = stContext();
    const names = await listStWorlds();
    const existed = names.includes(name);
    const before = existed ? await getStWorld(name) : null;
    if (ctx.saveWorldInfo) {
        await ctx.saveWorldInfo(name, clone(data), true);
    } else {
        await stPost('/api/worldinfo/edit', { name, data });
    }
    if (!existed) await ctx.updateWorldInfoList?.();
    return { backup: { kind: 'world', name, data: before, existed, time: new Date().toISOString(), id: uid('bk') } };
}

export async function restoreWorldBackup(backup) {
    const ctx = stContext();
    if (backup.existed) return saveStWorld(backup.name, backup.data);
    await stPost('/api/worldinfo/delete', { name: backup.name });
    await ctx.updateWorldInfoList?.();
    return null;
}

// ------------------------------------------------------------------------------------ presets

/** apiId: openai | textgenerationwebui | instruct | context | sysprompt | reasoning | kobold | novel */
export function listStPresets(apiId) {
    const ctx = stContext();
    const pm = ctx.getPresetManager?.(apiId);
    if (!pm) return [];
    const all = pm.getAllPresets?.() ?? [];
    return all.map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
}

export function getStPreset(apiId, name) {
    const ctx = stContext();
    const pm = ctx.getPresetManager?.(apiId);
    if (!pm) throw new Error(`No preset manager for ${apiId}`);
    const settings = pm.getCompletionPresetByName?.(name) ?? pm.getPresetSettings?.(name) ?? pm.findPreset?.(name);
    if (!settings) throw new Error(`Preset "${name}" not found`);
    return clone(typeof settings === 'object' ? settings : pm.getPresetSettings(name));
}

export function getSelectedPresetName(apiId) {
    try { return stContext().getPresetManager?.(apiId)?.getSelectedPresetName?.() ?? ''; } catch { return ''; }
}

/** Save a preset file through ST's endpoint; returns backup of any existing preset with that name. */
export async function saveStPreset(apiId, name, preset) {
    const existing = listStPresets(apiId).includes(name);
    let before = null;
    if (existing) {
        try { before = getStPreset(apiId, name); } catch { before = null; }
    }
    await stPost('/api/presets/save', { apiId, name, preset });
    return { backup: { kind: 'preset', apiId, name, data: before, existed: existing, time: new Date().toISOString(), id: uid('bk') }, note: 'Reload SillyTavern or re-select the preset to see changes in its panels.' };
}

// ------------------------------------------------------------------------------------ regex

export function getStRegex() {
    const ctx = stContext();
    const global = clone(ctx.extensionSettings?.regex ?? []);
    const chid = ctx.characterId;
    const char = chid != null ? ctx.characters?.[chid] : null;
    const scoped = clone(char?.data?.extensions?.regex_scripts ?? []);
    return { global, scoped, characterName: char?.name ?? '', characterAvatar: char?.avatar ?? '', allowedScoped: (ctx.extensionSettings?.character_allowed_regex ?? []).includes(char?.avatar) };
}

export async function saveStGlobalRegex(scripts) {
    const ctx = stContext();
    const before = clone(ctx.extensionSettings.regex ?? []);
    ctx.extensionSettings.regex = clone(scripts);
    ctx.saveSettingsDebounced();
    return { backup: { kind: 'regex-global', data: before, time: new Date().toISOString(), id: uid('bk') }, note: 'Open the Regex panel again (or reload) for the list to refresh.' };
}

export async function saveStScopedRegex(avatar, scripts) {
    const ctx = stContext();
    const idx = ctx.characters.findIndex(c => c.avatar === avatar);
    if (idx < 0) throw new Error('Character not found in SillyTavern');
    const before = clone(ctx.characters[idx]?.data?.extensions?.regex_scripts ?? []);
    await ctx.writeExtensionField(idx, 'regex_scripts', clone(scripts));
    return { backup: { kind: 'regex-scoped', avatar, data: before, time: new Date().toISOString(), id: uid('bk') } };
}

// ------------------------------------------------------------------------------------ quick replies

export function qrApi() {
    return globalThis.quickReplyApi ?? null;
}

export async function listStQrSets() {
    const api = qrApi();
    if (api?.listSets) return api.listSets();
    const settings = await stPost('/api/settings/get', {});
    return (settings.quickReplyPresets ?? []).map(s => s.name);
}

export async function getStQrSet(name) {
    const settings = await stPost('/api/settings/get', {});
    const set = (settings.quickReplyPresets ?? []).find(s => s.name === name);
    if (set) return clone(set);
    const live = qrApi()?.getSetByName?.(name);
    if (live?.toJSON) return clone(live.toJSON());
    throw new Error(`Quick Reply set "${name}" not found`);
}

/** Save a QR set JSON file. ST loads sets at startup; a reload makes the new/updated set visible. */
export async function saveStQrSet(set) {
    let before = null;
    try { before = await getStQrSet(set.name); } catch { before = null; }
    await stPost('/api/quick-replies/save', set);
    return { backup: { kind: 'qr', name: set.name, data: before, existed: !!before, time: new Date().toISOString(), id: uid('bk') }, note: 'Reload SillyTavern for Quick Reply to pick up the saved set file.' };
}

// ------------------------------------------------------------------------------------ connection profiles

export function listStProfiles() {
    const ctx = stContext();
    return clone(ctx.extensionSettings?.connectionManager?.profiles ?? []).map(p => {
        // Never copy secret ids into projects.
        delete p['secret-id'];
        return p;
    });
}

// ------------------------------------------------------------------------------------ prompt preview (dry run)

/**
 * Assemble the real prompt ST would send for the current chat, without sending it.
 * Recipe verified in docs/research/st-extension-api.md §6.
 * @returns {Promise<{ api: string, messages?: {role: string, content: string}[], text?: string, raw: any }>}
 */
export async function dryRunPrompt() {
    const ctx = stContext();
    if (ctx.characterId == null && !ctx.groupId) throw new Error('Open a chat with a character first: a dry run assembles the prompt for the current chat.');
    let captured = null;
    const onData = (data, dryRun) => { if (dryRun) captured = clone(data); };
    ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, onData);
    try {
        await ctx.generate('normal', {}, true);
    } finally {
        ctx.eventSource.removeListener(ctx.eventTypes.GENERATE_AFTER_DATA, onData);
    }
    if (!captured) throw new Error('SillyTavern did not produce a prompt (is an API selected?)');
    if (Array.isArray(captured.prompt)) return { api: ctx.mainApi, messages: captured.prompt, raw: captured };
    if (Array.isArray(captured.messages)) return { api: ctx.mainApi, messages: captured.messages, raw: captured };
    return { api: ctx.mainApi, text: String(captured.prompt ?? ''), raw: captured };
}

/** Snapshot of the active configuration for reproducible playtests. */
export function activeConfiguration() {
    const ctx = stContext();
    const cm = ctx.extensionSettings?.connectionManager ?? {};
    const profile = (cm.profiles ?? []).find(p => p.id === cm.selectedProfile);
    const pu = ctx.powerUserSettings ?? {};
    let model = '';
    try { model = ctx.mainApi === 'openai' ? ctx.getChatCompletionModel?.() ?? '' : ctx.onlineStatus ?? ''; } catch { /* ignore */ }
    return {
        time: new Date().toISOString(),
        mainApi: ctx.mainApi,
        model,
        connectionProfile: profile ? { id: profile.id, name: profile.name } : null,
        presets: {
            openai: getSelectedPresetName('openai'),
            textgenerationwebui: getSelectedPresetName('textgenerationwebui'),
            instruct: pu.instruct?.enabled ? pu.instruct?.preset ?? '' : '(instruct off)',
            context: pu.context?.preset ?? '',
            sysprompt: pu.sysprompt?.enabled === false ? '(off)' : pu.sysprompt?.name ?? '',
        },
        character: ctx.characterId != null ? ctx.characters?.[ctx.characterId]?.name ?? '' : '',
        persona: ctx.name1,
        chatId: ctx.getCurrentChatId?.() ?? '',
        maxContext: ctx.maxContext,
        stVersion: '1.19.0',
    };
}

export function sameJson(a, b) {
    return stableStringify(a) === stableStringify(b);
}

export { V3_ONLY_FIELDS };
