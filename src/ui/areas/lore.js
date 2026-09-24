// World & lore workshop: lorebook editing with every verified 1.19 control, lint, AI proposals, activation preview.
import {
    html, useState, useMemo, useEffect, Button, Icon, Badge, Tabs, TextInput, TextArea, TagsInput, Field, Section, Empty,
    Diagnostics, Modal, Toggle, NumberInput, Select, downloadBlob, pickFile, fileBytes, cx,
} from '../kit.js';
import { useAiTask, AiStatus, CreationRoute } from '../ai.js';
import { pushProposals, PendingFor, isHandsFree } from '../proposals.js';
import { findArtifact, editArtifactField, upsertArtifact, removeArtifact, logHistory } from '../../core/project.js';
import {
    entriesOf, newEntry, normalizeWorld, lintWorld, simulateActivation, POSITION_LABEL, LOGIC_LABEL, ROLE_LABEL, TRIGGERS,
    WI_SETTINGS_DEFAULTS, characterBookToWorld, worldToCharacterBook, looksLikeRegexKey, parseRegexKey,
} from '../../core/lorebook.js';
import { clone, uid, utf8Decode, utf8Encode } from '../../core/bytes.js';
import { listStWorlds, getStWorld, saveStWorld } from '../../st/live.js';
import { recordBackup } from '../inspector.js';
import { stContext, readStWorldInfoSettings } from '../../st/env.js';
import { entryTitle, entryKeys, loreEntryAsk } from '../../ai/tasks.js';
import { useAiAssist } from '../ai-assist.js';

export const newLorebookArtifact = name => ({ id: uid('lb'), name, data: { entries: {} }, origin: { kind: 'new' } });

/** Compact reason for the chain view; the full text stays in the tooltip. */
function shortReason(reason = '') {
    const m = reason.match(/^Primary matched \((.+?)\) but secondary logic (.+?) failed/);
    if (m) return `“${m[1]}” matched, but ${m[2]} needs a secondary key too`;
    return reason.length > 70 ? `${reason.slice(0, 70)}…` : reason;
}

function linkLorebook(store, characterId, lorebookId) {
    store.update(p => {
        const c = findArtifact(p, 'characters', characterId);
        if (!c || (c.links?.lorebooks ?? []).includes(lorebookId)) return p;
        return editArtifactField(p, 'characters', characterId, 'links.lorebooks', [...(c.links?.lorebooks ?? []), lorebookId], { summary: 'Linked lorebook' });
    }, 'link lorebook');
}

export function LoreArea(props) {
    const { project, selection } = props;
    const lb = selection?.type === 'lorebooks' ? findArtifact(project, 'lorebooks', selection.id) : null;
    if (lb) return html`<${LorebookEditor} ...${props} lb=${lb} key=${lb.id} />`;
    return html`<${LoreHome} ...${props} />`;
}

// ============================================================================================ home

function LoreHome({ store, env, project, select }) {
    const [stPicker, setStPicker] = useState(false);
    const add = (lb, summary, actor = 'user') => {
        store.update(p => upsertArtifact(p, 'lorebooks', lb, { action: 'create', actor, summary }), 'create lorebook');
        select('lorebooks', lb.id);
    };
    const importFile = async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const json = JSON.parse(utf8Decode(await fileBytes(f)));
            let data;
            let note = '';
            if (json?.spec === 'lorebook_v3' && json.data) { data = characterBookToWorld(json.data); note = 'Converted from lorebook_v3'; }
            else if (Array.isArray(json?.entries)) { data = characterBookToWorld(json); note = 'Converted from character_book (entries array)'; }
            else if (json?.entries && typeof json.entries === 'object') data = json;
            else throw new Error('Not a SillyTavern World Info file or V3 lorebook');
            const { world, report } = normalizeWorld(data);
            delete world.originalData;
            add({ id: uid('lb'), name: json.name || f.name.replace(/\.json$/i, ''), data: world, origin: { kind: 'import', file: f.name, note, report } }, `Imported ${f.name}`, 'import');
        } catch (e) { env.toast(`Import failed: ${e.message}`, 'error', 7000); }
    };
    return html`<div class="cs-area-head">
            <h3><${Icon} name="book-atlas" /> World & lore</h3>
            <div class="cs-spacer"></div>
            <${Button} icon="plus" label="New lorebook" onClick=${() => add(newLorebookArtifact('New lorebook'), 'New lorebook')} />
            <${Button} icon="file-import" label="Import JSON…" title="SillyTavern world file, character_book, or lorebook_v3" onClick=${importFile} />
            <${Button} icon="plug" label="From SillyTavern…" onClick=${() => setStPicker(true)} />
        </div>
        <div class="cs-area-body">
            <${WorldDesigner} store=${store} env=${env} project=${project} select=${select} />
            <${Section} title=${`Lorebooks (${project.lorebooks.length})`}>
                ${project.lorebooks.length ? html`<table class="cs-table"><thead><tr><th>Name</th><th>Entries</th><th>Linked to</th><th>Lint</th></tr></thead><tbody>
                    ${project.lorebooks.map(lb => {
                        const lint = lintWorld(lb.data).filter(i => i.level !== 'info');
                        const users = project.characters.filter(c => (c.links?.lorebooks ?? []).includes(lb.id)).map(c => c.card.data.name);
                        return html`<tr key=${lb.id} style="cursor:pointer" onClick=${() => select('lorebooks', lb.id)}>
                            <td><strong>${lb.name}</strong></td><td>${Object.keys(lb.data.entries ?? {}).length}</td><td>${users.join(', ') || html`<span class="cs-muted">global / unlinked</span>`}</td>
                            <td>${lint.length ? html`<${Badge} kind="warn">${lint.length}</${Badge}>` : html`<${Badge} kind="ok">ok</${Badge}>`}</td></tr>`;
                    })}</tbody></table>` : html`<${Empty} icon="book-atlas" title="No lorebooks yet">Design a world with AI above, import a file, or pull one from SillyTavern.</${Empty}>`}
            </${Section}>
        </div>
        ${stPicker && html`<${StWorldPicker} env=${env} onClose=${() => setStPicker(false)} onPicked=${(name, data) => {
            setStPicker(false);
            const { world } = normalizeWorld(data);
            add({ id: uid('lb'), name, data: world, origin: { kind: 'st', name, at: new Date().toISOString() } }, `Pulled ${name} from SillyTavern`, 'import');
        }} />`}`;
}

function StWorldPicker({ env, onClose, onPicked }) {
    const [names, setNames] = useState(null);
    const [busy, setBusy] = useState('');
    useMemo(() => { listStWorlds().then(setNames).catch(e => { env.toast(e.message, 'error'); setNames([]); }); }, []);
    const pick = async n => {
        setBusy(n);
        try { onPicked(n, await getStWorld(n)); } catch (e) { env.toast(e.message, 'error'); } finally { setBusy(''); }
    };
    return html`<${Modal} title="Pull a World Info book from SillyTavern" onClose=${onClose}>
        ${names === null ? html`<div class="cs-muted">Loading…</div>` : names.length ? html`<ul class="cs-list">${names.map(n => html`<li class="cs-list-item" key=${n} onClick=${() => !busy && pick(n)}><${Icon} name="book" /><span class="cs-grow">${n}</span>${busy === n && html`<${Icon} name="spinner" />`}</li>`)}</ul>` : html`<${Empty} title="No World Info books in SillyTavern" />`}
    </${Modal}>`;
}

/** AI world design from a premise or a character: proposes a new lorebook for review. */
function WorldDesigner({ store, env, project, select }) {
    const [premise, setPremise] = useState(project.premise ?? '');
    const [charId, setCharId] = useState(() => (project.characters.length === 1 ? project.characters[0].id : ''));
    const [count, setCount] = useState(8);
    const ai = useAiTask(store);
    const pending = project.proposals.filter(p => p.status === 'pending' && p.task === 'lore.structure' && !p.target.id);
    const run = async () => {
        const card = charId ? findArtifact(project, 'characters', charId)?.card : null;
        const r = await ai.run('lore.structure', { premise: premise || store.get().premise || '', card, count });
        if (!r) return;
        const world = { entries: {} };
        for (const e of r.value.entries) {
            const entry = newEntry(world, { comment: entryTitle(e), key: e.keys ?? [], keysecondary: e.secondary_keys ?? [], content: e.content, constant: !!e.constant, selective: true });
            entry.extensions = { studio: { category: e.category ?? '', rationale: e.rationale ?? '' } };
            world.entries[entry.uid] = entry;
        }
        const lbId = uid('lb');
        const accepted = pushProposals(store, [{
            task: 'lore.structure', title: `New lorebook: ${r.value.entries.length} entries`,
            target: { type: 'lorebooks', id: null },
            after: { id: lbId, name: card ? `${card.data.name} — World` : 'World', data: world, origin: { kind: 'ai', characterId: charId || undefined } },
            rationale: r.value.overview ?? '', generation: r.generation,
        }], 'AI world design');
        if (!accepted.length) return;
        // Hands-free: the lorebook exists now; link it to the character it was built for and open it.
        if (charId) linkLorebook(store, charId, lbId);
        env.toast(`Created a lorebook with ${r.value.entries.length} entries${card ? ` linked to ${card.data.name}` : ''}`, 'ok');
        select('lorebooks', lbId);
    };
    return html`<${Section} title="Design a world with AI" right=${html`<${CreationRoute} store=${store} project=${project} compact />`}>
        <${TextArea} label="World premise" value=${premise} onChange=${setPremise} rows=${3} stats=${false} placeholder="Setting, factions, conflicts, what the roleplay needs to know…" />
        <div class="cs-row">
            <select class="text_pole" style="width:auto" value=${charId} onChange=${e => setCharId(e.currentTarget.value)} aria-label="Base on character">
                <option value="">No character</option>
                ${project.characters.map(c => html`<option value=${c.id} selected=${c.id === charId}>Base on ${c.card.data.name}</option>`)}
            </select>
            <select class="text_pole" style="width:auto" value=${count} onChange=${e => setCount(Number(e.currentTarget.value))} aria-label="Entry count">
                ${[4, 6, 8, 12, 16].map(n => html`<option value=${n} selected=${n === count}>${n} entries</option>`)}
            </select>
            <${Button} kind="ai" icon="wand-magic-sparkles" label=${isHandsFree(project) ? 'Build the world' : 'Propose world structure'} onClick=${run} disabled=${ai.busy} />
        </div>
        <${AiStatus} ai=${ai} />
        ${pending.map(p => html`<${WorldProposal} key=${p.id} store=${store} proposal=${p} select=${select} />`)}
    </${Section}>`;
}

function WorldProposal({ store, proposal, select }) {
    const entries = entriesOf(proposal.after.data);
    const [keep, setKeep] = useState(() => new Set(entries.map(e => e.uid)));
    const toggle = u => { const n = new Set(keep); n.has(u) ? n.delete(u) : n.add(u); setKeep(n); };
    const accept = async () => {
        const { acceptProposal } = await import('../../core/project.js');
        const value = clone(proposal.after);
        value.data.entries = Object.fromEntries(Object.entries(value.data.entries).filter(([k]) => keep.has(Number(k))));
        store.update(p => acceptProposal(p, proposal.id, value), 'accept world');
        if (value.origin?.characterId) linkLorebook(store, value.origin.characterId, value.id);
        select('lorebooks', value.id);
    };
    const reject = async () => {
        const { rejectProposal } = await import('../../core/project.js');
        store.update(p => rejectProposal(p, proposal.id), 'reject world');
    };
    return html`<div class="cs-proposal">
        <div class="cs-proposal-head"><div class="cs-proposal-title">${proposal.title}</div><${Badge} kind="accent">pending</${Badge}></div>
        ${proposal.rationale && html`<div class="cs-rationale">${proposal.rationale}</div>`}
        <table class="cs-table"><thead><tr><th></th><th>Entry</th><th>Keys</th><th>Content</th></tr></thead><tbody>
            ${entries.map(e => html`<tr key=${e.uid} class=${keep.has(e.uid) ? '' : 'cs-miss'}>
                <td><input type="checkbox" checked=${keep.has(e.uid)} onChange=${() => toggle(e.uid)} aria-label=${`Keep ${e.comment}`} /></td>
                <td><strong>${e.comment}</strong>${e.constant ? html` <${Badge}>constant</${Badge}>` : ''}<div class="cs-muted cs-small">${e.extensions?.studio?.category ?? ''}</div></td>
                <td class="cs-small">${(e.key ?? []).join(', ')}</td>
                <td class="cs-small">${e.content}${e.extensions?.studio?.rationale ? html`<div class="cs-muted">↳ ${e.extensions.studio.rationale}</div>` : ''}</td>
            </tr>`)}
        </tbody></table>
        <div class="cs-row">
            <${Button} small kind="primary" icon="check" label=${`Create lorebook with ${keep.size} entries`} onClick=${accept} disabled=${!keep.size} />
            <${Button} small kind="danger" icon="xmark" label="Discard" onClick=${reject} />
        </div>
    </div>`;
}

// ============================================================================================ editor

function LorebookEditor(props) {
    const { store, env, project, lb, setSelection } = props;
    const [tab, setTab] = useState('entries');
    const [sel, setSel] = useState(() => entriesOf(lb.data)[0]?.uid ?? null);
    const lint = useMemo(() => lintWorld(lb.data), [lb.data]);
    const setWorld = (data, summary) => store.update(p => editArtifactField(p, 'lorebooks', lb.id, 'data', data, { summary }), `edit lorebook`);
    const setEntry = (u, patch, summary = 'Edited entry') => {
        const data = clone(lb.data);
        data.entries[u] = { ...data.entries[u], ...patch };
        store.update(p => editArtifactField(p, 'lorebooks', lb.id, `data.entries.${u}`, data.entries[u], { summary: `${summary} #${u}` }), `edit entry ${u}`);
    };
    const addEntry = () => {
        const data = clone(lb.data);
        const e = newEntry(data, { comment: 'New entry' });
        data.entries[e.uid] = e;
        setWorld(data, `Added entry #${e.uid}`);
        setSel(e.uid);
    };
    const removeEntry = u => {
        const data = clone(lb.data);
        delete data.entries[u];
        setWorld(data, `Deleted entry #${u}`);
        setSel(entriesOf(data)[0]?.uid ?? null);
    };
    const tabs = [
        { id: 'entries', label: 'Entries', icon: 'list', badge: Object.keys(lb.data.entries ?? {}).length },
        { id: 'preview', label: 'Activation preview', icon: 'bolt' },
        { id: 'audit', label: 'Audit', icon: 'stethoscope', badge: lint.filter(i => i.level !== 'info').length },
        { id: 'extract', label: 'Extract from text', icon: 'scissors' },
        { id: 'publish', label: 'Export & SillyTavern', icon: 'upload' },
    ];
    const remove = async () => {
        if (!(await env.confirm(`Remove lorebook ${lb.name} from the project?`, 'Nothing in SillyTavern is deleted. Undo with Ctrl+Z.'))) return;
        store.update(p => removeArtifact(p, 'lorebooks', lb.id, { summary: `Removed lorebook ${lb.name}` }), 'remove lorebook');
        setSelection(null);
    };
    return html`<div class="cs-area-head">
            <h3><${Icon} name="book" /></h3>
            <input class="text_pole" style="max-width:320px;font-weight:600" value=${lb.name} aria-label="Lorebook name"
                onInput=${e => store.update(p => editArtifactField(p, 'lorebooks', lb.id, 'name', e.currentTarget.value, { summary: 'Renamed lorebook' }), 'rename lorebook')} />
            ${lb.origin?.kind === 'st' && html`<${Badge} kind="accent">ST: ${lb.origin.name}</${Badge}>`}
            <div class="cs-spacer"></div>
            <${CreationRoute} store=${store} project=${project} compact />
            <${Button} small icon="trash" kind="danger" title="Remove from project" onClick=${remove} />
        </div>
        <${Tabs} tabs=${tabs} active=${tab} onChange=${setTab} />
        <div class="cs-area-body">
            ${tab === 'entries' && html`<div class="cs-split-3">
                <${EntryList} lb=${lb} sel=${sel} setSel=${setSel} addEntry=${addEntry} lint=${lint} setEntry=${setEntry} />
                <div>${sel != null && lb.data.entries[sel] ? html`<${EntryEditor} ...${props} entry=${lb.data.entries[sel]} setEntry=${setEntry} removeEntry=${removeEntry} lint=${lint.filter(i => i.uid === sel)} />`
                    : html`<${Empty} icon="book" title="No entry selected">Add an entry or pick one on the left.</${Empty}>`}</div>
            </div>`}
            ${tab === 'preview' && html`<${ActivationPreview} ...${props} />`}
            ${tab === 'audit' && html`<${Audit} ...${props} lint=${lint} setSel=${u => { setSel(u); setTab('entries'); }} />`}
            ${tab === 'extract' && html`<${Extract} ...${props} />`}
            ${tab === 'publish' && html`<${LorePublish} ...${props} />`}
        </div>`;
}

function EntryList({ lb, sel, setSel, addEntry, lint, setEntry }) {
    const [q, setQ] = useState('');
    const [sort, setSort] = useState('display');
    let list = entriesOf(lb.data);
    if (q) list = list.filter(e => `${e.comment} ${(e.key ?? []).join(' ')} ${e.content}`.toLowerCase().includes(q.toLowerCase()));
    if (sort === 'order') list = [...list].sort((a, b) => b.order - a.order);
    const flagged = new Set(lint.filter(i => i.level !== 'info').map(i => i.uid));
    return html`<div class="cs-stack">
        <div class="cs-row"><input class="text_pole" style="flex:1" placeholder="Filter entries…" value=${q} onInput=${e => setQ(e.currentTarget.value)} aria-label="Filter entries" />
            <select class="text_pole" style="width:auto" value=${sort} onChange=${e => setSort(e.currentTarget.value)} aria-label="Sort"><option value="display">Display</option><option value="order">Order ↓</option></select></div>
        <${Button} small icon="plus" label="New entry" onClick=${addEntry} />
        <ul class="cs-list" role="listbox" aria-label="Entries">${list.map(e => html`<li key=${e.uid} role="option" aria-selected=${sel === e.uid}
                class=${cx('cs-list-item', sel === e.uid && 'active', e.disable && 'disabled')} onClick=${() => setSel(e.uid)}>
            <span title=${e.constant ? 'Constant' : 'Keyword'} style=${`color:${e.constant ? 'var(--cs-accent)' : 'var(--cs-ok)'}`}>${e.constant ? '●' : '○'}</span>
            <span class="cs-grow">${e.comment || (e.key ?? []).join(', ') || `#${e.uid}`}</span>
            ${flagged.has(e.uid) && html`<${Icon} name="triangle-exclamation" title="Has lint warnings" />`}
            <span class="cs-muted cs-small" title="Order">${e.order}</span>
            <input type="checkbox" checked=${!e.disable} title="Enabled" aria-label="Enabled" onClick=${ev => ev.stopPropagation()} onChange=${ev => setEntry(e.uid, { disable: !ev.currentTarget.checked }, 'Toggled')} />
        </li>`)}</ul>
    </div>`;
}

function EntryEditor({ store, env, project, lb, entry: e, setEntry, removeEntry, lint }) {
    const set = (patch, s) => setEntry(e.uid, patch, s);
    const ai = useAiTask(store);
    const suggestKeys = async () => {
        const r = await ai.run('lore.keys', { entry: e });
        if (!r) return;
        pushProposals(store, [
            { task: 'lore.keys', title: `Keys for "${e.comment || e.uid}"`, target: { type: 'lorebooks', id: lb.id, path: `data.entries.${e.uid}.key` }, after: r.value.keys, rationale: r.value.rationale, generation: r.generation },
            ...(r.value.secondary_keys?.length ? [{ task: 'lore.keys', title: `Secondary keys for "${e.comment || e.uid}"`, target: { type: 'lorebooks', id: lb.id, path: `data.entries.${e.uid}.keysecondary` }, after: r.value.secondary_keys, rationale: r.value.rationale, generation: r.generation }] : []),
        ], 'AI keys');
    };
    const assist = useAiAssist({
        store, project, label: 'Content', value: e.content,
        target: { type: 'lorebooks', id: lb.id, path: `data.entries.${e.uid}.content` },
        current: () => findArtifact(store.get(), 'lorebooks', lb.id)?.data.entries[e.uid]?.content ?? '',
        rewrite: { id: 'text.rewrite', args: (instruction, count) => ({ ...loreEntryAsk(store.get(), lb.id, e.uid), instruction, count }) },
        add: { id: 'text.extend', args: instruction => ({ ...loreEntryAsk(store.get(), lb.id, e.uid), instruction }) },
        emptyHint: 'What should this entry say? (optional: the AI works from the title, keys and linked characters)',
    });
    const regexNote = [...(e.key ?? []), ...(e.keysecondary ?? [])].filter(looksLikeRegexKey).map(k => `${k} → ${parseRegexKey(k) ? 'valid regex' : 'INVALID regex (matched as text)'}`);
    return html`<div class="cs-stack">
        <div class="cs-row-between">
            <div class="cs-row"><strong>#${e.uid}</strong>
                <${Toggle} label="Enabled" checked=${!e.disable} onChange=${v => set({ disable: !v }, 'Toggled')} />
                <${Toggle} label="Constant" checked=${e.constant} onChange=${v => set({ constant: v }, 'Constant')} title="Always inserted (subject to budget)" />
                <${Toggle} label="Vectorized" checked=${e.vectorized} onChange=${v => set({ vectorized: v })} title="Eligible for Vector Storage activation" />
            </div>
            <${Button} small icon="trash" kind="danger" label="Delete" onClick=${() => removeEntry(e.uid)} />
        </div>
        <${TextInput} label="Title / memo" value=${e.comment} onChange=${v => set({ comment: v }, 'Title')} />
        <div class="cs-grid">
            <${TagsInput} label="Primary keys" items=${e.key} onChange=${v => set({ key: v }, 'Keys')} hint="Comma-separated. /pattern/flags = regex." />
            <${Select} label="Secondary logic" value=${e.selectiveLogic} options=${Object.entries(LOGIC_LABEL).map(([v, l]) => ({ value: v, label: l }))} onChange=${v => set({ selectiveLogic: Number(v) })} />
            <${TagsInput} label="Secondary keys" items=${e.keysecondary} onChange=${v => set({ keysecondary: v, selective: v.length > 0 || e.selective }, 'Secondary keys')} />
        </div>
        <div class="cs-row"><${Button} small kind="ai" icon="wand-magic-sparkles" label="Suggest keys" onClick=${suggestKeys} disabled=${ai.busy} /><${AiStatus} ai=${ai} /></div>
        ${regexNote.length > 0 && html`<div class="cs-small cs-muted">${regexNote.join(' · ')}</div>`}
        <${PendingFor} store=${store} project=${project} type="lorebooks" id=${lb.id} path=${`data.entries.${e.uid}.key`} />
        <${PendingFor} store=${store} project=${project} type="lorebooks" id=${lb.id} path=${`data.entries.${e.uid}.keysecondary`} />
        <${TextArea} label="Content" value=${e.content} onChange=${v => set({ content: v }, 'Content')} rows=${8} counter=${env.countTokens} actions=${assist.actions} hint="Macros are substituted at activation. Leading @@activate / @@dont_activate lines are decorators (others are stripped by ST 1.19)." />
        ${assist.panel}
        ${assist.status}
        <${PendingFor} store=${store} project=${project} type="lorebooks" id=${lb.id} path=${`data.entries.${e.uid}.content`} />
        <${Section} title="Placement">
            <div class="cs-grid">
                <${Select} label="Position" value=${e.position} options=${Object.entries(POSITION_LABEL).map(([v, l]) => ({ value: v, label: l }))} onChange=${v => set({ position: Number(v) }, 'Position')} />
                <${NumberInput} label="Order" value=${e.order} onChange=${v => set({ order: v ?? 100 }, 'Order')} hint="Higher = placed later (closer to chat)." />
                ${e.position === 4 && html`<${NumberInput} label="Depth" value=${e.depth} min=${0} onChange=${v => set({ depth: v ?? 4 })} />`}
                ${e.position === 4 && html`<${Select} label="Role" value=${e.role} options=${Object.entries(ROLE_LABEL).map(([v, l]) => ({ value: v, label: l }))} onChange=${v => set({ role: Number(v) })} />`}
                ${e.position === 7 && html`<${TextInput} label="Outlet name" value=${e.outletName} onChange=${v => set({ outletName: v })} hint="Emitted where {{outlet::name}} appears." />`}
            </div>
        </${Section}>
        <${Section} title="Activation" open=${false}>
            <div class="cs-grid">
                <${NumberInput} label="Scan depth (blank = global)" value=${e.scanDepth} min=${0} onChange=${v => set({ scanDepth: v })} />
                <${Select} label="Case sensitive" value=${String(e.caseSensitive)} options=${[{ value: 'null', label: 'Global setting' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange=${v => set({ caseSensitive: v === 'null' ? null : v === 'true' })} />
                <${Select} label="Match whole words" value=${String(e.matchWholeWords)} options=${[{ value: 'null', label: 'Global setting' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange=${v => set({ matchWholeWords: v === 'null' ? null : v === 'true' })} />
                <${Toggle} label="Use probability" checked=${e.useProbability} onChange=${v => set({ useProbability: v })} />
                <${NumberInput} label="Probability %" value=${e.probability} min=${0} max=${100} onChange=${v => set({ probability: v ?? 100 })} />
                <${TextInput} label="Automation ID" value=${e.automationId} onChange=${v => set({ automationId: v })} hint="Runs Quick Replies with the same automation ID on activation." />
            </div>
            <div class="cs-row">
                ${[['matchPersonaDescription', 'Persona'], ['matchCharacterDescription', 'Char description'], ['matchCharacterPersonality', 'Char personality'], ['matchCharacterDepthPrompt', "Char's note"], ['matchScenario', 'Scenario'], ['matchCreatorNotes', 'Creator notes']]
                    .map(([f, l]) => html`<${Toggle} key=${f} label=${`Scan ${l}`} checked=${e[f]} onChange=${v => set({ [f]: v })} />`)}
            </div>
            <${Field} label="Generation triggers (none = all)">
                <div class="cs-row">${TRIGGERS.map(t => html`<${Toggle} key=${t} label=${t} checked=${(e.triggers ?? []).includes(t)} onChange=${v => set({ triggers: v ? [...(e.triggers ?? []), t] : (e.triggers ?? []).filter(x => x !== t) })} />`)}</div>
            </${Field}>
        </${Section}>
        <${Section} title="Recursion, groups & timing" open=${false}>
            <div class="cs-row">
                <${Toggle} label="Non-recursable (exclude)" checked=${e.excludeRecursion} onChange=${v => set({ excludeRecursion: v })} />
                <${Toggle} label="Prevent further recursion" checked=${e.preventRecursion} onChange=${v => set({ preventRecursion: v })} />
                <${Toggle} label="Ignore budget" checked=${e.ignoreBudget} onChange=${v => set({ ignoreBudget: v })} />
            </div>
            <div class="cs-grid">
                <${NumberInput} label="Delay until recursion (level)" value=${Number(e.delayUntilRecursion || 0)} min=${0} onChange=${v => set({ delayUntilRecursion: v ?? 0 })} />
                <${TextInput} label="Inclusion group(s)" value=${e.group} onChange=${v => set({ group: v })} hint="Comma-separated; one member per group activates." />
                <${NumberInput} label="Group weight" value=${e.groupWeight} min=${0} onChange=${v => set({ groupWeight: v ?? 100 })} />
                <${Toggle} label="Prioritize (group override)" checked=${e.groupOverride} onChange=${v => set({ groupOverride: v })} />
                <${Select} label="Group scoring" value=${String(e.useGroupScoring)} options=${[{ value: 'null', label: 'Global setting' }, { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} onChange=${v => set({ useGroupScoring: v === 'null' ? null : v === 'true' })} />
                <${NumberInput} label="Sticky (messages)" value=${e.sticky} min=${0} onChange=${v => set({ sticky: v })} />
                <${NumberInput} label="Cooldown (messages)" value=${e.cooldown} min=${0} onChange=${v => set({ cooldown: v })} />
                <${NumberInput} label="Delay (min chat length)" value=${e.delay} min=${0} onChange=${v => set({ delay: v })} />
            </div>
        </${Section}>
        ${lint.length > 0 && html`<${Diagnostics} items=${lint} />`}
    </div>`;
}

// -------------------------------------------------------------------------------- activation preview

function ActivationPreview({ project, lb, env }) {
    const [chatText, setChatText] = useState('User: I walk into the forest.\nChar: The trees lean closer.');
    const [otherBooks, setOtherBooks] = useState([]);
    let maxContext = 8192;
    try { maxContext = stContext().maxContext ?? maxContext; } catch { /* offline */ }
    const [settings, setSettings] = useState({ ...WI_SETTINGS_DEFAULTS });
    const [settingsSource, setSettingsSource] = useState('shipped defaults');
    useEffect(() => {
        readStWorldInfoSettings().then(s => {
            if (s && Number.isFinite(s.depth)) { setSettings({ ...WI_SETTINGS_DEFAULTS, ...s }); setSettingsSource('your SillyTavern World Info settings'); }
        });
    }, []);
    const [ctxLen, setCtxLen] = useState(maxContext);
    const [genType, setGenType] = useState('normal');
    const chat = chatText.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const m = l.match(/^([^:]{1,40}):\s*(.*)$/);
        return m ? { name: m[1], mes: m[2] } : { name: '', mes: l };
    });
    const books = [{ name: lb.name, world: lb.data }, ...otherBooks.map(id => findArtifact(project, 'lorebooks', id)).filter(Boolean).map(b => ({ name: b.name, world: b.data }))];
    const result = useMemo(() => simulateActivation({ books, chat, settings, maxContext: ctxLen, generationType: genType, probabilityMode: 'assume', random: () => 0.5 }), [JSON.stringify(books.map(b => b.world)), chatText, JSON.stringify(settings), ctxLen, genType]);
    const S = (k, v) => setSettings({ ...settings, [k]: v });
    const statusBadge = s => ({ activated: 'ok', miss: '', skipped: '', budget: 'err', 'group-lost': 'warn', 'probability-failed': 'warn', candidate: 'accent' }[s] ?? '');
    const placedBlocks = [];
    for (const [pos, list] of Object.entries(result.placed)) {
        if (Array.isArray(list) && list.length) placedBlocks.push({ label: POSITION_LABEL[pos], items: list });
        else if (list && typeof list === 'object') for (const [k, l] of Object.entries(list)) if (l.length) placedBlocks.push({ label: `${POSITION_LABEL[pos]} ${k}`, items: l });
    }
    return html`<div class="cs-split">
        <div class="cs-stack">
            <${TextArea} label="Test chat (oldest first, “Name: message” per line)" value=${chatText} onChange=${setChatText} rows=${8} stats=${false} />
            <${Section} title="Scan settings" open=${false}>
                <div class="cs-muted cs-small">Loaded from ${settingsSource}. Changes here only affect this preview.</div>
                <div class="cs-grid">
                    <${NumberInput} label="Scan depth" value=${settings.depth} min=${0} onChange=${v => S('depth', v ?? 2)} />
                    <${NumberInput} label="Budget % of context" value=${settings.budget} min=${1} max=${100} onChange=${v => S('budget', v ?? 25)} />
                    <${NumberInput} label="Budget cap (tokens)" value=${settings.budgetCap} min=${0} onChange=${v => S('budgetCap', v ?? 0)} />
                    <${NumberInput} label="Context size" value=${ctxLen} min=${256} onChange=${v => setCtxLen(v ?? 8192)} />
                    <${NumberInput} label="Min activations" value=${settings.minActivations} min=${0} onChange=${v => S('minActivations', v ?? 0)} />
                    <${Select} label="Generation type" value=${genType} options=${TRIGGERS} onChange=${setGenType} />
                </div>
                <div class="cs-row">
                    <${Toggle} label="Recursive scan" checked=${settings.recursive} onChange=${v => S('recursive', v)} />
                    <${Toggle} label="Whole words" checked=${settings.matchWholeWords} onChange=${v => S('matchWholeWords', v)} />
                    <${Toggle} label="Case sensitive" checked=${settings.caseSensitive} onChange=${v => S('caseSensitive', v)} />
                    <${Toggle} label="Include names" checked=${settings.includeNames} onChange=${v => S('includeNames', v)} />
                    <${Toggle} label="Group scoring" checked=${settings.useGroupScoring} onChange=${v => S('useGroupScoring', v)} />
                </div>
            </${Section}>
            ${project.lorebooks.length > 1 && html`<${Section} title="Also scan (competing books)" open=${false}>
                ${project.lorebooks.filter(b => b.id !== lb.id).map(b => html`<${Toggle} key=${b.id} label=${b.name} checked=${otherBooks.includes(b.id)} onChange=${v => setOtherBooks(v ? [...otherBooks, b.id] : otherBooks.filter(x => x !== b.id))} />`)}
            </${Section}>`}
            <div class="cs-small">Budget: <strong>${result.usedTokens}</strong> / ${result.budget} tokens ${result.overflowed ? html`<${Badge} kind="err">overflowed</${Badge}>` : ''} · ${result.log.length} scan pass(es): ${result.log.map(l => `${l.state}@depth ${l.depth}: +${l.activated}`).join(' → ')}</div>
            <${ActivationChain} result=${result} multi=${books.length > 1} />
            <${Section} title="Every entry, with reasons" open=${false}>
            <table class="cs-table"><thead><tr><th>Entry</th><th>Result</th><th>Why</th></tr></thead><tbody>
                ${result.results.sort((a, b) => (a.status === 'activated' ? -1 : 0) - (b.status === 'activated' ? -1 : 0)).map(r => html`<tr key=${`${r.entry.world}.${r.entry.uid}`} class=${r.status === 'activated' ? 'cs-hit' : 'cs-miss'}>
                    <td>${r.entry.comment || `#${r.entry.uid}`}${books.length > 1 ? html`<div class="cs-muted cs-small">${r.entry.world}</div>` : ''}</td>
                    <td><${Badge} kind=${statusBadge(r.status)}>${r.status}</${Badge}>${r.pass ? html`<div class="cs-muted cs-small">pass ${r.pass}</div>` : ''}</td>
                    <td class="cs-small">${r.reason}</td>
                </tr>`)}
            </tbody></table>
            </${Section}>
            <div class="cs-muted cs-small">Probability rolls are assumed to succeed and inclusion-group ties use a fixed roll so the preview is stable. Timed effects (sticky/cooldown) need real chat state and are not simulated beyond “delay”.</div>
        </div>
        <div class="cs-stack">
            <h4 style="margin:0">What reaches the model</h4>
            ${placedBlocks.length ? placedBlocks.map(b => html`<div class="cs-pblock cs-pblock-system">
                <div class="cs-pblock-head">${b.label}</div>
                <div class="cs-pblock-body">${b.items.map(a => a.content).join('\n')}</div>
            </div>`) : html`<${Empty} icon="bolt" title="Nothing activates">Try adding a key word to the test chat.</${Empty}>`}
        </div>
    </div>`;
}

/** Chain reaction: one lane per scan pass; each lit entry shows the key that sparked it. */
function ActivationChain({ result, multi }) {
    const lit = result.results.filter(r => r.status === 'activated');
    const passes = [...new Set(lit.map(r => r.pass))].sort((a, b) => a - b);
    const cold = result.results.filter(r => r.status !== 'activated' && r.status !== 'skipped');
    const spark = r => {
        if (/^Constant/.test(r.reason)) return html`<span class="cs-chain-spark">always on</span>`;
        if (/^Decorator/.test(r.reason)) return html`<span class="cs-chain-spark">@@activate</span>`;
        return (r.matched ?? []).slice(0, 3).map(k => html`<span class="cs-chain-spark">“${k}”</span>`);
    };
    if (!lit.length && !cold.length) return null;
    return html`<div class="cs-stack">
    ${lit.length > 0 && html`<div class="cs-chain" role="list" aria-label="Activation chain">
        ${passes.map((p, i) => {
            const state = result.log[p - 1]?.state ?? '';
            return html`<div class="cs-chain-lane" role="listitem" key=${p}>
                <div class="cs-chain-lane-head">Pass ${p} · ${state === 'initial' ? 'chat' : state === 'recursion' ? 'recursion' : state}</div>
                ${lit.filter(r => r.pass === p).map(r => html`<div class="cs-chain-node" key=${`${r.entry.world}.${r.entry.uid}`} title=${r.reason}>
                    <span class="cs-chain-name">${r.entry.comment || `#${r.entry.uid}`}</span>${multi ? html`<span class="cs-muted cs-small"> · ${r.entry.world}</span>` : ''}
                    <div class="cs-chain-sparks">${spark(r)}${state === 'recursion' ? html`<span class="cs-muted"> from pass ${p - 1} text</span>` : ''}</div>
                </div>`)}
            </div>`;
        })}
    </div>`}
    ${cold.length > 0 && html`<div class="cs-chain-cold" aria-label="Entries that did not fire">
        <div class="cs-chain-lane-head">Did not fire</div>
        <div class="cs-chain-cold-row">
            ${cold.slice(0, 24).map(r => html`<div class="cs-chain-node" key=${`${r.entry.world}.${r.entry.uid}`} title=${r.reason}>
                <span class="cs-chain-name">${r.entry.comment || `#${r.entry.uid}`}</span>
                <div class="cs-small cs-muted">${r.status === 'miss' && !/^Primary matched/.test(r.reason ?? '') ? 'no key in the scanned messages' : shortReason(r.reason)}</div>
            </div>`)}
            ${cold.length > 24 && html`<div class="cs-muted cs-small">+${cold.length - 24} more</div>`}
        </div>
    </div>`}
    </div>`;
}

// -------------------------------------------------------------------------------------------- audit

function Audit({ store, project, lb, lint, setSel }) {
    const ai = useAiTask(store);
    const [charId, setCharId] = useState(() => project.characters.find(c => (c.links?.lorebooks ?? []).includes(lb.id))?.id ?? '');
    const findings = lb.aiAudit;
    const run = async () => {
        const card = charId ? findArtifact(project, 'characters', charId)?.card : null;
        const r = await ai.run('lore.contradictions', { entries: entriesOf(lb.data), card });
        if (!r) return;
        store.update(p => editArtifactField(p, 'lorebooks', lb.id, 'aiAudit', { time: new Date().toISOString(), findings: r.value.findings, model: r.generation.label }, { actor: 'ai', summary: 'AI lore audit' }), 'AI audit');
    };
    return html`
        <${Section} title="Structural lint (instant)"><${Diagnostics} items=${lint} onPick=${d => d.uid != null && setSel(d.uid)} /></${Section}>
        <${Section} title="AI audit: contradictions, gaps, duplicates, key problems">
            <div class="cs-row">
                <select class="text_pole" style="width:auto" value=${charId} onChange=${e => setCharId(e.currentTarget.value)} aria-label="Compare with character">
                    <option value="">No character</option>${project.characters.map(c => html`<option value=${c.id} selected=${c.id === charId}>Compare with ${c.card.data.name}</option>`)}
                </select>
                <${Button} kind="ai" icon="stethoscope" label="Run AI audit" onClick=${run} disabled=${ai.busy} />
            </div>
            <${AiStatus} ai=${ai} />
            ${findings && html`<div class="cs-muted cs-small">${new Date(findings.time).toLocaleString()} · ${findings.model ?? ''}</div>
                <ul class="cs-diags">${findings.findings.map((f, i) => html`<li key=${i} class=${`cs-diag cs-diag-${f.kind === 'contradiction' ? 'error' : f.kind === 'gap' ? 'info' : 'warn'}`}>
                    <${Badge}>${f.kind}</${Badge}> <span>${f.summary}${f.suggestion ? html`<br /><span class="cs-muted">→ ${f.suggestion}</span>` : ''}
                    ${(f.entry_uids ?? []).map(u => html` <a href="#" onClick=${ev => { ev.preventDefault(); setSel(Number(u)); }}>#${u}</a>`)}</span></li>`)}</ul>`}
        </${Section}>`;
}

// ------------------------------------------------------------------------------------------ extract

function Extract({ store, project, lb }) {
    const [text, setText] = useState('');
    const ai = useAiTask(store);
    const pending = project.proposals.filter(p => p.status === 'pending' && p.task === 'lore.extract' && p.target.id === lb.id);
    const loadChat = () => {
        try {
            const ctx = stContext();
            setText((ctx.chat ?? []).filter(m => !m.is_system).map(m => `${m.name}: ${m.mes}`).join('\n\n'));
        } catch (e) { /* ignore */ }
    };
    const run = async () => {
        const r = await ai.run('lore.extract', { text, existing: entriesOf(lb.data) });
        if (!r) return;
        const group = uid('grp');
        const specs = r.value.entries.map(e => {
            const data = clone(lb.data);
            const entry = newEntry(data, { comment: entryTitle(e), key: e.keys ?? [], content: e.content });
            entry.extensions = { studio: { evidence: e.evidence ?? '', rationale: e.rationale ?? '' } };
            return { task: 'lore.extract', title: `Add entry: ${entryTitle(e)}`, group, target: { type: 'lorebooks', id: lb.id, path: `data.entries.${entry.uid}` }, after: entry, rationale: `${e.rationale ?? ''}${e.evidence ? ` — evidence: “${e.evidence}”` : ''}`, generation: r.generation };
        });
        // Give each candidate a distinct uid so several can be accepted.
        let next = Math.max(-1, ...Object.keys(lb.data.entries ?? {}).map(Number)) + 1;
        for (const s of specs) { s.after.uid = next; s.after.displayIndex = next; s.target.path = `data.entries.${next}`; next++; }
        pushProposals(store, specs.map(s => ({ ...s, group: null })), 'AI extracted lore');
    };
    return html`
        <div class="cs-muted cs-small">Paste writing, notes or a chat log. Candidates appear below and in the inspector; nothing is added until you accept.</div>
        <${TextArea} label="Source text" value=${text} onChange=${setText} rows=${10} />
        <div class="cs-row">
            <${Button} icon="comments" label="Use current SillyTavern chat" onClick=${loadChat} />
            <${Button} kind="ai" icon="scissors" label="Extract candidates" onClick=${run} disabled=${ai.busy || !text.trim()} />
        </div>
        <${AiStatus} ai=${ai} />
        <${PendingFor} store=${store} project=${project} type="lorebooks" id=${lb.id} />
        ${!pending.length && html`<div class="cs-muted cs-small">No pending candidates.</div>`}`;
}

// ------------------------------------------------------------------------------------------ publish

function LorePublish({ store, env, project, lb }) {
    const [busy, setBusy] = useState(false);
    const [stName, setStName] = useState(lb.origin?.kind === 'st' ? lb.origin.name : lb.name);
    const exportJson = () => downloadBlob(utf8Encode(JSON.stringify(lb.data, null, 4)), `${lb.name}.json`, 'application/json');
    const exportV3 = () => {
        const { book, lost } = worldToCharacterBook(lb.name, lb.data, lb.bookMeta ?? {});
        downloadBlob(utf8Encode(JSON.stringify({ spec: 'lorebook_v3', data: book }, null, 2)), `${lb.name}.lorebook_v3.json`, 'application/json');
        if (lost.length) env.toast(`Not representable in V3: ${lost.join(', ')}`, '', 6000);
    };
    const save = async () => {
        let exists = false;
        try { exists = (await listStWorlds()).includes(stName); } catch { /* ignore */ }
        if (!(await env.confirm(`${exists ? 'Overwrite' : 'Create'} World Info "${stName}" in SillyTavern?`, exists ? 'The current version is backed up first and can be restored from the inspector.' : 'A new World Info file will be created.'))) return;
        setBusy(true);
        try {
            const data = clone(lb.data);
            delete data.originalData;
            const { backup } = await saveStWorld(stName, data);
            recordBackup(store, backup, `Saved lorebook ${stName} to SillyTavern`);
            const back = await getStWorld(stName);
            const same = JSON.stringify(Object.keys(back.entries ?? {}).sort()) === JSON.stringify(Object.keys(data.entries).sort());
            env.toast(same ? `Saved "${stName}" to SillyTavern (verified ${Object.keys(back.entries).length} entries)` : 'Saved, but the read-back differs; check the World Info panel.', same ? 'ok' : 'error', 6000);
        } catch (e) { env.toast(`Save failed: ${e.message}`, 'error', 8000); } finally { setBusy(false); }
    };
    return html`
        <${Section} title="Export files">
            <div class="cs-row">
                <${Button} icon="download" label="SillyTavern World Info JSON" onClick=${exportJson} />
                <${Button} icon="download" label="Lorebook V3 JSON" onClick=${exportV3} title="{spec:'lorebook_v3'} — note: ST's World Info importer rejects this shape; use the ST JSON for ST." />
            </div>
            <div class="cs-muted cs-small">SillyTavern World Info JSON imports via World Info → Import. The lorebook_v3 file is for other V3 tools; SillyTavern 1.19 does not import that shape directly.</div>
        </${Section}>
        <${Section} title="SillyTavern">
            <div class="cs-row"><${TextInput} label="World Info name in SillyTavern" value=${stName} onChange=${setStName} />
                <${Button} kind="primary" icon="upload" label="Save to SillyTavern…" onClick=${save} disabled=${busy || !stName.trim()} /></div>
            <div class="cs-muted cs-small">Saved through SillyTavern's own saveWorldInfo, so the editor cache and WORLDINFO_UPDATED stay consistent. Link it to a character in ST (globe icon) or enable it globally.</div>
        </${Section}>`;
}
