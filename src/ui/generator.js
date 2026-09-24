// "Generate a complete roleplay": one idea (or none) + optional dials → a whole linked project, built step by step.
import { html, useState, Button, Icon, Badge, Section, Select, cx } from './kit.js';
import { CreationRoute } from './ai.js';
import { STEPS, DEFAULT_STEPS, newRun, runPipeline, retryable, discardRun } from '../ai/pipeline.js';
import { DIALS, getTask, taskSchema, buildTask } from '../ai/tasks.js';
import { promptOverrides } from '../st/prompt-store.js';
import { contentOf, contentFromRating, imageRating } from '../core/content.js';
import { runStructured } from '../ai/gateway.js';
import { stContext } from '../st/env.js';
import { commandRegistry, describeCommand } from '../st/stscript-live.js';
import { paint, imageSettings, imageReady, familyOf } from '../st/comfy.js';
import { FAMILIES } from '../core/comfy.js';
import { saveMedia } from './media.js';
import { openPullPicker } from './st-pull.js';

/** Controllers of runs in flight, so any mounted view (or none) can cancel them. */
const running = new Map();

export function makeRunTask(store, env, onStatus = () => {}) {
    return async (taskId, args, signal) => {
        if (taskId === 'image.portrait') {
            // Painting, not writing: the picture is saved as project media and handed to the step.
            const t0 = Date.now();
            const r = await paint({ prompt: args.prompt, negative: args.negative, purpose: args.purpose, rating: imageRating(contentOf(store.get())), signal });
            const { media } = await saveMedia(env, store.get(), r.bytes, { name: args.name ?? 'portrait', role: 'generated' });
            Object.assign(media, { prompt: r.positive, seed: r.seed, purpose: args.purpose });
            return { value: { media }, generation: { task: taskId, label: 'ComfyUI', durationMs: Date.now() - t0 } };
        }
        const task = getTask(taskId);
        const { system, user } = buildTask(taskId, args, { overrides: promptOverrides(), content: contentOf(store.get()) });
        const profileId = store.get().settings?.creationProfileId ?? '';
        const r = await runStructured(stContext(), { system, user, schema: taskSchema(task, args), schemaName: task.schemaName, profileId, maxTokens: args?.maxTokens ?? task.maxTokens, signal, onStatus });
        return { value: r.value, generation: { task: taskId, ...r.meta, prompt: `${system}\n---\n${user}` } };
    };
}

function commandList() {
    try {
        const reg = commandRegistry();
        return ['echo', 'setvar', 'getvar', 'addvar', 'incvar', 'if', 'gen', 'trigger', 'sendas', 'sys', 'inject', 'input', 'popup', 'setinput', 'rand', 'roll']
            .filter(c => reg.allNames.has(c)).map(c => {
                const d = describeCommand(reg.byName.get(c));
                return d ? `/${c} ${d.named.map(a => `${a.name}=`).join(' ')} — ${d.help.slice(0, 80)}` : `/${c}`;
            }).join('\n');
    } catch { return ''; }
}

export async function startGeneration(store, env, run) {
    // Only one pipeline per run id, and the run shows as running before anything is awaited (no double starts).
    if (running.has(run.id)) return run;
    const ac = new AbortController();
    running.set(run.id, ac);
    const progress = { history: false };
    store.update(p => ({ ...p, generationRuns: [...(p.generationRuns ?? []).filter(x => x.id !== run.id), { ...run, status: 'running' }] }), 'generation progress', progress);
    try {
        await env.saveNow();
        await env.storage.saveSnapshot(store.get(), 'Before AI generation', 'auto').catch(() => {});
        const runTask = makeRunTask(store, env);
        const r = { ...run, state: { ...run.state, commandList: run.state.commandList ?? commandList(), promptStyle: run.state.promptStyle ?? currentPromptStyle() } };
        return await runPipeline({
            getProject: () => store.get(),
            // Progress records are bookkeeping: saved, but not undo steps (undo reverts what was written, not the log).
            update: (fn, label) => store.update(fn, label, label === 'generation progress' ? progress : undefined),
            runTask: (t, a) => runTask(t, a, ac.signal),
            run: r,
            signal: ac.signal,
        });
    } finally {
        running.delete(run.id);
    }
}

/** Image prompts are written as tags or sentences depending on the checkpoint the author paints with. */
function currentPromptStyle() {
    try { return FAMILIES[familyOf(imageSettings())]?.tags ? 'tags' : 'natural'; } catch { return 'tags'; }
}

function imagesOn() {
    try { return imageReady(); } catch { return false; }
}

/** The steps a new run starts with: the defaults, plus the portrait when an image generator is set up. */
export function startingSteps() {
    return imagesOn() ? [...DEFAULT_STEPS, 'art'] : [...DEFAULT_STEPS];
}

/** Which generation steps an existing character still needs (so building "the rest" never duplicates artifacts). */
export function missingSteps(ch) {
    const d = ch?.card?.data ?? {};
    const has = v => (Array.isArray(v) ? v.length > 0 : !!String(v ?? '').trim());
    const need = [];
    if (!['description', 'scenario', 'first_mes', 'mes_example'].every(k => has(d[k]))) need.push('card');
    if ((d.alternate_greetings?.length ?? 0) < 2) need.push('greetings');
    if (!ch?.links?.lorebooks?.length && !d.character_book?.entries?.length) need.push('lore');
    if (!ch?.links?.presets?.length) need.push('preset');
    if (!d.extensions?.regex_scripts?.length) need.push('regex');
    if (!ch?.links?.qrSets?.length) need.push('qr');
    if (!ch?.imagePrompts?.length) need.push('images');
    if (imagesOn() && !ch?.avatarMediaId) need.push('art');
    if (need.length) need.push('polish');
    return need;
}

/** Build everything around an existing character that it does not have yet (card gaps → openings → lore → preset → regex → QR → images → polish). */
export function developCharacter(store, env, characterId, { steps, dials } = {}) {
    const p = store.get();
    const ch = p.characters.find(c => c.id === characterId);
    steps ??= missingSteps(ch);
    if (!steps.length) {
        env.toast(`${ch?.card.data.name ?? 'This character'} already has everything: card, openings, lore, preset, regex, Quick Replies and image prompts.`, 'ok', 6000);
        return Promise.resolve({ status: 'done', steps: {} });
    }
    const run = newRun({ idea: p.premise ?? '', dials: dials ?? p.lastDials ?? {}, steps });
    run.steps.premise = { status: 'done' };
    run.steps.concept = { status: 'done' };
    const lb = ch?.links?.lorebooks?.[0];
    const pr = ch?.links?.presets?.[0];
    run.state = {
        ...run.state, characterId, lorebookId: lb, presetId: pr,
        fillOnly: !!(ch?.card.data.description?.trim() || ch?.card.data.first_mes?.trim()),
        concept: ch?.concept ?? { name: ch?.card.data.name, hook: ch?.card.data.description?.slice(0, 300) ?? '' },
        premise: p.brief ?? (p.premise ? { title: p.name, logline: '', premise: p.premise } : null),
    };
    return startGeneration(store, env, run).then(r => {
        if (r.status === 'done') env.toast(`${ch?.card.data.name ?? 'Character'} is fully built: card, openings, lore, preset, regex, Quick Replies and image prompts.`, 'ok', 8000);
        else if (r.status === 'partial') env.toast('Built with some failed steps; see Project → Generate to retry them.', 'error', 8000);
        return r;
    });
}

export function isRunning(runId) {
    return running.has(runId);
}

const STATUS_ICON = { pending: 'circle', running: 'spinner', done: 'circle-check', failed: 'circle-xmark', blocked: 'ban', skipped: 'minus', cancelled: 'circle-stop' };

/** Progress as a fuse: one segment per selected step, burning left to right. */
function Fuse({ run, stuck }) {
    const steps = STEPS.filter(s => (run.steps[s.id]?.status ?? 'skipped') !== 'skipped');
    const done = steps.filter(s => run.steps[s.id].status === 'done').length;
    const current = steps.find(s => run.steps[s.id].status === 'running');
    const caption = run.status === 'done' ? `${done} of ${steps.length} steps · ${Math.round(steps.reduce((t, s) => t + (run.steps[s.id].durationMs ?? 0), 0) / 1000)} s of writing`
        : stuck ? `Interrupted after ${done} of ${steps.length} steps`
            : current ? `Writing: ${current.label.toLowerCase()} (${done + 1} of ${steps.length})` : `${done} of ${steps.length} steps`;
    return html`<div class="cs-fuse-wrap">
        <div class="cs-fuse" role="progressbar" aria-valuemin="0" aria-valuemax=${steps.length} aria-valuenow=${done} aria-label="Generation progress">
            ${steps.map(s => {
                const st = run.steps[s.id];
                return html`<span key=${s.id} class=${cx('cs-fuse-seg', `is-${stuck && st.status === 'running' ? 'cancelled' : st.status}`)}
                    title=${`${s.label}: ${st.status}${st.durationMs ? ` (${Math.round(st.durationMs / 1000)} s)` : ''}${st.warning ? ` · ${st.warning}` : ''}`}></span>`;
            })}
        </div>
        <div class="cs-muted cs-small">${caption}</div>
    </div>`;
}

export function Generator({ store, env, project, select }) {
    const [idea, setIdea] = useState('');
    const [dials, setDials] = useState(() => project.lastDials ?? {});
    const [steps, setSteps] = useState(startingSteps);
    const [showDials, setShowDials] = useState(false);
    const runs = (project.generationRuns ?? []).filter(r => r.status !== 'discarded');
    // The live run first; otherwise the latest (a run left "running" by a reload shows as interrupted only if it is the latest).
    const active = runs.find(r => running.has(r.id)) ?? runs.at(-1);
    const isRunning = active?.status === 'running' && running.has(active.id);
    const go = surprise => {
        const run = newRun({ idea: surprise ? '' : idea.trim(), dials, steps });
        // The rating dial is the project's content level (writing and pictures), so it sticks for later work too.
        const content = contentFromRating(dials.rating);
        store.update(p => ({ ...p, lastDials: dials, settings: content ? { ...p.settings, content } : p.settings }), 'dials');
        startGeneration(store, env, run).then(r => {
            if (r.status === 'done') env.toast(`Done: “${r.state.premise?.title ?? 'your roleplay'}” is ready.`, 'ok', 8000);
            else if (r.status === 'partial') env.toast('Generation finished with some failed steps; retry them below.', 'error', 8000);
        });
    };
    const cancel = () => running.get(active?.id)?.abort();
    const retry = stepId => startGeneration(store, env, retryable(active, stepId));
    const discard = async () => {
        if (!(await env.confirm('Discard everything this generation created?', 'The character, lorebook, preset and Quick Reply set it made are removed. Undo with Ctrl+Z.'))) return;
        store.update(p => discardRun(p, active), 'discard generation');
    };
    const ch = active?.state?.characterId ? project.characters.find(c => c.id === active.state.characterId) : null;
    const stuck = active?.status === 'running' && !running.has(active.id);
    const [showSteps, setShowSteps] = useState(false);
    // The step list opens by itself whenever something needs attention.
    const trouble = active && Object.values(active.steps).some(s => ['failed', 'blocked'].includes(s.status) || s.warning || s.retrying);
    const stepsOpen = showSteps || trouble || stuck;
    return html`<section class="cs-generator" aria-label="Generate a complete roleplay">
        <div class="cs-gen-head">
            <h3><${Icon} name="wand-magic-sparkles" /> Generate a complete roleplay</h3>
            <${CreationRoute} store=${store} project=${project} compact />
        </div>
        <textarea class="text_pole cs-textarea cs-gen-idea" rows="3" value=${idea} onInput=${e => setIdea(e.currentTarget.value)}
            placeholder="Any rough idea — a line, a vibe, a character, a setting. Or leave it empty and let the AI surprise you." aria-label="Idea"></textarea>
        <div class="cs-row">
            <${Button} kind="ai" icon="wand-magic-sparkles" label=${idea.trim() ? 'Generate it' : 'Surprise me'} onClick=${() => go(!idea.trim())} disabled=${isRunning} />
            ${idea.trim() && html`<${Button} icon="dice" label="Ignore my idea, surprise me" onClick=${() => go(true)} disabled=${isRunning} />`}
            <${Button} small icon="sliders" label=${`Dials${Object.values(dials).filter(Boolean).length ? ` (${Object.values(dials).filter(Boolean).length})` : ''}`} ariaPressed=${showDials} onClick=${() => setShowDials(!showDials)} />
            <span class="cs-spacer"></span>
            <${Button} small icon="user-plus" label="Start from one of my characters…"
                title="Bring in a SillyTavern character with its lorebook and sprites; the AI improves it and builds what it is missing" onClick=${openPullPicker} />
        </div>
        ${showDials && html`<div class="cs-grid">
            ${Object.entries(DIALS).map(([k, d]) => html`<${Select} key=${k} label=${d.label} value=${dials[k] ?? ''} options=${d.options.map(o => ({ value: o, label: o || 'AI decides' }))} onChange=${v => setDials({ ...dials, [k]: v })} />`)}
        </div>
        <div class="cs-row cs-small"><span class="cs-muted">Build:</span>${STEPS.map(s => html`<label key=${s.id} class="cs-toggle"><input type="checkbox" checked=${steps.includes(s.id)} disabled=${['premise', 'concept', 'card'].includes(s.id) || (s.id === 'art' && !imagesOn())} title=${s.id === 'art' && !imagesOn() ? 'Set up images first (plug icon → Images)' : ''}
            onChange=${e => setSteps(e.currentTarget.checked ? [...steps, s.id] : steps.filter(x => x !== s.id))} /><span>${s.label}</span></label>`)}</div>`}
        ${active && html`<div class="cs-gen-run">
            <div class="cs-row-between">
                <div class=${cx('cs-gen-card', active.status === 'done' && 'is-done')}>
                    <div class="cs-gen-title">${active.state?.premise?.title ?? (active.idea ? `“${active.idea.slice(0, 60)}”` : 'Surprise')}</div>
                    ${active.state?.premise?.logline && html`<div class="cs-gen-logline">${active.state.premise.logline}</div>`}
                </div>
                <span class="cs-row">
                    <${Badge} kind=${active.status === 'done' ? 'ok' : active.status === 'running' ? 'accent' : 'warn'}>${stuck ? 'interrupted' : active.status}</${Badge}>
                    ${isRunning && html`<${Button} small icon="stop" label="Stop" onClick=${cancel} />`}
                    ${!isRunning && ['partial', 'cancelled'].includes(active.status) || stuck ? html`<${Button} small icon="rotate" label="Resume" onClick=${() => retry()} />` : ''}
                    <${Button} small icon="list-check" title=${stepsOpen ? 'Hide the steps' : 'Show every step'} ariaPressed=${stepsOpen} onClick=${() => setShowSteps(!showSteps)} />
                </span>
            </div>
            <${Fuse} run=${active} stuck=${stuck} />
            ${stepsOpen && html`<ol class="cs-gen-steps">${STEPS.map(s => {
                const st = active.steps[s.id] ?? { status: 'skipped' };
                return html`<li key=${s.id} class=${cx('cs-gen-step', `is-${st.status}`)}>
                    <span class=${st.status === 'running' ? 'cs-spin' : ''}><${Icon} name=${STATUS_ICON[st.status] ?? 'circle'} /></span>
                    <span class="cs-grow">${s.label}</span>
                    ${st.status === 'running' && st.retrying && html`<span class="cs-warn-text cs-small" title=${st.retrying}>retrying: ${String(st.retrying).slice(0, 60)}</span>`}
                    ${st.warning && html`<span class="cs-warn-text cs-small" title=${st.warning}><${Icon} name="triangle-exclamation" /> ${st.warning}</span>`}
                    ${st.status === 'done' && st.durationMs && html`<span class="cs-muted cs-small">${Math.round(st.durationMs / 1000)}s</span>`}
                    ${(st.status === 'failed' || st.status === 'blocked') && html`<span class="cs-err-text cs-small" title=${st.error}>${String(st.error ?? '').slice(0, 70)}</span>`}
                    ${st.status === 'failed' && !isRunning && html`<${Button} small icon="rotate" label="Retry" onClick=${() => retry(s.id)} />`}
                </li>`;
            })}</ol>`}
            ${!isRunning && ch && html`<div class="cs-row">
                <${Button} kind="primary" icon="user-pen" label=${`Open ${ch.card.data.name}`} onClick=${() => select('characters', ch.id)} />
                ${active.state.lorebookId && html`<${Button} icon="book" label="Open lorebook" onClick=${() => select('lorebooks', active.state.lorebookId)} />`}
                ${active.state.presetId && html`<${Button} icon="sliders" label="Open preset" onClick=${() => select('presets', active.state.presetId)} />`}
                <${Button} icon="trash" kind="danger" label="Discard this run" onClick=${discard} />
            </div>`}
        </div>`}
    </section>`;
}
