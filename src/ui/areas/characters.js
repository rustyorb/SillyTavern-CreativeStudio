// Character & scenario workshop: ideation, V3 editing with AI proposals, compatibility, import/export, live ST.
import {
    html, useState, useMemo, useEffect, Button, Icon, Badge, Tabs, TextInput, TextArea, StringList, TagsInput, Field,
    Section, Empty, Diagnostics, Modal, Toggle, NumberInput, Select, downloadBlob, pickFile, fileBytes, cx,
} from '../kit.js';
import { useAiTask, AiStatus, CreationRoute } from '../ai.js';
import { pushProposals, PendingFor, isHandsFree } from '../proposals.js';
import { startGeneration, developCharacter, isRunning, missingSteps } from '../generator.js';
import { openPullPicker } from '../st-pull.js';
import { useAiAssist } from '../ai-assist.js';
import { characterContext } from '../field-context.js';
import { newRun } from '../../ai/pipeline.js';
import {
    findArtifact, editArtifactField, upsertArtifact, newCharacter, logHistory, acceptProposal, rejectProposal, cardForSt,
    removeCharacter, isUntouchedBlank,
} from '../../core/project.js';
import { validateCardV3, splitExamples, joinExamples, fieldStats, emptyCardV3, tidyExamples } from '../../core/card.js';
import { cardFeatureUsage, STATUS_LABEL } from '../../core/compat.js';
import { exportCard, EXPORT_KINDS, withSpriteAssets } from '../../core/cardio.js';
import { CARD_FIELDS, FIELD_LABELS, tidyTags } from '../../ai/tasks.js';
import { characterBookToWorld, worldToCharacterBook, normalizeWorld } from '../../core/lorebook.js';
import { clone, uid } from '../../core/bytes.js';
import { importIntoSt, applyCardToSt, getStCharacter } from '../../st/live.js';
import { jsonDiff } from '../../core/diff.js';
import { saveMedia, mediaBytes, toPngBytes } from '../media.js';
import { recordBackup } from '../inspector.js';
import { openCardImport } from '../importer.js';
import { MediaView } from './media.js';
import { CharacterPictures } from '../character-pictures.js';
import { CHARACTER_TABS, TAB_HELP, characterProgress } from '../../core/workflow.js';
import { CharacterLibrary } from '../character-library.js';
import { navigateStudio } from '../guide.js';

export function CharactersArea(props) {
    const { project, selection } = props;
    // A picture that is no longer in this project (removed, or another project opened) leaves the Characters page.
    if (selection?.type === 'media' && findArtifact(project, 'media', selection.id)) return html`<${MediaView} ...${props} key=${selection.id} />`;
    const ch = selection?.type === 'characters' ? findArtifact(project, 'characters', selection.id) : null;
    if (ch) return html`<${CharacterEditor} ...${props} ch=${ch} key=${ch.id} />`;
    return html`<${CharacterHome} ...${props} />`;
}

// ============================================================================================ home

function CharacterHome({ store, env, project, select }) {
    const [query, setQuery] = useState('');
    const add = (art, summary) => {
        store.update(p => upsertArtifact(p, 'characters', art, { action: 'create', actor: art.origin?.kind === 'import' ? 'import' : 'user', summary }), 'create character');
        select('characters', art.id);
    };
    const chars = project.characters;
    return html`<div class="cs-area-head">
            <h3><${Icon} name="user-pen" /> Characters & scenarios</h3>
            <div class="cs-spacer"></div>
            <${Button} icon="user-plus" label="New character" onClick=${() => add(newCharacter('New character'), 'New character')} />
            <${Button} icon="masks-theater" label="New scenario" title="Scenario / narrator card" onClick=${() => add(newCharacter('New scenario', null, { kind: 'scenario' }), 'New scenario')} />
            <${Button} icon="file-import" label="Import card…" title="A character card: PNG, CHARX or JSON. You can also drop a card anywhere on the studio." onClick=${() => openCardImport()} />
            <${Button} icon="user-plus" label="From SillyTavern…" title="Bring in one of your SillyTavern characters with its lorebook and sprites" onClick=${openPullPicker} />
        </div>
        <div class="cs-area-body">
            <p class="cs-page-intro">Choose a character to keep writing. Start with the basics; add world details, pictures and extra tools when you need them.</p>
            ${chars.length > 0 && html`<input class="text_pole cs-library-search" aria-label="Find a character" placeholder="Find a character…" value=${query} onInput=${e => setQuery(e.currentTarget.value)} />`}
            <${CharacterLibrary} project=${project} characters=${chars.filter(c => c.card.data.name.toLowerCase().includes(query.toLowerCase()))} select=${select} />
            ${chars.length > 0 && !chars.some(c => c.card.data.name.toLowerCase().includes(query.toLowerCase())) && html`<p class="cs-muted">No matching characters.</p>`}
            ${!chars.length && html`<${Empty} icon="user-pen" title="Bring your first character in">Use Import card for a file, From SillyTavern for an existing character, or New character to write your own.</${Empty}>`}
            <${Ideation} store=${store} env=${env} project=${project} select=${select} />
        </div>`;
}

// -------------------------------------------------------------------------------------- ideation

function Ideation({ store, env, project, select }) {
    const [premise, setPremise] = useState(project.premise ?? '');
    const [constraints, setConstraints] = useState('');
    const [count, setCount] = useState(4);
    const ai = useAiTask(store);
    const pending = project.proposals.filter(p => p.task === 'character.ideate' && p.status === 'pending');
    const run = async () => {
        store.update(p => (p.premise === premise ? p : { ...p, premise }), 'edit premise');
        const r = await ai.run('character.ideate', { premise, constraints, count });
        if (!r) return;
        const group = uid('grp');
        pushProposals(store, r.value.candidates.map(c => ({
            task: 'character.ideate',
            title: `Concept: ${c.name}`,
            group,
            target: { type: 'characters', id: null },
            after: conceptToCharacter(c),
            rationale: c.hook,
            generation: r.generation,
        })), 'AI concepts', { forceReview: true });
    };
    const buildAll = () => {
        store.update(p => (p.premise === premise ? p : { ...p, premise }), 'edit premise');
        startGeneration(store, env, newRun({ idea: [premise, constraints].filter(Boolean).join('\n'), dials: project.lastDials ?? {} }));
        env.toast('Building the whole roleplay: follow progress in Project → Generate.', 'ok', 6000);
    };
    return html`<${Section} title="Need an idea? Explore character concepts with AI" open=${false} right=${html`<${CreationRoute} store=${store} project=${project} compact />`}>
        <${TextArea} label="Premise" value=${premise} onChange=${setPremise} rows=${3} stats=${false}
            placeholder="A rough idea: setting, tone, the kind of story you want to play, rating, anything you already know…" />
        <div class="cs-row">
            <input class="text_pole" style="flex:1;min-width:200px" placeholder="Constraints (optional): e.g. SFW, no magic, second person greetings…" value=${constraints} onInput=${e => setConstraints(e.currentTarget.value)} aria-label="Constraints" />
            <select class="text_pole" style="width:auto" value=${count} onChange=${e => setCount(Number(e.currentTarget.value))} aria-label="How many concepts">
                ${[2, 3, 4, 5, 6].map(n => html`<option value=${n} selected=${n === count}>${n} concepts</option>`)}
            </select>
            <${Button} kind="ai" icon="wand-magic-sparkles" label="Show me concepts" onClick=${run} disabled=${ai.busy} />
            <${Button} kind="ai" icon="bolt" label="Just build it for me" title="Premise → character → openings → lore → preset → regex → Quick Replies → image prompts → self-polish" onClick=${buildAll} />
        </div>
        <${AiStatus} ai=${ai} />
        ${pending.length > 0 && html`<div class="cs-cands">${pending.map(p => html`<${ConceptCard} key=${p.id} store=${store} env=${env} proposal=${p} select=${select} />`)}</div>`}
    </${Section}>`;
}

function conceptToCharacter(c) {
    const card = emptyCardV3(c.name);
    card.data.tags = tidyTags(c.tags);
    const art = newCharacter(c.name, card);
    art.concept = c;
    return art;
}

function ConceptCard({ store, env, proposal, select }) {
    const c = proposal.after.concept ?? {};
    const accept = () => {
        store.update(p => acceptProposal(p, proposal.id), 'accept concept');
        select('characters', proposal.after.id);
        // Hands-free: developing a concept builds the whole character around it.
        if (isHandsFree(store.get())) developCharacter(store, env, proposal.after.id);
    };
    const reject = () => store.update(p => rejectProposal(p, proposal.id), 'reject concept');
    return html`<div class="cs-cand">
        <div class="cs-row-between"><h5>${c.name}</h5><${Badge} kind="accent">concept</${Badge}></div>
        <div>${c.hook}</div>
        <dl>
            <dt>Voice</dt><dd>${c.voice}${c.sample_lines?.length ? html`<br /><em>${c.sample_lines.map(l => `“${l}”`).join(' ')}</em>` : ''}</dd>
            <dt>Contradiction</dt><dd>${c.contradiction}</dd>
            <dt>Motive</dt><dd>${c.motive}${c.secret ? html`<br /><span class="cs-muted">Secret: ${c.secret}</span>` : ''}</dd>
            <dt>Dynamic</dt><dd>${c.dynamic}</dd>
            <dt>Pressure</dt><dd>${c.pressure}</dd>
            <dt>Openings</dt><dd>${(c.openings ?? []).map(o => html`<div>• ${o}</div>`)}</dd>
            ${c.replay && html`<dt>Replay</dt><dd>${c.replay}</dd>`}
        </dl>
        <div class="cs-row">
            <${Button} small kind="primary" icon="check" label=${isHandsFree(store.get()) ? 'Build this one' : 'Develop this'} title="Creates the character and generates everything around it" onClick=${accept} />
            <${Button} small kind="danger" icon="xmark" label="Discard" onClick=${reject} />
        </div>
    </div>`;
}

// ============================================================================================ editor

const EDITOR_TABS = CHARACTER_TABS;

function CharacterEditor(props) {
    const { store, env, project, ch } = props;
    const tab = EDITOR_TABS.some(t => t.id === props.selection?.tab) ? props.selection.tab : 'core';
    const setTab = next => props.setSelection({ type: 'characters', id: ch.id, tab: next });
    const [advanced, setAdvanced] = useState(false);
    const progress = characterProgress(ch);
    const d = ch.card.data;
    const setPath = (path, value, summary) => store.update(p => editArtifactField(p, 'characters', ch.id, path, value, { summary }), `edit ${path}`);
    const setData = (field, value) => setPath(`card.data.${field}`, value, `Edited ${CARD_FIELDS[field] ?? field}`);
    const issues = useMemo(() => validateCardV3(ch.card), [ch.card]);
    const pendingCount = project.proposals.filter(p => p.status === 'pending' && p.target.id === ch.id).length;
    const avatar = ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null;
    const tabs = EDITOR_TABS.map(t => ({ ...t, badge: t.id === 'compat' ? issues.filter(i => i.level === 'error').length : t.id === 'greetings' ? 1 + (d.alternate_greetings?.length ?? 0) : undefined }));
    const remove = async () => {
        const pictures = project.media.length - removeCharacter(project, ch.id).media.length;
        const also = pictures === 1 ? ' The picture only it uses goes too.' : pictures > 1 ? ` The ${pictures} pictures only it uses go too.` : '';
        if (!(await env.confirm(`Remove ${d.name} from the project?`, `Nothing in SillyTavern is deleted.${also} You can undo with Ctrl+Z.`))) return;
        store.update(p => removeCharacter(p, ch.id), 'remove character');
        props.setSelection(null);
    };
    const ep = { ...props, setData, setPath, d, setTab };
    const byline = [ch.kind === 'scenario' ? 'Scenario' : 'Character', d.character_version && `v${d.character_version}`, d.creator && `by ${d.creator}`, d.nickname && `“${d.nickname}”`].filter(Boolean).join(' · ');
    return html`<div class="cs-area-head cs-entity-head" style=${avatar ? `background-image:url("${avatar.url}")` : ''}>
            <${Button} small icon="arrow-left" title="Back to characters" onClick=${() => props.setSelection(null)} />
            ${avatar ? html`<img src=${avatar.url} alt="" width="46" height="46" style="border-radius:6px;object-fit:cover;border:1px solid var(--cs-line)" />`
                : html`<div class="cs-monogram" aria-hidden="true">${monogram(d.name)}</div>`}
            <div class="cs-entity-title"><h3>${d.name || '(unnamed)'}</h3><span class="cs-byline">${byline}</span></div>
            ${ch.origin?.kind === 'st' && html`<${Badge} kind="accent" title=${`A copy of ${ch.origin.avatar} from SillyTavern`}>ST</${Badge}>`}
            ${pendingCount > 0 && html`<${Badge} kind="accent">${pendingCount} pending</${Badge}>`}
            <div class="cs-spacer"></div>
            <${CreationRoute} store=${store} project=${project} compact />
            <${Button} small icon="trash" kind="danger" label="Delete character" title="Remove this character from the project" onClick=${remove} />
        </div>
        <${Tabs} tabs=${tabs.filter(t => !t.advanced)} active=${tab} onChange=${setTab} right=${html`<${Button} small icon="sliders" label="Advanced" ariaPressed=${advanced || EDITOR_TABS.find(t => t.id === tab)?.advanced} onClick=${() => { setAdvanced(!advanced); if (EDITOR_TABS.find(t => t.id === tab)?.advanced) setTab('core'); }} />`} />
        ${(advanced || EDITOR_TABS.find(t => t.id === tab)?.advanced) && html`<${Tabs} tabs=${tabs.filter(t => t.advanced)} active=${tab} onChange=${setTab} />`}
        <div class="cs-area-body">
            ${TAB_HELP[tab] && html`<p class="cs-page-intro">${TAB_HELP[tab]}</p>`}
            <div class="cs-character-progress" aria-label="Character basics">
                ${progress.steps.map(step => html`<button class=${cx('cs-progress-step', step.done && 'is-done')} onClick=${() => setTab(step.tab)} title=${`${step.label}: ${step.done ? 'written' : 'still to write'}`}><${Icon} name=${step.done ? 'circle-check' : 'circle'} />${step.label}</button>`)}
                <span class="cs-spacer"></span>
                ${progress.ready ? html`<${Button} small icon="flask" label="Try a conversation" onClick=${() => navigateStudio({ area: 'playtest', selection: { type: 'characters', id: ch.id } })} />` : html`<span class="cs-muted cs-small">${progress.complete} of ${progress.total} basics written</span>`}
            </div>
            ${isUntouchedBlank(ch, project) && html`<div class="cs-blank-hint" role="note">
                <${Icon} name="file-import" />
                <span>This ${ch.kind === 'scenario' ? 'scenario' : 'character'} is empty. Have a card already? Import it in place of this one, or fill in the fields below.</span>
                <${Button} small kind="primary" icon="file-import" label="Import card…" onClick=${() => openCardImport({ replaceId: ch.id })} />
            </div>`}
            ${ch.concept && tab === 'core' && html`<${ConceptPanel} ...${ep} />`}
            ${tab === 'core' && html`<${CoreTab} ...${ep} />`}
            ${tab === 'greetings' && html`<${GreetingsTab} ...${ep} />`}
            ${tab === 'examples' && html`<${ExamplesTab} ...${ep} />`}
            ${tab === 'prompts' && html`<${PromptsTab} ...${ep} />`}
            ${tab === 'lore' && html`<${LoreTab} ...${ep} />`}
            ${tab === 'images' && html`<${CharacterPictures} ...${ep} />`}
            ${tab === 'meta' && html`<${MetaTab} ...${ep} />`}
            ${tab === 'extensions' && html`<${ExtensionsTab} ...${ep} />`}
            ${tab === 'compat' && html`<${CompatTab} ...${ep} issues=${issues} />`}
            ${tab === 'publish' && html`<${PublishTab} ...${ep} />`}
        </div>`;
}

/**
 * A card text field with the same AI controls whether it is empty or not: say what you want, then Add to it (every
 * word already there stays), Rewrite, or compare 3 takes. Earlier fields are explicit, selectable context.
 */
function AiField({ store, env, project, ch, field, label, rows = 6, hint, d, setData, singleLine = false, renderEditor }) {
    const cardNow = () => store.get().characters.find(c => c.id === ch.id)?.card ?? ch.card;
    const context = characterContext({ store, project, ch, field });
    const assist = useAiAssist({
        store, project, label, value: d[field],
        target: { type: 'characters', id: ch.id, path: `card.data.${field}` },
        current: () => cardNow().data[field],
        rewrite: { id: 'character.rewrite-field', args: (instruction, count) => ({ ...context.args(), instruction, count }) },
        add: { id: 'character.extend-field', args: instruction => ({ ...context.args(), instruction }) },
        tidy: text => (field === 'mes_example' ? tidyExamples(text, ch.card.data.name) : singleLine ? text.replace(/\s+/g, ' ').trim() : text),
        emptyHint: `What should the ${label.toLowerCase()} say? (the checked fields below provide context)`,
        contextPanel: context.panel,
    });
    const actions = html`<span class="cs-muted">${fieldStats(d[field]).words}w</span>${assist.actions}`;
    return html`<div class="cs-stack" ref=${assist.ref} data-card-field=${field}>
        ${renderEditor ? renderEditor(actions) : singleLine ? html`<${TextInput} label=${label} value=${d[field]} onChange=${v => setData(field, v)} hint=${hint} meta=${actions} />`
            : html`<${TextArea} label=${label} value=${d[field]} onChange=${v => setData(field, v)} rows=${rows} hint=${hint} counter=${env.countTokens} actions=${actions} />`}
        ${assist.panel}
        ${assist.status}
        <${PendingFor} store=${store} project=${project} type="characters" id=${ch.id} path=${`card.data.${field}`} />
    </div>`;
}

function ConceptPanel({ store, env, project, ch }) {
    const c = ch.concept;
    const ai = useAiTask(store);
    const [style, setStyle] = useState('');
    const expand = async () => {
        const r = await ai.run('character.expand', { concept: c, card: ch.card, voiceDirection: ch.voiceDirection, style });
        if (!r) return;
        const group = uid('grp');
        const specs = [];
        for (const [field, value] of Object.entries(r.value.fields ?? {})) {
            if (value == null || (Array.isArray(value) && !value.length) || value === '') continue;
            specs.push({ task: 'character.expand', title: `Draft ${FIELD_LABELS[field] ?? field}`, group, target: { type: 'characters', id: ch.id, path: `card.data.${field}` }, after: field === 'mes_example' ? tidyExamples(value, ch.card.data.name) : field === 'tags' ? tidyTags(value) : value, rationale: r.value.rationale, generation: r.generation });
        }
        const applied = pushProposals(store, specs, 'AI draft fields');
        env.toast(applied.length ? `Wrote ${applied.length} fields (undo with Ctrl+Z)` : `${specs.length} field drafts ready for review in the inspector`, 'ok');
    };
    return html`<${Section} title="Concept" right=${html`<${Button} small icon="xmark" title="Hide concept notes" onClick=${() => store.update(p => editArtifactField(p, 'characters', ch.id, 'concept', undefined, { summary: 'Removed concept notes' }), 'remove concept')} />`}>
        <div class="cs-cand" style="border:none;padding:0">
            <div><strong>${c.hook}</strong></div>
            <dl>
                <dt>Voice</dt><dd>${c.voice}</dd><dt>Contradiction</dt><dd>${c.contradiction}</dd><dt>Motive</dt><dd>${c.motive}</dd>
                ${c.secret && html`<dt>Secret</dt><dd>${c.secret}</dd>`}<dt>Dynamic</dt><dd>${c.dynamic}</dd><dt>Pressure</dt><dd>${c.pressure}</dd>
                <dt>Openings</dt><dd>${(c.openings ?? []).join(' · ')}</dd>
            </dl>
        </div>
        <div class="cs-row">
            <input class="text_pole" style="flex:1" placeholder="Style notes for the draft (optional): POV, length, formatting…" value=${style} onInput=${e => setStyle(e.currentTarget.value)} aria-label="Style notes" />
            <${Button} kind="ai" icon="wand-magic-sparkles" label="Draft card fields" onClick=${expand} disabled=${ai.busy} />
        </div>
        <${AiStatus} ai=${ai} />
    </${Section}>`;
}

const STEP_WHAT = { card: 'the empty card fields', greetings: 'openings', lore: 'a lorebook', preset: 'a preset', regex: 'regex', qr: 'Quick Replies', images: 'image prompts', art: 'a portrait' };

/** What "Build the rest for me" would add to this character, in words. */
function buildsWhat(ch) {
    const what = missingSteps(ch).map(s => STEP_WHAT[s]).filter(Boolean);
    if (!what.length) return 'Nothing is missing: Critique & fix is the way to improve it.';
    return `Builds ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]}.`;
}

function CoreTab(p) {
    const { d, setData, store, ch, env, project } = p;
    const ai = useAiTask(store);
    const building = (project.generationRuns ?? []).find(r => r.status === 'running' && r.state?.characterId === ch.id && isRunning(r.id));
    const critique = async () => {
        const lore = (ch.links?.lorebooks ?? []).flatMap(id => Object.values(findArtifact(project, 'lorebooks', id)?.data?.entries ?? {}));
        const r = await ai.run('character.critique', { card: ch.card, lore });
        if (!r) return;
        const group = uid('grp');
        const specs = [];
        const notes = [];
        for (const issue of r.value.issues ?? []) {
            if (issue.replacement && CARD_FIELDS[issue.field]) {
                specs.push({ task: 'character.critique', title: `Fix ${CARD_FIELDS[issue.field]} (${issue.severity})`, group, target: { type: 'characters', id: ch.id, path: `card.data.${issue.field}` }, after: issue.replacement, rationale: `${issue.problem} → ${issue.suggestion}`, generation: r.generation });
            } else {
                notes.push({ level: issue.severity === 'high' ? 'error' : issue.severity === 'medium' ? 'warn' : 'info', path: issue.field, message: `${issue.problem} — ${issue.suggestion}` });
            }
        }
        pushProposals(store, specs, 'AI critique');
        store.update(pr => editArtifactField(pr, 'characters', ch.id, 'critique', { time: new Date().toISOString(), strengths: r.value.strengths ?? [], notes, model: r.generation.label }, { actor: 'ai', summary: 'AI critique' }), 'AI critique');
    };
    return html`
        <div class="cs-grid">
            <${AiField} ...${p} key="name" field="name" label="Name" singleLine=${true} hint="The name used in your story." />
            <${Select} label="Card type" value=${ch.kind} options=${[{ value: 'character', label: 'A character' }, { value: 'scenario', label: 'A scenario / narrator' }]} onChange=${v => store.update(pr => editArtifactField(pr, 'characters', ch.id, 'kind', v), 'kind')} />
        </div>
        <${Section} title="Tags, credit & version" open=${false}><div class="cs-grid">
            <${TextInput} label="Nickname (V3)" value=${d.nickname ?? ''} onChange=${v => setData('nickname', v || undefined)} hint="Valid V3; SillyTavern 1.19 stores but ignores it." />
            <${TagsInput} label="Tags" items=${d.tags} onChange=${v => setData('tags', v)} />
            <${TextInput} label="Creator" value=${d.creator} onChange=${v => setData('creator', v)} />
            <${TextInput} label="Version" value=${d.character_version} onChange=${v => setData('character_version', v)} />
        </div></${Section}>
        ${ch.origin?.kind === 'st' && html`<div class="cs-st-copy">
            <${Icon} name="feather-pointed" />
            <span class="cs-grow">A copy of <strong>${ch.origin.avatar}</strong> from SillyTavern. Improve it here; SillyTavern changes only when you apply it, and its current version is kept as a backup.</span>
            <${Button} small icon="upload" label="Apply to SillyTavern…" onClick=${() => p.setTab('publish')} />
        </div>`}
        <${Section} title="Build more or review this character with AI" open=${false}><div class="cs-row">
            <${Button} kind="gild" icon="feather-pointed" label=${building ? 'Building…' : 'Build the rest for me'} disabled=${building}
                title="Fills every empty field, then writes openings, lore, a preset, regex, Quick Replies and image prompts around this character. Fields you wrote are kept."
                onClick=${() => developCharacter(store, env, ch.id)} />
            <${Button} kind="ai" icon="magnifying-glass-chart" label="Critique & fix" title=${isHandsFree(project) ? 'Reviews the card and applies the concrete fixes (undo with Ctrl+Z)' : 'Reviews the card and proposes fixes'} onClick=${critique} disabled=${ai.busy} />
            <${AiStatus} ai=${ai} />
            ${!building && html`<span class="cs-muted cs-small">${buildsWhat(ch)}</span>`}
        </div>
        </${Section}>
        ${building && html`<div class="cs-muted cs-small"><span class="cs-spin"><${Icon} name="spinner" /></span> Building around ${d.name}: ${building.selected.filter(id => building.steps[id]?.status === 'done').length} of ${building.selected.length} steps done. Follow progress on Home.</div>`}
        ${ch.critique && html`<${Section} title=${`Critique · ${new Date(ch.critique.time).toLocaleString()}`}>
            ${ch.critique.strengths?.length > 0 && html`<div class="cs-small"><strong>Strengths:</strong> ${ch.critique.strengths.join(' · ')}</div>`}
            <${Diagnostics} items=${ch.critique.notes} />
        </${Section}>`}
        <${AiField} ...${p} field="description" label="Description" rows=${10} hint="Appearance, background, behaviour and speech patterns: concrete material the model can act on." />
        <${AiField} ...${p} field="personality" label="Personality" rows=${4} hint="Often folded into the description by modern cards; keep short if used." />
        <${AiField} ...${p} field="scenario" label="Scenario" rows=${4} hint="The situation right now, and the pressure that forces choices." />
        <div class="cs-next-step"><div><strong>Next, give the story an opening.</strong><p>The first message sets the scene and gives the player a way in.</p></div><${Button} kind="primary" icon="comment" label="Write the opening" onClick=${() => p.setTab('greetings')} /></div>
    `;
}

function GreetingsTab(p) {
    const { d, setData, store, ch, project } = p;
    const ai = useAiTask(store);
    const [direction, setDirection] = useState('');
    const context = characterContext({ store, project, ch, field: 'alternate_greetings' });
    const gen = async () => {
        const r = await ai.run('character.greetings', { ...context.args(), count: 3, direction });
        if (!r) return;
        const alt = r.value.greetings.filter(g => !g.group_only);
        const grp = r.value.greetings.filter(g => g.group_only);
        const group = uid('grp');
        const specs = [];
        if (alt.length) specs.push({ task: 'character.greetings', title: `Add ${alt.length} alternate greeting(s)`, group, target: { type: 'characters', id: ch.id, path: 'card.data.alternate_greetings' }, after: [...(d.alternate_greetings ?? []), ...alt.map(g => g.text)], rationale: alt.map(g => `${g.situation}${g.mood ? ` (${g.mood})` : ''}`).join(' · '), generation: r.generation });
        if (grp.length) specs.push({ task: 'character.greetings', title: `Add ${grp.length} group-only greeting(s)`, group: uid('grp'), target: { type: 'characters', id: ch.id, path: 'card.data.group_only_greetings' }, after: [...(d.group_only_greetings ?? []), ...grp.map(g => g.text)], rationale: grp.map(g => g.situation).join(' · '), generation: r.generation });
        pushProposals(store, specs, 'AI greetings');
    };
    return html`
        <${AiField} ...${p} field="first_mes" label="First message" rows=${8} />
        <div class="cs-ai-box">
            <div class="cs-row">
                <input class="text_pole" style="flex:1" placeholder="Direction for new openings (optional): different place, time, mood, relationship stage…" value=${direction} onInput=${e => setDirection(e.currentTarget.value)} aria-label="Greeting direction" />
                <${Button} kind="ai" icon="wand-magic-sparkles" label="Generate 3 distinct openings" onClick=${gen} disabled=${ai.busy} />
            </div>
            ${context.panel}
            <${AiStatus} ai=${ai} />
        </div>
        <${PendingFor} store=${store} project=${project} type="characters" id=${ch.id} path="card.data.alternate_greetings" />
        <${StringList} label="Alternate greetings" items=${d.alternate_greetings} multiline onChange=${v => setData('alternate_greetings', v)} addLabel="Add greeting" hint="Offered as swipes on the first message." />
        <${PendingFor} store=${store} project=${project} type="characters" id=${ch.id} path="card.data.group_only_greetings" />
        <${StringList} label="Group-only greetings (V3)" items=${d.group_only_greetings} multiline onChange=${v => setData('group_only_greetings', v)} addLabel="Add group greeting"
            hint="Valid V3 and required by the spec (may be empty). SillyTavern 1.19 stores but does not use them." />
    `;
}

function ExamplesTab(p) {
    const { d, setData, ch, setPath } = p;
    const [raw, setRaw] = useState(false);
    const parts = splitExamples(d.mes_example);
    return html`
        <${TextArea} label="Voice direction — highest priority" value=${ch.voiceDirection ?? ''} rows=${3} stats=${false}
            placeholder="For example: a clipped London accent, dry humour, and questions ending in ‘yeah?’ Keep slang light."
            hint="Use this for accents, speech quirks and dialogue rules. AI-written dialogue and openings follow this ahead of other voice or style instructions. Other character facts still apply. Saved with this character."
            onChange=${value => setPath('voiceDirection', value, 'Edited priority voice direction')} />
        <div class="cs-row"><${Button} small label="Structured" ariaPressed=${!raw} onClick=${() => setRaw(false)} /><${Button} small label="Raw text" ariaPressed=${raw} onClick=${() => setRaw(true)} /></div>
        <${AiField} ...${p} field="mes_example" label="Example dialogue" rows=${14} hint="Blocks separated by <START>."
            renderEditor=${raw ? null : actions => html`<${StringList} label="Example dialogues" items=${parts} multiline placeholder=${'{{user}}: …\n{{char}}: …'} onChange=${v => setData('mes_example', joinExamples(v))} addLabel="Add example" actions=${actions}
                hint="Each block becomes a <START> section. Show the voice; don't narrate {{user}}." />`} />
    `;
}

function PromptsTab(p) {
    const { d, setPath, ch } = p;
    const dp = d.extensions?.depth_prompt ?? { prompt: '', depth: 4, role: 'system' };
    const setDp = patch => setPath('card.data.extensions.depth_prompt', { ...dp, ...patch }, "Edited character's note");
    return html`
        <${AiField} ...${p} field="system_prompt" label="System prompt override" rows=${5} hint="Replaces the user's system prompt when 'Prefer Char. Prompt' is on (default). {{original}} inserts the user's prompt." />
        <${AiField} ...${p} field="post_history_instructions" label="Post-history instructions" rows=${4} hint="Replaces post-history instructions when 'Prefer Char. Instructions' is on (default). {{original}} supported." />
        <${Section} title="Character's Note (ST extension: depth_prompt)">
            <${TextArea} label="Note" value=${dp.prompt} onChange=${v => setDp({ prompt: v })} rows=${4} counter=${p.env.countTokens} hint="SillyTavern-specific; injected at a chat depth. Stored in data.extensions.depth_prompt." />
            <div class="cs-grid">
                <${NumberInput} label="Depth" value=${dp.depth} min=${0} onChange=${v => setDp({ depth: v ?? 4 })} />
                <${Select} label="Role" value=${dp.role} options=${['system', 'user', 'assistant']} onChange=${v => setDp({ role: v })} />
                <${NumberInput} label="Talkativeness (groups)" value=${Number(d.extensions?.talkativeness ?? 0.5)} min=${0} max=${1} step=${0.05} onChange=${v => setPath('card.data.extensions.talkativeness', v ?? 0.5, 'Edited talkativeness')} />
            </div>
        </${Section}>
    `;
}

function LoreTab({ store, env, project, ch, d, setPath, select }) {
    const book = d.character_book;
    const linked = (ch.links?.lorebooks ?? []).map(id => findArtifact(project, 'lorebooks', id)).filter(Boolean);
    const unlinked = project.lorebooks.filter(l => !(ch.links?.lorebooks ?? []).includes(l.id));
    const extract = () => {
        const world = normalizeWorld(characterBookToWorld(book)).world;
        delete world.originalData;
        const lb = { id: uid('lb'), name: book.name || `${d.name}'s Lorebook`, data: world, origin: { kind: 'card', characterId: ch.id }, bookMeta: pickBookMeta(book) };
        store.update(pr => {
            let next = upsertArtifact(pr, 'lorebooks', lb, { action: 'create', summary: `Extracted embedded lorebook of ${d.name}` });
            next = editArtifactField(next, 'characters', ch.id, 'links.lorebooks', [...(ch.links?.lorebooks ?? []), lb.id], { summary: 'Linked lorebook' });
            return next;
        }, 'extract lorebook');
        env.toast('Embedded lorebook is now a project lorebook, linked to this character', 'ok');
        select('lorebooks', lb.id);
    };
    const embed = lb => {
        const { book: nb, lost } = worldToCharacterBook(lb.name, lb.data, lb.bookMeta ?? {});
        setPath('card.data.character_book', nb, `Embedded lorebook ${lb.name}`);
        env.toast(`Embedded ${nb.entries.length} entries${lost.length ? ` (lost in card format: ${lost.join(', ')})` : ''}`, lost.length ? '' : 'ok', 6000);
    };
    const link = id => setPath('links.lorebooks', [...(ch.links?.lorebooks ?? []), id], 'Linked lorebook');
    const unlink = id => setPath('links.lorebooks', (ch.links?.lorebooks ?? []).filter(x => x !== id), 'Unlinked lorebook');
    return html`
        <${Section} title=${`Embedded lorebook (character_book) · ${book?.entries?.length ?? 0} entries`}>
            <div class="cs-muted cs-small">SillyTavern does not use an embedded book until the user imports it as a World Info file (ST asks once per character). If that world stays linked, ST rebuilds the embedded book from it on every save, dropping book-level settings and entry name/priority.</div>
            ${book?.entries?.length ? html`<ul class="cs-list">${book.entries.slice(0, 50).map((e, i) => html`<li class="cs-list-item" key=${i}><${Icon} name=${e.constant ? 'circle' : 'key'} /><span class="cs-grow">${e.comment || e.name || (e.keys ?? []).join(', ')}</span><span class="cs-muted cs-small">${(e.keys ?? []).slice(0, 4).join(', ')}</span></li>`)}</ul>` : html`<div class="cs-muted">No embedded entries.</div>`}
            <div class="cs-row">
                ${book?.entries?.length > 0 && html`<${Button} icon="arrow-right-from-bracket" label="Edit as project lorebook" onClick=${extract} title="Convert to a project lorebook (ST world format) and link it" />`}
                ${book && html`<${Button} icon="trash" kind="danger" label="Remove embedded book" onClick=${() => setPath('card.data.character_book', undefined, 'Removed embedded lorebook')} />`}
            </div>
        </${Section}>
        <${Section} title=${`Linked project lorebooks (${linked.length})`}>
            ${linked.map(lb => html`<div class="cs-list-item" key=${lb.id}>
                <${Icon} name="book" /><span class="cs-grow">${lb.name} <span class="cs-muted">(${Object.keys(lb.data?.entries ?? {}).length} entries)</span></span>
                <${Button} small label="Open" onClick=${() => select('lorebooks', lb.id)} />
                <${Button} small icon="file-export" label="Embed in card" onClick=${() => embed(lb)} title="Write this lorebook into data.character_book so it travels with the card" />
                <${Button} small icon="link-slash" title="Unlink" onClick=${() => unlink(lb.id)} />
            </div>`)}
            ${unlinked.length > 0 && html`<div class="cs-row"><span class="cs-muted">Link:</span>${unlinked.map(lb => html`<${Button} small icon="link" label=${lb.name} onClick=${() => link(lb.id)} />`)}</div>`}
            ${!project.lorebooks.length && html`<div class="cs-muted">No project lorebooks yet — create one in the Lore workshop.</div>`}
        </${Section}>`;
}

function pickBookMeta(book) {
    const out = {};
    for (const k of ['description', 'scan_depth', 'token_budget', 'recursive_scanning', 'extensions']) if (book?.[k] !== undefined) out[k] = clone(book[k]);
    return out;
}

function MetaTab({ store, env, project, ch, d, setData, setPath }) {
    const avatar = ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null;
    const setAvatar = async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        const { media, apply } = await saveMedia(env, store.get(), await fileBytes(f), { name: `${d.name} avatar`, role: 'avatar' });
        store.update(pr => editArtifactField(apply(pr), 'characters', ch.id, 'avatarMediaId', media.id, { summary: 'Set avatar image' }), 'set avatar');
    };
    const ml = Object.entries(d.creator_notes_multilingual ?? {});
    const setMl = entries => setData('creator_notes_multilingual', entries.length ? Object.fromEntries(entries) : undefined);
    const toUnix = v => (v ? Math.floor(new Date(v).getTime() / 1000) : undefined);
    const fromUnix = s => (s ? new Date(s * 1000).toISOString().slice(0, 16) : '');
    return html`
        <div class="cs-row" style="align-items:flex-start">
            <div class="cs-stack" style="width:160px">
                ${avatar ? html`<img src=${avatar.url} alt="Avatar" style="width:160px;max-height:240px;object-fit:cover;border-radius:6px;border:1px solid var(--cs-line)" />` : html`<div class="cs-empty" style="width:160px;height:160px;border:1px dashed var(--cs-line);border-radius:6px">No image</div>`}
                <${Button} small icon="image" label=${avatar ? 'Replace image' : 'Set image'} onClick=${setAvatar} />
            </div>
            <div class="cs-stack" style="flex:1;min-width:260px">
                <${AiField} store=${store} env=${env} project=${project} ch=${ch} d=${d} setData=${setData} field="creator_notes" label="Creator notes" rows=${5} hint="Shown to users in ST; not sent to the model (unless World Info scans it)." />
            </div>
        </div>
        <${Section} title="Multilingual creator notes (V3)" right=${html`<${Button} small icon="plus" label="Language" onClick=${() => setMl([...ml, ['en', '']])} />`}>
            <div class="cs-muted cs-small">Valid V3; SillyTavern 1.19 keeps but does not show them.</div>
            ${ml.map(([lang, text], i) => html`<div class="cs-row" key=${i}>
                <input class="text_pole" style="width:60px" value=${lang} aria-label="Language code" onInput=${e => setMl(ml.map((x, j) => (j === i ? [e.currentTarget.value, x[1]] : x)))} />
                <textarea class="text_pole cs-textarea" rows="2" style="flex:1" value=${text} aria-label="Notes" onInput=${e => setMl(ml.map((x, j) => (j === i ? [x[0], e.currentTarget.value] : x)))}></textarea>
                <${Button} small icon="trash" kind="danger" onClick=${() => setMl(ml.filter((_, j) => j !== i))} />
            </div>`)}
        </${Section}>
        <div class="cs-grid">
            <${Field} label="Creation date (V3)"><input type="datetime-local" class="text_pole cs-input" value=${fromUnix(d.creation_date)} onInput=${e => setData('creation_date', toUnix(e.currentTarget.value))} /></${Field}>
            <${Field} label="Modification date (V3)"><input type="datetime-local" class="text_pole cs-input" value=${fromUnix(d.modification_date)} onInput=${e => setData('modification_date', toUnix(e.currentTarget.value))} /></${Field}>
        </div>
        <${StringList} label="Source (V3)" items=${d.source ?? []} onChange=${v => setData('source', v.length ? v : undefined)} placeholder="https://…" hint="IDs or URLs where the card came from; append-only by convention. Not used by ST." />
        <${AssetsEditor} d=${d} setData=${setData} ch=${ch} project=${project} />
    `;
}


function AssetsEditor({ d, setData, ch, project }) {
    const assets = d.assets ?? [];
    const set = (i, patch) => setData('assets', assets.map((a, j) => (j === i ? { ...a, ...patch } : a)));
    return html`<${Section} title=${`Assets (V3) · ${assets.length}`} right=${html`<${Button} small icon="plus" label="Asset" onClick=${() => setData('assets', [...assets, { type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }])} />`}>
        <div class="cs-muted cs-small">Used by SillyTavern only when importing CHARX (icon → avatar, emotion → sprites, background → character backgrounds). Embedded files (embeded://) travel only in CHARX exports.</div>
        ${assets.length ? html`<table class="cs-table"><thead><tr><th>Type</th><th>Name</th><th>URI</th><th>Ext</th><th></th></tr></thead><tbody>
            ${assets.map((a, i) => html`<tr key=${i}>
                <td><select class="text_pole" value=${a.type} onChange=${e => set(i, { type: e.currentTarget.value })}>${['icon', 'background', 'user_icon', 'emotion', 'other'].concat(a.type && !['icon', 'background', 'user_icon', 'emotion', 'other'].includes(a.type) ? [a.type] : []).map(t => html`<option value=${t} selected=${t === a.type}>${t}</option>`)}</select></td>
                <td><input class="text_pole" value=${a.name} onInput=${e => set(i, { name: e.currentTarget.value })} /></td>
                <td><input class="text_pole cs-mono" value=${a.uri} onInput=${e => set(i, { uri: e.currentTarget.value })} />${ch.assetFiles?.[a.uri.replace(/^embedd?ed:\/\//, '')] && html`<${Badge} kind="ok">file kept</${Badge}>`}</td>
                <td><input class="text_pole" style="width:60px" value=${a.ext} onInput=${e => set(i, { ext: e.currentTarget.value })} /></td>
                <td><${Button} small icon="trash" kind="danger" onClick=${() => setData('assets', assets.filter((_, j) => j !== i).length ? assets.filter((_, j) => j !== i) : undefined)} /></td>
            </tr>`)}
        </tbody></table>` : null}
    </${Section}>`;
}

function ExtensionsTab({ d, setData }) {
    const [text, setText] = useState(JSON.stringify(d.extensions ?? {}, null, 2));
    const [err, setErr] = useState('');
    const serialized = JSON.stringify(d.extensions ?? {}, null, 2);
    useEffect(() => { setText(serialized); setErr(''); }, [serialized]);
    const commit = () => {
        try {
            const v = JSON.parse(text);
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('must be an object');
            setData('extensions', v);
            setErr('');
        } catch (e) { setErr(e.message); }
    };
    const KNOWN = { talkativeness: 'Group chat talkativeness (0–1)', fav: 'Favourite flag', world: 'Primary linked World Info name', depth_prompt: "Character's Note", regex_scripts: 'Character-scoped regex (see Regex Lab)', chub: 'Chub metadata', risuai: 'RisuAI data (sprites imported by ST are removed from here)', sd_character_prompt: 'Image generation prompts', source_url: 'Source link', github_repo: 'GitHub repo', pygmalion_id: 'Pygmalion id' };
    return html`
        <div class="cs-muted cs-small">Everything here is preserved on import, edit and export (the V2/V3 specs require editors to keep unknown extension data).</div>
        <table class="cs-table"><thead><tr><th>Key</th><th>Meaning</th></tr></thead><tbody>
            ${Object.keys(d.extensions ?? {}).map(k => html`<tr key=${k}><td><code>${k}</code></td><td>${KNOWN[k] ?? html`<span class="cs-muted">Third-party or unknown: kept verbatim</span>`}</td></tr>`)}
        </tbody></table>
        <${Field} label="data.extensions (JSON)" wide>
            <textarea class="text_pole cs-textarea cs-mono" rows="14" value=${text} onInput=${e => setText(e.currentTarget.value)} aria-label="Extensions JSON"></textarea>
        </${Field}>
        <div class="cs-row"><${Button} icon="check" label="Apply JSON" onClick=${commit} disabled=${text === serialized} />${err && html`<span class="cs-err-text">${err}</span>`}</div>`;
}

function CompatTab({ ch, issues }) {
    const usage = cardFeatureUsage(ch.card);
    return html`
        <${Section} title="Specification validation (Character Card V3)">
            <${Diagnostics} items=${issues} />
        </${Section}>
        <${Section} title="SillyTavern 1.19 support for the features this card uses">
            <div class="cs-muted cs-small">“Valid in the V3 spec” is not the same as “used by SillyTavern”. Rows in bold are present in this card.</div>
            <table class="cs-table"><thead><tr><th>Feature</th><th>In card</th><th>SillyTavern 1.19</th><th>Notes</th></tr></thead><tbody>
                ${usage.map(r => html`<tr key=${r.path} style=${r.present ? 'font-weight:600' : 'opacity:.7'}>
                    <td>${r.label}</td><td>${r.present ? 'yes' : '—'}</td>
                    <td><${Badge} kind=${r.st === 'used' ? 'ok' : r.st === 'lost' ? 'err' : 'warn'}>${STATUS_LABEL[r.st] ?? r.st}</${Badge}></td>
                    <td class="cs-small">${r.note ?? ''}</td>
                </tr>`)}
            </tbody></table>
        </${Section}>
        ${ch.origin?.diagnostics?.length > 0 && html`<${Section} title="Import notes">${ch.origin.diagnostics.map(x => html`<div class="cs-small">• ${x}</div>`)}</${Section}>`}
        ${ch.origin?.report?.length > 0 && html`<${Section} title="Normalization report"><${Diagnostics} items=${ch.origin.report} /></${Section}>`}
    `;
}

function PublishTab({ store, env, project, ch, d }) {
    const [busy, setBusy] = useState('');
    const [review, setReview] = useState(null);
    const [lastNotes, setLastNotes] = useState([]);
    const cardImage = async () => {
        const avatar = ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null;
        return avatar ? toPngBytes(await mediaBytes(env, avatar)) : null;
    };
    const assetFiles = async () => {
        const out = {};
        for (const [path, mid] of Object.entries(ch.assetFiles ?? {})) {
            const m = findArtifact(project, 'media', mid);
            if (m) out[path] = await mediaBytes(env, m);
        }
        return out;
    };
    const doExport = async kind => {
        setBusy(kind);
        try {
            let card = ch.card;
            let files = kind === 'charx' ? await assetFiles() : {};
            if (kind === 'charx' && Object.keys(ch.sprites ?? {}).length) {
                // Expression sprites ride along as emotion assets; SillyTavern's CHARX import makes them sprites again.
                const bytes = {};
                for (const [label, id] of Object.entries(ch.sprites)) {
                    const m = findArtifact(project, 'media', id);
                    if (m) bytes[label] = await toPngBytes(await mediaBytes(env, m));
                }
                const withSprites = withSpriteAssets(card, bytes);
                card = withSprites.card;
                files = { ...files, ...withSprites.files };
            }
            const r = exportCard(kind, { card, topLevelExtras: ch.topLevelExtras, image: await cardImage(), assetFiles: files });
            downloadBlob(r.bytes, `${safeName(d.name)}.${r.ext}`, r.mime);
            setLastNotes(r.notes);
            store.update(p => logHistory(p, { target: { type: 'characters', id: ch.id }, action: 'export', summary: `Exported ${kind}` }), 'export');
        } catch (e) { env.toast(`Export failed: ${e.message}`, 'error'); } finally { setBusy(''); }
    };
    const linked = ch.origin?.kind === 'st' ? ch.origin.avatar : ch.stAvatar;
    const prepareApply = async () => {
        setBusy('apply');
        try {
            const current = await getStCharacter(linked);
            const diff = jsonDiff(current?.data ?? {}, cardForSt(project, ch).data, 'data').filter(x => !/^data\.extensions\.(fav)$/.test(x.path));
            setReview({ current, diff });
        } catch (e) { env.toast(`Could not read ${linked} from SillyTavern: ${e.message}`, 'error'); } finally { setBusy(''); }
    };
    const apply = async () => {
        setBusy('apply');
        try {
            await env.storage.saveSnapshot(store.get(), `Before applying ${d.name} to SillyTavern`, 'auto').catch(() => {});
            const { backup, fidelity, renamed } = await applyCardToSt(linked, cardForSt(project, ch), ch.topLevelExtras);
            recordBackup(store, backup, `Applied ${d.name} to SillyTavern (${linked})`);
            setLastNotes([
                'Applied through /api/characters/merge-attributes. The previous version is saved under Snapshots → Live SillyTavern backups.',
                ...(renamed ? ['Name changes are not applied to the ST file name; use ST’s rename if needed.'] : []),
                ...(fidelity.length ? [`SillyTavern stored ${fidelity.length} difference(s): ${fidelity.slice(0, 6).map(f => `${f.kind} ${f.path}`).join('; ')}`] : ['Verified: SillyTavern stored exactly what was sent.']),
            ]);
            setReview(null);
            env.toast('Applied to SillyTavern', 'ok');
        } catch (e) { env.toast(`Apply failed: ${e.message}`, 'error', 8000); } finally { setBusy(''); }
    };
    const createInSt = async () => {
        if (!(await env.confirm(`Create ${d.name} as a new character in SillyTavern?`, 'The card is imported as a PNG with both chunks; the studio then reads it back to report anything ST changed.'))) return;
        setBusy('create');
        try {
            const card = cardForSt(project, ch);
            const r = exportCard('png-v3', { card, topLevelExtras: ch.topLevelExtras, image: await cardImage() });
            const avatar = await importIntoSt(r.bytes, 'png', `${safeName(d.name)}.png`);
            const stored = await getStCharacter(avatar);
            const { fidelityReport } = await import('../../st/live.js');
            const fid = fidelityReport(card, stored);
            store.update(p => logHistory(editArtifactField(p, 'characters', ch.id, 'stAvatar', avatar, { summary: `Created in SillyTavern as ${avatar}` }), { actor: 'st', action: 'create-live', target: { type: 'characters', id: ch.id }, summary: `Created ${avatar} in SillyTavern` }), 'create in ST');
            setLastNotes([`Created ${avatar}.`, ...(fid.length ? [`Differences after ST import: ${fid.slice(0, 8).map(f => `${f.kind} ${f.path}`).join('; ')}`] : ['Verified: SillyTavern stored the card data unchanged.'])]);
            env.toast(`Created ${avatar} in SillyTavern`, 'ok');
        } catch (e) { env.toast(`Create failed: ${e.message}`, 'error', 8000); } finally { setBusy(''); }
    };
    return html`
        <div class="cs-next-step"><div><strong>Download a character card</strong><p>PNG works with SillyTavern and includes the portrait and character text. Choose CHARX to include extra assets and expressions.</p></div><div class="cs-row">
            <${Button} kind="primary" icon="download" label="Download PNG card" onClick=${() => doExport('png-st')} disabled=${!!busy} />
            <${Button} icon="box-archive" label="Download CHARX" onClick=${() => doExport('charx')} disabled=${!!busy} />
        </div></div>
        <${Section} title="Other export formats" open=${false}>
            <table class="cs-table"><tbody>${EXPORT_KINDS.filter(k => !['png-st', 'charx'].includes(k.id)).map(k => html`<tr key=${k.id}>
                <td style="width:260px"><${Button} small icon="download" label=${k.label} onClick=${() => doExport(k.id)} disabled=${!!busy} /></td>
                <td class="cs-small cs-muted">${k.hint}</td></tr>`)}</tbody></table>
        </${Section}>
        <${Section} title="SillyTavern">
            ${linked ? html`<div class="cs-row">
                    <span>Linked to <strong>${linked}</strong>.</span>
                    <${Button} kind="primary" icon="upload" label="Review & apply to SillyTavern…" onClick=${prepareApply} disabled=${!!busy} />
                </div>`
                : html`<div class="cs-muted">Not linked to a SillyTavern character.</div>`}
            <div class="cs-row"><${Button} icon="user-plus" label="Create as new SillyTavern character" onClick=${createInSt} disabled=${!!busy} /></div>
            ${busy && html`<div class="cs-ai-status"><span class="cs-spin"><${Icon} name="spinner" /></span> Working…</div>`}
        </${Section}>
        ${lastNotes.length > 0 && html`<${Section} title="Result">${lastNotes.map(n => html`<div class="cs-small">• ${n}</div>`)}</${Section}>`}
        ${review && html`<${Modal} title=${`Apply ${d.name} to SillyTavern (${linked})`} onClose=${() => setReview(null)} wide
            footer=${html`<${Button} label="Cancel" onClick=${() => setReview(null)} /><${Button} kind="primary" icon="upload" label=${`Apply ${review.diff.length} change(s)`} onClick=${apply} disabled=${!review.diff.length || busy === 'apply'} />`}>
            <div class="cs-muted cs-small">These fields differ between SillyTavern and the project. Applying overwrites SillyTavern's version; a backup of the current ST data is stored first.</div>
            ${review.diff.length ? html`<table class="cs-table"><thead><tr><th>Field</th><th>Change</th><th>SillyTavern now</th><th>Project</th></tr></thead><tbody>
                ${review.diff.map(x => html`<tr key=${x.path}><td><code>${x.path}</code></td><td>${x.kind}</td>
                    <td class="cs-small"><pre class="cs-pre" style="max-height:120px">${fmt(x.before)}</pre></td>
                    <td class="cs-small"><pre class="cs-pre" style="max-height:120px">${fmt(x.after)}</pre></td></tr>`)}
            </tbody></table>` : html`<div class="cs-ok-text">No differences: SillyTavern already has this version.</div>`}
        </${Modal}>`}
    `;
}

function fmt(v) {
    if (v === undefined) return '(absent)';
    return typeof v === 'string' ? (v.length > 600 ? `${v.slice(0, 600)}…` : v) : JSON.stringify(v, null, 1)?.slice(0, 600);
}

/** Initials for a character without an image ("Prometheus in the Gloom" → "PG"; skips small words). */
function monogram(name) {
    const words = String(name || '?').split(/[\s\-_]+/).filter(w => w && !/^(the|of|in|a|an|and|de|la|le|von|van)$/i.test(w));
    return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

function safeName(s) {
    return String(s || 'character').replace(/[^\w.-]+/g, '_').slice(0, 60);
}
