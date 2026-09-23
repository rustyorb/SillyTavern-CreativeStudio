// Playtest workspace: representative openings and short conversations, run in a studio sandbox (project artifacts,
// your chosen connection profile) or captured from the live SillyTavern chat, with the configuration recorded for each run.
import { html, useState, useMemo, useRef, Button, Icon, Badge, TextInput, TextArea, Section, Empty, Modal, Toggle, Select, NumberInput, cx, roughTokens } from '../kit.js';
import { AiStatus, useAiTask } from '../ai.js';
import { findArtifact, upsertArtifact, removeArtifact, logHistory } from '../../core/project.js';
import { buildSandboxTurn, processReply, newPlaytestRecord, newScenario } from '../../core/playtest.js';
import { runChat, describeRoute, listProfiles, AiError } from '../../ai/gateway.js';
import { stContext } from '../../st/env.js';
import { activeConfiguration, dryRunPrompt } from '../../st/live.js';
import { readStWorldInfoSettings } from '../../st/env.js';
import { clone, uid } from '../../core/bytes.js';

export function PlaytestArea({ store, env, project, select }) {
    const [characterId, setCharacterId] = useState(project.characters[0]?.id ?? '');
    const [presetId, setPresetId] = useState(project.presets.find(p => p.kind === 'cc')?.id ?? '');
    const [profileId, setProfileId] = useState(project.settings?.roleplayProfileId ?? '');
    const [scenarioId, setScenarioId] = useState(project.playtestScenarios?.[0]?.id ?? '');
    const [greeting, setGreeting] = useState(0);
    const [maxTokens, setMaxTokens] = useState(350);
    const [useEmbedded, setUseEmbedded] = useState(false);
    const [run, setRun] = useState(null); // live record being built
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [err, setErr] = useState('');
    const [inspect, setInspect] = useState(null);
    const [compare, setCompare] = useState([]);
    const abort = useRef(null);
    const userAi = useAiTask(store);
    const ch = characterId ? findArtifact(project, 'characters', characterId) : null;
    const scenarios = project.playtestScenarios ?? [];
    const scenario = scenarios.find(s => s.id === scenarioId) ?? null;
    let ctx = null;
    try { ctx = stContext(); } catch { /* offline */ }
    const profiles = ctx ? listProfiles(ctx) : [];
    const route = ctx ? describeRoute(ctx, profileId) : { ok: false, label: 'SillyTavern not available' };
    const greetings = ch ? [ch.card.data.first_mes, ...(ch.card.data.alternate_greetings ?? [])].filter(g => g != null) : [];

    const setScenarios = list => store.update(p => ({ ...p, playtestScenarios: list, modified: new Date().toISOString() }), 'edit scenarios');
    const cfgBase = () => ({ characterId, presetId, user: ctx?.name1 || 'User', persona: '', useEmbeddedBook: useEmbedded });

    const start = async () => {
        if (!ch) return;
        const wi = await readStWorldInfoSettings();
        const base = { ...cfgBase(), wiSettings: wi ?? undefined };
        const g = processReply(project, base, greetings[greeting] ?? '').stored;
        const probe = buildSandboxTurn(project, { ...base, chat: [{ role: 'assistant', text: g }] });
        const rec = newPlaytestRecord(scenario, { ...probe.config, route: { label: route.label, profileName: route.profileName ?? '', api: route.api, model: route.model }, greetingIndex: greeting, maxTokens });
        rec.transcript = [{ role: 'assistant', text: g, display: processReply(project, base, g).display, note: `greeting #${greeting}` }];
        rec.base = base;
        setRun(rec);
        setErr('');
    };

    const runRef = useRef(null);
    runRef.current = run;
    const turn = async userText => {
        const run = runRef.current;
        if (!run || !userText.trim()) return false;
        setBusy(true);
        setErr('');
        const ac = new AbortController();
        abort.current = ac;
        try {
            const transcript = [...run.transcript, { role: 'user', text: userText }];
            const t = buildSandboxTurn(project, { ...run.base, chat: transcript.map(m => ({ role: m.role, text: m.text })) });
            setStatus(`Sending ${t.messages.length} messages (≈${t.messages.reduce((s, m) => s + roughTokens(m.content), 0)} tokens) via ${route.label}…`);
            const r = await runChat(stContext(), { messages: t.messages, profileId, maxTokens, signal: ac.signal });
            const pr = processReply(project, run.base, r.text);
            const next = { ...run, transcript: [...transcript, { role: 'assistant', text: pr.stored, display: pr.display, raw: r.text, activatedLore: t.config.activatedLore, promptMessages: t.messages, durationMs: r.meta.durationMs }] };
            runRef.current = next;
            setRun(next);
            setStatus(`Reply in ${(r.meta.durationMs / 1000).toFixed(1)}s`);
            return true;
        } catch (e) {
            setErr(e instanceof AiError ? e.message : String(e?.message ?? e));
            setStatus('');
            return false;
        } finally { setBusy(false); abort.current = null; }
    };

    const autoUser = async () => {
        const transcript = runRef.current.transcript.map(m => `${m.role === 'user' ? 'User' : ch.card.data.name}: ${m.text}`).join('\n\n');
        const r = await userAi.run('playtest.user-turn', { transcript: transcript.slice(-6000) });
        if (r) await turn(r.value.message);
    };

    const runScenario = async () => {
        if (!scenario) return;
        for (const u of scenario.userTurns) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await turn(u))) break;
        }
    };

    const save = () => {
        const rec = clone(run);
        delete rec.base;
        rec.transcript = rec.transcript.map(m => ({ ...m, promptMessages: undefined }));
        store.update(p => logHistory({ ...p, playtests: [...p.playtests, rec], modified: new Date().toISOString() }, { action: 'playtest', target: { type: 'characters', id: characterId }, summary: `Saved playtest (${rec.transcript.length} messages)` }), 'save playtest');
        env.toast('Playtest saved with its configuration', 'ok');
    };

    const capture = async () => {
        try {
            const c = stContext();
            const cfg = activeConfiguration();
            let prompt = null;
            try { prompt = await dryRunPrompt(); } catch { prompt = null; }
            const rec = newPlaytestRecord(scenario, { mode: 'st-capture', ...cfg, dryRun: prompt ? { messages: prompt.messages?.length ?? 0, tokens: roughTokens(JSON.stringify(prompt.messages ?? prompt.text)) } : null });
            rec.transcript = (c.chat ?? []).filter(m => !m.is_system).slice(-40).map(m => ({ role: m.is_user ? 'user' : 'assistant', text: m.mes, name: m.name }));
            rec.stPrompt = prompt?.messages ?? prompt?.text ?? null;
            store.update(p => logHistory({ ...p, playtests: [...p.playtests, rec] }, { actor: 'st', action: 'playtest-capture', summary: `Captured SillyTavern chat (${rec.transcript.length} messages) with its configuration` }), 'capture playtest');
            env.toast('Captured the current SillyTavern chat and configuration', 'ok');
        } catch (e) { env.toast(e.message, 'error'); }
    };

    return html`<div class="cs-area-head">
            <h3><${Icon} name="flask" /> Playtest</h3>
            <div class="cs-spacer"></div>
            <${Button} icon="camera" label="Capture current ST chat" title="Store the open SillyTavern chat with the active API, model, presets and the dry-run prompt" onClick=${capture} />
        </div>
        <div class="cs-area-body">
            ${!project.characters.length ? html`<${Empty} icon="flask" title="Add a character first" />` : html`
            <div class="cs-split">
                <div class="cs-stack">
                    <${Section} title="Setup">
                        <div class="cs-grid">
                            <${Select} label="Character" value=${characterId} options=${project.characters.map(c => ({ value: c.id, label: c.card.data.name }))} onChange=${v => { setCharacterId(v); setRun(null); }} />
                            <${Select} label="Greeting" value=${greeting} options=${greetings.map((g, i) => ({ value: i, label: `${i === 0 ? 'First message' : `Alternate #${i}`}: ${String(g).slice(0, 40)}` }))} onChange=${v => setGreeting(Number(v))} />
                            <${Select} label="Prompt preset (project)" value=${presetId} options=${[{ value: '', label: 'Default prompts' }, ...project.presets.filter(p => p.kind === 'cc').map(p => ({ value: p.id, label: p.name }))]} onChange=${setPresetId} />
                            <${Select} label="Connection profile" value=${profileId} options=${[{ value: '', label: 'Main connection' }, ...profiles.map(p => ({ value: p.id, label: p.name }))]} onChange=${v => { setProfileId(v); store.update(p => ({ ...p, settings: { ...p.settings, roleplayProfileId: v } }), 'roleplay profile'); }} />
                            <${NumberInput} label="Max reply tokens" value=${maxTokens} min=${16} onChange=${v => setMaxTokens(v ?? 350)} />
                            <${Toggle} label="Scan embedded lorebook" checked=${useEmbedded} onChange=${setUseEmbedded} title="Only if users will import the card's book in ST" />
                        </div>
                        <div class="cs-small ${route.ok ? 'cs-muted' : 'cs-err-text'}">${route.label}. The sandbox builds the prompt from project artifacts (card, linked lore activation, preset prompts, prompt-stage regex); it does not touch SillyTavern chats.</div>
                        <div class="cs-row"><${Button} kind="primary" icon="play" label=${run ? 'Restart' : 'Start playtest'} onClick=${start} disabled=${!ch || busy} /></div>
                    </${Section}>
                    <${ScenarioEditor} scenarios=${scenarios} setScenarios=${setScenarios} scenarioId=${scenarioId} setScenarioId=${setScenarioId} characterId=${characterId} />
                </div>
                <div class="cs-stack">
                    ${run ? html`<${Section} title=${`Conversation · ${run.transcript.length} messages`} right=${html`<${Button} small icon="floppy-disk" label="Save run" onClick=${save} disabled=${busy} />`}>
                        <${ChatView} run=${run} charName=${ch?.card.data.name} setInspect=${setInspect} />
                        <${Composer} busy=${busy || userAi.busy} onSend=${turn} onAuto=${autoUser} onScenario=${scenario ? runScenario : null} onCancel=${() => abort.current?.abort()} />
                        <div class="cs-ai-status">${busy && html`<span class="cs-spin"><${Icon} name="spinner" /></span>`}${status}</div>
                        <${AiStatus} ai=${userAi} />
                        ${err && html`<div class="cs-err-text">${err}</div>`}
                    </${Section}>` : html`<${Empty} icon="comments" title="No run in progress">Pick a setup and start. Each reply records the prompt it was built from.</${Empty}>`}
                </div>
            </div>
            <${Runs} store=${store} project=${project} compare=${compare} setCompare=${setCompare} />`}
        </div>
        ${inspect && html`<${Modal} title="Prompt sent for this reply" onClose=${() => setInspect(null)} wide>
            ${inspect.activatedLore?.length > 0 && html`<div class="cs-small">Activated lore: ${inspect.activatedLore.map(a => html`<${Badge}>${a.comment || `#${a.uid}`}</${Badge}> `)}</div>`}
            ${(inspect.promptMessages ?? []).map((m, i) => html`<div key=${i} class=${cx('cs-pblock', `cs-pblock-${m.role}`)}><div class="cs-pblock-head"><strong>${m.role}</strong><span>≈${roughTokens(m.content)} tok</span></div><div class="cs-pblock-body">${m.content}</div></div>`)}
            ${inspect.raw && inspect.raw !== inspect.text && html`<${Section} title="Raw model output (before regex)"><pre class="cs-pre">${inspect.raw}</pre></${Section}>`}
        </${Modal}>`}`;
}

function ChatView({ run, charName, setInspect }) {
    return html`<div class="cs-chat" style="max-height:52vh;overflow:auto">${run.transcript.map((m, i) => html`<div key=${i} class=${cx('cs-msg', m.role === 'user' ? 'cs-msg-user' : 'cs-msg-assistant')}>
        <div class="cs-msg-head"><strong>${m.role === 'user' ? 'User' : m.name ?? charName}</strong>${m.note ? html`<span>${m.note}</span>` : ''}${m.durationMs ? html`<span>${(m.durationMs / 1000).toFixed(1)}s</span>` : ''}
            ${m.activatedLore?.length ? html`<span title=${m.activatedLore.map(a => a.comment).join(', ')}><${Icon} name="book" /> ${m.activatedLore.length}</span>` : ''}
            ${m.promptMessages && html`<a href="#" onClick=${e => { e.preventDefault(); setInspect(m); }}>prompt</a>`}</div>
        <div>${m.display ?? m.text}</div>
    </div>`)}</div>`;
}

function Composer({ busy, onSend, onAuto, onScenario, onCancel }) {
    const [text, setText] = useState('');
    const send = () => { const t = text; setText(''); onSend(t); };
    return html`<div class="cs-stack">
        <textarea class="text_pole cs-textarea" rows="2" placeholder="Your message (Ctrl+Enter to send)" value=${text} onInput=${e => setText(e.currentTarget.value)} aria-label="User message"
            onKeyDown=${e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}></textarea>
        <div class="cs-row">
            <${Button} kind="primary" icon="paper-plane" label="Send" onClick=${send} disabled=${busy || !text.trim()} />
            <${Button} kind="ai" icon="user-astronaut" label="AI plays user" onClick=${onAuto} disabled=${busy} />
            ${onScenario && html`<${Button} icon="forward" label="Run scenario turns" onClick=${onScenario} disabled=${busy} />`}
            ${busy && html`<${Button} icon="stop" label="Cancel" onClick=${onCancel} />`}
        </div>
    </div>`;
}

function ScenarioEditor({ scenarios, setScenarios, scenarioId, setScenarioId, characterId }) {
    const cur = scenarios.find(s => s.id === scenarioId);
    const set = patch => setScenarios(scenarios.map(s => (s.id === scenarioId ? { ...s, ...patch } : s)));
    return html`<${Section} title=${`Scenarios (${scenarios.length})`} right=${html`<${Button} small icon="plus" label="Scenario" onClick=${() => { const s = newScenario(`Scenario ${scenarios.length + 1}`, characterId); setScenarios([...scenarios, s]); setScenarioId(s.id); }} />`}>
        ${scenarios.length ? html`<div class="cs-row">${scenarios.map(s => html`<${Button} small key=${s.id} label=${s.name} ariaPressed=${s.id === scenarioId} onClick=${() => setScenarioId(s.id)} />`)}</div>` : html`<div class="cs-muted cs-small">Scenarios are scripted user turns you can replay against different versions of the card, lore or preset.</div>`}
        ${cur && html`<${TextInput} label="Name" value=${cur.name} onChange=${v => set({ name: v })} />
            <${TextArea} label="User turns (one per line)" value=${cur.userTurns.join('\n')} onChange=${v => set({ userTurns: v.split('\n').filter(x => x.trim()) })} rows=${5} stats=${false} />
            <${TextArea} label="What to look for" value=${cur.notes} onChange=${v => set({ notes: v })} rows=${2} stats=${false} />
            <${Button} small icon="trash" kind="danger" label="Delete scenario" onClick=${() => { setScenarios(scenarios.filter(s => s.id !== scenarioId)); setScenarioId(''); }} />`}
    </${Section}>`;
}

function Runs({ store, project, compare, setCompare }) {
    const runs = [...project.playtests].reverse();
    const toggle = id => setCompare(compare.includes(id) ? compare.filter(x => x !== id) : [...compare, id].slice(-2));
    const setRun = (id, patch) => store.update(p => ({ ...p, playtests: p.playtests.map(r => (r.id === id ? { ...r, ...patch } : r)) }), 'edit playtest');
    const picked = compare.map(id => project.playtests.find(r => r.id === id)).filter(Boolean);
    return html`<${Section} title=${`Recorded runs (${runs.length})`}>
        ${runs.length ? html`<table class="cs-table"><thead><tr><th></th><th>When</th><th>Mode</th><th>Configuration</th><th>Msgs</th><th>Rating</th><th>Notes</th></tr></thead><tbody>
            ${runs.map(r => html`<tr key=${r.id}>
                <td><input type="checkbox" checked=${compare.includes(r.id)} onChange=${() => toggle(r.id)} aria-label="Compare" /></td>
                <td class="cs-small">${new Date(r.time).toLocaleString()}<div class="cs-muted">${r.scenarioName}</div></td>
                <td>${r.config.mode === 'st-capture' ? html`<${Badge} kind="accent">ST capture</${Badge}>` : html`<${Badge}>sandbox</${Badge}>`}</td>
                <td class="cs-small">${configSummary(r.config)}</td>
                <td>${r.transcript.length}</td>
                <td><select class="text_pole" value=${r.rating} onChange=${e => setRun(r.id, { rating: Number(e.currentTarget.value) })} aria-label="Rating">${[0, 1, 2, 3, 4, 5].map(n => html`<option value=${n} selected=${n === r.rating}>${n ? '★'.repeat(n) : '—'}</option>`)}</select></td>
                <td><input class="text_pole" value=${r.notes} onInput=${e => setRun(r.id, { notes: e.currentTarget.value })} aria-label="Notes" /></td>
            </tr>`)}
        </tbody></table>` : html`<div class="cs-muted cs-small">Saved runs appear here with the model, profile, preset, activated lore and regex used, so results can be reproduced.</div>`}
        ${picked.length === 2 && html`<div class="cs-split">${picked.map(r => html`<div key=${r.id} class="cs-stack"><div class="cs-small"><strong>${new Date(r.time).toLocaleString()}</strong> · ${configSummary(r.config)}</div>
            <div class="cs-chat">${r.transcript.map((m, i) => html`<div key=${i} class=${cx('cs-msg', m.role === 'user' ? 'cs-msg-user' : 'cs-msg-assistant')}>${m.display ?? m.text}</div>`)}</div></div>`)}</div>`}
    </${Section}>`;
}

function configSummary(c) {
    if (c.mode === 'st-capture') return `${c.mainApi}${c.model ? ` · ${c.model}` : ''}${c.connectionProfile ? ` · profile ${c.connectionProfile.name}` : ''} · CC preset ${c.presets?.openai || '—'} · ${c.character}`;
    return `${c.route?.profileName || c.route?.label || ''}${c.route?.model ? ` · ${c.route.model}` : ''} · preset ${c.preset?.name}${c.preset?.hash ? ` #${c.preset.hash.slice(0, 6)}` : ''} · card #${c.character?.cardHash?.slice(0, 6)} · lore ${c.lorebooks?.length ?? 0} book(s) · regex ${c.regex?.length ?? 0}`;
}
