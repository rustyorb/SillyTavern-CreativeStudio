// "AI for creation": pick which model writes for you, or add a provider (cloud key or local server).
// Keys are stored by SillyTavern's secret store; the studio keeps only profile ids.
import { html, useState, useEffect, useRef, Button, Icon, Badge, Section, Modal, cx } from './kit.js';
import { stContext } from '../st/env.js';
import { ImageSetup } from './image-setup.js';
import { openPromptSettings } from './prompt-settings.js';
import { scheduleSettingsBackup } from '../st/studio-settings.js';
import { describeRoute, listProfiles, runStructured } from '../ai/gateway.js';
import {
    PROVIDERS, providerForProfile, connectionManagerAvailable, storeKey, storedKeys, listModels, saveProfile, removeProfile,
    studioProfiles, profileName, keyIsDisposable, discardStoredKey,
} from '../st/providers.js';

/** Open the panel from anywhere (e.g. the "Creation model" menu). */
export function openAiSetup() {
    globalThis.dispatchEvent(new CustomEvent('cs-ai-setup'));
}

/** Round trip through a profile: a tiny structured request, timed. */
export async function testProfile(profileId) {
    const t0 = Date.now();
    const r = await runStructured(stContext(), {
        system: 'You are a connectivity check.',
        user: 'Reply with {"ok": true}.',
        schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        schemaName: 'ping',
        profileId,
        maxTokens: 300,
        repair: false,
        timeoutMs: 60000,
    });
    if (r.value?.ok !== true) throw new Error('Unexpected answer from the model.');
    return Date.now() - t0;
}

export function AiSetup({ store, env, project, onClose }) {
    const ctx = stContext();
    const [tick, setTick] = useState(0);
    const refresh = () => setTick(t => t + 1);
    const current = project.settings?.creationProfileId ?? '';
    const route = describeRoute(ctx, current);
    const all = listProfiles(ctx);
    const mine = studioProfiles(ctx);
    const [tests, setTests] = useState({});
    const [adding, setAdding] = useState(null);
    const cmOk = connectionManagerAvailable(ctx);

    const use = id => {
        store.update(p => ({ ...p, settings: { ...p.settings, creationProfileId: id } }), 'creation model');
        ctx.extensionSettings.creativeStudio ??= {};
        ctx.extensionSettings.creativeStudio.defaultCreationProfileId = id;
        ctx.saveSettingsDebounced();
        scheduleSettingsBackup(ctx);
    };
    const test = async id => {
        setTests(t => ({ ...t, [id]: { busy: true } }));
        try {
            const ms = await testProfile(id);
            setTests(t => ({ ...t, [id]: { ok: true, ms } }));
        } catch (e) {
            setTests(t => ({ ...t, [id]: { ok: false, error: e.message } }));
        }
    };
    const remove = async p => {
        // Only a key the studio added (and nothing else uses) can go with the profile; the user's own keys are never offered.
        const deleteKey = (await keyIsDisposable(ctx, p)) ? await env.confirm(`Also delete the API key the studio stored for “${p.name}”?`, 'Choose No to keep the key in SillyTavern (you can reuse it later).') : false;
        await removeProfile(ctx, p.id, { deleteKey });
        if (current === p.id) use('');
        refresh();
    };

    return html`<${Modal} title="AI for creation" onClose=${onClose} wide>
        <div class="cs-ai-now">
            <${Icon} name="wand-magic-sparkles" />
            <div class="cs-grow">
                <div class="cs-muted cs-small">The studio writes with</div>
                <strong>${route.label}</strong>
                ${!route.ok && html`<div class="cs-err-text cs-small">${route.label}</div>`}
            </div>
            <select class="text_pole cs-input" style="width:auto;max-width:320px" aria-label="Creation model" value=${current} onChange=${e => use(e.currentTarget.value)}>
                <option value="">Main connection</option>
                ${all.map(p => html`<option value=${p.id} selected=${p.id === current}>${p.name}</option>`)}
            </select>
            <${Button} small icon="stethoscope" label="Test" onClick=${() => test(current)} disabled=${tests[current]?.busy} />
        </div>
        ${tests[current] && html`<${TestResult} t=${tests[current]} />`}
        <div class="cs-muted cs-small">Your roleplay chat keeps using SillyTavern's main connection. Creation can use a different model (a strong, fast one is ideal) through a Connection Manager profile.</div>
        <div class="cs-row">
            <${Button} small icon="scroll" label="AI instructions & content level…" title="Read and edit every instruction the studio gives the model; choose what this project allows" onClick=${() => { onClose(); openPromptSettings(); }} />
        </div>

        ${!cmOk && html`<div class="cs-warn-text"><${Icon} name="triangle-exclamation" /> Enable SillyTavern's built-in <strong>Connection Manager</strong> extension (Extensions → Manage extensions) to add providers here. The main connection works without it.</div>`}

        ${cmOk && html`<${Section} key=${mine.length > 0 ? 'some' : 'none'} title=${`Added from the studio (${mine.length})`} open=${mine.length > 0}>
            ${mine.length ? html`<table class="cs-table"><tbody>${mine.map(p => {
                const prov = providerForProfile(p);
                const t = tests[p.id];
                return html`<tr key=${p.id}>
                    <td><strong>${p.name}</strong><div class="cs-muted cs-small">${prov?.name ?? p.api}${p['api-url'] ? ` · ${p['api-url']}` : ''}</div></td>
                    <td class="cs-small cs-mono">${p.model}</td>
                    <td>${t ? html`<${TestResult} t=${t} inline />` : ''}</td>
                    <td style="white-space:nowrap;text-align:right">
                        ${current === p.id ? html`<${Badge} kind="ok">in use</${Badge}>` : html`<${Button} small kind="primary" label="Use" onClick=${() => use(p.id)} />`}
                        <${Button} small icon="stethoscope" title="Test" onClick=${() => test(p.id)} disabled=${t?.busy} />
                        <${Button} small icon="trash" kind="danger" title="Remove" onClick=${() => remove(p)} />
                    </td>
                </tr>`;
            })}</tbody></table>` : html`<div class="cs-muted cs-small">None yet. Add a provider below.</div>`}
        </${Section}>

        <${Section} title="Add a provider">
            <div class="cs-provider-grid" role="list">
                ${PROVIDERS.map(p => html`<button key=${p.id} role="listitem" class=${cx('cs-provider', adding?.id === p.id && 'active')} onClick=${() => setAdding(adding?.id === p.id ? null : p)}>
                    <span class="cs-provider-name">${p.name}</span>
                    <${Badge} kind=${p.kind === 'cloud' ? 'accent' : 'ok'}>${p.kind === 'cloud' ? 'cloud' : 'local'}</${Badge}>
                </button>`)}
            </div>
            ${adding && html`<${AddProvider} key=${adding.id} provider=${adding} ctx=${ctx} env=${env}
                onSaved=${profile => { use(profile.id); setAdding(null); refresh(); test(profile.id); }} />`}
        </${Section}>`}

        <${ImageSetup} env=${env} />
    </${Modal}>`;
}

function TestResult({ t, inline }) {
    if (t.busy) return html`<span class="cs-muted cs-small"><span class="cs-spin"><${Icon} name="spinner" /></span> Testing…</span>`;
    if (t.ok) return html`<span class="cs-ok-text cs-small"><${Icon} name="circle-check" /> Works (${(t.ms / 1000).toFixed(1)} s)</span>`;
    return html`<span class="cs-err-text cs-small" title=${t.error}><${Icon} name="circle-xmark" /> ${inline ? 'Failed' : t.error}</span>`;
}

function AddProvider({ provider, ctx, env, onSaved }) {
    const cloud = provider.kind === 'cloud';
    const [url, setUrl] = useState(provider.url ?? '');
    const [key, setKey] = useState('');
    const [existing, setExisting] = useState([]);
    const [keyChoice, setKeyChoice] = useState('new'); // 'new' | secret id
    const [pendingId, setPendingId] = useState(''); // a key stored here but not yet saved into a profile
    const [models, setModels] = useState(null);
    const [filter, setFilter] = useState('');
    const [model, setModel] = useState('');
    const [busy, setBusy] = useState('');
    const [err, setErr] = useState('');
    const pending = useRef(''); // mirrors pendingId for the unmount cleanup
    const mounted = useRef(true);

    useEffect(() => {
        storedKeys(provider).then(list => {
            setExisting(list);
            if (cloud && list.length) setKeyChoice(list.find(k => k.active)?.id ?? list[0].id);
        }).catch(() => setExisting([]));
    }, [provider.id]);
    // A key typed here and then abandoned is removed again, so nothing is left behind in SillyTavern.
    useEffect(() => () => {
        mounted.current = false;
        if (pending.current) discardStoredKey(provider, pending.current);
    }, []);

    /** Editing the key (or switching away from "new") retires a key stored for the previous text. */
    const dropPending = () => {
        if (!pending.current) return;
        discardStoredKey(provider, pending.current);
        pending.current = '';
        setPendingId('');
    };

    const secretIdFor = async () => {
        if (keyChoice !== 'new') return keyChoice;
        if (!key.trim()) return cloud ? null : '';
        if (pendingId) return pendingId;
        const id = await storeKey(provider, key, `Creative Studio · ${provider.name}`);
        if (!mounted.current) {
            // The panel closed while the key was being stored.
            await discardStoredKey(provider, id);
            throw new Error('Closed');
        }
        pending.current = id;
        setPendingId(id);
        return id;
    };
    const load = async () => {
        setBusy('models');
        setErr('');
        try {
            const secretId = await secretIdFor();
            if (secretId === null) throw new Error('Paste an API key first.');
            const list = await listModels(provider, { secretId, url });
            if (!list.length) throw new Error('The provider returned no models.');
            setModels(list);
            if (!list.includes(model)) setModel(list[0]);
        } catch (e) { setErr(e.message); } finally { setBusy(''); }
    };
    const save = async () => {
        setBusy('save');
        setErr('');
        try {
            const secretId = await secretIdFor();
            const profile = saveProfile(ctx, { name: profileName(ctx, provider, model), provider, model, url, secretId: secretId || '' });
            pending.current = '';
            env.toast(`Added “${profile.name}”. It is also listed in SillyTavern's Connection Manager.`, 'ok', 6000);
            onSaved(profile);
        } catch (e) { setErr(e.message); } finally { setBusy(''); }
    };
    const shown = (models ?? []).filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));

    return html`<div class="cs-provider-form">
        <div class="cs-row-between"><strong>${provider.name}</strong>${provider.keyUrl && html`<a class="cs-small" href=${provider.keyUrl} target="_blank" rel="noopener noreferrer">Get an API key <${Icon} name="arrow-up-right-from-square" /></a>`}</div>
        ${provider.note && html`<div class="cs-muted cs-small">${provider.note}</div>`}
        ${!cloud && html`<label class="cs-field"><span class="cs-field-head"><span>Server URL</span></span>
            <input class="text_pole cs-input cs-mono" value=${url} placeholder="http://127.0.0.1:1234/v1" onInput=${e => { setUrl(e.currentTarget.value); setModels(null); }} /></label>`}
        ${(cloud || existing.length > 0) && html`<div class="cs-stack">
            ${existing.length > 0 && html`<label class="cs-field"><span class="cs-field-head"><span>API key</span></span>
                <select class="text_pole cs-input" value=${keyChoice} onChange=${e => { dropPending(); setKeyChoice(e.currentTarget.value); setModels(null); }}>
                    ${existing.map(k => html`<option value=${k.id} selected=${k.id === keyChoice}>Use a stored key: ${k.label}${k.active ? ' (active in SillyTavern)' : ''}</option>`)}
                    <option value="new" selected=${keyChoice === 'new'}>Add a new key…</option>
                </select></label>`}
            ${keyChoice === 'new' && html`<label class="cs-field"><span class="cs-field-head"><span>${existing.length ? 'New API key' : cloud ? 'API key' : 'API key (only if your server needs one)'}</span></span>
                <input type="password" autocomplete="off" class="text_pole cs-input cs-mono" value=${key} placeholder=${cloud ? 'Paste your key' : 'optional'}
                    onInput=${e => { dropPending(); setKey(e.currentTarget.value); setModels(null); }} /></label>`}
        </div>`}
        <div class="cs-muted cs-small"><${Icon} name="lock" /> Keys are saved in SillyTavern's own secret store, not in extension settings. Your chat connection keeps its current key.</div>
        <div class="cs-row">
            <${Button} icon="list" label=${models ? 'Reload models' : 'Load models'} onClick=${load} disabled=${!!busy || (cloud && keyChoice === 'new' && !key.trim()) || (!cloud && !url.trim())} />
            ${busy === 'models' && html`<span class="cs-muted cs-small"><span class="cs-spin"><${Icon} name="spinner" /></span> Asking ${provider.name}…</span>`}
        </div>
        ${models && html`<div class="cs-stack">
            <input class="text_pole cs-input" placeholder=${`Filter ${models.length} models…`} value=${filter} onInput=${e => setFilter(e.currentTarget.value)} aria-label="Filter models" />
            <select class="text_pole cs-input cs-mono" size=${Math.min(10, Math.max(3, shown.length))} value=${model} onChange=${e => setModel(e.currentTarget.value)} aria-label="Model">
                ${shown.slice(0, 500).map(m => html`<option value=${m} selected=${m === model}>${m}</option>`)}
            </select>
            <div class="cs-row">
                <${Button} kind="primary" icon="check" label="Save and use for creation" onClick=${save} disabled=${!!busy || !model} />
                <span class="cs-muted cs-small">${model ? `Creates the profile “${profileName(ctx, provider, model)}”.` : ''}</span>
            </div>
        </div>`}
        ${err && html`<div class="cs-err-text cs-small"><${Icon} name="triangle-exclamation" /> ${err}</div>`}
    </div>`;
}
