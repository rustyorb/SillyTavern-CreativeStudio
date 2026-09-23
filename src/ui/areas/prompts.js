// Prompt & preset workshop: Chat Completion Prompt Manager presets, Text Completion templates, samplers,
// assembled previews (offline + live dry run), versions & compare, connection profiles, AI generation.
import {
    html, useState, useMemo, useEffect, Button, Icon, Badge, Tabs, TextInput, TextArea, Field, Section, Empty, Diagnostics,
    Modal, Toggle, NumberInput, Select, downloadBlob, pickFile, fileBytes, cx, roughTokens,
} from '../kit.js';
import { useAiTask, AiStatus, CreationRoute } from '../ai.js';
import { pushProposals } from '../proposals.js';
import { findArtifact, editArtifactField, upsertArtifact, removeArtifact, logHistory, acceptProposal, rejectProposal } from '../../core/project.js';
import {
    KINDS, MARKERS, detectKind, splitMaster, normalizeCc, ccOrder, setCcOrder, newCustomPrompt, markerKind, lintCc, assembleCc,
    sceneFromCard, diffCc, emptyCcPreset, stripSensitive, INSTRUCT_DEFAULT, CONTEXT_DEFAULT, SYSPROMPT_DEFAULT, REASONING_DEFAULT, TRIGGERS,
    mergeGeneratedPrompts,
} from '../../core/preset.js';
import { clone, uid, utf8Decode, utf8Encode } from '../../core/bytes.js';
import { jsonDiff } from '../../core/diff.js';
import { listStPresets, getStPreset, saveStPreset, dryRunPrompt, listStProfiles } from '../../st/live.js';
import { renderTcPrompt } from '../../st/render.js';
import { recordBackup } from '../inspector.js';

export function newPresetArtifact(kind, name) {
    const data = kind === 'cc' ? emptyCcPreset()
        : kind === 'instruct' ? { ...clone(INSTRUCT_DEFAULT), name }
            : kind === 'context' ? { ...clone(CONTEXT_DEFAULT), name }
                : kind === 'sysprompt' ? { ...clone(SYSPROMPT_DEFAULT), name }
                    : kind === 'reasoning' ? { ...clone(REASONING_DEFAULT), name }
                        : { temp: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05, rep_pen: 1.05, rep_pen_range: 2048, extensions: {} };
    return { id: uid('pre'), kind, name, data, origin: { kind: 'new' }, versions: [] };
}

export function PromptsArea(props) {
    const { project, selection } = props;
    const pr = selection?.type === 'presets' ? findArtifact(project, 'presets', selection.id) : null;
    if (pr) return html`<${PresetEditor} ...${props} pr=${pr} key=${pr.id} />`;
    if (selection?.type === 'connectionProfiles') return html`<${ProfilesView} ...${props} />`;
    return html`<${PromptsHome} ...${props} />`;
}

// ============================================================================================ home

function PromptsHome(props) {
    const { store, env, project, select } = props;
    const [stPicker, setStPicker] = useState(false);
    const [genOpen, setGenOpen] = useState(false);
    const add = (art, summary, actor = 'user') => {
        store.update(p => upsertArtifact(p, 'presets', art, { action: 'create', actor, summary }), 'create preset');
        select('presets', art.id);
    };
    const importFile = async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const json = JSON.parse(utf8Decode(await fileBytes(f)));
            const kind = detectKind(json);
            const base = f.name.replace(/\.json$/i, '');
            if (kind === 'master') {
                for (const part of splitMaster(json)) add({ ...newPresetArtifact(part.kind, part.name), data: part.data, origin: { kind: 'import', file: f.name } }, `Imported ${part.kind} from master export`, 'import');
                return;
            }
            if (kind === 'prompt-export') throw new Error('This is a Prompt Manager prompt export ({version,type,data}); open a CC preset and use “Import prompts”.');
            if (kind === 'unknown') throw new Error('Unrecognized preset/template file.');
            const data = kind === 'cc' ? normalizeCc(json).preset : json;
            add({ ...newPresetArtifact(kind, json.name ?? base), data, origin: { kind: 'import', file: f.name } }, `Imported ${f.name} (${kind})`, 'import');
        } catch (e) { env.toast(`Import failed: ${e.message}`, 'error', 7000); }
    };
    const byKind = Object.keys(KINDS).map(k => ({ k, list: project.presets.filter(p => p.kind === k) }));
    return html`<div class="cs-area-head">
            <h3><${Icon} name="sliders" /> Prompts & presets</h3>
            <div class="cs-spacer"></div>
            <select class="text_pole" style="width:auto" aria-label="New preset kind" onChange=${e => { const k = e.currentTarget.value; if (k) add(newPresetArtifact(k, `New ${KINDS[k].label}`), `New ${KINDS[k].label}`); e.currentTarget.value = ''; }}>
                <option value="">+ New…</option>${Object.entries(KINDS).map(([k, v]) => html`<option value=${k}>${v.label}</option>`)}
            </select>
            <${Button} icon="file-import" label="Import file…" title="CC preset, TC preset, instruct/context/system prompt/reasoning template, or an Advanced Formatting master export" onClick=${importFile} />
            <${Button} icon="plug" label="From SillyTavern…" onClick=${() => setStPicker(true)} />
            <${Button} kind="ai" icon="wand-magic-sparkles" label="Generate from goals…" onClick=${() => setGenOpen(true)} />
        </div>
        <div class="cs-area-body">
            <div class="cs-muted cs-small">Chat Completion presets carry the Prompt Manager (prompts, order, injections) plus samplers. Text Completion setups combine a sampler preset with instruct, context (story string) and system-prompt templates. Connection profiles only <em>select</em> presets by name.</div>
            ${byKind.map(({ k, list }) => html`<${Section} key=${k} title=${`${KINDS[k].label} (${list.length})`} open=${list.length > 0}>
                ${list.length ? html`<ul class="cs-list">${list.map(p => html`<li key=${p.id} class="cs-list-item" onClick=${() => select('presets', p.id)}>
                    <${Icon} name=${KINDS[k].icon} /><span class="cs-grow">${p.name}</span>
                    ${k === 'cc' && html`<span class="cs-muted cs-small">${(p.data.prompts ?? []).length} prompts · ${ccOrder(p.data).filter(o => o.enabled).length} enabled${p.data.extensions?.regex_scripts?.length ? ` · ${p.data.extensions.regex_scripts.length} regex` : ''}</span>`}
                    ${p.origin?.kind === 'st' && html`<${Badge} kind="accent">ST</${Badge}>`}
                    ${(p.versions?.length ?? 0) > 0 && html`<${Badge}>${p.versions.length} versions</${Badge}>`}
                </li>`)}</ul>` : html`<div class="cs-muted cs-small">None.</div>`}
            </${Section}>`)}
            <${ProfilesSection} ...${props} />
        </div>
        ${stPicker && html`<${StPresetPicker} env=${env} onClose=${() => setStPicker(false)} onPicked=${(kind, name, data) => {
            setStPicker(false);
            add({ ...newPresetArtifact(kind, name), data: kind === 'cc' ? normalizeCc(data).preset : data, origin: { kind: 'st', apiId: KINDS[kind].apiId, name, at: new Date().toISOString() } }, `Pulled ${name} from SillyTavern`, 'import');
        }} />`}
        ${genOpen && html`<${GenerateModal} ...${props} onClose=${() => setGenOpen(false)} />`}`;
}

/** Goals written from the project itself, so the author never has to describe a preset. */
function projectGoals(project) {
    const c = project.characters[0]?.card?.data;
    const b = project.brief;
    const parts = [
        'A high-quality immersive roleplay preset for this project: vivid, grounded prose; the character stays in voice; never speak or act for {{user}}; move scenes forward with concrete choices.',
        b?.logline && `Story: ${b.logline}`,
        b?.tone && `Tone: ${b.tone}`,
        !b && project.premise && `Premise: ${project.premise.slice(0, 600)}`,
        c?.name && `Main character: ${c.name}. ${String(c.description ?? '').slice(0, 400)}`,
    ].filter(Boolean);
    return parts.length > 1 ? parts.join('\n') : 'A strong, general-purpose immersive roleplay preset: vivid, grounded prose; characters stay in voice; never speak or act for {{user}}; keep scenes moving.';
}

function linkPreset(store, characterId, presetId) {
    store.update(p => {
        const c = findArtifact(p, 'characters', characterId);
        if (!c || (c.links?.presets ?? []).includes(presetId)) return p;
        return editArtifactField(p, 'characters', characterId, 'links.presets', [...(c.links?.presets ?? []), presetId], { summary: 'Linked preset' });
    }, 'link preset');
}

function StPresetPicker({ env, onClose, onPicked }) {
    const [kind, setKind] = useState('cc');
    let names = [];
    try { names = listStPresets(KINDS[kind].apiId); } catch { names = []; }
    const pick = n => {
        try { onPicked(kind, n, getStPreset(KINDS[kind].apiId, n)); } catch (e) { env.toast(e.message, 'error'); }
    };
    return html`<${Modal} title="Pull a preset or template from SillyTavern" onClose=${onClose}>
        <div class="cs-row">${Object.entries(KINDS).map(([k, v]) => html`<${Button} small label=${v.label} ariaPressed=${k === kind} onClick=${() => setKind(k)} />`)}</div>
        ${names.length ? html`<ul class="cs-list">${names.map(n => html`<li class="cs-list-item" key=${n} onClick=${() => pick(n)}><${Icon} name=${KINDS[kind].icon} /><span class="cs-grow">${n}</span></li>`)}</ul>` : html`<${Empty} title="None found for this kind" />`}
    </${Modal}>`;
}

// -------------------------------------------------------------------------------------- AI generation

function GenerateModal({ store, env, project, select, onClose }) {
    const [mode, setMode] = useState('cc');
    const [goals, setGoals] = useState('');
    const [samples, setSamples] = useState('');
    const [model, setModel] = useState('');
    const [target, setTarget] = useState('');
    const ai = useAiTask(store);
    const ccPresets = project.presets.filter(p => p.kind === 'cc');
    const derived = projectGoals(project);
    const run = async () => {
        const g = goals.trim() || derived;
        if (mode === 'cc') {
            const base = target ? findArtifact(project, 'presets', target) : null;
            const existing = base ? ccOrder(base.data).filter(o => o.enabled).map(o => base.data.prompts.find(p => p.identifier === o.identifier)).filter(p => p && !p.marker && p.content).map(p => `[${p.name}] ${p.content.slice(0, 300)}`).join('\n') : '';
            const r = await ai.run('preset.generate-cc', { goals: g, samples, model, existing });
            if (!r) return;
            const art = base ?? newPresetArtifact('cc', goals.trim() ? `Generated: ${goals.trim().slice(0, 40)}` : `${project.name} preset`);
            if (!base) store.update(p => upsertArtifact(p, 'presets', art, { action: 'create', summary: 'New preset for AI prompts' }), 'create preset');
            const merged = mergeGeneratedPrompts(art.data, r.value);
            const accepted = pushProposals(store, [{
                task: 'preset.generate-cc', title: `${r.value.prompts.length} prompts${r.value.sampler ? ' + samplers' : ''} for ${art.name}`,
                target: { type: 'presets', id: art.id, path: 'data' }, after: merged.preset,
                rationale: `${r.value.rationale}${r.value.model_assumptions ? `\nModel assumptions: ${r.value.model_assumptions}` : ''}`, generation: r.generation,
                group: null,
            }], 'AI preset');
            if (accepted.length) {
                if (!base && project.characters.length === 1) linkPreset(store, project.characters[0].id, art.id);
                env.toast(`Wrote ${r.value.prompts.length} prompts into ${art.name}`, 'ok');
            } else {
                store.update(p => editArtifactField(p, 'presets', art.id, 'pendingGenerated', merged.meta, { summary: 'AI generated prompts pending' }), 'pending meta');
            }
            select('presets', art.id);
            onClose();
        } else {
            const r = await ai.run('preset.generate-tc', { goals: g, model });
            if (!r) return;
            const sp = { ...newPresetArtifact('sysprompt', `Generated system prompt`), data: { name: 'Generated system prompt', content: r.value.system_prompt, post_history: '' } };
            const accepted = pushProposals(store, [{ task: 'preset.generate-tc', title: 'New system prompt', target: { type: 'presets', id: null }, after: sp, rationale: `${r.value.rationale}\nInstruct family: ${r.value.instruct_family ?? '?'}\nStory string: ${r.value.story_string_notes ?? ''}\nStop strings: ${(r.value.stop_strings ?? []).join(', ')}`, generation: r.generation }], 'AI TC');
            if (accepted.length) {
                env.toast(`Created a system prompt${r.value.instruct_family ? ` (use the ${r.value.instruct_family} instruct template)` : ''}`, 'ok', 7000);
                select('presets', sp.id);
            } else env.toast('Proposal ready in the inspector', 'ok');
            onClose();
        }
    };
    return html`<${Modal} title="Generate prompts from goals" onClose=${onClose} wide
        footer=${html`<${AiStatus} ai=${ai} /><${Button} label="Close" onClick=${onClose} /><${Button} kind="ai" icon="wand-magic-sparkles" label="Generate" onClick=${run} disabled=${ai.busy} />`}>
        <div class="cs-row"><${Button} small label="Chat Completion prompts" ariaPressed=${mode === 'cc'} onClick=${() => setMode('cc')} /><${Button} small label="Text Completion system prompt" ariaPressed=${mode === 'tc'} onClick=${() => setMode('tc')} /></div>
        <${CreationRoute} store=${store} project=${project} />
        <${TextArea} label="Goals (optional)" value=${goals} onChange=${setGoals} rows=${5} stats=${false}
            placeholder=${derived ? `Leave empty and the AI writes a preset that fits this project (${project.name}). Or describe what you want: prose style, POV, pacing, length, formatting…` : 'Leave empty for a strong general roleplay preset, or describe what you want: prose style, POV, pacing, length, formatting, what to avoid…'} />
        <${TextArea} label="Sample outputs with notes (optional)" value=${samples} onChange=${setSamples} rows=${5} stats=${false} placeholder="Paste replies you liked or disliked and say why." />
        <div class="cs-grid">
            <${TextInput} label="Target model (optional)" value=${model} onChange=${setModel} placeholder="e.g. Claude, GPT-5, Mistral Small, Qwen3" />
            ${mode === 'cc' && html`<${Select} label="Add to" value=${target} options=${[{ value: '', label: 'A new preset' }, ...ccPresets.map(p => ({ value: p.id, label: p.name }))]} onChange=${setTarget} />`}
        </div>
    </${Modal}>`;
}

// ======================================================================================= profiles

function ProfilesSection({ store, env, project, select }) {
    let st = [];
    try { st = listStProfiles(); } catch { st = []; }
    const pull = prof => {
        const art = { id: uid('cp'), name: prof.name, data: prof, origin: { kind: 'st', id: prof.id } };
        store.update(p => upsertArtifact(p, 'connectionProfiles', art, { action: 'create', actor: 'import', summary: `Referenced connection profile ${prof.name}` }), 'add profile');
    };
    return html`<${Section} title=${`Connection profiles (${project.connectionProfiles.length} in project · ${st.length} in SillyTavern)`}>
        <div class="cs-muted cs-small">A profile stores the API, model and the <em>names</em> of the presets/templates it selects — not their contents. The project keeps a reference copy (secrets are never copied) so a playtest can record exactly which configuration was used.</div>
        <table class="cs-table"><thead><tr><th>Profile</th><th>Mode</th><th>API / model</th><th>Selects</th><th></th></tr></thead><tbody>
            ${st.map(pf => {
                const inProj = project.connectionProfiles.some(c => c.origin?.id === pf.id);
                return html`<tr key=${pf.id}>
                    <td>${pf.name}</td><td>${pf.mode}</td><td class="cs-small">${pf.api}${pf.model ? ` · ${pf.model}` : ''}</td>
                    <td class="cs-small">${profileSelections(pf, project).map(s => html`<div>${s.label}: <strong>${s.value}</strong> ${s.inProject ? html`<${Badge} kind="ok">in project</${Badge}>` : ''}</div>`)}</td>
                    <td>${inProj ? html`<${Badge} kind="ok">referenced</${Badge}>` : html`<${Button} small icon="plus" label="Reference" onClick=${() => pull(pf)} />`}</td>
                </tr>`;
            })}
        </tbody></table>
        ${!st.length && html`<div class="cs-muted cs-small">No connection profiles in SillyTavern (Connection Manager extension).</div>`}
    </${Section}>`;
}

function profileSelections(pf, project) {
    const rows = [];
    const has = (kind, name) => project.presets.some(p => p.kind === kind && (p.name === name || p.origin?.name === name));
    if (pf.preset) rows.push({ label: pf.mode === 'cc' ? 'CC preset' : 'Sampler preset', value: pf.preset, inProject: has(pf.mode === 'cc' ? 'cc' : 'textgen', pf.preset) });
    if (pf.instruct) rows.push({ label: 'Instruct', value: `${pf.instruct}${pf['instruct-state'] === 'false' ? ' (off)' : ''}`, inProject: has('instruct', pf.instruct) });
    if (pf.context) rows.push({ label: 'Context', value: pf.context, inProject: has('context', pf.context) });
    if (pf.sysprompt) rows.push({ label: 'System prompt', value: `${pf.sysprompt}${pf['sysprompt-state'] === 'false' ? ' (off)' : ''}`, inProject: has('sysprompt', pf.sysprompt) });
    if (pf['reasoning-template']) rows.push({ label: 'Reasoning', value: pf['reasoning-template'], inProject: has('reasoning', pf['reasoning-template']) });
    if (pf['regex-preset']) rows.push({ label: 'Regex preset', value: pf['regex-preset'], inProject: false });
    return rows;
}

function ProfilesView({ project, selection, store }) {
    const cp = findArtifact(project, 'connectionProfiles', selection.id);
    if (!cp) return html`<${Empty} title="Profile not found" />`;
    const sel = profileSelections(cp.data, project);
    return html`<div class="cs-area-head"><h3><${Icon} name="plug" /> ${cp.name}</h3><div class="cs-spacer"></div>
            <${Button} small icon="trash" kind="danger" label="Remove reference" onClick=${() => store.update(p => removeArtifact(p, 'connectionProfiles', cp.id, { summary: `Removed profile ${cp.name}` }), 'remove profile')} /></div>
        <div class="cs-area-body">
            <div class="cs-muted cs-small">Reference copy of a SillyTavern connection profile. It selects the following by name:</div>
            <table class="cs-table"><tbody>${sel.map(s => html`<tr><td>${s.label}</td><td><strong>${s.value}</strong></td><td>${s.inProject ? html`<${Badge} kind="ok">content is in this project</${Badge}>` : html`<${Badge}>not in project</${Badge}>`}</td></tr>`)}</tbody></table>
            <pre class="cs-pre">${JSON.stringify(cp.data, null, 2)}</pre>
        </div>`;
}

// ============================================================================================ editor

function PresetEditor(props) {
    const { store, env, project, pr, setSelection } = props;
    const isCc = pr.kind === 'cc';
    const [tab, setTab] = useState(isCc ? 'prompts' : 'edit');
    const setData = (data, summary) => store.update(p => editArtifactField(p, 'presets', pr.id, 'data', data, { summary }), 'edit preset');
    const lint = useMemo(() => (isCc ? lintCc(pr.data) : []), [pr.data]);
    const tabs = isCc
        ? [
            { id: 'prompts', label: 'Prompt Manager', icon: 'list-ol', badge: ccOrder(pr.data).filter(o => o.enabled).length },
            { id: 'samplers', label: 'Samplers & format', icon: 'sliders' },
            { id: 'preview', label: 'Assembled prompt', icon: 'eye' },
            { id: 'lint', label: 'Diagnostics', icon: 'stethoscope', badge: lint.filter(i => i.level !== 'info').length },
            { id: 'versions', label: 'Versions & compare', icon: 'code-compare', badge: pr.versions?.length || undefined },
            { id: 'publish', label: 'Export & SillyTavern', icon: 'upload' },
        ]
        : [
            { id: 'edit', label: KINDS[pr.kind].label, icon: KINDS[pr.kind].icon },
            ...(['instruct', 'context', 'sysprompt'].includes(pr.kind) ? [{ id: 'preview', label: 'Rendered prompt', icon: 'eye' }] : []),
            { id: 'versions', label: 'Versions & compare', icon: 'code-compare', badge: pr.versions?.length || undefined },
            { id: 'publish', label: 'Export & SillyTavern', icon: 'upload' },
        ];
    const remove = async () => {
        if (!(await env.confirm(`Remove ${pr.name} from the project?`, 'Nothing in SillyTavern is deleted. Undo with Ctrl+Z.'))) return;
        store.update(p => removeArtifact(p, 'presets', pr.id, { summary: `Removed preset ${pr.name}` }), 'remove preset');
        setSelection(null);
    };
    const ep = { ...props, setData, lint };
    return html`<div class="cs-area-head">
            <h3><${Icon} name=${KINDS[pr.kind].icon} /></h3>
            <input class="text_pole" style="max-width:340px;font-weight:600" value=${pr.name} aria-label="Preset name"
                onInput=${e => store.update(p => editArtifactField(p, 'presets', pr.id, 'name', e.currentTarget.value, { summary: 'Renamed preset' }), 'rename preset')} />
            <${Badge}>${KINDS[pr.kind].label}</${Badge}>
            ${pr.origin?.kind === 'st' && html`<${Badge} kind="accent">ST: ${pr.origin.name}</${Badge}>`}
            <div class="cs-spacer"></div>
            <${Button} small icon="code-branch" label="Save version" onClick=${async () => {
                const label = await env.prompt('Version label', `v${(pr.versions?.length ?? 0) + 1}`);
                if (label) store.update(p => editArtifactField(p, 'presets', pr.id, 'versions', [...(pr.versions ?? []), { id: uid('ver'), label, time: new Date().toISOString(), data: clone(pr.data) }].slice(-50), { summary: `Saved version ${label}` }), 'save version');
            }} />
            <${Button} small icon="trash" kind="danger" title="Remove from project" onClick=${remove} />
        </div>
        <${Tabs} tabs=${tabs} active=${tab} onChange=${setTab} />
        <div class="cs-area-body">
            ${pr.pendingGenerated && html`<${GeneratedReview} ...${ep} />`}
            ${tab === 'prompts' && html`<${PromptManager} ...${ep} />`}
            ${tab === 'samplers' && html`<${SamplersTab} ...${ep} />`}
            ${tab === 'preview' && (isCc ? html`<${CcPreview} ...${ep} />` : html`<${TcPreview} ...${ep} />`)}
            ${tab === 'lint' && html`<${Diagnostics} items=${lint} />`}
            ${tab === 'edit' && html`<${TemplateEditor} ...${ep} />`}
            ${tab === 'versions' && html`<${Versions} ...${ep} />`}
            ${tab === 'publish' && html`<${PresetPublish} ...${ep} />`}
        </div>`;
}

/** Selective acceptance of AI-generated prompts: untick prompts you don't want, then accept. */
function GeneratedReview({ store, project, pr }) {
    const prop = project.proposals.find(p => p.status === 'pending' && p.task === 'preset.generate-cc' && p.target.id === pr.id);
    const meta = pr.pendingGenerated;
    const [skip, setSkip] = useState(new Set());
    if (!prop) return null;
    const clear = p => editArtifactField(p, 'presets', pr.id, 'pendingGenerated', undefined, { summary: 'Cleared AI review' });
    const accept = () => {
        const value = clone(prop.after);
        value.prompts = value.prompts.filter(p => !skip.has(p.identifier) || meta.prompts.find(m => m.identifier === p.identifier)?.replaced);
        for (const m of meta.prompts) if (skip.has(m.identifier) && m.replaced) {
            const orig = pr.data.prompts.find(p => p.identifier === m.identifier);
            const idx = value.prompts.findIndex(p => p.identifier === m.identifier);
            if (orig && idx >= 0) value.prompts[idx] = clone(orig);
        }
        const order = ccOrder(value).filter(o => !(skip.has(o.identifier) && !meta.prompts.find(m => m.identifier === o.identifier)?.replaced));
        store.update(p => clear(acceptProposal(p, prop.id, setCcOrder(value, order))), 'accept AI prompts');
    };
    const newPrompts = new Map(prop.after.prompts.map(p => [p.identifier, p]));
    return html`<div class="cs-proposal">
        <div class="cs-proposal-head"><div class="cs-proposal-title"><${Icon} name="wand-magic-sparkles" /> ${prop.title}</div><${Badge} kind="accent">review</${Badge}></div>
        <div class="cs-rationale" style="white-space:pre-wrap">${prop.rationale}</div>
        <table class="cs-table"><thead><tr><th></th><th>Prompt</th><th>Placement</th><th>Content</th></tr></thead><tbody>
            ${meta.prompts.map(m => html`<tr key=${m.identifier} class=${skip.has(m.identifier) ? 'cs-miss' : ''}>
                <td><input type="checkbox" checked=${!skip.has(m.identifier)} onChange=${() => { const n = new Set(skip); n.has(m.identifier) ? n.delete(m.identifier) : n.add(m.identifier); setSkip(n); }} aria-label=${`Keep ${m.name}`} /></td>
                <td><strong>${m.name}</strong>${m.replaced ? html` <${Badge} kind="warn">replaces</${Badge}>` : ''}<div class="cs-muted cs-small">${m.purpose}</div></td>
                <td class="cs-small">${m.placement}${m.placement === 'in-chat' ? ` @${m.depth ?? 4}` : ''}</td>
                <td class="cs-small" style="white-space:pre-wrap;max-width:520px">${newPrompts.get(m.identifier)?.content}</td>
            </tr>`)}
        </tbody></table>
        ${meta.sampler && html`<div class="cs-small">Sampler changes: ${Object.entries(meta.sampler).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}</div>`}
        <div class="cs-row">
            <${Button} small kind="primary" icon="check" label="Accept selected" onClick=${accept} />
            <${Button} small kind="danger" icon="xmark" label="Reject all" onClick=${() => store.update(p => clear(rejectProposal(p, prop.id)), 'reject AI prompts')} />
        </div>
    </div>`;
}

// ------------------------------------------------------------------------------------ prompt manager

function PromptManager({ store, env, pr, setData, lint }) {
    const data = pr.data;
    const order = ccOrder(data);
    const byId = new Map((data.prompts ?? []).map(p => [p.identifier, p]));
    const [sel, setSel] = useState(order.find(o => !byId.get(o.identifier)?.marker)?.identifier ?? order[0]?.identifier);
    const [q, setQ] = useState('');
    const [showOff, setShowOff] = useState(true);
    const setOrder = (o, s) => setData(setCcOrder(data, o), s);
    const move = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= order.length) return;
        const next = [...order];
        [next[i], next[j]] = [next[j], next[i]];
        setOrder(next, 'Reordered prompts');
    };
    const toggle = id => setOrder(order.map(o => (o.identifier === id ? { ...o, enabled: !o.enabled } : o)), 'Toggled prompt');
    const add = () => {
        const np = newCustomPrompt();
        const next = clone(data);
        next.prompts.push(np);
        const idx = order.findIndex(o => o.identifier === sel);
        const o = [...order];
        o.splice(idx >= 0 ? idx + 1 : o.length, 0, { identifier: np.identifier, enabled: true });
        setData(setCcOrder(next, o), 'Added prompt');
        setSel(np.identifier);
    };
    const orphans = (data.prompts ?? []).filter(p => !order.some(o => o.identifier === p.identifier));
    const flagged = new Set(lint.filter(i => i.level !== 'info' && i.identifier).map(i => i.identifier));
    const counts = useMemo(() => {
        const m = {};
        for (const p of data.prompts ?? []) m[p.identifier] = roughTokens(p.content);
        return m;
    }, [data.prompts]);
    const enabledTokens = order.filter(o => o.enabled).reduce((s, o) => s + (counts[o.identifier] ?? 0), 0);
    return html`<div class="cs-split-3" style="grid-template-columns:minmax(280px,380px) minmax(0,1fr)">
        <div class="cs-stack">
            <div class="cs-row"><input class="text_pole" style="flex:1" placeholder="Filter prompts…" value=${q} onInput=${e => setQ(e.currentTarget.value)} aria-label="Filter prompts" />
                <${Toggle} label="Show disabled" checked=${showOff} onChange=${setShowOff} /></div>
            <div class="cs-row-between cs-small cs-muted"><span>${order.filter(o => o.enabled).length}/${order.length} enabled · ≈${enabledTokens} tokens of static text</span><${Button} small icon="plus" label="Prompt" onClick=${add} /></div>
            <ul class="cs-list" aria-label="Prompt order">${order.map((o, i) => {
                const p = byId.get(o.identifier);
                const kind = p ? markerKind(p) : 'missing';
                const label = p?.name ?? o.identifier;
                if (q && !`${label} ${p?.content ?? ''}`.toLowerCase().includes(q.toLowerCase())) return null;
                if (!showOff && !o.enabled) return null;
                return html`<li key=${o.identifier} class=${cx('cs-list-item', sel === o.identifier && 'active', !o.enabled && 'disabled')} onClick=${() => setSel(o.identifier)}
                    style=${kind === 'divider' ? 'font-weight:600;border-top:1px solid var(--cs-line);margin-top:4px' : ''}>
                    <input type="checkbox" checked=${o.enabled} aria-label=${`Enable ${label}`} onClick=${e => e.stopPropagation()} onChange=${() => toggle(o.identifier)} />
                    <${Icon} name=${kind === 'marker' ? 'thumbtack' : kind === 'divider' ? 'grip-lines' : kind === 'missing' ? 'circle-question' : p.injection_position === 1 ? 'syringe' : 'align-left'} />
                    <span class="cs-grow" title=${label}>${label}</span>
                    ${flagged.has(o.identifier) && html`<${Icon} name="triangle-exclamation" />`}
                    ${p?.injection_position === 1 && html`<span class="cs-kind" title="In-chat depth">@${p.injection_depth ?? 4}</span>`}
                    ${p && !p.marker && html`<span class="cs-muted cs-small" style="min-width:34px;text-align:right">${counts[o.identifier]}</span>`}
                    <span class="cs-row" style="gap:0">
                        <button class="cs-btn cs-btn-sm" title="Move up" aria-label="Move up" onClick=${e => { e.stopPropagation(); move(i, -1); }}>↑</button>
                        <button class="cs-btn cs-btn-sm" title="Move down" aria-label="Move down" onClick=${e => { e.stopPropagation(); move(i, 1); }}>↓</button>
                    </span>
                </li>`;
            })}</ul>
            ${orphans.length > 0 && html`<${Section} title=${`Not in order (${orphans.length})`} open=${false}>
                ${orphans.map(p => html`<div class="cs-list-item" key=${p.identifier}><span class="cs-grow">${p.name}</span><${Button} small label="Add to order" onClick=${() => setOrder([...order, { identifier: p.identifier, enabled: true }], 'Added to order')} /></div>`)}
            </${Section}>`}
        </div>
        <div>${sel && byId.get(sel) ? html`<${PromptEditor} store=${store} env=${env} pr=${pr} data=${data} prompt=${byId.get(sel)} setData=${setData} order=${order} setSel=${setSel} />` : html`<${Empty} title="Select a prompt" />`}</div>
    </div>`;
}

function PromptEditor({ env, data, prompt: p, setData, order, setSel }) {
    const set = (patch, s = 'Edited prompt') => {
        const next = clone(data);
        const i = next.prompts.findIndex(x => x.identifier === p.identifier);
        next.prompts[i] = { ...next.prompts[i], ...patch };
        setData(next, `${s}: ${p.name}`);
    };
    const kind = markerKind(p);
    const remove = () => {
        const next = clone(data);
        next.prompts = next.prompts.filter(x => x.identifier !== p.identifier);
        setData(setCcOrder(next, order.filter(o => o.identifier !== p.identifier)), `Deleted prompt ${p.name}`);
        setSel(order[0]?.identifier);
    };
    if (kind === 'marker') {
        return html`<div class="cs-stack"><h4 style="margin:0"><${Icon} name="thumbtack" /> ${p.name}</h4>
            <div class="cs-muted">Marker: SillyTavern fills this slot at generation time (${MARKERS[p.identifier]}). Its position in the order decides where that content goes.</div></div>`;
    }
    return html`<div class="cs-stack">
        <div class="cs-row-between"><strong>${kind === 'divider' ? 'Divider / section marker' : p.system_prompt ? 'Built-in prompt' : 'Custom prompt'}</strong>
            ${!p.system_prompt && html`<${Button} small icon="trash" kind="danger" label="Delete" onClick=${remove} />`}</div>
        ${kind === 'divider' && html`<div class="cs-muted cs-small">This prompt is flagged as a marker but is not one of ST's marker slots; presets use these as section headers. ST sends nothing for it.</div>`}
        <div class="cs-grid">
            <${TextInput} label="Name" value=${p.name} onChange=${v => set({ name: v })} />
            <${Select} label="Role" value=${p.role ?? 'system'} options=${['system', 'user', 'assistant']} onChange=${v => set({ role: v })} />
            <${Select} label="Position" value=${p.injection_position ?? 0} options=${[{ value: 0, label: 'Relative (in order)' }, { value: 1, label: 'In-chat (at depth)' }]} onChange=${v => set({ injection_position: Number(v) })} />
            ${p.injection_position === 1 && html`<${NumberInput} label="Depth" value=${p.injection_depth ?? 4} min=${0} onChange=${v => set({ injection_depth: v ?? 4 })} hint="0 = after the last message" />`}
            ${p.injection_position === 1 && html`<${NumberInput} label="Order (same depth)" value=${p.injection_order ?? 100} onChange=${v => set({ injection_order: v ?? 100 })} />`}
        </div>
        <${Field} label="Triggers (none = all generation types)">
            <div class="cs-row">${TRIGGERS.map(t => html`<${Toggle} key=${t} label=${t} checked=${(p.injection_trigger ?? []).includes(t)} onChange=${v => set({ injection_trigger: v ? [...(p.injection_trigger ?? []), t] : (p.injection_trigger ?? []).filter(x => x !== t) })} />`)}</div>
        </${Field}>
        ${['main', 'jailbreak'].includes(p.identifier) && html`<${Toggle} label="Forbid overrides (ignore the card's system prompt / post-history instructions)" checked=${!!p.forbid_overrides} onChange=${v => set({ forbid_overrides: v })} />`}
        <${TextArea} label="Content" value=${p.content ?? ''} onChange=${v => set({ content: v })} rows=${14} counter=${env.countTokens} mono hint="Macros such as {{char}}, {{user}}, {{getvar::name}} are expanded by ST at generation." />
    </div>`;
}

// ------------------------------------------------------------------------------------ samplers

const CC_SAMPLERS = [
    ['temperature', 'Temperature', 0, 2, 0.05], ['top_p', 'Top P', 0, 1, 0.01], ['top_k', 'Top K', 0, 500, 1], ['top_a', 'Top A', 0, 1, 0.01], ['min_p', 'Min P', 0, 1, 0.01],
    ['frequency_penalty', 'Frequency penalty', -2, 2, 0.05], ['presence_penalty', 'Presence penalty', -2, 2, 0.05], ['repetition_penalty', 'Repetition penalty', 1, 2, 0.01],
    ['openai_max_context', 'Context size (tokens)', 512, 2000000, 1], ['openai_max_tokens', 'Max response (tokens)', 1, 128000, 1], ['seed', 'Seed (-1 random)', -1, 2 ** 31, 1],
];
const TG_SAMPLERS = ['temp', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tfs', 'rep_pen', 'rep_pen_range', 'freq_pen', 'presence_pen', 'dry_multiplier', 'dry_base', 'dry_allowed_length', 'xtc_threshold', 'xtc_probability', 'nsigma', 'mirostat_mode', 'mirostat_tau', 'mirostat_eta', 'genamt', 'max_length'];

function SamplersTab({ pr, setData }) {
    const d = pr.data;
    const set = (k, v) => setData({ ...d, [k]: v }, `Set ${k}`);
    const known = new Set([...CC_SAMPLERS.map(s => s[0]), 'prompts', 'prompt_order', 'extensions']);
    const other = Object.keys(d).filter(k => !known.has(k)).sort();
    return html`
        <${Section} title="Samplers">
            <div class="cs-grid">${CC_SAMPLERS.map(([k, l, min, max, step]) => html`<${NumberInput} key=${k} label=${l} value=${d[k]} min=${min} max=${max} step=${step} onChange=${v => set(k, v)} />`)}</div>
            <div class="cs-muted cs-small">Keys absent from a preset keep the user's current values when it is applied. Some models (e.g. Claude Fable 5.x) ignore sampling parameters; ST strips them for those.</div>
        </${Section}>
        <${Section} title="Formatting">
            <div class="cs-grid">
                <${TextInput} label="World Info format" value=${d.wi_format ?? '{0}'} onChange=${v => set('wi_format', v)} mono />
                <${TextInput} label="Scenario format" value=${d.scenario_format ?? '{{scenario}}'} onChange=${v => set('scenario_format', v)} mono />
                <${TextInput} label="Personality format" value=${d.personality_format ?? '{{personality}}'} onChange=${v => set('personality_format', v)} mono />
                <${Select} label="Names behavior" value=${d.names_behavior ?? 0} options=${[{ value: -1, label: 'None' }, { value: 0, label: 'Default' }, { value: 1, label: 'Completion object (name field)' }, { value: 2, label: 'Message content (Name: prefix)' }]} onChange=${v => set('names_behavior', Number(v))} />
                <${TextInput} label="Assistant prefill" value=${d.assistant_prefill ?? ''} onChange=${v => set('assistant_prefill', v)} />
                <${Toggle} label="Squash system messages" checked=${!!d.squash_system_messages} onChange=${v => set('squash_system_messages', v)} />
            </div>
            <${TextArea} label="New chat prompt" value=${d.new_chat_prompt ?? ''} onChange=${v => set('new_chat_prompt', v)} rows=${2} stats=${false} />
            <${TextArea} label="Continue nudge" value=${d.continue_nudge_prompt ?? ''} onChange=${v => set('continue_nudge_prompt', v)} rows=${2} stats=${false} />
            <${TextArea} label="Impersonation prompt" value=${d.impersonation_prompt ?? ''} onChange=${v => set('impersonation_prompt', v)} rows=${2} stats=${false} />
        </${Section}>
        <${Section} title=${`Other stored keys (${other.length})`} open=${false}>
            <table class="cs-table"><tbody>${other.map(k => html`<tr key=${k}><td><code>${k}</code></td><td class="cs-small">${JSON.stringify(d[k])?.slice(0, 120)}</td></tr>`)}</tbody></table>
        </${Section}>
        ${d.extensions?.regex_scripts?.length > 0 && html`<div class="cs-small"><${Icon} name="code" /> This preset carries ${d.extensions.regex_scripts.length} preset-scoped regex scripts; open them in the Regex Lab.</div>`}`;
}

// ------------------------------------------------------------------------------------ previews

function scenePicker(project) {
    return [{ value: '', label: 'Sample scene' }, ...project.characters.map(c => ({ value: c.id, label: c.card.data.name }))];
}

function CcPreview({ store, env, project, pr }) {
    const [charId, setCharId] = useState(project.characters[0]?.id ?? '');
    const [gen, setGen] = useState('normal');
    const [overrides, setOverrides] = useState(true);
    const [live, setLive] = useState(null);
    const [liveErr, setLiveErr] = useState('');
    const card = charId ? findArtifact(project, 'characters', charId)?.card : null;
    const blocks = useMemo(() => assembleCc(pr.data, sceneFromCard(card), { generationType: gen, honorCardOverrides: overrides }), [pr.data, card, gen, overrides]);
    // Exact counts from SillyTavern's active tokenizer (estimates until they arrive).
    const [counts, setCounts] = useState(null);
    useEffect(() => {
        let alive = true;
        setCounts(null);
        const t = setTimeout(() => {
            Promise.all(blocks.map(b => env.countTokens(b.content))).then(c => alive && setCounts(c)).catch(() => {});
        }, 300);
        return () => { alive = false; clearTimeout(t); };
    }, [blocks]);
    const tok = i => (counts ? counts[i] : roughTokens(blocks[i].content));
    const total = blocks.reduce((s, _, i) => s + tok(i), 0);
    const ai = useAiTask(store);
    const [critique, setCritique] = useState(null);
    const runLive = async () => {
        setLiveErr('');
        try { setLive(await dryRunPrompt()); } catch (e) { setLiveErr(e.message); }
    };
    const runCritique = async () => {
        const r = await ai.run('preset.critique', { assembled: blocks.map(b => `[${b.role} · ${b.label}]\n${b.content}`).join('\n\n') });
        if (r) setCritique(r.value);
    };
    return html`<div class="cs-split">
        <div class="cs-stack">
            <div class="cs-row">
                <${Select} label="Scene" value=${charId} options=${scenePicker(project)} onChange=${setCharId} />
                <${Select} label="Generation type" value=${gen} options=${TRIGGERS} onChange=${setGen} />
                <${Toggle} label="Apply card overrides" checked=${overrides} onChange=${setOverrides} />
            </div>
            <div class="cs-small cs-muted">Structural preview of this preset (${counts ? '' : '≈'}${total} tokens${counts ? ' by SillyTavern’s tokenizer' : ''}, ${blocks.length} messages). Roles, order and in-chat depth follow ST's assembly; exact text (World Info, macros, squashing, names) comes from ST itself in the live dry run →</div>
            ${blocks.map((b, i) => html`<div key=${i} class=${cx('cs-pblock', `cs-pblock-${b.role}`, b.source === 'injection' && 'cs-injected')}>
                <div class="cs-pblock-head"><strong>${b.role}</strong><span>${b.label}</span><span class="cs-spacer" style="flex:1"></span><span>${counts ? '' : '≈'}${tok(i)} tok</span></div>
                <div class="cs-pblock-body">${b.content}</div>
            </div>`)}
        </div>
        <div class="cs-stack">
            <${Section} title="Live dry run (SillyTavern's real prompt)">
                <div class="cs-muted cs-small">Assembles the prompt for the chat that is open in SillyTavern with the <em>active</em> preset and settings, without sending it. To test this project preset live, save it to SillyTavern and select it first.</div>
                <div class="cs-row"><${Button} icon="play" label="Dry run current chat" onClick=${runLive} /></div>
                ${liveErr && html`<div class="cs-err-text cs-small">${liveErr}</div>`}
                ${live?.messages && live.messages.map((m, i) => html`<div key=${i} class=${cx('cs-pblock', `cs-pblock-${m.role}`)}><div class="cs-pblock-head"><strong>${m.role}</strong>${m.name ? html`<span>${m.name}</span>` : ''}</div><div class="cs-pblock-body">${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}</div></div>`)}
                ${live?.text && html`<pre class="cs-pre">${live.text}</pre>`}
            </${Section}>
            <${Section} title="AI critique of the assembled prompt">
                <div class="cs-row"><${Button} kind="ai" icon="magnifying-glass-chart" label="Critique" onClick=${runCritique} disabled=${ai.busy} /><${AiStatus} ai=${ai} /></div>
                ${critique && html`<${Diagnostics} items=${critique.findings.map(f => ({ level: f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warn' : 'info', path: f.where, message: `${f.problem} → ${f.suggestion}` }))} />
                    ${critique.token_notes && html`<div class="cs-small cs-muted">${critique.token_notes}</div>`}`}
            </${Section}>
        </div>
    </div>`;
}

function TcPreview({ project, pr }) {
    const tpl = kind => project.presets.filter(p => p.kind === kind);
    const [ids, setIds] = useState(() => ({ instruct: pr.kind === 'instruct' ? pr.id : tpl('instruct')[0]?.id ?? '', context: pr.kind === 'context' ? pr.id : tpl('context')[0]?.id ?? '', sysprompt: pr.kind === 'sysprompt' ? pr.id : tpl('sysprompt')[0]?.id ?? '' }));
    const [charId, setCharId] = useState(project.characters[0]?.id ?? '');
    const [out, setOut] = useState(null);
    const get = id => (id ? findArtifact(project, 'presets', id)?.data : undefined);
    const card = charId ? findArtifact(project, 'characters', charId)?.card : null;
    useEffect(() => {
        renderTcPrompt({ instruct: get(ids.instruct), context: get(ids.context), sysprompt: get(ids.sysprompt), instructEnabled: !!ids.instruct }, sceneFromCard(card)).then(setOut).catch(e => setOut({ text: `Render error: ${e.message}`, stops: [], notes: [] }));
    }, [JSON.stringify(ids), charId, JSON.stringify([get(ids.instruct), get(ids.context), get(ids.sysprompt)])]);
    const opt = kind => [{ value: '', label: kind === 'instruct' ? 'Instruct off' : 'ST default' }, ...tpl(kind).map(p => ({ value: p.id, label: p.name }))];
    return html`<div class="cs-stack">
        <div class="cs-grid">
            <${Select} label="Instruct template" value=${ids.instruct} options=${opt('instruct')} onChange=${v => setIds({ ...ids, instruct: v })} />
            <${Select} label="Context template" value=${ids.context} options=${opt('context')} onChange=${v => setIds({ ...ids, context: v })} />
            <${Select} label="System prompt" value=${ids.sysprompt} options=${opt('sysprompt')} onChange=${v => setIds({ ...ids, sysprompt: v })} />
            <${Select} label="Scene" value=${charId} options=${scenePicker(project)} onChange=${setCharId} />
        </div>
        ${out && html`<div class="cs-small cs-muted">${(out.notes ?? []).join(' ')} ${out.renderer ? html`<${Badge} kind=${out.renderer === 'sillytavern' ? 'ok' : 'warn'}>${out.renderer}</${Badge}>` : ''} · ≈${roughTokens(out.text)} tokens</div>
            <pre class="cs-pre cs-code" style="max-height:60vh;white-space:pre-wrap">${out.text}</pre>
            ${out.stops?.length > 0 && html`<div class="cs-small">Stop strings: ${out.stops.map(s => html`<code>${JSON.stringify(s)}</code> `)}</div>`}`}
    </div>`;
}

// ------------------------------------------------------------------------------------ TC editors

const INSTRUCT_FIELDS = [
    ['input_sequence', 'User message prefix'], ['input_suffix', 'User message suffix'], ['output_sequence', 'Assistant message prefix'], ['output_suffix', 'Assistant message suffix'],
    ['system_sequence', 'System message prefix'], ['system_suffix', 'System message suffix'], ['first_input_sequence', 'First user prefix'], ['last_input_sequence', 'Last user prefix'],
    ['first_output_sequence', 'First assistant prefix'], ['last_output_sequence', 'Last assistant prefix'], ['last_system_sequence', 'System instruction prefix'],
    ['story_string_prefix', 'Story string prefix'], ['story_string_suffix', 'Story string suffix'], ['stop_sequence', 'Stop sequence'], ['user_alignment_message', 'User alignment message'], ['activation_regex', 'Activation regex (model id)'],
];

function TemplateEditor({ env, pr, setData }) {
    const d = pr.data;
    const set = (k, v) => setData({ ...d, [k]: v }, `Set ${k}`);
    if (pr.kind === 'instruct') {
        return html`<div class="cs-grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
                ${INSTRUCT_FIELDS.map(([k, l]) => html`<${Field} key=${k} label=${l}><textarea class="text_pole cs-textarea cs-mono" rows="2" value=${d[k] ?? ''} onInput=${e => set(k, e.currentTarget.value)} aria-label=${l}></textarea></${Field}>`)}
            </div>
            <div class="cs-row">
                <${Toggle} label="Wrap sequences with newlines" checked=${d.wrap ?? true} onChange=${v => set('wrap', v)} />
                <${Toggle} label="Replace macros in sequences" checked=${d.macro ?? true} onChange=${v => set('macro', v)} />
                <${Toggle} label="Skip example dialogues formatting" checked=${!!d.skip_examples} onChange=${v => set('skip_examples', v)} />
                <${Toggle} label="System same as user" checked=${!!d.system_same_as_user} onChange=${v => set('system_same_as_user', v)} />
                <${Toggle} label="Sequences as stop strings" checked=${d.sequences_as_stop_strings ?? true} onChange=${v => set('sequences_as_stop_strings', v)} />
                <${Select} label="Include names" value=${d.names_behavior ?? 'force'} options=${[{ value: 'none', label: 'Never' }, { value: 'force', label: 'Groups and past personas' }, { value: 'always', label: 'Always' }]} onChange=${v => set('names_behavior', v)} />
            </div>`;
    }
    if (pr.kind === 'context') {
        return html`<${TextArea} label="Story string (Handlebars)" value=${d.story_string ?? ''} onChange=${v => set('story_string', v)} rows=${12} mono counter=${env.countTokens}
                hint="Params: system, description, personality, persona, scenario, char, user, wiBefore/loreBefore, wiAfter/loreAfter, anchorBefore, anchorAfter, mesExamples, mesExamplesRaw; {{trim}} removes surrounding whitespace." />
            <div class="cs-grid">
                <${TextInput} label="Example separator" value=${d.example_separator ?? ''} onChange=${v => set('example_separator', v)} mono />
                <${TextInput} label="Chat start" value=${d.chat_start ?? ''} onChange=${v => set('chat_start', v)} mono />
                <${Select} label="Story string position" value=${d.story_string_position ?? 0} options=${[{ value: 0, label: 'Default (top of prompt)' }, { value: 1, label: 'In-chat @ depth' }]} onChange=${v => set('story_string_position', Number(v))} />
                <${NumberInput} label="Depth" value=${d.story_string_depth ?? 1} min=${0} onChange=${v => set('story_string_depth', v ?? 1)} />
                <${Select} label="Role" value=${d.story_string_role ?? 0} options=${[{ value: 0, label: 'System' }, { value: 1, label: 'User' }, { value: 2, label: 'Assistant' }]} onChange=${v => set('story_string_role', Number(v))} />
            </div>
            <div class="cs-row">
                <${Toggle} label="Use as stop strings" checked=${!!d.use_stop_strings} onChange=${v => set('use_stop_strings', v)} />
                <${Toggle} label="Names as stop strings" checked=${d.names_as_stop_strings ?? true} onChange=${v => set('names_as_stop_strings', v)} />
                <${Toggle} label="Always add character's name" checked=${d.always_force_name2 ?? true} onChange=${v => set('always_force_name2', v)} />
                <${Toggle} label="Trim incomplete sentences" checked=${!!d.trim_sentences} onChange=${v => set('trim_sentences', v)} />
                <${Toggle} label="Single line mode" checked=${!!d.single_line} onChange=${v => set('single_line', v)} />
            </div>
            <div class="cs-muted cs-small">always_force_name2, trim_sentences and single_line are stored in the template but apply globally in ST.</div>`;
    }
    if (pr.kind === 'sysprompt') {
        return html`<${TextArea} label="System prompt" value=${d.content ?? ''} onChange=${v => set('content', v)} rows=${10} counter=${env.countTokens} />
            <${TextArea} label="Post-history instructions (Text Completion)" value=${d.post_history ?? ''} onChange=${v => set('post_history', v)} rows=${4} counter=${env.countTokens} hint="Also the {{original}} for a card's post-history instructions." />`;
    }
    if (pr.kind === 'reasoning') {
        return html`<div class="cs-grid">
            <${Field} label="Prefix"><textarea class="text_pole cs-textarea cs-mono" rows="2" value=${d.prefix ?? ''} onInput=${e => set('prefix', e.currentTarget.value)}></textarea></${Field}>
            <${Field} label="Suffix"><textarea class="text_pole cs-textarea cs-mono" rows="2" value=${d.suffix ?? ''} onInput=${e => set('suffix', e.currentTarget.value)}></textarea></${Field}>
            <${Field} label="Separator"><textarea class="text_pole cs-textarea cs-mono" rows="2" value=${d.separator ?? ''} onInput=${e => set('separator', e.currentTarget.value)}></textarea></${Field}>
        </div>`;
    }
    // textgen samplers
    const other = Object.keys(d).filter(k => !TG_SAMPLERS.includes(k)).sort();
    return html`<div class="cs-grid">${TG_SAMPLERS.map(k => html`<${NumberInput} key=${k} label=${k} value=${d[k]} step=${0.01} onChange=${v => set(k, v)} />`)}</div>
        <${Section} title=${`Other keys (${other.length})`} open=${false}><table class="cs-table"><tbody>${other.map(k => html`<tr key=${k}><td><code>${k}</code></td><td class="cs-small">${JSON.stringify(d[k])?.slice(0, 160)}</td></tr>`)}</tbody></table></${Section}>
        <div class="cs-muted cs-small">Missing or null keys keep the user's current values when the preset is loaded (except extensions → {} and json_schema → null).</div>`;
}

// ------------------------------------------------------------------------------------ versions

function Versions({ store, project, pr, setData }) {
    const versions = pr.versions ?? [];
    const others = project.presets.filter(p => p.kind === pr.kind && p.id !== pr.id);
    const [against, setAgainst] = useState(versions.length ? `v:${versions[versions.length - 1].id}` : others[0] ? `p:${others[0].id}` : '');
    const base = against.startsWith('v:') ? versions.find(v => v.id === against.slice(2))?.data : against.startsWith('p:') ? findArtifact(project, 'presets', against.slice(2))?.data : null;
    const d = base ? (pr.kind === 'cc' ? diffCc(base, pr.data) : { settings: jsonDiff(base, pr.data), prompts: [], orderChanged: false }) : null;
    return html`<div class="cs-stack">
        <div class="cs-row"><${Select} label="Compare current with" value=${against} options=${[{ value: '', label: '—' }, ...versions.map(v => ({ value: `v:${v.id}`, label: `Version ${v.label} (${new Date(v.time).toLocaleString()})` })), ...others.map(o => ({ value: `p:${o.id}`, label: `Preset ${o.name}` }))]} onChange=${setAgainst} />
            ${against.startsWith('v:') && html`<${Button} icon="rotate-left" label="Restore this version" onClick=${() => setData(clone(base), 'Restored version')} />`}</div>
        ${!versions.length && html`<div class="cs-muted cs-small">No saved versions yet. Use “Save version” in the header before experimenting.</div>`}
        ${d && html`
            ${pr.kind === 'cc' && html`<${Section} title=${`Prompts (${d.prompts.length} changed)${d.orderChanged ? ' · order changed' : ''}`}>
                <table class="cs-table"><tbody>${d.prompts.map(x => html`<tr key=${x.id}><td>${x.name ?? x.id}</td><td><${Badge} kind=${x.kind === 'added' ? 'ok' : x.kind === 'removed' ? 'err' : 'warn'}>${x.kind}</${Badge}></td><td class="cs-small">${(x.fields ?? []).join(', ')}</td></tr>`)}</tbody></table>
            </${Section}>`}
            <${Section} title=${`Settings (${d.settings.length} changed)`}>
                <table class="cs-table"><tbody>${d.settings.map(x => html`<tr key=${x.path}><td><code>${x.path}</code></td><td class="cs-small">${JSON.stringify(x.before)?.slice(0, 80)}</td><td class="cs-small">→ ${JSON.stringify(x.after)?.slice(0, 80)}</td></tr>`)}</tbody></table>
            </${Section}>`}
    </div>`;
}

// ------------------------------------------------------------------------------------ publish

function PresetPublish({ store, env, pr }) {
    const apiId = KINDS[pr.kind].apiId;
    const [name, setName] = useState(pr.origin?.kind === 'st' ? pr.origin.name : pr.name);
    const [strip, setStrip] = useState(true);
    const [busy, setBusy] = useState(false);
    const payload = () => {
        let data = clone(pr.data);
        if (pr.kind === 'cc' && strip) data = stripSensitive(data);
        if (['instruct', 'context', 'sysprompt', 'reasoning'].includes(pr.kind)) data.name = name;
        return data;
    };
    const exportFile = () => downloadBlob(utf8Encode(JSON.stringify(payload(), null, 4)), `${name}.json`, 'application/json');
    const save = async () => {
        let exists = false;
        try { exists = listStPresets(apiId).includes(name); } catch { /* ignore */ }
        if (!(await env.confirm(`${exists ? 'Overwrite' : 'Create'} ${KINDS[pr.kind].label} "${name}" in SillyTavern?`, exists ? 'The current version is backed up and can be restored from the inspector.' : ''))) return;
        setBusy(true);
        try {
            const { backup, note } = await saveStPreset(apiId, name, payload());
            recordBackup(store, backup, `Saved ${KINDS[pr.kind].label} ${name} to SillyTavern`);
            env.toast(`Saved to SillyTavern. ${note}`, 'ok', 7000);
        } catch (e) { env.toast(`Save failed: ${e.message}`, 'error', 8000); } finally { setBusy(false); }
    };
    return html`
        <div class="cs-grid"><${TextInput} label="File / preset name" value=${name} onChange=${setName} /></div>
        ${pr.kind === 'cc' && html`<${Toggle} label="Strip sensitive connection fields (proxy, custom URL…)" checked=${strip} onChange=${setStrip} />`}
        <div class="cs-row">
            <${Button} icon="download" label="Export JSON" onClick=${exportFile} />
            <${Button} kind="primary" icon="upload" label="Save to SillyTavern…" onClick=${save} disabled=${busy || !name.trim()} />
        </div>
        <div class="cs-muted cs-small">Saved via /api/presets/save (apiId “${apiId}”). ${pr.kind === 'cc' ? 'Import in ST: AI Response Configuration → Import. ' : ''}${['instruct', 'context', 'sysprompt', 'reasoning'].includes(pr.kind) ? 'Templates are identified by their in-file name. ' : ''}SillyTavern lists newly saved presets after a reload.</div>`;
}
