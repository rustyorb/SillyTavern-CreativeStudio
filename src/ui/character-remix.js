import { html, useState, useRef, useEffect, Button, Modal, Select, NumberInput, TextInput, TextArea, Section, Badge } from './kit.js';
import { useAiTask, AiStatus, CreationRoute } from './ai.js';
import { REMIX_FIELDS, DEFAULT_MINIMUMS, sourceFacts, resolveLocks, normalizeMinimums, minimumReport, lockedFactsText } from '../core/remix.js';
import { generateRemix, saveRemix } from '../ai/remix.js';
import { editArtifactField } from '../core/project.js';

const choices = [{ value: 'ai', label: 'Let AI choose' }, { value: 'a', label: 'Use character A' }, { value: 'b', label: 'Use character B' }, { value: 'custom', label: 'Set myself' }];

export function RemixLauncher({ store, env, project, select }) {
    const [open, setOpen] = useState(false);
    return html`<${Button} icon="shuffle" label="Remix two characters" onClick=${() => setOpen(true)} />
        ${open && html`<${RemixForm} key=${project.id} store=${store} env=${env} project=${project} select=${select} onClose=${() => setOpen(false)} />`}`;
}

function Minimums({ values, onChange, fields }) {
    const report = fields ? minimumReport(fields, values) : [];
    return html`<div class="cs-remix-minimums">
        <div class="cs-remix-minimum-head"><span>Field</span><span>Minimum words</span>${fields && html`<span>Actual words</span>`}</div>
        ${Object.entries(REMIX_FIELDS).map(([key, label]) => {
            const rows = report.filter(r => r.field === key);
            const short = rows.some(r => r.short);
            return html`<div class="cs-remix-minimum" key=${key}>
                <label for=${`cs-remix-min-${key}`}>${label}</label>
                <input id=${`cs-remix-min-${key}`} aria-label=${`${label} minimum words`} class="text_pole cs-input" type="number" min="0" max="5000" step="1" value=${values[key] ?? 0} onInput=${e => onChange({ ...values, [key]: e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value) })} />
                ${fields && html`<span class=${short ? 'cs-err-text' : 'cs-muted'}>${rows.map(r => r.actual).join(', ')}${short ? ' · Below minimum' : ''}</span>`}
            </div>`;
        })}
    </div>`;
}

function RemixForm({ store, env, project, select, onClose }) {
    const [ids, setIds] = useState(['', '']);
    const [rules, setRules] = useState({ age: { mode: 'average', a: '', b: '', value: '' }, species: { mode: 'ai', a: '', b: '', value: '' }, gender: { mode: 'ai', a: '', b: '', value: '' } });
    const [minimums, setMinimums] = useState({ ...DEFAULT_MINIMUMS, ...project.settings?.remixMinimums });
    const [direction, setDirection] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const controller = useRef(null);
    const ai = useAiTask(store);
    useEffect(() => () => { controller.current?.abort(); ai.cancel(); }, []);
    const sources = ids.map(id => project.characters.find(c => c.id === id));
    const setSource = (i, id) => {
        setIds(ids.map((old, n) => n === i ? id : old));
        const facts = sourceFacts(project.characters.find(c => c.id === id));
        const side = i === 0 ? 'a' : 'b';
        setRules(Object.fromEntries(Object.entries(rules).map(([field, rule]) => [field, { ...rule, [side]: facts[field] ?? '' }])));
    };
    const changeMinimums = next => {
        setMinimums(next);
        try { normalizeMinimums(next); } catch { return; }
        store.update(p => p.id !== project.id ? p : { ...p, settings: { ...p.settings, remixMinimums: next } }, 'remix word minimums');
    };
    let locks = {}, issue = '';
    try { locks = resolveLocks(rules); normalizeMinimums(minimums); } catch (e) { issue = e.message; }
    if (!sources.every(Boolean)) issue = 'Choose character A and character B from your imported library.';
    else if (ids[0] === ids[1]) issue = 'Choose two different characters.';
    const close = () => { controller.current?.abort(); ai.cancel(); onClose(); };
    const run = async () => {
        if (busy || issue || controller.current) return;
        const ac = new AbortController();
        controller.current = ac;
        setBusy(true); setError('');
        try {
            const result = await generateRemix({ sources, options: { ...rules, minimums, direction }, signal: ac.signal, onStatus: setStatus,
                runTask: async (task, args) => {
                    const r = await ai.run(task, args);
                    if (!r) throw new Error('The writing request failed. See the model error below.');
                    return r;
                } });
            if (ac.signal.aborted) return;
            saveRemix(store, result, project.id);
            env.toast(result.report.some(r => r.short) ? 'New character created. Some fields are below your minimum; see the word-count report.' : 'New character created. Both originals are unchanged.', 'ok', 7000);
            onClose();
            select('characters', result.character.id, 'core');
        } catch (e) { if (!ac.signal.aborted) { setStatus(''); setError(e.message); } }
        finally { if (controller.current === ac) controller.current = null; if (!ac.signal.aborted) setBusy(false); }
    };
    return html`<${Modal} title="Remix two characters" onClose=${close} footer=${html`
        <${Button} label=${busy ? 'Cancel generation' : 'Cancel'} onClick=${close} />
        <${Button} kind="primary" icon="shuffle" label=${busy ? 'Creating character…' : 'Generate new character'} disabled=${busy || !!issue} onClick=${run} />`}>
        <p class="cs-page-intro">Turn two characters into inspiration for someone new. One click creates a full card; your originals stay in the library.</p>
        <${CreationRoute} store=${store} project=${project} />
        <fieldset class="cs-remix-controls" disabled=${busy}>
            <h4>1. Choose your inspiration</h4>
            <div class="cs-remix-sources">${[0, 1].map(i => {
                const c = sources[i];
                const portrait = project.media.find(m => m.id === c?.avatarMediaId);
                return html`<div class="cs-remix-source">
                    <${Select} label=${`Character ${i ? 'B' : 'A'}`} value=${ids[i]} options=${[{ value: '', label: 'Choose from your library…' }, ...project.characters.map(c => ({ value: c.id, label: `${c.card.data.name || 'Unnamed'} · ${c.id.slice(-4)}` }))]} onChange=${id => setSource(i, id)} />
                    ${c && html`<div class="cs-remix-source-preview">${portrait && html`<img src=${portrait.url} alt="" />`}<p>${c.card.data.description?.slice(0, 180) || 'No description yet.'}</p></div>`}
                </div>`;
            })}</div>
            ${project.characters.length < 2 && html`<p class="cs-muted">Import at least two characters with Import card or From SillyTavern in the library first.</p>`}
            <h4>2. Lock what matters</h4>
            <p class="cs-muted cs-small">Only clearly labelled details are filled automatically. You can correct the source values here without changing either card.</p>
            ${['age', 'species', 'gender'].map(field => {
                const label = field[0].toUpperCase() + field.slice(1);
                const rule = rules[field];
                const set = patch => setRules({ ...rules, [field]: { ...rule, ...patch } });
                const Input = field === 'age' ? NumberInput : TextInput;
                return html`<div class="cs-remix-rule">
                    <${Select} label=${`${label} rule`} value=${rule.mode} options=${field === 'age' ? [{ value: 'average', label: 'Average both (rounded)' }, ...choices] : choices} onChange=${mode => set({ mode })} />
                    ${['average', 'a'].includes(rule.mode) && html`<${Input} label=${`${label} of A`} value=${rule.a} min=${0} onChange=${a => set({ a })} />`}
                    ${['average', 'b'].includes(rule.mode) && html`<${Input} label=${`${label} of B`} value=${rule.b} min=${0} onChange=${b => set({ b })} />`}
                    ${rule.mode === 'custom' && html`<${Input} label=${`New ${field}`} value=${rule.value} min=${0} onChange=${value => set({ value })} />`}
                </div>`;
            })}
            <div class="cs-remix-locks" role="status">${Object.keys(locks).length ? html`<strong>New character: ${Object.entries(locks).map(([k, v]) => `${k} ${v}`).join(' · ')}</strong>` : 'Unlocked details are open to invention.'}</div>
            <${TextArea} label="Your direction and other requirements" value=${direction} onChange=${setDirection} rows=${3} stats=${false} placeholder="For example: a reluctant leader, a coastal setting, dry humor. Keep these details; invent the rest." />
            <h4>3. Set your minimum word counts</h4>
            <p class="cs-muted cs-small">0 = no minimum. Saved for the next remix in this project. Studio counts the result and expands short fields once. Large minimums may exceed your model's output limit.</p>
            <${Minimums} values=${minimums} onChange=${changeMinimums} />
        </fieldset>
        ${issue && html`<p class="cs-muted" role="status">${issue}</p>`}
        ${status && html`<p role="status" aria-live="polite">${status}</p>`}
        ${error && html`<p class="cs-err-text" role="alert">${error}</p>`}
        <${AiStatus} ai=${{ ...ai, cancel: close }} />
    </${Modal}>`;
}

export function RemixReport({ store, project, ch }) {
    if (!ch.remix) return null;
    const minimums = ch.remix.minimums ?? DEFAULT_MINIMUMS;
    const short = minimumReport(ch.card.data, minimums).filter(r => r.short);
    const set = next => {
        try { normalizeMinimums(next); } catch { return; }
        store.update(p => {
            if (p.id !== project.id) return p;
            const edited = editArtifactField(p, 'characters', ch.id, 'remix.minimums', next, { summary: 'Changed word minimums' });
            return { ...edited, settings: { ...edited.settings, remixMinimums: next } };
        }, 'remix word minimums');
    };
    return html`<${Section} title=${`Remix · word counts${short.length ? ` · ${short.length} below minimum` : ''}`} open=${short.length > 0} right=${html`<${Badge} kind=${short.length ? '' : 'ok'}>${short.length ? 'Needs more words' : 'Minimums met'}</${Badge}>`}>
        <p>Inspired by ${ch.remix.sources.map(s => s.name).join(' + ')}. This is a separate character.</p>
        ${Object.keys(ch.remix.locks ?? {}).length > 0 && html`<pre class="cs-pre">${lockedFactsText(ch.remix.locks)}</pre>`}
        ${ch.remix.warnings?.map(w => html`<p class="cs-err-text">${w}</p>`)}
        <p class="cs-muted cs-small">Counts update as you edit. Change minimums here; 0 turns a minimum off. Use Ask AI beside a field to expand or rewrite it.</p>
        <${Minimums} values=${minimums} fields=${ch.card.data} onChange=${set} />
    </${Section}>`;
}
