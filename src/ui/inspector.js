// Inspector: pending AI proposals, provenance history, snapshots and live-ST backups.
import { html, useState, useEffect, Tabs, Button, Icon, Empty, Badge, cx } from './kit.js';
import { ProposalCard } from './proposals.js';
import { restoreSnapshot, findArtifact, artifactName, logHistory } from '../core/project.js';
import { restoreCharacterBackup, restoreWorldBackup, saveStPreset, saveStQrSet, saveStGlobalRegex, saveStScopedRegex } from '../st/live.js';

export function Inspector({ store, env, project, inspector, setInspector, selection }) {
    const pending = project.proposals.filter(p => p.status === 'pending');
    const tabs = [
        { id: 'proposals', label: 'Proposals', icon: 'wand-magic-sparkles', badge: pending.length },
        { id: 'history', label: 'History', icon: 'clock-rotate-left' },
        { id: 'snapshots', label: 'Snapshots', icon: 'camera' },
    ];
    return html`<aside class="cs-inspector" aria-label="Inspector">
        <${Tabs} tabs=${tabs} active=${inspector} onChange=${setInspector} />
        <div class="cs-insp-body">
            ${inspector === 'proposals' && html`<${ProposalsPanel} store=${store} project=${project} selection=${selection} />`}
            ${inspector === 'history' && html`<${HistoryPanel} project=${project} selection=${selection} />`}
            ${inspector === 'snapshots' && html`<${SnapshotsPanel} store=${store} env=${env} project=${project} />`}
        </div>
    </aside>`;
}

function ProposalsPanel({ store, project, selection }) {
    const [scope, setScope] = useState('selection');
    const [showDecided, setShowDecided] = useState(false);
    let list = project.proposals.filter(p => showDecided || p.status === 'pending');
    if (scope === 'selection' && selection) list = list.filter(p => p.target.id === selection.id || (!p.target.id && p.target.type === selection.type));
    list = [...list].reverse();
    const pendingAll = project.proposals.filter(p => p.status === 'pending').length;
    return html`
        <div class="cs-row-between">
            <div class="cs-row">
                <${Button} small label="Selection" ariaPressed=${scope === 'selection'} onClick=${() => setScope('selection')} disabled=${!selection} />
                <${Button} small label=${`All (${pendingAll})`} ariaPressed=${scope === 'all' || !selection} onClick=${() => setScope('all')} />
            </div>
            <label class="cs-toggle cs-small"><input type="checkbox" checked=${showDecided} onChange=${e => setShowDecided(e.currentTarget.checked)} /> decided</label>
        </div>
        ${list.length ? list.map(p => html`<${ProposalCard} key=${p.id} store=${store} project=${project} proposal=${p} />`)
            : html`<${Empty} icon="wand-magic-sparkles" title="No proposals here">AI suggestions appear here for review. Nothing is applied until you accept it.</${Empty}>`}
    `;
}

function HistoryPanel({ project, selection }) {
    const [mine, setMine] = useState(true);
    let items = [...project.history].reverse();
    if (mine && selection) items = items.filter(h => h.target?.id === selection.id);
    return html`
        <div class="cs-row">
            <${Button} small label="Selection" ariaPressed=${mine && !!selection} disabled=${!selection} onClick=${() => setMine(true)} />
            <${Button} small label="Whole project" ariaPressed=${!mine || !selection} onClick=${() => setMine(false)} />
        </div>
        ${items.length ? html`<div>${items.slice(0, 300).map(h => html`<div class="cs-history-item" key=${h.id}>
            <span class=${h.actor === 'ai' ? 'cs-actor-ai' : 'cs-muted'} title=${h.actor}>${h.actor === 'ai' ? html`<${Icon} name="wand-magic-sparkles" />` : h.actor === 'import' ? html`<${Icon} name="file-import" />` : h.actor === 'st' ? html`<${Icon} name="plug" />` : html`<${Icon} name="user-pen" />`}</span>
            <span>${h.summary ?? h.action}${h.target && !selection ? html` <span class="cs-muted">· ${label(project, h.target)}</span>` : ''}<br /><span class="cs-muted cs-small">${new Date(h.time).toLocaleString()}</span></span>
        </div>`)}</div>` : html`<${Empty} icon="clock-rotate-left" title="No history yet" />`}
    `;
}

function label(project, target) {
    const a = findArtifact(project, target.type, target.id);
    return a ? artifactName(target.type, a) : target.type;
}

function SnapshotsPanel({ store, env, project }) {
    const [list, setList] = useState(null);
    const [busy, setBusy] = useState(false);
    const refresh = () => env.storage.listSnapshots(project.id).then(setList).catch(() => setList([]));
    useEffect(() => { refresh(); }, [project.id]);
    const take = async () => {
        const name = await env.prompt('Snapshot label', `Snapshot ${new Date().toLocaleString()}`);
        if (name == null) return;
        setBusy(true);
        try {
            await env.saveNow();
            await env.storage.saveSnapshot(store.get(), name);
            env.toast('Snapshot saved', 'ok');
            refresh();
        } catch (e) { env.toast(`Snapshot failed: ${e.message}`, 'error'); } finally { setBusy(false); }
    };
    const restore = async s => {
        if (!(await env.confirm('Restore this snapshot?', 'Current work is saved as a snapshot first, so this can be undone.'))) return;
        setBusy(true);
        try {
            await env.storage.saveSnapshot(store.get(), `Before restoring "${s.label}"`, 'auto');
            const snap = await env.storage.loadSnapshot(project.id, s.id);
            store.update(p => restoreSnapshot(p, snap), 'restore snapshot');
            env.toast('Snapshot restored', 'ok');
            refresh();
        } catch (e) { env.toast(`Restore failed: ${e.message}`, 'error'); } finally { setBusy(false); }
    };
    const backups = project.liveBackups ?? [];
    return html`
        <div class="cs-row"><${Button} small icon="camera" label="Take snapshot" onClick=${take} disabled=${busy} /></div>
        ${list === null ? html`<div class="cs-muted">Loading…</div>` : list.length === 0 ? html`<div class="cs-muted cs-small">No snapshots yet. Snapshots are also taken automatically before restores and live applies.</div>`
            : html`<ul class="cs-list">${list.map(s => html`<li class="cs-list-item" key=${s.id}>
                <${Icon} name=${s.kind === 'auto' ? 'robot' : 'camera'} /><span class="cs-grow" title=${s.label}>${s.label}<br /><span class="cs-muted cs-small">${new Date(s.time).toLocaleString()}</span></span>
                <${Button} small label="Restore" onClick=${() => restore(s)} disabled=${busy} />
            </li>`)}</ul>`}
        <h4 style="margin:8px 0 2px">Live SillyTavern backups <${Badge}>${backups.length}</${Badge}></h4>
        <div class="cs-muted cs-small">Before the studio writes to SillyTavern it stores what it overwrote. Restoring writes it back.</div>
        <ul class="cs-list">${[...backups].reverse().map(b => html`<li class="cs-list-item" key=${b.id}>
            <${Icon} name="plug" /><span class="cs-grow">${backupLabel(b)}<br /><span class="cs-muted cs-small">${new Date(b.time).toLocaleString()}</span></span>
            <${Button} small label="Restore in ST" onClick=${() => restoreBackup(store, env, b)} />
        </li>`)}</ul>
    `;
}

function backupLabel(b) {
    switch (b.kind) {
        case 'character': return `Character ${b.data?.name ?? b.avatar}`;
        case 'world': return `Lorebook ${b.name}${b.existed ? '' : ' (was new)'}`;
        case 'preset': return `Preset ${b.name} [${b.apiId}]${b.existed ? '' : ' (was new)'}`;
        case 'qr': return `Quick Reply set ${b.name}${b.existed ? '' : ' (was new)'}`;
        case 'regex-global': return `Global regex list (${b.data?.length ?? 0} scripts)`;
        case 'regex-scoped': return `Scoped regex of ${b.avatar}`;
        default: return b.kind;
    }
}

export async function restoreBackup(store, env, b) {
    if (!(await env.confirm('Write this backup back into SillyTavern?', backupLabel(b)))) return;
    try {
        switch (b.kind) {
            case 'character': await restoreCharacterBackup(b); break;
            case 'world': await restoreWorldBackup(b); break;
            case 'preset':
                if (!b.existed) throw new Error('The preset did not exist before; delete it in SillyTavern if you no longer want it.');
                await saveStPreset(b.apiId, b.name, b.data);
                break;
            case 'qr':
                if (!b.existed) throw new Error('The set did not exist before; delete it in the Quick Reply panel if unwanted.');
                await saveStQrSet(b.data);
                break;
            case 'regex-global': await saveStGlobalRegex(b.data); break;
            case 'regex-scoped': await saveStScopedRegex(b.avatar, b.data); break;
            default: throw new Error(`Unknown backup kind ${b.kind}`);
        }
        store.update(p => logHistory(p, { actor: 'st', action: 'restore-live', summary: `Restored in SillyTavern: ${backupLabel(b)}` }), 'restore live backup');
        env.toast('Restored in SillyTavern', 'ok');
    } catch (e) {
        env.toast(`Restore failed: ${e.message}`, 'error');
    }
}

/** Record a live backup in the project (bounded). */
export function recordBackup(store, backup, summary) {
    store.update(p => logHistory({ ...p, liveBackups: [...(p.liveBackups ?? []), backup].slice(-100) }, { actor: 'st', action: 'apply-live', summary }), 'apply to SillyTavern');
}
