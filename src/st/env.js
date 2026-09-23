// Runtime environment: binds the studio to the running SillyTavern (context, REST, dialogs, autosave).
import { createStorage } from './storage.js';

export function stContext() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx) throw new Error('SillyTavern context is not available');
    return ctx;
}

/** JSON POST to a SillyTavern endpoint with CSRF headers. */
export async function stPost(url, body, { raw = false } = {}) {
    const ctx = stContext();
    const res = await fetch(url, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body ?? {}) });
    if (raw) return res;
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${url} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.text();
}

async function makeCache() {
    try {
        const lf = globalThis.SillyTavern?.libs?.localforage;
        if (lf?.createInstance) return lf.createInstance({ name: 'CreativeStudio' });
    } catch { /* optional */ }
    return null;
}

/**
 * The user's live World Info scan settings (exported `let` bindings of /scripts/world-info.js).
 * Path: this file is served at /scripts/extensions/third-party/<folder>/src/st/ → five levels up is /scripts/.
 */
export async function readStWorldInfoSettings() {
    try {
        const wi = await import('../../../../../world-info.js');
        return {
            depth: wi.world_info_depth,
            minActivations: wi.world_info_min_activations,
            minActivationsDepthMax: wi.world_info_min_activations_depth_max,
            budget: wi.world_info_budget,
            budgetCap: wi.world_info_budget_cap,
            includeNames: wi.world_info_include_names,
            recursive: wi.world_info_recursive,
            caseSensitive: wi.world_info_case_sensitive,
            matchWholeWords: wi.world_info_match_whole_words,
            useGroupScoring: wi.world_info_use_group_scoring,
            maxRecursionSteps: wi.world_info_max_recursion_steps,
        };
    } catch {
        return null;
    }
}

export async function createEnvironment() {
    const ctx = stContext();
    const cache = await makeCache();
    const storage = createStorage({
        upload: async (name, data) => (await stPost('/api/files/upload', { name, data })).path,
        fetch: path => fetch(`/${path.replace(/^\//, '')}`, { cache: 'no-store', headers: { 'X-CSRF-Token': ctx.getRequestHeaders()['X-CSRF-Token'] } }),
        remove: async path => { await stPost('/api/files/delete', { path }); },
        cache,
    });

    const saveListeners = new Set();
    const toastListeners = new Set();
    let saveState = { status: 'idle', label: 'Saved' };
    let store = null;
    let timer = null;
    let saving = null;
    let dirty = false;
    let baseRevision;
    let baseProjectId;

    const setSaveState = s => {
        saveState = s;
        saveListeners.forEach(l => l(s));
    };

    async function saveNow() {
        if (!store) return;
        clearTimeout(timer);
        if (saving) await saving;
        if (!dirty && saveState.status !== 'error') return;
        dirty = false;
        setSaveState({ status: 'saving', label: 'Saving…' });
        const current = store.get();
        if (baseRevision === undefined || baseProjectId !== current.id) { baseRevision = current.revision ?? null; baseProjectId = current.id; }
        saving = storage.saveProject(current, { baseRevision: baseRevision ?? undefined }).then(r => {
            if (r.revision) baseRevision = r.revision;
            if (r.conflict) toastListeners.forEach(l => l({ text: 'Another tab or device saved this project meanwhile. Their version was kept as a snapshot (Inspector → Snapshots) before saving yours.', kind: 'error', ms: 10000 }));
            if (r.where === 'server') setSaveState({ status: 'idle', label: 'Saved', detail: `Saved to SillyTavern user files at ${new Date().toLocaleTimeString()}` });
            else setSaveState({ status: 'error', label: 'Saved locally only', detail: `Server save failed (${r.error}); a copy is in this browser. Will retry on next change.` });
        }).catch(e => setSaveState({ status: 'error', label: 'Save failed', detail: e.message }))
            .finally(() => { saving = null; });
        return saving;
    }

    const env = {
        ctx,
        storage,
        stPost,
        attachStore(s) {
            store = s;
            s.subscribe(() => {
                dirty = true;
                setSaveState({ status: 'dirty', label: 'Unsaved' });
                clearTimeout(timer);
                timer = setTimeout(saveNow, 1200);
            });
        },
        saveNow,
        flush: () => saveNow(),
        saveState: () => saveState,
        onSaveState(fn) {
            saveListeners.add(fn);
            return () => saveListeners.delete(fn);
        },
        onToast(fn) {
            toastListeners.add(fn);
            return () => toastListeners.delete(fn);
        },
        toast(text, kind = '', ms) {
            toastListeners.forEach(l => l({ text, kind, ms }));
        },
        /** Text prompt using ST's popup (falls back to window.prompt). */
        async prompt(title, value = '') {
            const c = stContext();
            if (c.callGenericPopup && c.POPUP_TYPE) {
                const r = await c.callGenericPopup(title, c.POPUP_TYPE.INPUT, value);
                return typeof r === 'string' ? r.trim() : null;
            }
            return window.prompt(title, value);
        },
        async confirm(title, text = '') {
            const c = stContext();
            if (c.callGenericPopup && c.POPUP_TYPE) {
                const r = await c.callGenericPopup(`<h3>${escapeHtml(title)}</h3>${text ? `<p>${escapeHtml(text)}</p>` : ''}`, c.POPUP_TYPE.CONFIRM);
                return r === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) || r === true;
            }
            return window.confirm(`${title}\n\n${text}`);
        },
        /** Token counter using ST's active tokenizer. */
        countTokens: async text => {
            const c = stContext();
            if (c.getTokenCountAsync) return c.getTokenCountAsync(text);
            return Math.ceil(String(text).length / 3.6);
        },
    };
    return env;
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
