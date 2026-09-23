// Regex laboratory: global, preset-scoped and character-scoped scripts in SillyTavern's engine order,
// stage-by-stage previews with fixtures (run in a worker with a timeout), lint, order conflicts, AI generation.
import {
    html, useState, useMemo, useEffect, useRef, Button, Icon, Badge, Tabs, TextInput, TextArea, Field, Section, Empty, Diagnostics,
    Modal, Toggle, NumberInput, Select, downloadBlob, pickFile, fileBytes, cx,
} from '../kit.js';
import { useAiTask, AiStatus, CreationRoute } from '../ai.js';
import { isHandsFree } from '../proposals.js';
import { findArtifact, editArtifactField, upsertArtifact, removeArtifact, logHistory } from '../../core/project.js';
import { defaultScript, PLACEMENT_LABEL, SUBSTITUTE_LABEL, STAGES, lintScripts, parseRegexImport, regexFromString, runRegexScript } from '../../core/regex.js';
import { clone, uid, utf8Decode, utf8Encode } from '../../core/bytes.js';
import { getStRegex, saveStGlobalRegex } from '../../st/live.js';
import { recordBackup } from '../inspector.js';

export const newRegexArtifact = name => ({ id: uid('rx'), scope: 'global', script: defaultScript(name) });

/** Collect every script in engine order with a locator describing where it is stored. */
function collect(project, { presetId, characterId }) {
    const out = [];
    for (const r of project.regexScripts) out.push({ scope: 'global', script: r.script, loc: { kind: 'global', id: r.id } });
    const pr = presetId ? findArtifact(project, 'presets', presetId) : null;
    (pr?.data?.extensions?.regex_scripts ?? []).forEach((s, i) => out.push({ scope: 'preset', script: s, loc: { kind: 'preset', id: pr.id, index: i } }));
    const ch = characterId ? findArtifact(project, 'characters', characterId) : null;
    (ch?.card?.data?.extensions?.regex_scripts ?? []).forEach((s, i) => out.push({ scope: 'character', script: s, loc: { kind: 'character', id: ch.id, index: i } }));
    return out;
}

function writeScript(store, loc, script, summary = 'Edited regex') {
    if (loc.kind === 'global') {
        store.update(p => editArtifactField(p, 'regexScripts', loc.id, 'script', script, { summary: `${summary}: ${script.scriptName}` }), 'edit regex');
    } else if (loc.kind === 'preset') {
        store.update(p => editArtifactField(p, 'presets', loc.id, `data.extensions.regex_scripts[${loc.index}]`, script, { summary: `${summary}: ${script.scriptName}` }), 'edit regex');
    } else {
        store.update(p => editArtifactField(p, 'characters', loc.id, `card.data.extensions.regex_scripts[${loc.index}]`, script, { summary: `${summary}: ${script.scriptName}` }), 'edit regex');
    }
}

function listPath(loc) {
    return loc.kind === 'preset' ? ['presets', 'data.extensions.regex_scripts'] : ['characters', 'card.data.extensions.regex_scripts'];
}

export function RegexArea({ store, env, project, selection, select }) {
    const [presetId, setPresetId] = useState(() => project.presets.find(p => p.kind === 'cc' && p.data?.extensions?.regex_scripts?.length)?.id ?? '');
    const [characterId, setCharacterId] = useState(() => project.characters.find(c => c.card.data.extensions?.regex_scripts?.length)?.id ?? project.characters[0]?.id ?? '');
    const all = useMemo(() => collect(project, { presetId, characterId }), [project.regexScripts, project.presets, project.characters, presetId, characterId]);
    const [selKey, setSelKey] = useState(() => (selection?.type === 'regexScripts' ? `global:${selection.id}` : ''));
    useEffect(() => { if (selection?.type === 'regexScripts') setSelKey(`global:${selection.id}`); }, [selection?.id]);
    const keyOf = x => `${x.loc.kind}:${x.loc.id}${x.loc.index != null ? `:${x.loc.index}` : ''}`;
    const cur = all.find(x => keyOf(x) === selKey) ?? all[0];
    const [tab, setTab] = useState('edit');
    const lint = useMemo(() => lintScripts(all), [all]);
    const [genOpen, setGenOpen] = useState(false);

    const addGlobal = (scripts, summary, actor = 'user') => {
        store.update(p => {
            let next = p;
            for (const s of scripts) next = upsertArtifact(next, 'regexScripts', { id: uid('rx'), scope: 'global', script: s }, { action: 'create', actor, summary: summary ?? `Added regex ${s.scriptName}` });
            return next;
        }, 'add regex');
    };
    const addScoped = (loc, scripts) => {
        const [type, path] = listPath(loc);
        const art = findArtifact(store.get(), type, loc.id);
        const listNow = (loc.kind === 'preset' ? art.data.extensions?.regex_scripts : art.card.data.extensions?.regex_scripts) ?? [];
        store.update(p => editArtifactField(p, type, loc.id, path, [...listNow, ...scripts], { summary: `Added ${scripts.length} ${loc.kind}-scoped regex` }), 'add regex');
    };
    const importFile = async target => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const scripts = parseRegexImport(JSON.parse(utf8Decode(await fileBytes(f))));
            if (!scripts.length) throw new Error('No scripts with a scriptName found');
            if (target === 'global') addGlobal(scripts, `Imported ${scripts.length} regex from ${f.name}`, 'import');
            else addScoped(target === 'preset' ? { kind: 'preset', id: presetId } : { kind: 'character', id: characterId }, scripts);
            env.toast(`Imported ${scripts.length} script(s); new ids assigned (as ST does).`, 'ok');
        } catch (e) { env.toast(`Import failed: ${e.message}`, 'error'); }
    };
    const pullSt = async () => {
        try {
            const st = getStRegex();
            const existing = new Set(project.regexScripts.map(r => r.script.id));
            const fresh = st.global.filter(s => !existing.has(s.id));
            addGlobal(fresh.map(clone), `Pulled ${fresh.length} global regex from SillyTavern`, 'import');
            env.toast(`Pulled ${fresh.length} global script(s)${st.scoped.length ? `; the open ST character also has ${st.scoped.length} scoped script(s) — pull that character to edit them` : ''}.`, 'ok', 7000);
        } catch (e) { env.toast(e.message, 'error'); }
    };
    const pushSt = async () => {
        const scripts = project.regexScripts.map(r => clone(r.script));
        if (!(await env.confirm(`Replace SillyTavern's global regex list with the project's ${scripts.length} global script(s)?`, 'The current ST list is backed up first and can be restored from the inspector.'))) return;
        try {
            const { backup, note } = await saveStGlobalRegex(scripts);
            recordBackup(store, backup, `Saved ${scripts.length} global regex to SillyTavern`);
            env.toast(`Saved. ${note}`, 'ok', 6000);
        } catch (e) { env.toast(e.message, 'error'); }
    };
    const exportAll = () => downloadBlob(utf8Encode(JSON.stringify(all.map(x => x.script), null, 4)), `regex-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');

    return html`<div class="cs-area-head">
            <h3><${Icon} name="code" /> Regex lab</h3>
            <div class="cs-spacer"></div>
            <${Button} icon="plus" label="Global script" onClick=${() => addGlobal([defaultScript('New regex')])} />
            <select class="text_pole" style="width:auto" aria-label="Import regex" onChange=${e => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v) importFile(v); }}>
                <option value="">Import…</option><option value="global">into Global</option>
                ${presetId && html`<option value="preset">into selected preset</option>`}${characterId && html`<option value="character">into selected character</option>`}
            </select>
            <${Button} icon="download" label="Export all" onClick=${exportAll} disabled=${!all.length} />
            <${Button} icon="plug" label="Pull ST global" onClick=${pullSt} />
            <${Button} icon="upload" label="Save global to ST…" onClick=${pushSt} disabled=${!project.regexScripts.length} />
            <${Button} kind="ai" icon="wand-magic-sparkles" label="Generate…" onClick=${() => setGenOpen(true)} />
        </div>
        <div class="cs-area-body">
            <div class="cs-row">
                <${Select} label="Active CC preset (preset-scoped scripts)" value=${presetId} options=${[{ value: '', label: 'None' }, ...project.presets.filter(p => p.kind === 'cc' || p.kind === 'textgen').map(p => ({ value: p.id, label: `${p.name} (${p.data?.extensions?.regex_scripts?.length ?? 0})` }))]} onChange=${setPresetId} />
                <${Select} label="Character (scoped scripts)" value=${characterId} options=${[{ value: '', label: 'None' }, ...project.characters.map(c => ({ value: c.id, label: `${c.card.data.name} (${c.card.data.extensions?.regex_scripts?.length ?? 0})` }))]} onChange=${setCharacterId} />
                ${characterId && html`<${Button} small icon="plus" label="Character script" onClick=${() => addScoped({ kind: 'character', id: characterId }, [{ ...defaultScript('New scoped regex') }])} />`}
                ${presetId && html`<${Button} small icon="plus" label="Preset script" onClick=${() => addScoped({ kind: 'preset', id: presetId }, [{ ...defaultScript('New preset regex') }])} />`}
            </div>
            <div class="cs-muted cs-small">SillyTavern runs scripts in this order: global, then preset-scoped (if allowed), then character-scoped (if allowed). Each script's output feeds the next. Scoped scripts need the user's permission on first use.</div>
            <div class="cs-split-3" style="grid-template-columns:minmax(260px,340px) minmax(0,1fr)">
                <${ScriptList} all=${all} cur=${cur} keyOf=${keyOf} setSelKey=${setSelKey} lint=${lint} store=${store} />
                <div class="cs-stack">
                    ${cur ? html`
                        <${Tabs} tabs=${[{ id: 'edit', label: 'Script', icon: 'pen' }, { id: 'test', label: 'Stage preview', icon: 'flask' }, { id: 'lint', label: 'Diagnostics', icon: 'stethoscope', badge: lint.filter(i => i.level !== 'info').length }]} active=${tab} onChange=${setTab} />
                        ${tab === 'edit' && html`<${ScriptEditor} store=${store} env=${env} project=${project} item=${cur} key=${keyOf(cur)} setSelKey=${setSelKey} />`}
                        ${tab === 'test' && html`<${StageBench} store=${store} project=${project} all=${all} cur=${cur} characterId=${characterId} />`}
                        ${tab === 'lint' && html`<${Diagnostics} items=${lint} />`}`
                        : html`<${Empty} icon="code" title="No regex scripts">Add a global script, import a file, pull from SillyTavern, or generate one from examples.</${Empty}>`}
                </div>
            </div>
        </div>
        ${genOpen && html`<${GenerateRegex} store=${store} env=${env} project=${project} onClose=${() => setGenOpen(false)} addGlobal=${addGlobal} />`}`;
}

function ScriptList({ all, cur, keyOf, setSelKey, lint, store }) {
    const flagged = new Set(lint.filter(i => i.level !== 'info').map(i => i.id));
    const groups = ['global', 'preset', 'character'];
    const moveGlobal = (id, d) => store.update(p => {
        const list = [...p.regexScripts];
        const i = list.findIndex(r => r.id === id);
        const j = i + d;
        if (i < 0 || j < 0 || j >= list.length) return p;
        [list[i], list[j]] = [list[j], list[i]];
        return logHistory({ ...p, regexScripts: list }, { action: 'reorder', summary: 'Reordered global regex' });
    }, 'reorder regex');
    return html`<div class="cs-stack">
        ${groups.map(g => {
            const items = all.filter(x => x.scope === g);
            return html`<div key=${g}><div class="cs-small cs-muted" style="text-transform:uppercase;letter-spacing:.05em">${g} (${items.length})</div>
                <ul class="cs-list">${items.map((x, i) => html`<li key=${keyOf(x)} class=${cx('cs-list-item', cur && keyOf(cur) === keyOf(x) && 'active', x.script.disabled && 'disabled')} onClick=${() => setSelKey(keyOf(x))}>
                    <span class="cs-muted cs-small" style="min-width:18px">${all.indexOf(x) + 1}</span>
                    <span class="cs-grow" title=${x.script.scriptName}>${x.script.scriptName || '(unnamed)'}</span>
                    ${flagged.has(x.script.id) && html`<${Icon} name="triangle-exclamation" />`}
                    <span class="cs-kind" title="Mode">${x.script.markdownOnly && x.script.promptOnly ? 'D+P' : x.script.markdownOnly ? 'D' : x.script.promptOnly ? 'P' : 'S'}</span>
                    ${g === 'global' && html`<span class="cs-row" style="gap:0"><button class="cs-btn cs-btn-sm" aria-label="Move up" onClick=${e => { e.stopPropagation(); moveGlobal(x.loc.id, -1); }}>↑</button><button class="cs-btn cs-btn-sm" aria-label="Move down" onClick=${e => { e.stopPropagation(); moveGlobal(x.loc.id, 1); }}>↓</button></span>`}
                </li>`)}</ul></div>`;
        })}
        <div class="cs-small cs-muted">Mode: D = display only, P = prompt only, D+P = both, S = rewrites stored chat text.</div>
    </div>`;
}

function ScriptEditor({ store, env, project, item, setSelKey }) {
    const s = item.script;
    const set = (patch, summary) => writeScript(store, item.loc, { ...s, ...patch }, summary);
    const re = useMemo(() => regexFromString(s.findRegex || '(?:)'), [s.findRegex]);
    const remove = () => {
        if (item.loc.kind === 'global') store.update(p => removeArtifact(p, 'regexScripts', item.loc.id, { summary: `Removed regex ${s.scriptName}` }), 'remove regex');
        else {
            const [type, path] = listPath(item.loc);
            const art = findArtifact(store.get(), type, item.loc.id);
            const list = (item.loc.kind === 'preset' ? art.data.extensions.regex_scripts : art.card.data.extensions.regex_scripts).filter((_, i) => i !== item.loc.index);
            store.update(p => editArtifactField(p, type, item.loc.id, path, list, { summary: `Removed regex ${s.scriptName}` }), 'remove regex');
        }
        setSelKey('');
    };
    const exportOne = () => downloadBlob(utf8Encode(JSON.stringify(s, null, 4)), `regex-${(s.scriptName || 'script').replace(/[^\w-]+/g, '_')}.json`, 'application/json');
    const mode = s.markdownOnly && s.promptOnly ? 'both' : s.markdownOnly ? 'display' : s.promptOnly ? 'prompt' : 'stored';
    return html`<div class="cs-stack">
        <div class="cs-row-between"><div class="cs-row"><${Badge} kind="accent">${item.scope}</${Badge}><${Toggle} label="Enabled" checked=${!s.disabled} onChange=${v => set({ disabled: !v }, 'Toggled regex')} /></div>
            <div class="cs-row"><${Button} small icon="download" label="Export" onClick=${exportOne} /><${Button} small icon="trash" kind="danger" label="Delete" onClick=${remove} /></div></div>
        <${TextInput} label="Script name" value=${s.scriptName} onChange=${v => set({ scriptName: v })} />
        <${TextInput} label="Find regex" value=${s.findRegex} onChange=${v => set({ findRegex: v })} mono hint=${re ? `Compiles as /${re.source}/${re.flags}${re.flags.includes('g') ? '' : ' — first match only (no g flag)'}` : 'Does not compile: SillyTavern will skip this script.'} />
        <${TextArea} label="Replace with" value=${s.replaceString} onChange=${v => set({ replaceString: v })} rows=${3} mono stats=${false} hint="{{match}} or $0 = whole match, $1… = groups, $<name> = named group, macros like {{char}} are expanded. $& and $$ are NOT special in ST." />
        <${TextInput} label="Trim out (comma-separated; removed from inserted groups only)" value=${(s.trimStrings ?? []).join(', ')} onChange=${v => set({ trimStrings: v.split(',').map(x => x.trim()).filter(Boolean) })} />
        <${Field} label="Affects">
            <div class="cs-row">${Object.entries(PLACEMENT_LABEL).map(([v, l]) => html`<${Toggle} key=${v} label=${l} checked=${(s.placement ?? []).includes(Number(v))} onChange=${on => set({ placement: on ? [...(s.placement ?? []), Number(v)].sort() : (s.placement ?? []).filter(x => x !== Number(v)) })} />`)}</div>
        </${Field}>
        <${Field} label="What it changes">
            <div class="cs-row">
                <${Toggle} label="Alter chat display (markdownOnly)" checked=${!!s.markdownOnly} onChange=${v => set({ markdownOnly: v })} />
                <${Toggle} label="Alter outgoing prompt (promptOnly)" checked=${!!s.promptOnly} onChange=${v => set({ promptOnly: v })} />
                <${Toggle} label="Run on edit" checked=${!!s.runOnEdit} onChange=${v => set({ runOnEdit: v })} />
            </div>
            <div class=${cx('cs-small', mode === 'stored' ? 'cs-warn-text' : 'cs-muted')}>${{ both: 'Display and prompt are altered; stored chat text is unchanged.', display: 'Only what the user sees changes; the model sees the original text.', prompt: 'Only what the model sees changes (and World Info content, if selected).', stored: 'Neither option: the script permanently rewrites messages as they are saved.' }[mode]}</div>
        </${Field}>
        <div class="cs-grid">
            <${Select} label="Macros in find regex" value=${Number(s.substituteRegex ?? 0)} options=${Object.entries(SUBSTITUTE_LABEL).map(([v, l]) => ({ value: v, label: l }))} onChange=${v => set({ substituteRegex: Number(v) })} />
            <${NumberInput} label="Min depth (blank = none)" value=${s.minDepth} min=${-1} onChange=${v => set({ minDepth: v })} />
            <${NumberInput} label="Max depth (blank = none)" value=${s.maxDepth} min=${0} onChange=${v => set({ maxDepth: v })} hint="0 = last message" />
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------- test bench

const DEFAULT_FIXTURE = { name: 'Sample', user: 'I open the door. (OOC: keep it short)', ai: '<think>They want tension.</think>*The hinge screams.* "Who\'s there?" **Mira** whispers.', wi: '', reasoning: '', depth: 0 };

function useWorkerPreview(payload) {
    const [state, setState] = useState({ status: 'idle' });
    const worker = useRef(null);
    const seq = useRef(0);
    useEffect(() => {
        const id = ++seq.current;
        let timer;
        try {
            worker.current?.terminate();
            worker.current = new Worker(new URL('../../core/regex-worker.js', import.meta.url), { type: 'module' });
            worker.current.onmessage = ev => { if (ev.data.id === id) { clearTimeout(timer); setState(ev.data.ok ? { status: 'ok', ...ev.data } : { status: 'error', error: ev.data.error }); } };
            worker.current.onerror = e => setState({ status: 'error', error: e.message ?? 'Worker error' });
            timer = setTimeout(() => {
                worker.current?.terminate();
                worker.current = null;
                setState({ status: 'timeout' });
            }, 2000);
            worker.current.postMessage({ id, ...payload });
            setState(s => ({ ...s, status: 'running' }));
        } catch (e) {
            setState({ status: 'error', error: e.message });
        }
        return () => clearTimeout(timer);
    }, [JSON.stringify(payload)]);
    useEffect(() => () => worker.current?.terminate(), []);
    return state;
}

function StageBench({ store, project, all, cur, characterId }) {
    const fixtures = project.regexFixtures?.length ? project.regexFixtures : [DEFAULT_FIXTURE];
    const [fi, setFi] = useState(0);
    const f = fixtures[Math.min(fi, fixtures.length - 1)];
    const setFixtures = list => store.update(p => ({ ...p, regexFixtures: list, modified: new Date().toISOString() }), 'edit fixtures');
    const setF = patch => setFixtures(fixtures.map((x, i) => (i === fi ? { ...x, ...patch } : x)));
    const charName = characterId ? findArtifact(project, 'characters', characterId)?.card.data.name : 'Char';
    const ordered = all.map(x => ({ scope: x.scope, script: x.script }));
    const state = useWorkerPreview({ ordered, fixtures: [f], depth: f.depth ?? 0, macroValues: { char: charName, user: 'User' }, conflicts: true });
    const m = state.results?.[0];
    const highlight = (text, id) => {
        const re = regexFromString(cur.script.findRegex || '(?!)');
        if (!re || !text) return text;
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        const parts = [];
        let last = 0;
        let mm;
        let n = 0;
        while ((mm = g.exec(text)) && n++ < 500) {
            if (mm[0] === '') { g.lastIndex++; continue; }
            parts.push(text.slice(last, mm.index), html`<mark class="cs-match">${mm[0]}</mark>`);
            last = mm.index + mm[0].length;
            if (!re.flags.includes('g')) break;
        }
        parts.push(text.slice(last));
        return parts;
    };
    return html`<div class="cs-stack">
        <div class="cs-row">
            ${fixtures.map((x, i) => html`<${Button} small key=${i} label=${x.name} ariaPressed=${i === fi} onClick=${() => setFi(i)} />`)}
            <${Button} small icon="plus" label="Fixture" onClick=${() => { setFixtures([...fixtures, { ...DEFAULT_FIXTURE, name: `Fixture ${fixtures.length + 1}` }]); setFi(fixtures.length); }} />
            ${fixtures.length > 1 && html`<${Button} small icon="trash" kind="danger" onClick=${() => { setFixtures(fixtures.filter((_, i) => i !== fi)); setFi(0); }} />`}
        </div>
        <div class="cs-grid">
            <${TextInput} label="Fixture name" value=${f.name} onChange=${v => setF({ name: v })} />
            <${NumberInput} label="Message depth (0 = last)" value=${f.depth ?? 0} min=${-1} onChange=${v => setF({ depth: v ?? 0 })} />
        </div>
        <${TextArea} label="User message" value=${f.user} onChange=${v => setF({ user: v })} rows=${2} stats=${false} />
        <${TextArea} label="AI message" value=${f.ai} onChange=${v => setF({ ai: v })} rows=${3} stats=${false} />
        <${Section} title="Other inputs (World Info, reasoning, slash output)" open=${!!(f.wi || f.reasoning || f.slash)}>
            <${TextArea} label="World Info content" value=${f.wi} onChange=${v => setF({ wi: v })} rows=${2} stats=${false} />
            <${TextArea} label="Reasoning" value=${f.reasoning} onChange=${v => setF({ reasoning: v })} rows=${2} stats=${false} />
            <${TextArea} label="Slash command output" value=${f.slash ?? ''} onChange=${v => setF({ slash: v })} rows=${2} stats=${false} />
        </${Section}>
        <div class="cs-small">Matches of “${cur.script.scriptName}” in the AI message: <span class="cs-pre" style="display:inline-block;padding:2px 6px">${highlight(f.ai, cur.script.id)}</span></div>
        ${state.status === 'timeout' && html`<div class="cs-err-text"><${Icon} name="hourglass-end" /> Preview stopped after 2 s: a pattern is too slow (possible catastrophic backtracking). SillyTavern would hang on this input too.</div>`}
        ${state.status === 'error' && html`<div class="cs-err-text">${state.error}</div>`}
        ${m && html`<table class="cs-table"><thead><tr><th>Stage</th><th>Result</th><th>Scripts applied</th></tr></thead><tbody>
            ${STAGES.map(st => {
                const r = m[st.id];
                if (!r) return null;
                const applied = r.trace.filter(t => t.applied && t.changed);
                const curTrace = r.trace.find(t => t.id === cur.script.id);
                return html`<tr key=${st.id}>
                    <td><strong>${st.label}</strong><div class="cs-muted cs-small">${st.note}</div></td>
                    <td class="cs-small" style="white-space:pre-wrap;max-width:460px">${r.output || html`<span class="cs-muted">(empty)</span>`}</td>
                    <td class="cs-small">${applied.map(t => html`<div>${t.name} <span class="cs-muted">(${t.scope})</span></div>`)}
                        ${curTrace && !curTrace.applied && html`<div class="cs-muted">“${cur.script.scriptName}” skipped: ${curTrace.reason}</div>`}</td>
                </tr>`;
            })}
        </tbody></table>`}
        ${state.conflicts?.length > 0 && html`<${Section} title=${`Order-sensitive pairs (${state.conflicts.length})`}>
            ${state.conflicts.map(c => html`<div class="cs-small cs-warn-text">“${c.a}” and “${c.b}” give different results if swapped (${c.stage}).</div>`)}
        </${Section}>`}
    </div>`;
}

// ---------------------------------------------------------------------------------------- AI

/** One-click goals for the regex jobs roleplayers need most. */
const REGEX_RECIPES = [
    { label: 'Hide <think> blocks', goal: 'Hide <think>…</think> reasoning blocks (and a dangling unclosed <think> at the end) from the chat display only.' },
    { label: 'Strip OOC notes', goal: 'Remove (OOC: …) and ((…)) out-of-character notes from what is sent to the model, keep them visible in chat.' },
    { label: 'Trim unfinished sentence', goal: 'Remove a trailing unfinished sentence (text after the last . ! ? … or closing quote) from AI replies.' },
    { label: 'Stop speaking for {{user}}', goal: 'Cut an AI reply at the point where the model starts writing lines for {{user}} (a new line beginning with {{user}}: or the user\'s name followed by a colon).' },
    { label: 'Bold dialogue (display)', goal: 'Display "quoted dialogue" in bold in the chat view only; do not change the stored text.' },
    { label: 'Hide HTML comments', goal: 'Hide <!-- … --> HTML comments from the chat display and from the prompt.' },
];

function GenerateRegex({ store, env, project, onClose, addGlobal }) {
    const [goal, setGoal] = useState('');
    const [samples, setSamples] = useState('');
    const ai = useAiTask(store);
    const [result, setResult] = useState(null);
    const [keep, setKeep] = useState(new Set());
    const run = async (g = goal) => {
        if (!g.trim()) return;
        setGoal(g);
        const r = await ai.run('regex.generate', { goal: g, samples });
        if (!r) return;
        if (isHandsFree(store.get())) {
            // Hands-free: add every script whose own test cases pass here; anything failing stays for a look.
            const passing = new Set(r.value.scripts.map((s, i) => (testsPass(s) ? i : -1)).filter(i => i >= 0));
            if (passing.size === r.value.scripts.length) { accept(r, passing); return; }
            if (passing.size) { accept(r, passing, false); env.toast(`Added ${passing.size} script(s) that passed their tests; ${r.value.scripts.length - passing.size} need a look.`, '', 7000); }
            const rest = new Set(r.value.scripts.map((_, i) => i).filter(i => !passing.has(i)));
            setResult({ ...r, value: { ...r.value, scripts: r.value.scripts.filter((_, i) => rest.has(i)) } });
            setKeep(new Set());
            return;
        }
        setResult(r);
        setKeep(new Set(r.value.scripts.map((_, i) => i)));
    };
    const accept = (res = result, keepSet = keep, close = true) => {
        const chosen = res.value.scripts.filter((_, i) => keepSet.has(i));
        const scripts = chosen.map(g => ({
            ...defaultScript(g.scriptName), findRegex: g.findRegex, replaceString: g.replaceString ?? '', trimStrings: g.trimStrings ?? [],
            placement: (g.placement ?? [2]).filter(p => [1, 2, 3, 5, 6].includes(p)), markdownOnly: !!g.markdownOnly, promptOnly: !!g.promptOnly,
            minDepth: g.minDepth ?? null, maxDepth: g.maxDepth ?? null,
        }));
        addGlobal(scripts, `Added ${scripts.length} AI regex script(s)`, 'ai');
        const fx = chosen.flatMap(g => (g.tests ?? []).map((t, i) => ({ name: `${g.scriptName} #${i + 1}`, user: '', ai: t.input, expected: t.expected, wi: '', reasoning: '', depth: 0 })));
        if (fx.length) store.update(p => ({ ...p, regexFixtures: [...(p.regexFixtures ?? []), ...fx] }), 'add fixtures');
        if (close) {
            env.toast(`Added ${scripts.length} regex script(s)${fx.length ? ` and ${fx.length} test fixture(s)` : ''}`, 'ok');
            onClose();
        }
    };
    return html`<${Modal} title="Generate regex scripts" onClose=${onClose} wide footer=${html`<${AiStatus} ai=${ai} /><${Button} label="Close" onClick=${onClose} />
        ${result ? html`<${Button} kind="primary" icon="check" label=${`Add ${keep.size} script(s)`} onClick=${() => accept()} disabled=${!keep.size} />` : html`<${Button} kind="ai" icon="wand-magic-sparkles" label="Generate" onClick=${() => run()} disabled=${ai.busy || !goal.trim()} />`}`}>
        <${CreationRoute} store=${store} project=${project} />
        <div class="cs-row cs-small"><span class="cs-muted">One click:</span>${REGEX_RECIPES.map(r => html`<${Button} small key=${r.label} kind="ai" label=${r.label} title=${r.goal} onClick=${() => run(r.goal)} disabled=${ai.busy} />`)}</div>
        <${TextArea} label="Or describe your own" value=${goal} onChange=${setGoal} rows=${3} stats=${false} placeholder="e.g. Hide <think> blocks from the chat display; strip (OOC: …) notes from what is sent to the model." />
        <${TextArea} label="Examples: before → after (optional)" value=${samples} onChange=${setSamples} rows=${4} stats=${false} />
        ${result && html`<table class="cs-table"><thead><tr><th></th><th>Script</th><th>Find → replace</th><th>Tests (checked here)</th></tr></thead><tbody>
            ${result.value.scripts.map((g, i) => {
                const script = { ...defaultScript(g.scriptName), ...g, placement: g.placement ?? [2] };
                // AI test inputs are short, so evaluating them here cannot meaningfully backtrack.
                const tests = (g.tests ?? []).map(t => {
                    let out = t.input;
                    try { out = runLocal(script, String(t.input).slice(0, 2000)); } catch { /* ignore */ }
                    return { ...t, got: out, pass: out === t.expected };
                });
                return html`<tr key=${i}>
                    <td><input type="checkbox" checked=${keep.has(i)} onChange=${() => { const n = new Set(keep); n.has(i) ? n.delete(i) : n.add(i); setKeep(n); }} aria-label=${`Keep ${g.scriptName}`} /></td>
                    <td><strong>${g.scriptName}</strong><div class="cs-muted cs-small">${g.explanation}</div><div class="cs-small">${g.markdownOnly ? 'display' : ''} ${g.promptOnly ? 'prompt' : ''} ${!g.markdownOnly && !g.promptOnly ? 'stored text' : ''} · ${(g.placement ?? []).map(p => PLACEMENT_LABEL[p] ?? p).join(', ')}</div></td>
                    <td class="cs-small"><code>${g.findRegex}</code> → <code>${g.replaceString}</code></td>
                    <td class="cs-small">${tests.map(t => html`<div class=${t.pass ? 'cs-ok-text' : 'cs-err-text'}>${t.pass ? '✓' : '✗'} ${t.input.slice(0, 50)} → ${JSON.stringify(t.got).slice(0, 60)}${t.pass ? '' : ` (expected ${JSON.stringify(t.expected).slice(0, 60)})`}</div>`)}</td>
                </tr>`;
            })}
        </tbody></table>`}
    </${Modal}>`;
}

function runLocal(script, text) {
    return runRegexScript({ ...script, disabled: false }, text).output;
}

/** True when a generated script passes all of its own (short) test cases; scripts without tests count as passing. */
function testsPass(g) {
    const script = { ...defaultScript(g.scriptName), ...g, placement: g.placement ?? [2] };
    try {
        return (g.tests ?? []).every(t => runLocal(script, String(t.input).slice(0, 2000)) === t.expected);
    } catch { return false; }
}
