// Quick Reply & STscript workshop: sets and buttons, readable outline + source editing, live syntax check with
// SillyTavern's parser, effects/dependency inspection, command help, AI generation, reviewed test runs, live install.
import {
    html, useState, useMemo, useEffect, Button, Icon, Badge, Tabs, TextInput, TextArea, Field, Section, Empty, Diagnostics,
    Modal, Toggle, Select, downloadBlob, pickFile, fileBytes, cx, useDebounced,
} from '../kit.js';
import { useAiTask, AiStatus, CreationRoute } from '../ai.js';
import { isHandsFree } from '../proposals.js';
import { findArtifact, editArtifactField, upsertArtifact, removeArtifact, logHistory } from '../../core/project.js';
import { newSet, addQr, importQrJson, lintSet, QR_FLAGS } from '../../core/qr.js';
import { analyze, isSideEffectFree, EFFECT } from '../../core/stscript.js';
import { clone, uid, utf8Decode, utf8Encode } from '../../core/bytes.js';
import { parseLive, commandRegistry, describeCommand, argumentLint, executeLive, installQrSetLive } from '../../st/stscript-live.js';
import { listStQrSets, getStQrSet, saveStQrSet } from '../../st/live.js';
import { recordBackup } from '../inspector.js';
import { entriesOf } from '../../core/lorebook.js';

export const newQrSetArtifact = name => ({ id: uid('qrs'), name, data: newSet(name), links: { global: true, characters: [] } });

function projectAutomationIds(project) {
    const ids = new Set();
    for (const lb of project.lorebooks) for (const e of entriesOf(lb.data)) if (e.automationId) ids.add(e.automationId);
    return ids;
}

export function ScriptsArea(props) {
    const { store, env, project, selection, select, setSelection } = props;
    const set = selection?.type === 'qrSets' ? findArtifact(project, 'qrSets', selection.id) : project.qrSets[0] ?? null;
    const [stPicker, setStPicker] = useState(false);
    const [genOpen, setGenOpen] = useState(false);
    const addSet = (art, summary, actor = 'user') => {
        store.update(p => upsertArtifact(p, 'qrSets', art, { action: 'create', actor, summary }), 'create QR set');
        select('qrSets', art.id);
    };
    const importFile = async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const r = importQrJson(JSON.parse(utf8Decode(await fileBytes(f))), f.name);
            if (r.kind === 'qr') {
                if (!set) throw new Error('Create or select a set first to import a single Quick Reply into it.');
                const { set: s } = addQr(set.data, { ...r.qr });
                store.update(p => editArtifactField(p, 'qrSets', set.id, 'data', s, { summary: `Imported QR ${r.qr.label}` }), 'import QR');
            } else {
                addSet({ ...newQrSetArtifact(r.set.name), data: r.set, origin: { kind: 'import', file: f.name } }, `Imported set ${r.set.name}`, 'import');
                if (r.notes.length) env.toast(r.notes.join(' '), '', 6000);
            }
        } catch (e) { env.toast(`Import failed: ${e.message}`, 'error', 7000); }
    };
    const openGen = () => {
        if (!set) addSet(newQrSetArtifact(project.brief?.title || project.name || 'Story tools'), 'New QR set');
        setGenOpen(true);
    };
    return html`<div class="cs-area-head">
            <h3><${Icon} name="terminal" /> Quick Replies & STscript</h3>
            ${project.qrSets.length > 1 && html`<select class="text_pole" style="width:auto" value=${set?.id} onChange=${e => select('qrSets', e.currentTarget.value)} aria-label="Quick Reply set">
                ${project.qrSets.map(s => html`<option value=${s.id} selected=${s.id === set?.id}>${s.name}</option>`)}</select>`}
            <div class="cs-spacer"></div>
            <${Button} icon="plus" label="New set" onClick=${() => addSet(newQrSetArtifact('New set'), 'New QR set')} />
            <${Button} icon="file-import" label="Import…" title="QR set (v1 or v2) or a single .qr.json" onClick=${importFile} />
            <${Button} icon="plug" label="From SillyTavern…" onClick=${() => setStPicker(true)} />
            <${Button} kind="ai" icon="wand-magic-sparkles" label="Generate…" onClick=${openGen} />
        </div>
        <div class="cs-area-body">
            ${set ? html`<${SetEditor} ...${props} set=${set} key=${set.id} />` : html`<${Empty} icon="terminal" title="No Quick Reply sets">
                <div>Let the AI write buttons for you: dice, time skips, recaps, plot twists…</div>
                <div class="cs-row" style="justify-content:center;margin-top:8px"><${Button} kind="ai" icon="wand-magic-sparkles" label="Generate Quick Replies" onClick=${openGen} /></div>
            </${Empty}>`}
        </div>
        ${stPicker && html`<${StQrPicker} env=${env} onClose=${() => setStPicker(false)} onPicked=${(name, data) => {
            setStPicker(false);
            const r = importQrJson(data, name);
            addSet({ ...newQrSetArtifact(name), data: r.set, origin: { kind: 'st', name, at: new Date().toISOString() } }, `Pulled QR set ${name} from SillyTavern`, 'import');
        }} />`}
        ${genOpen && set && html`<${GenerateQr} store=${store} env=${env} project=${project} set=${set} onClose=${() => setGenOpen(false)} />`}`;
}

function StQrPicker({ env, onClose, onPicked }) {
    const [names, setNames] = useState(null);
    useEffect(() => { listStQrSets().then(setNames).catch(e => { env.toast(e.message, 'error'); setNames([]); }); }, []);
    const pick = async n => { try { onPicked(n, await getStQrSet(n)); } catch (e) { env.toast(e.message, 'error'); } };
    return html`<${Modal} title="Pull a Quick Reply set from SillyTavern" onClose=${onClose}>
        ${names === null ? html`<div class="cs-muted">Loading…</div>` : names.length ? html`<ul class="cs-list">${names.map(n => html`<li class="cs-list-item" key=${n} onClick=${() => pick(n)}><${Icon} name="terminal" /><span class="cs-grow">${n}</span></li>`)}</ul>` : html`<${Empty} title="No sets" />`}
    </${Modal}>`;
}

// ============================================================================================ set editor

function SetEditor({ store, env, project, set, select, setSelection }) {
    const d = set.data;
    const [qrId, setQrId] = useState(d.qrList[0]?.id ?? null);
    const [tab, setTab] = useState('edit');
    const setData = (data, s) => store.update(p => editArtifactField(p, 'qrSets', set.id, 'data', data, { summary: s }), 'edit QR set');
    const setMeta = (path, v, s) => store.update(p => editArtifactField(p, 'qrSets', set.id, path, v, { summary: s }), 'edit QR set');
    const qr = d.qrList.find(q => q.id === qrId) ?? d.qrList[0];
    const lint = useMemo(() => lintSet(d, { setNames: project.qrSets.map(s => s.data.name), automationIds: projectAutomationIds(project) }), [d, project.qrSets, project.lorebooks]);
    const add = () => {
        const { set: s, qr: q } = addQr(d, { label: `Button ${d.qrList.length + 1}`, message: '/echo Hello from {{char}}' });
        setData(s, 'Added Quick Reply');
        setQrId(q.id);
    };
    const move = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= d.qrList.length) return;
        const list = [...d.qrList];
        [list[i], list[j]] = [list[j], list[i]];
        setData({ ...d, qrList: list }, 'Reordered Quick Replies');
    };
    const remove = async () => {
        if (!(await env.confirm(`Remove set ${d.name} from the project?`, 'Nothing in SillyTavern is deleted.'))) return;
        store.update(p => removeArtifact(p, 'qrSets', set.id, { summary: `Removed QR set ${d.name}` }), 'remove QR set');
        setSelection(null);
    };
    return html`
        <${Section} title="Set">
            <div class="cs-grid">
                <${TextInput} label="Set name" value=${d.name} onChange=${v => { store.update(p => editArtifactField(editArtifactField(p, 'qrSets', set.id, 'data.name', v, { summary: 'Renamed QR set' }), 'qrSets', set.id, 'name', v), 'rename QR set'); }} hint="Renaming in ST keeps the old file; the studio saves under the new name." />
                <${Toggle} label="Disable send (insert into input box)" checked=${d.disableSend} onChange=${v => setData({ ...d, disableSend: v }, 'Set option')} />
                <${Toggle} label="Inject user input" checked=${d.injectInput} onChange=${v => setData({ ...d, injectInput: v }, 'Set option')} />
                <${Toggle} label="Place before input" checked=${d.placeBeforeInput} onChange=${v => setData({ ...d, placeBeforeInput: v }, 'Set option')} />
            </div>
            <div class="cs-row">
                <span class="cs-muted cs-small">Intended links:</span>
                <${Toggle} label="Global" checked=${set.links?.global ?? true} onChange=${v => setMeta('links.global', v, 'QR link')} />
                ${project.characters.map(c => html`<${Toggle} key=${c.id} label=${c.card.data.name} checked=${(set.links?.characters ?? []).includes(c.id)} onChange=${v => setMeta('links.characters', v ? [...(set.links?.characters ?? []), c.id] : (set.links?.characters ?? []).filter(x => x !== c.id), 'QR link')} />`)}
                <div class="cs-spacer" style="flex:1"></div>
                <${Button} small icon="trash" kind="danger" label="Remove set" onClick=${remove} />
            </div>
        </${Section}>
        <div class="cs-split-3" style="grid-template-columns:minmax(220px,300px) minmax(0,1fr)">
            <div class="cs-stack">
                <${Button} small icon="plus" label="Quick Reply" onClick=${add} />
                <ul class="cs-list">${d.qrList.map((q, i) => html`<li key=${q.id} class=${cx('cs-list-item', qr?.id === q.id && 'active')} onClick=${() => setQrId(q.id)}>
                    ${q.icon ? html`<i class=${q.icon}></i>` : html`<${Icon} name=${q.isHidden ? 'eye-slash' : 'square'} />`}
                    <span class="cs-grow">${q.label || '(no label)'}</span>
                    ${QR_FLAGS.some(([k]) => q[k]) && html`<${Icon} name="bolt" title="Auto-executes" />`}
                    ${q.automationId && html`<${Icon} name="book" title=${`Automation ID ${q.automationId}`} />`}
                    ${lint.some(l => l.qrId === q.id && l.level !== 'info') && html`<${Icon} name="triangle-exclamation" />`}
                    <span class="cs-row" style="gap:0"><button class="cs-btn cs-btn-sm" aria-label="Move up" onClick=${e => { e.stopPropagation(); move(i, -1); }}>↑</button><button class="cs-btn cs-btn-sm" aria-label="Move down" onClick=${e => { e.stopPropagation(); move(i, 1); }}>↓</button></span>
                </li>`)}</ul>
                ${!d.qrList.length && html`<div class="cs-muted cs-small">No buttons yet.</div>`}
            </div>
            <div class="cs-stack">
                <${Tabs} tabs=${[{ id: 'edit', label: 'Script', icon: 'code' }, { id: 'set-lint', label: 'Set diagnostics', icon: 'stethoscope', badge: lint.filter(l => l.level !== 'info').length }, { id: 'publish', label: 'Export & SillyTavern', icon: 'upload' }]} active=${tab} onChange=${setTab} />
                ${tab === 'edit' && (qr ? html`<${QrEditor} store=${store} env=${env} project=${project} set=${set} qr=${qr} setData=${setData} setQrId=${setQrId} key=${qr.id} />` : html`<${Empty} title="Select or add a Quick Reply" />`)}
                ${tab === 'set-lint' && html`<${Diagnostics} items=${lint} />`}
                ${tab === 'publish' && html`<${QrPublish} store=${store} env=${env} set=${set} />`}
            </div>
        </div>`;
}

function QrEditor({ store, env, project, set, qr, setData, setQrId }) {
    const d = set.data;
    const setQr = (patch, s = 'Edited Quick Reply') => setData({ ...d, qrList: d.qrList.map(q => (q.id === qr.id ? { ...q, ...patch } : q)) }, `${s}: ${qr.label}`);
    const [view, setView] = useState('source');
    const [runState, setRunState] = useState(null);
    const debounced = useDebounced(qr.message, 350);
    const analysis = useMemo(() => {
        const reg = commandRegistry();
        return analyze(debounced, { knownCommands: reg.allNames.size ? reg.allNames : null });
    }, [debounced]);
    const live = useMemo(() => (analysis.isScript ? parseLive(debounced) : { available: false }), [debounced]);
    const argLint = useMemo(() => (analysis.isScript ? argumentLint(analysis.statements) : []), [analysis]);
    const diags = [
        ...(live.available && !live.ok ? [{ level: 'error', path: live.error.line ? `line ${live.error.line}:${live.error.column}` : '', message: `SillyTavern parser: ${live.error.message}` }] : []),
        ...analysis.lints.map(l => ({ level: l.level, path: l.line ? `line ${l.line}` : '', message: l.message })),
        ...argLint.map(l => ({ level: l.level, path: `line ${l.line}`, message: l.message })),
    ];
    const deleteQr = () => {
        setData({ ...d, qrList: d.qrList.filter(q => q.id !== qr.id) }, `Deleted Quick Reply ${qr.label}`);
        setQrId(d.qrList.find(q => q.id !== qr.id)?.id ?? null);
    };
    const exportQr = () => downloadBlob(utf8Encode(JSON.stringify(qr, null, 4)), `${qr.label || 'qr'}.qr.json`, 'application/json');
    return html`<div class="cs-stack">
        <div class="cs-grid">
            <${TextInput} label="Label" value=${qr.label} onChange=${v => setQr({ label: v })} />
            <${TextInput} label="Tooltip" value=${qr.title} onChange=${v => setQr({ title: v })} />
        </div>
        <div class="cs-row">
            <${Button} small label="Source" ariaPressed=${view === 'source'} onClick=${() => setView('source')} />
            <${Button} small label="Readable outline" ariaPressed=${view === 'outline'} onClick=${() => setView('outline')} />
            <div class="cs-spacer" style="flex:1"></div>
            ${live.available && html`<${Badge} kind=${live.ok ? 'ok' : 'err'} title="Checked with SillyTavern's own parser">${live.ok ? 'parses in ST' : 'syntax error'}</${Badge}>`}
            <${Button} small icon="play" label="Test run…" onClick=${() => setRunState({ phase: 'review' })} disabled=${!qr.message.trim()} />
            <${Button} small icon="download" title="Export this Quick Reply" onClick=${exportQr} />
            <${Button} small icon="trash" kind="danger" title="Delete" onClick=${deleteQr} />
        </div>
        ${view === 'source'
            ? html`<textarea class="text_pole cs-textarea cs-code" rows="14" value=${qr.message} onInput=${e => setQr({ message: e.currentTarget.value })} aria-label="Quick Reply message / STscript" spellcheck="false"></textarea>`
            : html`<${Outline} analysis=${analysis} />`}
        <${Section} title="Button behaviour" open=${false} right=${html`<span class="cs-muted cs-small">${[qr.isHidden && 'hidden', ...QR_FLAGS.filter(([k]) => qr[k]).map(([, l]) => l.toLowerCase()), qr.automationId && `automation ${qr.automationId}`, (qr.contextList ?? []).length && `${qr.contextList.length} context set(s)`].filter(Boolean).join(' · ') || 'manual button'}</span>`}>
            <div class="cs-grid">
            <${TextInput} label="Icon (Font Awesome class)" value=${qr.icon ?? ''} onChange=${v => setQr({ icon: v || undefined })} placeholder="fa-solid fa-dice" />
            <${TextInput} label="Automation ID" value=${qr.automationId ?? ''} onChange=${v => setQr({ automationId: v })} hint="Runs when a World Info entry with the same ID activates." />
        </div>
        <div class="cs-row">
            <${Toggle} label="Show label with icon" checked=${!!qr.showLabel} onChange=${v => setQr({ showLabel: v })} />
            <${Toggle} label="Hidden button" checked=${!!qr.isHidden} onChange=${v => setQr({ isHidden: v })} />
            <${Toggle} label="Don't trigger auto-execute" checked=${qr.preventAutoExecute !== false} onChange=${v => setQr({ preventAutoExecute: v })} title="Prevents this QR from triggering other auto-executing QRs" />
        </div>
        <${Field} label="Auto-execute"><div class="cs-row">${QR_FLAGS.map(([k, l]) => html`<${Toggle} key=${k} label=${l} checked=${!!qr[k]} onChange=${v => setQr({ [k]: v })} />`)}</div></${Field}>
        <${Field} label="Context menu (sets offered on right-click)">
            <div class="cs-row">${(qr.contextList ?? []).map((c, i) => html`<${Badge} key=${i}>${c.set}${c.isChained ? ' (chained)' : ''} <a href="#" aria-label="Remove" onClick=${e => { e.preventDefault(); setQr({ contextList: qr.contextList.filter((_, j) => j !== i) }); }}>×</a></${Badge}>`)}
                <select class="text_pole" style="width:auto" aria-label="Add context set" onChange=${e => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v) setQr({ contextList: [...(qr.contextList ?? []), { set: v, isChained: false }] }); }}>
                    <option value="">+ set…</option>${store.get().qrSets.map(s => html`<option value=${s.data.name}>${s.data.name}</option>`)}
                </select></div>
        </${Field}>
        </${Section}>
        <div class="cs-split">
            <div class="cs-stack">
                <h4 style="margin:0">Diagnostics</h4>
                <${Diagnostics} items=${diags} />
            </div>
            <div class="cs-stack">
                <h4 style="margin:0">What it does</h4>
                ${analysis.isScript ? html`<${EffectsPanel} analysis=${analysis} project=${project} />` : html`<div class="cs-muted cs-small">Plain text: sent as a user message${d.disableSend ? ' (placed in the input box because the set disables sending)' : ''}.</div>`}
            </div>
        </div>
        <${CommandHelp} analysis=${analysis} />
        ${runState && html`<${RunDialog} qr=${qr} analysis=${analysis} live=${live} state=${runState} setState=${setRunState} store=${store} set=${set} />`}
    </div>`;
}

function Outline({ analysis }) {
    if (!analysis.statements.length) return html`<div class="cs-muted">No commands.</div>`;
    return html`<ol class="cs-list" style="list-style:none">${analysis.statements.map((s, i) => html`<li key=${i} class="cs-list-item" style=${`padding-left:${6 + s.depth * 18}px`}>
        <code>/${s.cmd}</code>
        <span class="cs-grow cs-small">${Object.entries(s.named).map(([k, v]) => html`<${Badge}>${k}=${v.length > 30 ? `${v.slice(0, 30)}…` : v}</${Badge}> `)}${s.unnamed && !s.unnamed.startsWith('{:') ? html`<span class="cs-muted">${s.unnamed.slice(0, 80)}</span>` : ''}</span>
        <span class="cs-muted cs-small">line ${s.line}</span>
    </li>`)}</ol>`;
}

function EffectsPanel({ analysis, project }) {
    const qrLabels = new Set(project.qrSets.flatMap(s => s.data.qrList.map(q => `${s.data.name}.${q.label}`)));
    const v = analysis.vars;
    return html`<div class="cs-stack cs-small">
        ${analysis.effects.length ? html`<ul class="cs-diags">${analysis.effects.map(e => html`<li key=${e.id} class=${`cs-diag cs-diag-${['ui'].includes(e.id) ? 'info' : e.id === 'unknown' ? 'error' : 'warn'}`}>
            <${Icon} name=${e.id === 'generates' ? 'microchip' : e.id === 'sends-message' ? 'comment' : e.id.includes('var') ? 'database' : e.id === 'ui' ? 'window-maximize' : 'bolt'} />
            <span>${e.label}: ${[...new Set(e.uses.map(u => `/${u.cmd}`))].join(', ')}</span></li>`)}</ul>` : html`<div class="cs-ok-text">No side effects detected.</div>`}
        ${(v.writeLocal.length + v.readLocal.length + v.writeGlobal.length + v.readGlobal.length + v.scoped.length) > 0 && html`<table class="cs-table"><tbody>
            ${v.scoped.length > 0 && html`<tr><td>Scoped</td><td>${v.scoped.join(', ')}</td></tr>`}
            ${v.readLocal.length > 0 && html`<tr><td>Reads chat vars</td><td>${v.readLocal.join(', ')}</td></tr>`}
            ${v.writeLocal.length > 0 && html`<tr><td>Writes chat vars</td><td>${v.writeLocal.join(', ')}</td></tr>`}
            ${v.readGlobal.length > 0 && html`<tr><td>Reads global vars</td><td>${v.readGlobal.join(', ')}</td></tr>`}
            ${v.writeGlobal.length > 0 && html`<tr><td>Writes global vars</td><td>${v.writeGlobal.join(', ')}</td></tr>`}
        </tbody></table>`}
        ${analysis.calls.length > 0 && html`<div>Calls: ${analysis.calls.map(c => html`<${Badge} kind=${qrLabels.has(c.target) || !c.target.includes('.') ? '' : 'warn'} title=${qrLabels.has(c.target) ? 'In this project' : 'Not found in project sets'}>${c.target}</${Badge}> `)}</div>`}
        ${analysis.macros.length > 0 && html`<div class="cs-muted">Macros: ${[...new Set(analysis.macros.map(m => m.name))].join(', ')}</div>`}
    </div>`;
}

function CommandHelp({ analysis }) {
    const [q, setQ] = useState('');
    const reg = useMemo(() => commandRegistry(), []);
    const names = [...new Set(analysis.statements.map(s => s.cmd))].filter(n => reg.allNames.has(n));
    const shown = q ? [...reg.byName.keys()].filter(n => n.includes(q.toLowerCase())).slice(0, 12) : names.slice(0, 8);
    if (!reg.byName.size) return null;
    return html`<${Section} title=${`Command reference (${reg.byName.size} commands registered in this SillyTavern)`} open=${false}>
        <input class="text_pole" placeholder="Search commands…" value=${q} onInput=${e => setQ(e.currentTarget.value)} aria-label="Search commands" />
        ${shown.map(n => {
            const dsc = describeCommand(reg.byName.get(n) ?? globalThis.SillyTavern.getContext().SlashCommandParser.commands[n]);
            if (!dsc) return null;
            return html`<div key=${n} class="cs-small" style="border-bottom:1px dashed var(--cs-line);padding:4px 0">
                <code>/${dsc.name}</code>${dsc.aliases.length ? html` <span class="cs-muted">(${dsc.aliases.join(', ')})</span>` : ''} ${dsc.returns && html`→ <span class="cs-muted">${dsc.returns}</span>`}
                <div>${dsc.help.slice(0, 300)}</div>
                ${dsc.named.length > 0 && html`<div>${dsc.named.map(a => html`<${Badge} title=${a.description}>${a.name}${a.required ? '*' : ''}${a.enum.length ? `: ${a.enum.slice(0, 6).join('|')}` : ''}</${Badge}> `)}</div>`}
                ${dsc.unnamed.length > 0 && html`<div class="cs-muted">unnamed: ${dsc.unnamed.map(a => `${a.description || a.types.join('|')}${a.required ? ' (required)' : ''}`).join('; ')}</div>`}
            </div>`;
        })}
    </${Section}>`;
}

function RunDialog({ qr, analysis, live, state, setState, store, set }) {
    const safe = isSideEffectFree(analysis);
    const run = async () => {
        setState({ phase: 'running' });
        const r = await executeLive(qr.message);
        setState({ phase: 'done', result: r });
        store.update(p => logHistory(p, { actor: 'st', action: 'test-run', target: { type: 'qrSets', id: set.id }, summary: `Test-ran “${qr.label}” in SillyTavern: ${r.ok ? 'ok' : `error: ${r.error}`}` }), 'test run');
    };
    return html`<${Modal} title=${`Test run: ${qr.label}`} onClose=${() => setState(null)}
        footer=${html`<${Button} label="Close" onClick=${() => setState(null)} />${state.phase === 'review' && html`<${Button} kind=${safe ? 'primary' : 'danger'} icon="play" label=${safe ? 'Run' : 'Run with these effects'} onClick=${run} disabled=${live.available && !live.ok} />`}`}>
        ${state.phase === 'review' && html`
            <div>The script runs in the <strong>current SillyTavern chat</strong>, exactly as if the button were clicked. Review what it will do:</div>
            ${live.available && !live.ok && html`<div class="cs-err-text">It does not parse: ${live.error.message}</div>`}
            ${analysis.effects.length ? html`<ul>${analysis.effects.map(e => html`<li class=${e.id === 'ui' ? '' : 'cs-warn-text'}>${e.label} (${[...new Set(e.uses.map(u => `/${u.cmd}`))].join(', ')})</li>`)}</ul>` : html`<div class="cs-ok-text">No side effects detected.</div>`}
            ${!safe && html`<div class="cs-small cs-muted">Tip: test in a throwaway chat. Chat variables written here stay in that chat; global variables persist in settings.</div>`}`}
        ${state.phase === 'running' && html`<div class="cs-ai-status"><span class="cs-spin"><${Icon} name="spinner" /></span> Running…</div>`}
        ${state.phase === 'done' && html`<div class=${state.result.ok ? 'cs-ok-text' : 'cs-err-text'}>${state.result.ok ? (state.result.aborted ? 'Aborted by the script.' : 'Finished.') : `Error: ${state.result.error}`}</div>
            ${state.result.pipe !== undefined && html`<${Field} label="Result (pipe)"><pre class="cs-pre">${String(state.result.pipe)}</pre></${Field}>`}`}
    </${Modal}>`;
}

// ------------------------------------------------------------------------------------------ AI

/** One-click goals for common roleplay helpers. */
const QR_RECIPES = [
    { label: 'Dice roll', goal: "A 'Roll' button that rolls 1d20 and posts the result as a narrator (/sys) message." },
    { label: 'Time skip', goal: "A 'Time skip' button that asks how much time passes (/input), posts a short narrator note, then triggers the AI to continue." },
    { label: 'Scene summary', goal: "A 'Recap' button that uses /gen to write a 3-sentence summary of the recent scene and shows it in a popup without adding it to the chat." },
    { label: 'Draft my reply', goal: "A 'Draft' button that asks the AI to write {{user}}'s next message in character and puts it in the input box without sending it." },
    { label: 'Turn counter', goal: "A hidden Quick Reply that runs after every AI message and increments a chat variable 'turn', plus a 'Status' button that shows the turn count." },
    { label: 'Nudge the plot', goal: "A 'Twist' button that injects a one-time system note asking the AI to introduce a surprising but fitting complication in its next reply, then triggers generation." },
];

function GenerateQr({ store, env, project, set, onClose }) {
    const [goal, setGoal] = useState('');
    const ai = useAiTask(store);
    const [result, setResult] = useState(null);
    const [keep, setKeep] = useState(new Set());
    const reg = useMemo(() => commandRegistry(), []);
    const story = project.brief?.logline || (project.premise ? project.premise.slice(0, 300) : '');
    const recipes = story ? [{ label: 'Helpers for this story', goal: `Three to five Quick Replies that make this roleplay more fun to play (story tools, not generic chat utilities). The story: ${story}` }, ...QR_RECIPES] : QR_RECIPES;
    const run = async (g = goal) => {
        if (!g.trim()) return;
        setGoal(g);
        const core = ['echo', 'setvar', 'getvar', 'addvar', 'incvar', 'decvar', 'setglobalvar', 'getglobalvar', 'let', 'var', 'if', 'while', 'times', 'run', 'pass', 'abort', 'break', 'gen', 'genraw', 'trigger', 'send', 'sendas', 'sys', 'inject', 'input', 'buttons', 'popup', 'setinput', 'len', 'add', 'sub', 'rand', 'split', 'join', 'replace', 'createentry', 'setentryfield', 'findentry', 'getentryfield', 'qr-create', 'char-get'];
        const commands = core.filter(c => !reg.allNames.size || reg.allNames.has(c)).map(c => {
            const dd = describeCommand(reg.byName.get(c));
            return dd ? `/${c} ${dd.named.map(a => `${a.name}=${a.required ? '(req)' : ''}`).join(' ')} — ${dd.help.slice(0, 90)}` : `/${c}`;
        }).join('\n');
        const existing = set.data.qrList.map(q => `${q.label}: ${q.message.slice(0, 200)}`).join('\n');
        const r = await ai.run('stscript.generate', { goal: g, commands, existing });
        if (!r) return;
        if (isHandsFree(store.get())) {
            // Hands-free: scripts are only added (never run); those SillyTavern's parser accepts go straight in.
            const good = new Set(r.value.quickReplies.map((q, i) => (parseLive(q.message).ok !== false ? i : -1)).filter(i => i >= 0));
            if (good.size) accept(r, good, good.size === r.value.quickReplies.length);
            if (good.size < r.value.quickReplies.length) {
                setResult({ ...r, value: { ...r.value, quickReplies: r.value.quickReplies.filter((_, i) => !good.has(i)) } });
                setKeep(new Set());
                env.toast(`Added ${good.size}; ${r.value.quickReplies.length - good.size} did not parse and need a look.`, '', 7000);
            }
            return;
        }
        setResult(r);
        setKeep(new Set(r.value.quickReplies.map((_, i) => i)));
    };
    const accept = (res = result, keepSet = keep, close = true) => {
        let s = store.get().qrSets.find(x => x.id === set.id)?.data ?? set.data;
        for (const [i, g] of res.value.quickReplies.entries()) {
            if (!keepSet.has(i)) continue;
            const props = { label: g.label, title: g.title ?? g.explanation ?? '', message: g.message, isHidden: !!g.isHidden, automationId: g.automationId ?? '' };
            for (const [k] of QR_FLAGS) if (g[k]) props[k] = true;
            s = addQr(s, props).set;
        }
        store.update(p => logHistory(editArtifactField(p, 'qrSets', set.id, 'data', s, { actor: 'ai', summary: `Added ${keepSet.size} AI Quick Reply(s)` }), { actor: 'ai', action: 'ai-accept', target: { type: 'qrSets', id: set.id }, summary: `Accepted AI scripts from ${res.generation.label}` }), 'accept AI QRs');
        if (close) {
            env.toast(`Added ${keepSet.size} Quick Reply button(s) to “${set.name}”`, 'ok');
            onClose();
        }
    };
    const reg2 = reg.allNames.size ? reg.allNames : null;
    return html`<${Modal} title=${`Generate Quick Replies for “${set.name}”`} onClose=${onClose} wide footer=${html`<${AiStatus} ai=${ai} /><${Button} label="Close" onClick=${onClose} />
        ${result ? html`<${Button} kind="primary" icon="check" label=${`Add ${keep.size}`} onClick=${() => accept()} disabled=${!keep.size} />` : html`<${Button} kind="ai" icon="wand-magic-sparkles" label="Generate" onClick=${() => run()} disabled=${ai.busy || !goal.trim()} />`}`}>
        <${CreationRoute} store=${store} project=${project} />
        <div class="cs-row cs-small"><span class="cs-muted">One click:</span>${recipes.map(r => html`<${Button} small key=${r.label} kind="ai" label=${r.label} title=${r.goal} onClick=${() => run(r.goal)} disabled=${ai.busy} />`)}</div>
        <${TextArea} label="Or describe your own" value=${goal} onChange=${setGoal} rows=${3} stats=${false} placeholder="e.g. A 'Roll d20' button that echoes the result and stores it in a chat variable; a hidden QR that tracks the scene number after each AI message." />
        ${result && result.value.quickReplies.map((g, i) => {
            const a = analyze(g.message, { knownCommands: reg2 });
            const p = parseLive(g.message);
            return html`<div class="cs-proposal" key=${i}>
                <div class="cs-proposal-head"><label class="cs-toggle"><input type="checkbox" checked=${keep.has(i)} onChange=${() => { const n = new Set(keep); n.has(i) ? n.delete(i) : n.add(i); setKeep(n); }} /> <strong>${g.label}</strong></label>
                    ${p.available && html`<${Badge} kind=${p.ok ? 'ok' : 'err'}>${p.ok ? 'parses in ST' : 'syntax error'}</${Badge}>`}</div>
                <div class="cs-rationale">${g.explanation}</div>
                <pre class="cs-pre cs-code">${g.message}</pre>
                ${p.available && !p.ok && html`<div class="cs-err-text cs-small">${p.error.message}</div>`}
                <div class="cs-small">Detected effects: ${a.effects.map(e => e.label).join('; ') || 'none'}${g.effects?.length ? html`<br /><span class="cs-muted">Model says: ${g.effects.join('; ')}</span>` : ''}</div>
                ${a.lints.filter(l => l.level !== 'info').map(l => html`<div class="cs-warn-text cs-small">${l.message}</div>`)}
            </div>`;
        })}
    </${Modal}>`;
}

// ------------------------------------------------------------------------------------------ publish

function QrPublish({ store, env, set }) {
    const [busy, setBusy] = useState(false);
    const exportSet = () => downloadBlob(utf8Encode(JSON.stringify(set.data, null, 4)), `${set.data.name}.json`, 'application/json');
    const install = async () => {
        setBusy(true);
        try {
            let before = null;
            try { before = await getStQrSet(set.data.name); } catch { before = null; }
            const r = await installQrSetLive(clone(set.data));
            if (!r.ok) throw new Error(r.error);
            recordBackup(store, { kind: 'qr', name: set.data.name, data: before, existed: !!before, time: new Date().toISOString(), id: uid('bk') }, `Installed QR set ${set.data.name} in SillyTavern`);
            env.toast(`Installed “${set.data.name}” with Quick Reply's own importer. Enable it globally or per chat/character in the Quick Reply panel.`, 'ok', 8000);
        } catch (e) { env.toast(`Install failed: ${e.message}`, 'error', 8000); } finally { setBusy(false); }
    };
    const saveFile = async () => {
        setBusy(true);
        try {
            const { backup, note } = await saveStQrSet(clone(set.data));
            recordBackup(store, backup, `Saved QR set file ${set.data.name}`);
            env.toast(`Saved. ${note}`, 'ok', 7000);
        } catch (e) { env.toast(e.message, 'error'); } finally { setBusy(false); }
    };
    return html`<div class="cs-stack">
        <div class="cs-row">
            <${Button} icon="download" label="Export set JSON (v2)" onClick=${exportSet} />
            <${Button} kind="primary" icon="plug" label="Install live in SillyTavern" onClick=${install} disabled=${busy} title="Uses the Quick Reply extension's importer: available immediately" />
            <${Button} icon="floppy-disk" label="Save file only" onClick=${saveFile} disabled=${busy} title="Writes QuickReplies/<name>.json; visible after reload" />
        </div>
        <div class="cs-muted cs-small">Install asks before replacing an existing set of the same name (ST's own prompt). After installing, link the set globally, to a chat, or to a character in the Quick Reply panel. The project's intended links are listed in the bundle README.</div>
    </div>`;
}
