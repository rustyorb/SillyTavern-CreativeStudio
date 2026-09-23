// Shared UI primitives for the studio (Preact + htm, no build step).
import { html, useState, useEffect, useRef, useMemo, useCallback } from '../../vendor/preact-htm.mjs';
import { textDiff, diffStats } from '../core/diff.js';

export { html, useState, useEffect, useRef, useMemo, useCallback };

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Rough token estimate used when ST's tokenizer is not available (e.g. tests). */
export const roughTokens = text => Math.ceil(String(text ?? '').length / 3.6);

/** Debounced value hook. */
export function useDebounced(value, ms = 300) {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

/** Async token counter backed by a provided counter function (ST's getTokenCountAsync). */
export function useTokenCount(text, counter) {
    const debounced = useDebounced(text, 400);
    const [count, setCount] = useState(() => roughTokens(text));
    useEffect(() => {
        let alive = true;
        if (!counter) {
            setCount(roughTokens(debounced));
            return;
        }
        Promise.resolve(counter(String(debounced ?? '')))
            .then(n => alive && setCount(n))
            .catch(() => alive && setCount(roughTokens(debounced)));
        return () => { alive = false; };
    }, [debounced, counter]);
    return count;
}

export function Icon({ name, title }) {
    return html`<i class=${`fa-solid fa-${name}`} title=${title} aria-hidden=${title ? undefined : 'true'}></i>`;
}

export function Button({ icon, label, title, onClick, kind = '', disabled, small, type = 'button', ariaPressed }) {
    return html`<button type=${type} class=${cx('cs-btn', kind && `cs-btn-${kind}`, small && 'cs-btn-sm')} title=${title ?? label}
        aria-pressed=${ariaPressed} disabled=${disabled} onClick=${onClick}>
        ${icon && html`<${Icon} name=${icon} />`}${label && html`<span>${label}</span>`}
    </button>`;
}

export function Badge({ children, kind = '' , title }) {
    return html`<span class=${cx('cs-badge', kind && `cs-badge-${kind}`)} title=${title}>${children}</span>`;
}

/** Labelled field wrapper with optional hint and right-side meta. */
export function Field({ label, hint, meta, children, wide, htmlFor }) {
    return html`<div class=${cx('cs-field', wide && 'cs-field-wide')}>
        <div class="cs-field-head">
            <label for=${htmlFor}>${label}</label>
            ${meta && html`<span class="cs-field-meta">${meta}</span>`}
        </div>
        ${children}
        ${hint && html`<div class="cs-hint">${hint}</div>`}
    </div>`;
}

let fieldSeq = 0;
export function useId(prefix = 'cs') {
    const ref = useRef(null);
    if (!ref.current) ref.current = `${prefix}-${++fieldSeq}`;
    return ref.current;
}

export function TextInput({ label, value, onChange, placeholder, hint, meta, mono }) {
    const id = useId();
    return html`<${Field} label=${label} hint=${hint} meta=${meta} htmlFor=${id}>
        <input id=${id} class=${cx('text_pole cs-input', mono && 'cs-mono')} value=${value ?? ''} placeholder=${placeholder}
            onInput=${e => onChange(e.currentTarget.value)} />
    </${Field}>`;
}

export function NumberInput({ label, value, onChange, min, max, step = 1, hint }) {
    const id = useId();
    return html`<${Field} label=${label} hint=${hint} htmlFor=${id}>
        <input id=${id} type="number" class="text_pole cs-input cs-num" value=${value ?? ''} min=${min} max=${max} step=${step}
            onInput=${e => onChange(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} />
    </${Field}>`;
}

export function Toggle({ label, checked, onChange, title }) {
    return html`<label class="cs-toggle checkbox_label" title=${title}>
        <input type="checkbox" checked=${!!checked} onChange=${e => onChange(e.currentTarget.checked)} />
        <span>${label}</span>
    </label>`;
}

export function Select({ label, value, options, onChange, hint }) {
    const id = useId();
    return html`<${Field} label=${label} hint=${hint} htmlFor=${id}>
        <select id=${id} class="text_pole cs-input" value=${value} onChange=${e => onChange(e.currentTarget.value)}>
            ${options.map(o => (typeof o === 'string' ? { value: o, label: o } : o)).map(o => html`<option value=${o.value} selected=${String(o.value) === String(value)}>${o.label}</option>`)}
        </select>
    </${Field}>`;
}

/** Large text area with token count and optional AI action slot. */
export function TextArea({ label, value, onChange, rows = 6, hint, counter, actions, mono, placeholder, stats = true }) {
    const id = useId();
    const tokens = useTokenCount(value, counter);
    const meta = stats ? html`<span>${tokens} tok</span>${actions}` : actions;
    return html`<${Field} label=${label} hint=${hint} meta=${meta} wide htmlFor=${id}>
        <textarea id=${id} class=${cx('text_pole cs-textarea', mono && 'cs-mono')} rows=${rows} value=${value ?? ''} placeholder=${placeholder}
            onInput=${e => onChange(e.currentTarget.value)}></textarea>
    </${Field}>`;
}

/** Editable list of strings (tags, keys, greetings). */
export function StringList({ label, items, onChange, multiline, placeholder, hint, actions, addLabel = 'Add' }) {
    const list = items ?? [];
    const set = (i, v) => onChange(list.map((x, j) => (j === i ? v : x)));
    const move = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= list.length) return;
        const next = [...list];
        [next[i], next[j]] = [next[j], next[i]];
        onChange(next);
    };
    return html`<${Field} label=${`${label} (${list.length})`} hint=${hint} meta=${actions} wide>
        <div class="cs-strlist">
            ${list.map((item, i) => html`<div class="cs-strlist-row" key=${i}>
                ${multiline
                    ? html`<textarea class="text_pole cs-textarea" rows="4" value=${item} onInput=${e => set(i, e.currentTarget.value)}></textarea>`
                    : html`<input class="text_pole cs-input" value=${item} onInput=${e => set(i, e.currentTarget.value)} />`}
                <div class="cs-strlist-tools">
                    <${Button} small icon="arrow-up" title="Move up" onClick=${() => move(i, -1)} disabled=${i === 0} />
                    <${Button} small icon="arrow-down" title="Move down" onClick=${() => move(i, 1)} disabled=${i === list.length - 1} />
                    <${Button} small icon="trash" title="Remove" kind="danger" onClick=${() => onChange(list.filter((_, j) => j !== i))} />
                </div>
            </div>`)}
            <${Button} small icon="plus" label=${addLabel} onClick=${() => onChange([...list, placeholder ?? ''])} />
        </div>
    </${Field}>`;
}

/** Comma-separated tag/keys input that edits an array. */
export function TagsInput({ label, items, onChange, hint, placeholder = 'comma, separated' }) {
    const [draft, setDraft] = useState((items ?? []).join(', '));
    const joined = (items ?? []).join(', ');
    useEffect(() => { setDraft(joined); }, [joined]);
    const commit = v => onChange(v.split(',').map(s => s.trim()).filter(Boolean));
    const id = useId();
    return html`<${Field} label=${label} hint=${hint} htmlFor=${id}>
        <input id=${id} class="text_pole cs-input" value=${draft} placeholder=${placeholder}
            onInput=${e => setDraft(e.currentTarget.value)} onBlur=${e => commit(e.currentTarget.value)}
            onKeyDown=${e => e.key === 'Enter' && commit(e.currentTarget.value)} />
    </${Field}>`;
}

export function Tabs({ tabs, active, onChange, right }) {
    return html`<div class="cs-tabs" role="tablist">
        ${tabs.map(t => html`<button role="tab" aria-selected=${t.id === active} class=${cx('cs-tab', t.id === active && 'active')}
            onClick=${() => onChange(t.id)} title=${t.title ?? t.label}>
            ${t.icon && html`<${Icon} name=${t.icon} />`}<span>${t.label}</span>${t.badge != null && t.badge !== 0 && html`<${Badge}>${t.badge}</${Badge}>`}
        </button>`)}
        <div class="cs-tabs-right">${right}</div>
    </div>`;
}

/** Inline token-level diff between two strings. */
export function InlineDiff({ before, after }) {
    const segs = useMemo(() => textDiff(before ?? '', after ?? ''), [before, after]);
    const st = diffStats(segs);
    return html`<div class="cs-diff">
        <div class="cs-diff-stats"><span class="cs-ins">+${st.insertedWords}</span> <span class="cs-del">−${st.deletedWords}</span> words</div>
        <div class="cs-diff-body">${segs.map((s, i) => html`<span key=${i} class=${`cs-seg-${s.op}`}>${s.text}</span>`)}</div>
    </div>`;
}

/** Side-by-side before/after view with an inline diff toggle. */
export function SideBySide({ before, after, leftLabel = 'Current', rightLabel = 'Proposed' }) {
    const [mode, setMode] = useState('inline');
    const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    return html`<div class="cs-sbs">
        <div class="cs-sbs-bar">
            <${Button} small label="Inline" ariaPressed=${mode === 'inline'} onClick=${() => setMode('inline')} />
            <${Button} small label="Side by side" ariaPressed=${mode === 'split'} onClick=${() => setMode('split')} />
        </div>
        ${mode === 'inline'
            ? html`<${InlineDiff} before=${fmt(before ?? '')} after=${fmt(after ?? '')} />`
            : html`<div class="cs-sbs-cols">
                <div><div class="cs-sbs-label">${leftLabel}</div><pre class="cs-pre">${fmt(before ?? '')}</pre></div>
                <div><div class="cs-sbs-label">${rightLabel}</div><pre class="cs-pre">${fmt(after ?? '')}</pre></div>
            </div>`}
    </div>`;
}

export function Empty({ icon = 'feather', title, children }) {
    return html`<div class="cs-empty"><${Icon} name=${icon} /><div class="cs-empty-title">${title}</div><div>${children}</div></div>`;
}

/** Diagnostics list (validation issues, lint messages, compatibility notes). */
export function Diagnostics({ items, onPick }) {
    if (!items?.length) return html`<div class="cs-diag-ok"><${Icon} name="circle-check" /> No issues</div>`;
    const order = { error: 0, warn: 1, info: 2 };
    const sorted = [...items].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
    return html`<ul class="cs-diags">
        ${sorted.map((d, i) => html`<li key=${i} class=${`cs-diag cs-diag-${d.level}`} onClick=${() => onPick?.(d)}>
            <${Icon} name=${d.level === 'error' ? 'circle-xmark' : d.level === 'warn' ? 'triangle-exclamation' : 'circle-info'} />
            ${d.path && html`<code>${d.path}</code>`} <span>${d.message}</span>
        </li>`)}
    </ul>`;
}

/** Collapsible section. */
export function Section({ title, children, open: initial = true, right, id }) {
    const [open, setOpen] = useState(initial);
    return html`<section class="cs-section" id=${id}>
        <header class="cs-section-head" onClick=${() => setOpen(!open)}>
            <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} /><h4>${title}</h4>
            <div class="cs-section-right" onClick=${e => e.stopPropagation()}>${right}</div>
        </header>
        ${open && html`<div class="cs-section-body">${children}</div>`}
    </section>`;
}

/** Modal dialog rendered inside the studio (ST popups are used for simple prompts). */
export function Modal({ title, onClose, children, footer, wide }) {
    const ref = useRef(null);
    useEffect(() => {
        const prev = document.activeElement;
        ref.current?.querySelector('input, textarea, select, button')?.focus();
        return () => prev?.focus?.();
    }, []);
    return html`<div class="cs-modal-backdrop" onMouseDown=${e => e.target === e.currentTarget && onClose()}
        onKeyDown=${e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div class="cs-modal" role="dialog" aria-modal="true" aria-label=${title} ref=${ref} style=${wide ? 'width:min(1200px,100%)' : ''}>
            <div class="cs-modal-head"><h3>${title}</h3><${Button} small icon="xmark" title="Close (Esc)" onClick=${onClose} /></div>
            <div class="cs-modal-body">${children}</div>
            ${footer && html`<div class="cs-modal-foot">${footer}</div>`}
        </div>
    </div>`;
}

/** Download helper. */
export function downloadBlob(data, filename, mime = 'application/octet-stream') {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user for a file. */
export function pickFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
    });
}

export async function fileBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
}
