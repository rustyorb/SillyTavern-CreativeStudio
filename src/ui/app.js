// Creative Studio workbench shell: project tree | focused editor | inspector (AI proposals, history, diagnostics).
import { render } from '../../vendor/preact-htm.mjs';
import { html, useState, useEffect, useCallback, useMemo, Button, Icon, Badge, cx } from './kit.js';
import { createStore, useStore } from './store.js';
import { createProject } from '../core/project.js';
import { Workspace } from './workspace.js';

let store = null;
let studioEnv = null;

/** Mount (or re-show) the studio into the given root element. */
export async function mountStudio(root, { route, onClose }) {
    if (!studioEnv) {
        const { createEnvironment } = await import('../st/env.js');
        studioEnv = await createEnvironment();
    }
    if (!store) {
        const last = await studioEnv.storage.loadLastProject().catch(() => null);
        store = createStore(last ?? createProject('My first project'));
        studioEnv.attachStore(store);
    }
    render(html`<${Studio} store=${store} env=${studioEnv} initialRoute=${route} onClose=${onClose} />`, root);
}

export function unmountStudio(root) {
    studioEnv?.flush?.();
    render(null, root);
}

export const AREAS = [
    { id: 'project', label: 'Project', icon: 'diagram-project', key: '1' },
    { id: 'characters', label: 'Characters', icon: 'user-pen', key: '2' },
    { id: 'lore', label: 'Lore', icon: 'book-atlas', key: '3' },
    { id: 'prompts', label: 'Prompts & Presets', icon: 'sliders', key: '4' },
    { id: 'regex', label: 'Regex Lab', icon: 'code', key: '5' },
    { id: 'scripts', label: 'Quick Replies & STscript', icon: 'terminal', key: '6' },
    { id: 'playtest', label: 'Playtest', icon: 'flask', key: '7' },
];

function Studio({ store, env, initialRoute, onClose }) {
    const project = useStore(store);
    const [area, setArea] = useState(AREAS.some(a => a.id === initialRoute) ? initialRoute : 'project');
    const [selection, setSelection] = useState(null); // { type, id }
    const [inspector, setInspector] = useState('proposals');
    // 'auto' = open only while proposals are pending (an empty rail wastes a quarter of the screen).
    const [inspectorMode, setInspectorMode] = useState('auto');
    const [saveState, setSaveState] = useState(env.saveState());
    const [toast, setToast] = useState(null);

    useEffect(() => env.onSaveState(setSaveState), [env]);
    useEffect(() => env.onToast(t => {
        setToast(t);
        clearTimeout(env._toastTimer);
        env._toastTimer = setTimeout(() => setToast(null), t.ms ?? 4000);
    }), [env]);

    const pending = project.proposals.filter(p => p.status === 'pending').length;
    const inspectorOpen = inspectorMode === 'open' || (inspectorMode === 'auto' && pending > 0);
    const setInspectorOpen = v => setInspectorMode((typeof v === 'function' ? v(inspectorOpen) : v) ? 'open' : 'closed');
    const openInspectorAt = tab => { setInspector(tab); setInspectorMode('open'); };

    const onKey = useCallback(e => {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Escape' && !e.target.closest?.('textarea, input, select, .cs-modal')) {
            onClose();
        } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !e.target.closest?.('textarea, input')) {
            e.preventDefault();
            const l = store.undo();
            if (l) env.toast(`Undid: ${l}`);
        } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')) && !e.target.closest?.('textarea, input')) {
            e.preventDefault();
            const l = store.redo();
            if (l) env.toast(`Redid: ${l}`);
        } else if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            env.saveNow();
        } else if (e.altKey && /^[1-7]$/.test(e.key)) {
            e.preventDefault();
            setArea(AREAS[Number(e.key) - 1].id);
        } else if (e.altKey && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            setInspectorOpen(o => !o);
        }
    }, [store, env, onClose]);

    return html`<div class="cs-studio" onKeyDown=${onKey} tabIndex="-1" role="application" aria-label="Creative Studio">
        <header class="cs-topbar">
            <div class="cs-brand"><${Icon} name="feather-pointed" /> Creative Studio</div>
            <${ProjectSwitcher} store=${store} env=${env} project=${project} />
            <nav class="cs-areas" aria-label="Workshops">
                ${AREAS.map(a => html`<button class=${cx('cs-area', area === a.id && 'active')} onClick=${() => setArea(a.id)}
                    title=${`${a.label} (Alt+${a.key})`} aria-current=${area === a.id ? 'page' : undefined}>
                    <${Icon} name=${a.icon} /><span>${a.label}</span>
                </button>`)}
            </nav>
            <div class="cs-topbar-right">
                <${Button} small icon="rotate-left" title=${store.canUndo() ? `Undo: ${store.peekUndo()} (Ctrl+Z)` : 'Nothing to undo'} disabled=${!store.canUndo()} onClick=${() => store.undo()} />
                <${Button} small icon="rotate-right" title=${store.canRedo() ? `Redo: ${store.peekRedo()} (Ctrl+Y)` : 'Nothing to redo'} disabled=${!store.canRedo()} onClick=${() => store.redo()} />
                <span class=${cx('cs-save', `cs-save-${saveState.status}`)} title=${saveState.detail ?? ''}>${saveState.label}</span>
                <${Button} small icon=${inspectorOpen ? 'table-columns' : 'table-columns'} title=${`Inspector (Alt+I) — ${inspectorMode === 'auto' ? 'opens automatically when AI proposals are pending' : inspectorMode}`} ariaPressed=${inspectorOpen} onClick=${() => setInspectorOpen(!inspectorOpen)} />
                <${Button} small icon="xmark" title="Close (Esc)" onClick=${onClose} />
            </div>
        </header>
        <${Workspace} store=${store} env=${env} project=${project} area=${area} setArea=${setArea}
            selection=${selection} setSelection=${setSelection}
            inspector=${inspector} setInspector=${setInspector} inspectorOpen=${inspectorOpen} pending=${pending} openInspectorAt=${openInspectorAt} />
        ${toast && html`<div class=${cx('cs-toast', toast.kind && `cs-toast-${toast.kind}`)} role="status">${toast.text}</div>`}
    </div>`;
}

function ProjectSwitcher({ store, env, project }) {
    const [list, setList] = useState([]);
    const [open, setOpen] = useState(false);
    const refresh = () => env.storage.listProjects().then(setList).catch(() => setList([]));
    useEffect(() => { if (open) refresh(); }, [open]);
    const switchTo = async id => {
        await env.saveNow();
        const p = await env.storage.loadProject(id);
        store.reset(p);
        setOpen(false);
    };
    const create = async () => {
        const name = await env.prompt('New project name', 'Untitled project');
        if (!name) return;
        await env.saveNow();
        store.reset(createProject(name));
        await env.saveNow();
        setOpen(false);
    };
    const rename = async () => {
        const name = await env.prompt('Rename project', project.name);
        if (name) store.update(p => ({ ...p, name }), 'rename project');
    };
    return html`<div class="cs-projsw">
        <button class="cs-projsw-btn" onClick=${() => setOpen(!open)} aria-expanded=${open} title="Switch project">
            <${Icon} name="folder-open" /><span class="cs-projsw-name">${project.name}</span><${Icon} name="caret-down" />
        </button>
        ${open && html`<div class="cs-projsw-menu" role="menu">
            ${list.map(p => html`<button role="menuitem" class=${cx('cs-projsw-item', p.id === project.id && 'active')} onClick=${() => switchTo(p.id)}>
                <span>${p.name}</span><small>${new Date(p.modified).toLocaleString()}</small>
            </button>`)}
            <hr />
            <button role="menuitem" class="cs-projsw-item" onClick=${create}><${Icon} name="plus" /> New project…</button>
            <button role="menuitem" class="cs-projsw-item" onClick=${rename}><${Icon} name="i-cursor" /> Rename…</button>
        </div>`}
    </div>`;
}
