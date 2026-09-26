// Three-pane workbench: project tree | area editor | inspector.
import { html, useState, useEffect, useRef, Icon, Button, Badge, cx } from './kit.js';
import { artifactName, upsertArtifact, newCharacter, unusedMedia } from '../core/project.js';
import { openCardImport } from './importer.js';
import { openPullPicker } from './st-pull.js';
import { removeUnusedPictures } from './areas/media.js';
import { ProjectArea } from './areas/project.js';
import { CharactersArea } from './areas/characters.js';
import { LoreArea } from './areas/lore.js';
import { PromptsArea } from './areas/prompts.js';
import { RegexArea } from './areas/regex.js';
import { ScriptsArea } from './areas/scripts.js';
import { PlaytestArea } from './areas/playtest.js';
import { Inspector } from './inspector.js';
import { newLorebookArtifact } from './areas/lore.js';
import { newPresetArtifact } from './areas/prompts.js';
import { newRegexArtifact } from './areas/regex.js';
import { newQrSetArtifact } from './areas/scripts.js';

const TREE = [
    {
        type: 'characters', label: 'Characters & scenarios', icon: 'user', area: 'characters',
        // Adding a character has several starts; the + asks which instead of silently making a blank one.
        menu: [
            { icon: 'user', label: 'New character', create: () => newCharacter('New character') },
            { icon: 'masks-theater', label: 'New scenario', create: () => newCharacter('New scenario', null, { kind: 'scenario' }) },
            { icon: 'file-import', label: 'Import card…', hint: 'PNG, CHARX or JSON', run: () => openCardImport() },
            { icon: 'user-plus', label: 'From SillyTavern…', hint: 'with its lorebook and sprites', run: () => openPullPicker() },
        ],
    },
    { type: 'lorebooks', label: 'Lorebooks', icon: 'book', area: 'lore', create: () => newLorebookArtifact('New lorebook') },
    { type: 'presets', label: 'Presets', icon: 'sliders', area: 'prompts', create: () => newPresetArtifact('cc', 'New Chat Completion preset') },
    { type: 'connectionProfiles', label: 'Connection profiles', icon: 'plug', area: 'prompts' },
    { type: 'regexScripts', label: 'Regex scripts', icon: 'code', area: 'regex', create: () => newRegexArtifact('New regex') },
    { type: 'qrSets', label: 'Quick Reply sets', icon: 'terminal', area: 'scripts', create: () => newQrSetArtifact('New set') },
    { type: 'media', label: 'Media', icon: 'image', area: 'characters' },
];

export const AREA_FOR_TYPE = Object.fromEntries(TREE.map(t => [t.type, t.area]));

export function Workspace(props) {
    const { store, env, project, area, setArea, selection, setSelection, inspectorOpen } = props;
    const [collapsed, setCollapsed] = useState({});
    const [filter, setFilter] = useState('');

    const select = (type, id) => {
        setSelection({ type, id });
        setArea(AREA_FOR_TYPE[type] ?? area);
    };

    const create = (type, make) => {
        const art = make();
        store.update(p => upsertArtifact(p, type, art, { action: 'create', summary: `Created ${artifactName(type, art)}` }), `create ${type}`);
        select(type, art.id);
    };
    const unusedCount = unusedMedia(project).length;

    const areaProps = { ...props, select };
    const q = filter.trim().toLowerCase();

    return html`<div class=${cx('cs-workspace', !inspectorOpen && 'cs-no-inspector')}>
        <aside class="cs-tree" aria-label="Project tree">
            <div class="cs-tree-search">
                <${Icon} name="magnifying-glass" />
                <input class="text_pole" placeholder="Filter project…" value=${filter} onInput=${e => setFilter(e.currentTarget.value)} aria-label="Filter project tree" />
            </div>
            <button class=${cx('cs-tree-root', area === 'project' && !selection && 'active')} onClick=${() => { setSelection(null); setArea('project'); }}>
                <${Icon} name="diagram-project" /> <span>${project.name}</span>
            </button>
            ${TREE.map(t => {
                const rows = treeRows(t, project, q);
                const isCollapsed = collapsed[t.type];
                return html`<div class="cs-tree-group" key=${t.type}>
                    <div class="cs-tree-group-head">
                        <button class="cs-tree-toggle" onClick=${() => setCollapsed({ ...collapsed, [t.type]: !isCollapsed })} aria-expanded=${!isCollapsed}>
                            <${Icon} name=${isCollapsed ? 'caret-right' : 'caret-down'} /><${Icon} name=${t.icon} /> <span>${t.label}</span> <${Badge}>${project[t.type].length}</${Badge}>
                        </button>
                        ${t.create && html`<${Button} small icon="plus" title=${`New ${t.label.toLowerCase()}`} onClick=${() => create(t.type, t.create)} />`}
                        ${t.menu && html`<${AddMenu} label=${`Add to ${t.label.toLowerCase()}`} items=${t.menu.map(i => ({ ...i, run: i.run ?? (() => create(t.type, i.create)) }))} />`}
                        ${t.type === 'media' && unusedCount > 0 && html`<${Button} small icon="broom" title=${`Remove ${unusedCount} unused picture${unusedCount === 1 ? '' : 's'}`} onClick=${() => removeUnusedPictures(store, env)} />`}
                    </div>
                    ${!isCollapsed && html`<ul class="cs-tree-items">
                        ${rows.map(r => html`<li key=${r.key}>
                            <button class=${cx('cs-tree-item', !r.folded && selection?.id === r.id && 'active')} onClick=${() => select(r.type, r.id)} title=${r.label}>
                                ${r.badge}<span>${r.label}</span>
                            </button>
                        </li>`)}
                        ${!rows.length && html`<li class="cs-tree-empty">${q ? 'No match' : 'None yet'}</li>`}
                    </ul>`}
                </div>`;
            })}
        </aside>
        <main class="cs-main">
            ${area === 'project' && html`<${ProjectArea} ...${areaProps} />`}
            ${area === 'characters' && html`<${CharactersArea} ...${areaProps} />`}
            ${area === 'lore' && html`<${LoreArea} ...${areaProps} />`}
            ${area === 'prompts' && html`<${PromptsArea} ...${areaProps} />`}
            ${area === 'regex' && html`<${RegexArea} ...${areaProps} />`}
            ${area === 'scripts' && html`<${ScriptsArea} ...${areaProps} />`}
            ${area === 'playtest' && html`<${PlaytestArea} ...${areaProps} />`}
        </main>
        ${inspectorOpen ? html`<${Inspector} ...${areaProps} />` : html`<nav class="cs-rail" aria-label="Inspector">
            <button class="cs-rail-btn" title="AI proposals" onClick=${() => props.openInspectorAt('proposals')}><${Icon} name="wand-magic-sparkles" />${props.pending > 0 && html`<${Badge} kind="accent">${props.pending}</${Badge}>`}</button>
            <button class="cs-rail-btn" title="History" onClick=${() => props.openInspectorAt('history')}><${Icon} name="clock-rotate-left" /></button>
            <button class="cs-rail-btn" title="Snapshots & live backups" onClick=${() => props.openInspectorAt('snapshots')}><${Icon} name="camera" /></button>
        </nav>`}
    </div>`;
}

/** The rows of a tree group. Expression sprites fold into one row per character: a library character can have dozens. */
function treeRows(t, project, q) {
    const match = r => !q || r.label.toLowerCase().includes(q);
    const row = (type, a) => ({ key: a.id, type, id: a.id, label: artifactName(type, a), badge: treeBadge(type, a) });
    if (t.type !== 'media') return project[t.type].map(a => row(t.type, a)).filter(match);
    const spriteIds = new Set(project.characters.flatMap(c => Object.values(c.sprites ?? {})));
    const unused = new Set(unusedMedia(project).map(m => m.id));
    const rows = project.media.filter(m => !spriteIds.has(m.id)).map(m => ({
        ...row('media', m),
        badge: unused.has(m.id) ? html`<span class="cs-kind cs-unused" title="No character uses this picture">unused</span>` : null,
    }));
    for (const c of project.characters) {
        const n = Object.keys(c.sprites ?? {}).length;
        if (n) rows.push({ key: `sprites:${c.id}`, type: 'characters', id: c.id, folded: true, label: `${c.card.data.name} — ${n} expression sprite${n === 1 ? '' : 's'}`, badge: html`<${Icon} name="face-smile" />` });
    }
    return rows.filter(match);
}

/** A tree group's + as a small menu (click outside or Escape closes it without closing the studio). */
function AddMenu({ label, items }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const outside = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
        const escape = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('mousedown', outside, true);
            document.removeEventListener('keydown', escape, true);
        };
    }, [open]);
    return html`<div class="cs-addmenu" ref=${ref}>
        <${Button} small icon="plus" title=${label} ariaPressed=${open} onClick=${() => setOpen(!open)} />
        ${open && html`<div class="cs-projsw-menu cs-addmenu-menu" role="menu" aria-label=${label}>
            ${items.map(i => html`<button role="menuitem" class="cs-projsw-item cs-menu-action" key=${i.label} onClick=${() => { setOpen(false); i.run(); }}>
                <span><${Icon} name=${i.icon} /> ${i.label}</span>${i.hint && html`<small>${i.hint}</small>`}
            </button>`)}
        </div>`}
    </div>`;
}

function treeBadge(type, a) {
    if (type === 'characters') return html`<${Icon} name=${a.kind === 'scenario' ? 'masks-theater' : 'user'} />`;
    if (type === 'presets') return html`<span class="cs-kind">${a.kind}</span>`;
    if (type === 'regexScripts') return html`<span class="cs-kind">${a.scope?.[0] ?? 'g'}</span>`;
    if (type === 'lorebooks') return html`<span class="cs-kind">${Object.keys(a.data?.entries ?? {}).length}</span>`;
    return null;
}
