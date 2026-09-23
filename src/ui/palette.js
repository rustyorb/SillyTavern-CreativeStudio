// Ctrl+K command palette: jump to any workshop or artifact, or run a common action.
import { html, useState, useEffect, useRef, useMemo, Icon, cx } from './kit.js';
import { artifactName } from '../core/project.js';

const TYPE_META = {
    characters: { icon: 'user', label: 'Character' },
    lorebooks: { icon: 'book', label: 'Lorebook' },
    presets: { icon: 'sliders', label: 'Preset' },
    regexScripts: { icon: 'code', label: 'Regex' },
    qrSets: { icon: 'terminal', label: 'Quick Reply set' },
    connectionProfiles: { icon: 'plug', label: 'Connection profile' },
};

/** Subsequence match score (higher is better; -1 = no match). */
export function fuzzyScore(query, text) {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (!q) return 0;
    const direct = t.indexOf(q);
    if (direct >= 0) return 100 - direct;
    let ti = 0;
    let score = 0;
    for (const ch of q) {
        const found = t.indexOf(ch, ti);
        if (found < 0) return -1;
        score += found === ti ? 2 : 1;
        ti = found + 1;
    }
    return score;
}

export function Palette({ project, areas, onClose, onPick }) {
    const [q, setQ] = useState('');
    const [idx, setIdx] = useState(0);
    const input = useRef(null);
    useEffect(() => { input.current?.focus(); }, []);
    const items = useMemo(() => {
        const all = [
            ...areas.map(a => ({ kind: 'area', id: a.id, icon: a.icon, title: a.label, sub: `Workshop · Alt+${a.key}` })),
            ...Object.entries(TYPE_META).flatMap(([type, m]) => project[type].map(a => ({ kind: 'artifact', type, id: a.id, icon: m.icon, title: artifactName(type, a), sub: m.label }))),
            { kind: 'action', id: 'pull', icon: 'user-plus', title: 'Bring in a SillyTavern character…', sub: 'with its lorebook and sprites' },
            { kind: 'action', id: 'undo', icon: 'rotate-left', title: 'Undo', sub: 'Ctrl+Z' },
            { kind: 'action', id: 'redo', icon: 'rotate-right', title: 'Redo', sub: 'Ctrl+Y' },
            { kind: 'action', id: 'save', icon: 'floppy-disk', title: 'Save now', sub: 'Ctrl+S' },
            { kind: 'action', id: 'snapshot', icon: 'camera', title: 'Take snapshot', sub: 'Inspector → Snapshots' },
            { kind: 'action', id: 'proposals', icon: 'wand-magic-sparkles', title: 'Review AI proposals', sub: `${project.proposals.filter(p => p.status === 'pending').length} pending` },
            { kind: 'action', id: 'inspector', icon: 'table-columns', title: 'Toggle inspector', sub: 'Alt+I' },
        ];
        if (!q.trim()) return all.slice(0, 60);
        return all.map(i => ({ ...i, score: fuzzyScore(q.trim(), `${i.title} ${i.sub}`) })).filter(i => i.score >= 0).sort((a, b) => b.score - a.score).slice(0, 60);
    }, [q, project]);
    const pick = i => { if (i) { onPick(i); onClose(); } };
    const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(items[idx]); }
    };
    return html`<div class="cs-modal-backdrop" onMouseDown=${e => e.target === e.currentTarget && onClose()}>
        <div class="cs-modal cs-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown=${onKey}>
            <input ref=${input} class="text_pole cs-palette-input" placeholder="Go to a workshop, character, lorebook, preset… or run an action" value=${q}
                onInput=${e => { setQ(e.currentTarget.value); setIdx(0); }} aria-label="Search" aria-controls="cs-palette-list" />
            <ul id="cs-palette-list" class="cs-list" role="listbox">${items.map((i, n) => html`<li key=${`${i.kind}:${i.type ?? ''}:${i.id}`} role="option" aria-selected=${n === idx}
                    class=${cx('cs-list-item', n === idx && 'active')} onMouseEnter=${() => setIdx(n)} onClick=${() => pick(i)}>
                <${Icon} name=${i.icon} /><span class="cs-grow">${i.title}</span><span class="cs-muted cs-small">${i.sub}</span>
            </li>`)}</ul>
            ${!items.length && html`<div class="cs-muted" style="padding:10px">Nothing matches.</div>`}
        </div>
    </div>`;
}
