// Project assembly: overview, health, relationships/dependencies, publish bundle, deliberate apply-to-SillyTavern plan.
import { html, useState, useMemo, useEffect, Button, Icon, Badge, TextInput, TextArea, Section, Empty, Diagnostics, Modal, Toggle, Select, downloadBlob, pickFile, cx } from '../kit.js';
import { dependencyReport, artifactName, findArtifact, logHistory, createProject, cardForSt, stWorldName, newCharacter, upsertArtifact } from '../../core/project.js';
import { validateCardV3 } from '../../core/card.js';
import { lintWorld } from '../../core/lorebook.js';
import { lintCc } from '../../core/preset.js';
import { lintScripts } from '../../core/regex.js';
import { lintSet } from '../../core/qr.js';
import { buildBundle } from '../../core/bundle.js';
import { exportCard } from '../../core/cardio.js';
import { zipSync } from '../../../vendor/fflate.mjs';
import { mediaBytes, toPngBytes } from '../media.js';
import { applyCardToSt, importIntoSt, saveStWorld, saveStPreset, saveStGlobalRegex, getStCharacter, listStWorlds, listStPresets } from '../../st/live.js';
import { installQrSetLive } from '../../st/stscript-live.js';
import { recordBackup } from '../inspector.js';
import { KINDS, stripSensitive } from '../../core/preset.js';
import { clone } from '../../core/bytes.js';
import { Generator } from '../generator.js';
import { CARD_FILES, importAnyFile, openCardImport } from '../importer.js';
import { openPullPicker } from '../st-pull.js';
import { CharacterLibrary } from '../character-library.js';
const AREA_FOR_TYPE = { characters: 'characters', lorebooks: 'lore', presets: 'prompts', regexScripts: 'regex', qrSets: 'scripts', media: 'characters' };

export function ProjectArea({ store, env, project, select, setArea }) {
    const [publishOpen, setPublishOpen] = useState(false);
    const [applyOpen, setApplyOpen] = useState(false);
    const [generating, setGenerating] = useState(() => !!project.generationDraft || (project.generationRuns ?? []).some(r => r.status === 'running'));
    const [query, setQuery] = useState('');
    const set = (k, v, label) => store.update(p => logHistory({ ...p, [k]: v, modified: new Date().toISOString() }, { action: 'edit', path: k, summary: label }), `edit ${k}`);
    const health = useMemo(() => projectHealth(project), [project]);
    const deps = useMemo(() => dependencyReport(project), [project]);
    const newBlank = () => {
        const c = newCharacter('New character');
        store.update(p => upsertArtifact(p, 'characters', c, { action: 'create', summary: 'Created a character' }), 'create character');
        select('characters', c.id);
    };
    const activeRuns = (project.generationRuns ?? []).filter(r => r.status !== 'discarded');
    const showGenerator = generating;
    const hasItems = ['characters', 'lorebooks', 'presets', 'regexScripts', 'qrSets'].some(k => project[k].length);
    const characters = project.characters.filter(c => `${c.card.data.name} ${(c.card.data.tags ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    // A project or bundle opens; a character card is imported into this project and opened.
    const openFile = async () => {
        const f = await pickFile(`.zip,${CARD_FILES}`);
        if (!f) return;
        const r = await importAnyFile(store, env, f);
        if (r.character) select('characters', r.character.id);
    };
    return html`<div class="cs-area-body cs-home">
            <div class="cs-home-heading"><div><h1>${project.characters.length ? 'Pick up your story.' : 'What would you like to create?'}</h1>
                <p>${project.characters.length ? 'Your characters, world and pictures are together here. Choose a character to keep working.' : 'Start with an idea or a character you already have. You can add the rest as you go.'}</p></div>
                <${Button} icon="upload" label="Use in SillyTavern…" disabled=${!hasItems} title="Review the project before applying it to SillyTavern" onClick=${() => setApplyOpen(true)} />
            </div>
            <div class="cs-start-actions" aria-label="Start creating">
                <button class="cs-start-action" onClick=${() => openCardImport()}><${Icon} name="file-import" /><strong>Import a card</strong><span>Open a PNG, CHARX or JSON character.</span></button>
                <button class="cs-start-action" onClick=${openPullPicker}><${Icon} name="user-plus" /><strong>From SillyTavern</strong><span>Improve a copy of a character you own.</span></button>
                <button class="cs-start-action" onClick=${newBlank}><${Icon} name="pen-nib" /><strong>Write a character</strong><span>A blank page, with help when you want it.</span></button>
                <button class=${cx('cs-start-action', 'cs-start-ai', showGenerator && 'active')} aria-expanded=${showGenerator} onClick=${() => setGenerating(!generating)}><${Icon} name="wand-magic-sparkles" /><strong>Generate with AI</strong><span>${activeRuns.length ? 'Create something new or review generation progress.' : 'Turn a rough idea into a playable story.'}</span></button>
            </div>
            ${showGenerator && html`<${Generator} store=${store} env=${env} project=${project} select=${select} />`}
            <div class="cs-home-section-title"><h2>${project.characters.length ? `Your characters (${project.characters.length})` : 'Your first character starts here'}</h2>
                ${project.characters.length > 3 && html`<input class="text_pole" aria-label="Find a character" placeholder="Find a character…" value=${query} onInput=${e => setQuery(e.currentTarget.value)} />`}
            </div>
            ${project.characters.length ? html`<${CharacterLibrary} project=${project} characters=${characters} select=${select} />${!characters.length && html`<p class="cs-muted">No characters match “${query}”. Try another name.</p>`}` : html`
                <div class="cs-first-path"><div><span>1</span><strong>Bring in or create a character</strong><p>Choose any starting point above.</p></div><div><span>2</span><strong>Make it yours</strong><p>Write the basics and an opening. Pictures and lore are optional.</p></div><div><span>3</span><strong>Try it, then take it to chat</strong><p>Test a conversation or export to SillyTavern when you’re ready.</p></div></div>`}
            <div class="cs-home-tools">
                <${Button} icon="book-atlas" label=${`World · ${project.lorebooks.length} lorebooks`} onClick=${() => setArea('lore')} />
                <${Button} icon="images" label=${`Pictures · ${project.media.length}`} onClick=${() => setArea('media')} />
                <${Button} icon="flask" label="Try a conversation" onClick=${() => setArea('playtest')} disabled=${!project.characters.length} />
                <span class="cs-muted cs-small">Autosaved in the studio. Apply to SillyTavern when you choose.</span>
            </div>
            <${Section} title="Project details & notes" open=${false}>
                <${TextInput} label="Project name" value=${project.name} onChange=${v => set('name', v, 'Renamed project')} />
                <${TextArea} label="Story premise" value=${project.premise ?? ''} onChange=${v => set('premise', v, 'Edited premise')} rows=${4} stats=${false} hint="Shared background for AI writing throughout this project." />
                <${TextArea} label="Your notes" value=${project.notes ?? ''} onChange=${v => set('notes', v, 'Edited notes')} rows=${3} stats=${false} />
                <div class="cs-row"><${Button} icon="file-import" label="Open project or bundle…" onClick=${openFile} /><${Button} icon="box-archive" label="Download project bundle…" onClick=${() => setPublishOpen(true)} /></div>
            </${Section}>
            <${Section} title=${`Project checks${health.length ? ` · ${health.length} to review` : ' · no issues found'}`} open=${false}>
                <${Diagnostics} items=${health} onPick=${d => d.target && select(d.target.type, d.target.id)} />
            </${Section}>
            ${deps.length > 0 && html`<${Section} title="Linked items & dependencies" open=${false}>
                ${deps.length ? html`<table class="cs-table"><thead><tr><th>Character</th><th>Expects</th><th>Missing</th></tr></thead><tbody>
                    ${deps.map(d => html`<tr key=${d.characterId}>
                        <td><a href="#" onClick=${e => { e.preventDefault(); select('characters', d.characterId); }}>${d.name}</a></td>
                        <td>${d.needs.length ? d.needs.map(n => html`<span title=${n.how}><${Badge}>${n.type === 'extension-data' ? '🧩 ' : ''}${n.name}</${Badge}> </span>`) : html`<span class="cs-muted">nothing extra</span>`}</td>
                        <td>${d.missing.length ? html`<span class="cs-err-text">${d.missing.join(', ')}</span>` : '—'}</td>
                    </tr>`)}
                </tbody></table>` : html`<${Empty} icon="diagram-project" title="No characters yet">Relationships appear once characters link lorebooks, presets, regex and Quick Reply sets.</${Empty}>`}
                <div class="cs-muted cs-small">Hover a dependency to see how it gets installed. Link items from each character's Lore tab, the Quick Reply set links, or character-scoped regex.</div>
            </${Section}>`}
        </div>
        ${publishOpen && html`<${PublishModal} store=${store} env=${env} project=${project} onClose=${() => setPublishOpen(false)} />`}
        ${applyOpen && html`<${ApplyPlan} store=${store} env=${env} project=${project} onClose=${() => setApplyOpen(false)} />`}`;
}

export function projectHealth(project) {
    const out = [];
    for (const c of project.characters) for (const i of validateCardV3(c.card).filter(x => x.level !== 'info')) out.push({ ...i, path: `${c.card.data.name}: ${i.path}`, target: { type: 'characters', id: c.id } });
    for (const lb of project.lorebooks) for (const i of lintWorld(lb.data).filter(x => x.level !== 'info')) out.push({ ...i, path: `${lb.name} ${i.path}`, target: { type: 'lorebooks', id: lb.id } });
    for (const pr of project.presets.filter(p => p.kind === 'cc')) for (const i of lintCc(pr.data).filter(x => x.level !== 'info')) out.push({ ...i, path: `${pr.name}: ${i.path}`, target: { type: 'presets', id: pr.id } });
    for (const i of lintScripts(project.regexScripts.map(r => ({ scope: 'global', script: r.script }))).filter(x => x.level !== 'info')) out.push({ ...i, path: `regex ${i.path}`, target: { type: 'regexScripts', id: project.regexScripts.find(r => r.script.id === i.id)?.id } });
    const setNames = project.qrSets.map(s => s.data.name);
    for (const s of project.qrSets) for (const i of lintSet(s.data, { setNames }).filter(x => x.level !== 'info')) out.push({ ...i, path: `${s.data.name} ${i.path}`, target: { type: 'qrSets', id: s.id } });
    for (const d of dependencyReport(project)) for (const m of d.missing) out.push({ level: 'error', path: d.name, message: `Linked item ${m} no longer exists`, target: { type: 'characters', id: d.characterId } });
    return out;
}

async function characterImages(env, project) {
    const images = {};
    const assets = {};
    for (const c of project.characters) {
        const m = c.avatarMediaId ? findArtifact(project, 'media', c.avatarMediaId) : null;
        if (m) images[c.id] = await toPngBytes(await mediaBytes(env, m));
        const files = {};
        for (const [path, mid] of Object.entries(c.assetFiles ?? {})) {
            const mm = findArtifact(project, 'media', mid);
            if (mm) files[path] = await mediaBytes(env, mm);
        }
        assets[c.id] = files;
    }
    return { images, assets };
}

function PublishModal({ store, env, project, onClose }) {
    const [cardFormat, setCardFormat] = useState('png-v3');
    const [includeCharx, setIncludeCharx] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const health = projectHealth(project).filter(h => h.level === 'error');
    const build = async () => {
        setBusy(true);
        try {
            const { images, assets } = await characterImages(env, project);
            const b = buildBundle(project, { cardFormat, includeCharx, images, assetFiles: assets });
            const zip = zipSync(Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, [v, { level: /\.(png|charx)$/.test(k) ? 0 : 6 }]])));
            downloadBlob(zip, `${project.name.replace(/[^\w.-]+/g, '_')}-bundle.zip`, 'application/zip');
            setResult(b);
            store.update(p => logHistory(p, { action: 'publish', summary: `Published bundle (${Object.keys(b.files).length} files)` }), 'publish');
        } catch (e) { env.toast(`Bundle failed: ${e.message}`, 'error', 8000); } finally { setBusy(false); }
    };
    return html`<${Modal} title="Publish project bundle" onClose=${onClose} wide footer=${html`<${Button} label="Close" onClick=${onClose} /><${Button} kind="primary" icon="box-archive" label="Build & download zip" onClick=${build} disabled=${busy} />`}>
        <div>The bundle holds SillyTavern-native files (cards, World Info, presets and templates, regex, Quick Reply sets), a <code>manifest.json</code> describing how they relate, a <code>README.md</code> with installation steps in order, and <code>project.studio.json</code> to reopen the project here.</div>
        ${health.length > 0 && html`<div class="cs-warn-text"><${Icon} name="triangle-exclamation" /> ${health.length} error(s) in the project. You can still publish; see Health.</div>`}
        <div class="cs-grid">
            <${Select} label="Character card format" value=${cardFormat} options=${[{ value: 'png-v3', label: 'PNG: spec V3 (ccv3) + V2 fallback (chara)' }, { value: 'png-st', label: 'PNG: SillyTavern-style (same data in both chunks)' }]} onChange=${setCardFormat} />
            <${Toggle} label="Also include CHARX copies (embedded assets)" checked=${includeCharx} onChange=${setIncludeCharx} />
        </div>
        ${result && html`<${Section} title=${`Built: ${Object.keys(result.files).length} files`}>
            <ul class="cs-small">${Object.keys(result.files).sort().map(f => html`<li key=${f}><code>${f}</code></li>`)}</ul>
            ${result.notes.length > 0 && html`<div class="cs-small cs-muted">${result.notes.map(n => html`<div>• ${n}</div>`)}</div>`}
        </${Section}>`}
    </${Modal}>`;
}

/** Plan every live write, let the author untick items, then run them in order with backups. */
function ApplyPlan({ store, env, project, onClose }) {
    const [plan, setPlan] = useState(null);
    const [skip, setSkip] = useState(new Set());
    const [log, setLog] = useState([]);
    const [running, setRunning] = useState(false);
    useEffect(() => { (async () => {
        const items = [];
        const worlds = await listStWorlds().catch(() => []);
        for (const pr of project.presets) {
            const exists = (() => { try { return listStPresets(KINDS[pr.kind].apiId).includes(pr.origin?.name ?? pr.name); } catch { return false; } })();
            items.push({ key: `pre:${pr.id}`, label: `${exists ? 'Overwrite' : 'Create'} ${KINDS[pr.kind].label} “${pr.origin?.name ?? pr.name}”`, run: async () => {
                let data = clone(pr.data);
                if (pr.kind === 'cc') data = stripSensitive(data);
                if (['instruct', 'context', 'sysprompt', 'reasoning'].includes(pr.kind)) data.name = pr.origin?.name ?? pr.name;
                const r = await saveStPreset(KINDS[pr.kind].apiId, pr.origin?.name ?? pr.name, data);
                return { backup: r.backup, note: r.note };
            } });
        }
        for (const lb of project.lorebooks) {
            const name = stWorldName(lb);
            items.push({ key: `lb:${lb.id}`, label: `${worlds.includes(name) ? 'Overwrite' : 'Create'} World Info “${name}”`, run: async () => {
                const data = clone(lb.data);
                delete data.originalData;
                return saveStWorld(name, data);
            } });
        }
        for (const c of project.characters) {
            const linked = c.origin?.kind === 'st' ? c.origin.avatar : c.stAvatar;
            items.push({ key: `ch:${c.id}`, label: linked ? `Update character ${c.card.data.name} (${linked})` : `Create character ${c.card.data.name}`, run: async () => {
                if (linked) {
                    const r = await applyCardToSt(linked, cardForSt(project, c), c.topLevelExtras);
                    return { backup: r.backup, note: r.fidelity.length ? `${r.fidelity.length} field difference(s) after save` : 'verified' };
                }
                const m = c.avatarMediaId ? findArtifact(project, 'media', c.avatarMediaId) : null;
                const image = m ? await toPngBytes(await mediaBytes(env, m)) : null;
                const avatar = await importIntoSt(exportCard('png-v3', { card: cardForSt(project, c), topLevelExtras: c.topLevelExtras, image }).bytes, 'png', `${c.card.data.name}.png`);
                store.update(p => ({ ...p, characters: p.characters.map(x => (x.id === c.id ? { ...x, stAvatar: avatar } : x)) }), 'link ST character');
                return { note: `created ${avatar}` };
            } });
        }
        if (project.regexScripts.length) items.push({ key: 'rx:global', label: `Replace ST global regex with ${project.regexScripts.length} project script(s)`, run: () => saveStGlobalRegex(project.regexScripts.map(r => clone(r.script))) });
        for (const s of project.qrSets) items.push({ key: `qr:${s.id}`, label: `Install Quick Reply set “${s.data.name}” (ST asks before replacing)`, run: async () => {
            const r = await installQrSetLive(clone(s.data));
            if (!r.ok) throw new Error(r.error);
            return { note: 'installed' };
        } });
        setPlan(items);
    })(); }, []);
    const run = async () => {
        setRunning(true);
        await env.storage.saveSnapshot(store.get(), 'Before apply to SillyTavern', 'auto').catch(() => {});
        const out = [];
        for (const item of plan) {
            if (skip.has(item.key)) { out.push({ label: item.label, status: 'skipped' }); continue; }
            try {
                const r = await item.run();
                if (r?.backup) recordBackup(store, r.backup, item.label);
                out.push({ label: item.label, status: 'ok', note: r?.note ?? '' });
            } catch (e) { out.push({ label: item.label, status: 'error', note: e.message }); }
            setLog([...out]);
        }
        setRunning(false);
    };
    return html`<${Modal} title="Apply project to SillyTavern" onClose=${onClose} wide footer=${html`<${Button} label="Close" onClick=${onClose} /><${Button} kind="primary" icon="upload" label=${`Run ${plan ? plan.length - skip.size : 0} step(s)`} onClick=${run} disabled=${!plan || running || log.length > 0} />`}>
        <div>Each step overwrites or creates data in the running SillyTavern. A project snapshot is taken first, and every overwritten item is backed up (Inspector → Snapshots → Live backups).</div>
        ${!plan ? html`<div class="cs-muted">Planning…</div>` : html`<table class="cs-table"><tbody>${plan.map(item => {
            const res = log.find(l => l.label === item.label);
            return html`<tr key=${item.key} class=${skip.has(item.key) ? 'cs-miss' : ''}>
                <td><input type="checkbox" checked=${!skip.has(item.key)} disabled=${running || log.length > 0} onChange=${() => { const n = new Set(skip); n.has(item.key) ? n.delete(item.key) : n.add(item.key); setSkip(n); }} aria-label=${item.label} /></td>
                <td>${item.label}</td>
                <td>${res ? html`<${Badge} kind=${res.status === 'ok' ? 'ok' : res.status === 'error' ? 'err' : ''}>${res.status}</${Badge}> <span class="cs-small">${res.note}</span>` : ''}</td>
            </tr>`;
        })}</tbody></table>`}
        ${plan && !plan.length && html`<${Empty} title="Nothing to apply" />`}
    </${Modal}>`;
}
