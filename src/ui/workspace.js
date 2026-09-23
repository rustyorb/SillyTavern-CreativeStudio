// Three-pane workbench: project tree | area editor | inspector.
import { html, useState, Icon, Button, Badge, cx } from './kit.js';
import { artifactName, upsertArtifact, newCharacter } from '../core/project.js';
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
    { type: 'characters', label: 'Characters & scenarios', icon: 'user', area: 'characters', create: () => newCharacter('New character') },
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

    const create = t => {
        const art = t.create();
        store.update(p => upsertArtifact(p, t.type, art, { action: 'create', summary: `Created ${artifactName(t.type, art)}` }), `create ${t.type}`);
        select(t.type, art.id);
    };

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
                const items = project[t.type].filter(a => !q || artifactName(t.type, a).toLowerCase().includes(q));
                const isCollapsed = collapsed[t.type];
                return html`<div class="cs-tree-group" key=${t.type}>
                    <div class="cs-tree-group-head">
                        <button class="cs-tree-toggle" onClick=${() => setCollapsed({ ...collapsed, [t.type]: !isCollapsed })} aria-expanded=${!isCollapsed}>
                            <${Icon} name=${isCollapsed ? 'caret-right' : 'caret-down'} /><${Icon} name=${t.icon} /> <span>${t.label}</span> <${Badge}>${project[t.type].length}</${Badge}>
                        </button>
                        ${t.create && html`<${Button} small icon="plus" title=${`New ${t.label.toLowerCase()}`} onClick=${() => create(t)} />`}
                    </div>
                    ${!isCollapsed && html`<ul class="cs-tree-items">
                        ${items.map(a => html`<li key=${a.id}>
                            <button class=${cx('cs-tree-item', selection?.id === a.id && 'active')} onClick=${() => select(t.type, a.id)} title=${artifactName(t.type, a)}>
                                ${treeBadge(t.type, a)}<span>${artifactName(t.type, a)}</span>
                            </button>
                        </li>`)}
                        ${!items.length && html`<li class="cs-tree-empty">${q ? 'No match' : 'None yet'}</li>`}
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

function treeBadge(type, a) {
    if (type === 'characters') return html`<${Icon} name=${a.kind === 'scenario' ? 'masks-theater' : 'user'} />`;
    if (type === 'presets') return html`<span class="cs-kind">${a.kind}</span>`;
    if (type === 'regexScripts') return html`<span class="cs-kind">${a.scope?.[0] ?? 'g'}</span>`;
    if (type === 'lorebooks') return html`<span class="cs-kind">${Object.keys(a.data?.entries ?? {}).length}</span>`;
    return null;
}
