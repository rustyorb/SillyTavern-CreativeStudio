// AI UI plumbing: task runner hook, route indicator, profile picker.
import { html, useState, useRef, useCallback, Button, Icon, Badge, cx } from './kit.js';
import { runStructured, describeRoute, listProfiles, AiError } from '../ai/gateway.js';
import { openAiSetup } from './providers-panel.js';
import { getTask, taskSchema } from '../ai/tasks.js';
import { stContext } from '../st/env.js';

/**
 * Hook: run an AI task with status, cancellation and error capture. Drafts are never touched here;
 * callers turn results into proposals.
 */
export function useAiTask(store) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState(null);
    const ctrl = useRef(null);

    const run = useCallback(async (taskId, args) => {
        const task = getTask(taskId);
        ctrl.current?.abort();
        const ac = new AbortController();
        ctrl.current = ac;
        setBusy(true);
        setError(null);
        setStatus('Preparing…');
        try {
            const { system, user } = task.build(args);
            const profileId = store.get().settings?.creationProfileId ?? '';
            const result = await runStructured(stContext(), {
                system, user, schema: taskSchema(task, args), schemaName: task.schemaName, profileId,
                maxTokens: args?.maxTokens ?? task.maxTokens, signal: ac.signal, onStatus: setStatus,
            });
            setStatus(`Done in ${(result.meta.durationMs / 1000).toFixed(1)}s${result.meta.repaired.length ? ` (repaired: ${result.meta.repaired.join(', ')})` : ''}${result.meta.validationErrors?.length ? ` · ${result.meta.validationErrors.length} schema warning(s)` : ''}`);
            return { ...result, generation: { task: taskId, ...result.meta, prompt: `${system}\n---\n${user}` } };
        } catch (e) {
            const err = e instanceof AiError ? e : new AiError(e?.message ?? String(e), { cause: e });
            setError(err);
            setStatus('');
            return null;
        } finally {
            if (ctrl.current === ac) ctrl.current = null;
            setBusy(false);
        }
    }, [store]);

    const cancel = useCallback(() => {
        ctrl.current?.abort();
        setStatus('Cancelled.');
    }, []);

    return { run, cancel, busy, status, error, clearError: () => setError(null) };
}

/** Status line + cancel + error details (raw output kept for inspection). */
export function AiStatus({ ai }) {
    const [showRaw, setShowRaw] = useState(false);
    if (!ai.busy && !ai.status && !ai.error) return null;
    return html`<div class="cs-ai-status" role="status" aria-live="polite">
        ${ai.busy && html`<${Icon} name="spinner" /><span class="cs-spin" aria-hidden="true"></span>`}
        <span>${ai.status}</span>
        ${ai.busy && html`<${Button} small icon="stop" label="Cancel" onClick=${ai.cancel} />`}
        ${ai.error && html`<span class="cs-err-text"><${Icon} name="triangle-exclamation" /> ${ai.error.message}</span>
            ${ai.error.raw && html`<${Button} small label=${showRaw ? 'Hide output' : 'Show raw output'} onClick=${() => setShowRaw(!showRaw)} />`}
            <${Button} small icon="xmark" title="Dismiss" onClick=${ai.clearError} />`}
        ${showRaw && ai.error?.raw && html`<pre class="cs-pre">${ai.error.raw}</pre>`}
    </div>`;
}

/** Shows which model/profile creation tasks will use; lets the author pick a separate creation profile. */
export function CreationRoute({ store, project, compact }) {
    let ctx;
    try { ctx = stContext(); } catch { return null; }
    const profiles = listProfiles(ctx);
    const current = project.settings?.creationProfileId ?? '';
    const route = describeRoute(ctx, current);
    const set = id => store.update(p => ({ ...p, settings: { ...p.settings, creationProfileId: id } }), 'creation profile');
    const pick = e => {
        if (e.currentTarget.value === '__add__') {
            e.currentTarget.value = current;
            openAiSetup();
            return;
        }
        set(e.currentTarget.value);
    };
    const tip = `Creation model: ${route.label}${route.ok && !route.schemaEnforced ? '. JSON by instruction (no schema enforcement).' : ''}\nYour roleplay chat keeps its own connection.`;
    return html`<div class=${cx('cs-row', 'cs-small')} title=${tip}>
        <${Icon} name="wand-magic-sparkles" />
        ${!compact && html`<span class="cs-muted">Creation model:</span>`}
        <select class="text_pole cs-input" style="width:auto;max-width:260px" value=${current} onChange=${pick} aria-label="Creation connection profile">
            <option value="">Main connection${current ? '' : route.model ? ` (${String(route.model).split('/').pop()})` : ''}</option>
            ${profiles.map(p => html`<option value=${p.id} selected=${p.id === current}>${p.name}</option>`)}
            <option value="__add__">＋ Add a provider…</option>
        </select>
        ${!route.ok && html`<span class="cs-err-text">${route.label}</span>`}
        ${route.ok && !route.schemaEnforced && html`<${Badge} title="Text Completion: the studio asks for JSON by instruction and repairs the answer">JSON by instruction</${Badge}>`}
    </div>`;
}
