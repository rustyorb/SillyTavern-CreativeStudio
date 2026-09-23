// Creative Studio workbench shell: project tree | focused editor | inspector (AI proposals, history, diagnostics).
import { render } from '../../vendor/preact-htm.mjs';
import { html, useState, useEffect, useCallback, useMemo, Button, Icon, Badge, cx } from './kit.js';
import { createStore, useStore } from './store.js';
import { createProject } from '../core/project.js';
import { Workspace, AREA_FOR_TYPE } from './workspace.js';
import { Palette } from './palette.js';
import { isHandsFree } from './proposals.js';
import { AiSetup } from './providers-panel.js';

/** A new project starts with the creation model chosen last time (if that profile still exists). */
function withDefaultCreationModel(project) {
    try {
        const ctx = globalThis.SillyTavern.getContext();
        const id = ctx.extensionSettings?.creativeStudio?.defaultCreationProfileId;
        if (id && ctx.extensionSettings?.connectionManager?.profiles?.some(p => p.id === id)) {
            return { ...project, settings: { ...project.settings, creationProfileId: id } };
        }
    } catch { /* no ST context */ }
    return project;
}

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
        store = createStore(last ?? withDefaultCreationModel(createProject('My first project')), { sticky: ['generationRuns'] });
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
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [aiSetupOpen, setAiSetupOpen] = useState(false);

    useEffect(() => env.onSaveState(setSaveState), [env]);
    useEffect(() => {
        const open = () => setAiSetupOpen(true);
        globalThis.addEventListener('cs-ai-setup', open);
        return () => globalThis.removeEventListener('cs-ai-setup', open);
    }, []);
    useEffect(() => env.onToast(t => {
        setToast(t);
        clearTimeout(env._toastTimer);
        env._toastTimer = setTimeout(() => setToast(null), t.ms ?? 4000);
    }), [env]);

    const pending = project.proposals.filter(p => p.status === 'pending').length;
    const handsFree = isHandsFree(project);
    const toggleMode = () => {
        store.update(p => ({ ...p, settings: { ...p.settings, aiMode: handsFree ? 'review' : 'auto' } }), 'AI mode');
        env.toast(handsFree ? 'Review mode: AI output now waits for your OK in the inspector.' : 'Hands-free: the AI writes straight into the project. Ctrl+Z undoes any change.', 'ok', 5000);
    };
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
        } else if (mod && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            setPaletteOpen(true);
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
                <button class=${cx('cs-mode', handsFree ? 'is-auto' : 'is-review')} onClick=${toggleMode}
                    title=${handsFree ? 'Hands-free: AI writes straight into your project (every change is undoable and logged). Click to review AI output before it lands.' : 'Review: AI output waits as proposals you accept or reject. Click to let the AI write directly.'}
                    aria-pressed=${handsFree}>
                    <${Icon} name=${handsFree ? 'bolt' : 'list-check'} /><span>${handsFree ? 'Hands-free' : 'Review'}</span>
                </button>
                <${Button} small icon="plug" title="AI for creation: choose the model or add a provider" onClick=${() => setAiSetupOpen(true)} />
                <${Button} small icon="magnifying-glass" title="Command palette (Ctrl+K)" onClick=${() => setPaletteOpen(true)} />
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
        ${paletteOpen && html`<${Palette} project=${project} areas=${AREAS} onClose=${() => setPaletteOpen(false)} onPick=${async i => {
            if (i.kind === 'area') { setSelection(null); setArea(i.id); }
            else if (i.kind === 'artifact') { setSelection({ type: i.type, id: i.id }); setArea(AREA_FOR_TYPE[i.type] ?? area); }
            else if (i.id === 'undo') store.undo();
            else if (i.id === 'redo') store.redo();
            else if (i.id === 'save') env.saveNow();
            else if (i.id === 'snapshot') { await env.saveNow(); await env.storage.saveSnapshot(store.get(), `Snapshot ${new Date().toLocaleString()}`); env.toast('Snapshot saved', 'ok'); }
            else if (i.id === 'proposals') openInspectorAt('proposals');
            else if (i.id === 'inspector') setInspectorOpen(!inspectorOpen);
        }} />`}
        ${aiSetupOpen && html`<${AiSetup} store=${store} env=${env} project=${project} onClose=${() => setAiSetupOpen(false)} />`}
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
        store.reset(withDefaultCreationModel(createProject(name)));
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
