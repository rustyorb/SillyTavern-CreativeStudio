// Whole-project generation: premise → concept → card → openings → lore → preset → regex → Quick Replies →
// image prompts → self-critique. Each step turns AI output into real, linked project artifacts.
// Pure: the AI call is injected (runTask), so the pipeline is unit-testable with a fake model.

import { clone, uid } from '../core/bytes.js';
import { newCharacter, upsertArtifact, editArtifactField, findArtifact, logHistory, now } from '../core/project.js';
import { emptyCardV3, tidyExamples } from '../core/card.js';
import { newEntry } from '../core/lorebook.js';
import { emptyCcPreset, mergeGeneratedPrompts } from '../core/preset.js';
import { defaultScript } from '../core/regex.js';
import { newSet, addQr, QR_FLAGS } from '../core/qr.js';
import { dialText, cardDigest, CARD_FIELDS, CORE_CARD_FIELDS, entryTitle, entryKeys } from './tasks.js';

const STRING_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'];
/** Without these the card is not playable; the card step re-asks for any that come back empty. */
const MUST_HAVE = ['description', 'scenario', 'first_mes', 'mes_example'];

function brief(state) {
    const p = state.premise;
    if (!p) return state.idea ?? '';
    return `${p.title}: ${p.logline}\n\n${p.premise}\n\nSetting: ${p.setting ?? ''}\nTone: ${p.tone ?? ''}\nThemes: ${(p.themes ?? []).join(', ')}\n{{user}}'s role: ${p.user_role ?? ''}\nCentral conflict: ${p.central_conflict ?? ''}${p.cast?.length ? `\nCast: ${p.cast.map(c => `${c.name} (${c.role})`).join('; ')}` : ''}`;
}

function styleFrom(dials) {
    const s = [];
    if (dials.pov) s.push(`Narration: ${dials.pov}`);
    if (dials.length) s.push(`Reply length for greetings: ${dials.length}`);
    if (dials.rating) s.push(`Content rating: ${dials.rating}`);
    if (dials.tone) s.push(`Tone: ${dials.tone}`);
    return s.join('; ');
}

function char(project, state) {
    return state.characterId ? findArtifact(project, 'characters', state.characterId) : null;
}

function track(state, type, id) {
    return { ...state, created: [...(state.created ?? []), { type, id }] };
}

export const STEPS = [
    {
        id: 'premise', label: 'Premise', task: 'project.premise', needs: [],
        build: (s, p, dials) => ({ idea: s.idea, dials }),
        apply: (project, v, s) => {
            const next = { ...project, premise: `${v.title}\n${v.logline}\n\n${v.premise}`, brief: clone(v), modified: now() };
            if (/^(My first project|Untitled project|New project)$/i.test(project.name) || s.renameProject) next.name = v.title;
            return { project: logHistory(next, { actor: 'ai', action: 'generate', summary: `Premise: ${v.title}` }), state: { ...s, premise: v } };
        },
    },
    {
        id: 'concept', label: 'Main character', task: 'character.ideate', needs: ['premise'],
        build: (s, p, dials) => ({
            premise: brief(s), count: 1,
            constraints: [s.premise?.card_type === 'scenario' || /narrator/.test(dials.cardType ?? '') ? 'This card is a NARRATOR / game master that voices the setting and several characters; name it after the setting or story.' : '', dials.rating ? `Rating: ${dials.rating}` : ''].filter(Boolean).join(' '),
        }),
        apply: (project, v, s) => {
            const c = v.candidates[0];
            const card = emptyCardV3(c.name);
            card.data.tags = c.tags ?? [];
            const isScenario = s.premise?.card_type === 'scenario';
            const art = newCharacter(c.name, card, { concept: c, kind: isScenario ? 'scenario' : 'character', origin: { kind: 'ai', run: s.runId } });
            const next = upsertArtifact(project, 'characters', art, { action: 'create', actor: 'ai', summary: `Generated character concept ${c.name}` });
            return { project: next, state: track({ ...s, characterId: art.id, concept: c }, 'characters', art.id) };
        },
    },
    {
        id: 'card', label: 'Character card', task: 'character.expand', needs: ['concept'],
        build: (s, p, dials) => {
            const card = char(p, s)?.card;
            // Filling gaps in an existing card: ask only for what is empty instead of rewriting everything and discarding it.
            const gaps = s.fillOnly ? CORE_CARD_FIELDS.filter(k => (Array.isArray(card?.data[k]) ? !card.data[k].length : !String(card?.data[k] ?? '').trim())) : [];
            return { concept: { ...s.concept, story: brief(s) }, card, style: styleFrom(dials), ...(gaps.length ? { only: gaps } : {}) };
        },
        missing: (p, s) => MUST_HAVE.filter(k => !String(char(p, s)?.card.data[k] ?? '').trim()),
        apply: (project, v, s) => {
            let next = project;
            const f = v.fields ?? {};
            const d0 = char(project, s).card.data;
            // fillOnly: developing an existing character never overwrites what the author (or an earlier run) wrote.
            const empty = k => !s.fillOnly || (Array.isArray(d0[k]) ? !d0[k].length : !String(d0[k] ?? '').trim());
            for (const k of STRING_FIELDS) {
                if (typeof f[k] !== 'string' || !f[k].trim() || !empty(k) || (s.fillOnly && k === 'name')) continue;
                const value = k === 'mes_example' ? tidyExamples(f[k], f.name || d0.name) : f[k];
                next = editArtifactField(next, 'characters', s.characterId, `card.data.${k}`, value, { actor: 'ai', summary: `Generated ${CARD_FIELDS[k] ?? k}` });
            }
            if (Array.isArray(f.tags) && f.tags.length && empty('tags')) next = editArtifactField(next, 'characters', s.characterId, 'card.data.tags', f.tags, { actor: 'ai', summary: 'Generated tags' });
            if (Array.isArray(f.alternate_greetings) && f.alternate_greetings.length && empty('alternate_greetings')) next = editArtifactField(next, 'characters', s.characterId, 'card.data.alternate_greetings', f.alternate_greetings.filter(x => typeof x === 'string' && x.trim()), { actor: 'ai', summary: 'Generated alternate greetings' });
            if (!char(next, s).card.data.creator) next = editArtifactField(next, 'characters', s.characterId, 'card.data.creator', 'Creative Studio', { actor: 'ai', summary: 'Creator' });
            return { project: next, state: s };
        },
    },
    {
        id: 'greetings', label: 'Alternate openings', task: 'character.greetings', needs: ['card'],
        build: (s, p, dials) => ({ card: char(p, s).card, count: 3, direction: `Make each opening a different situation from the premise. ${styleFrom(dials)}` }),
        apply: (project, v, s) => {
            const d = char(project, s).card.data;
            const alt = v.greetings.filter(g => !g.group_only).map(g => g.text).filter(Boolean);
            const grp = v.greetings.filter(g => g.group_only).map(g => g.text).filter(Boolean);
            let next = editArtifactField(project, 'characters', s.characterId, 'card.data.alternate_greetings', [...(d.alternate_greetings ?? []), ...alt], { actor: 'ai', summary: `Generated ${alt.length} alternate opening(s)` });
            if (grp.length) next = editArtifactField(next, 'characters', s.characterId, 'card.data.group_only_greetings', [...(d.group_only_greetings ?? []), ...grp], { actor: 'ai', summary: 'Generated group openings' });
            return { project: next, state: s };
        },
    },
    {
        id: 'lore', label: 'Lorebook', task: 'lore.structure', needs: ['card'],
        build: (s, p) => ({ premise: brief(s), card: char(p, s).card, count: 10 }),
        apply: (project, v, s) => {
            const world = { entries: {} };
            for (const e of v.entries) {
                const entry = newEntry(world, { comment: entryTitle(e), key: entryKeys(e), content: e.content, constant: !!e.constant });
                entry.extensions = { studio: { category: e.category ?? '', rationale: e.rationale ?? '' } };
                world.entries[entry.uid] = entry;
            }
            const c = char(project, s);
            const lb = { id: uid('lb'), name: `${s.premise?.title ?? c.card.data.name} — World`, data: world, origin: { kind: 'ai', run: s.runId } };
            let next = upsertArtifact(project, 'lorebooks', lb, { action: 'create', actor: 'ai', summary: `Generated lorebook (${v.entries.length} entries)` });
            next = editArtifactField(next, 'characters', s.characterId, 'links.lorebooks', [...(c.links?.lorebooks ?? []), lb.id], { actor: 'ai', summary: 'Linked lorebook' });
            return { project: next, state: track({ ...s, lorebookId: lb.id }, 'lorebooks', lb.id) };
        },
    },
    {
        id: 'preset', label: 'Prompt preset', task: 'preset.generate-cc', needs: ['card'],
        build: (s, p, dials) => ({
            goals: `A roleplay preset for this story.\n${brief(s)}\n\nCharacter: ${char(p, s).card.data.name}. ${styleFrom(dials)}\nStay in character, never write {{user}}'s actions or dialogue, keep continuity with the lore, give each reply a clear hook for {{user}}.`,
            model: dials.model ?? '',
        }),
        apply: (project, v, s) => {
            const merged = mergeGeneratedPrompts(emptyCcPreset(), v);
            const c = char(project, s);
            const pr = { id: uid('pre'), kind: 'cc', name: `${s.premise?.title ?? c.card.data.name} — Preset`, data: merged.preset, origin: { kind: 'ai', run: s.runId }, versions: [], notes: v.rationale };
            let next = upsertArtifact(project, 'presets', pr, { action: 'create', actor: 'ai', summary: `Generated preset (${v.prompts.length} prompts)` });
            next = editArtifactField(next, 'characters', s.characterId, 'links.presets', [...(c.links?.presets ?? []), pr.id], { actor: 'ai', summary: 'Linked preset' });
            return { project: next, state: track({ ...s, presetId: pr.id }, 'presets', pr.id) };
        },
    },
    {
        id: 'regex', label: 'Formatting regex', task: 'regex.generate', needs: ['preset'],
        build: (s, p) => {
            const pr = s.presetId ? findArtifact(p, 'presets', s.presetId) : null;
            const prompts = (pr?.data.prompts ?? []).filter(x => x.content && !x.marker).map(x => `[${x.name}] ${x.content.slice(0, 300)}`).join('\n');
            return { goal: `Small, safe formatting helpers for this roleplay: hide model reasoning/thinking blocks from the chat display; strip (OOC: ...) notes from what is sent to the model; and handle any special tags the preset below asks the model to write. Prefer display-only or prompt-only scripts; never rewrite stored chat unless essential.\nPreset prompts:\n${prompts}` };
        },
        apply: (project, v, s) => {
            const scripts = v.scripts.map(g => ({ ...defaultScript(g.scriptName), findRegex: g.findRegex, replaceString: g.replaceString ?? '', trimStrings: g.trimStrings ?? [], placement: (g.placement ?? [2]).filter(x => [1, 2, 3, 5, 6].includes(x)), markdownOnly: !!g.markdownOnly, promptOnly: !!g.promptOnly, minDepth: g.minDepth ?? null, maxDepth: g.maxDepth ?? null }));
            const c = char(project, s);
            const existing = c.card.data.extensions?.regex_scripts ?? [];
            let next = editArtifactField(project, 'characters', s.characterId, 'card.data.extensions.regex_scripts', [...existing, ...scripts], { actor: 'ai', summary: `Generated ${scripts.length} character-scoped regex script(s)` });
            const fx = v.scripts.flatMap(g => (g.tests ?? []).map((t, i) => ({ name: `${g.scriptName} #${i + 1}`, user: '', ai: t.input, expected: t.expected, wi: '', reasoning: '', depth: 0 })));
            if (fx.length) next = { ...next, regexFixtures: [...(next.regexFixtures ?? []), ...fx] };
            return { project: next, state: s };
        },
    },
    {
        id: 'qr', label: 'Quick Reply helpers', task: 'stscript.generate', needs: ['card'],
        build: (s, p) => ({ goal: `2-4 practical Quick Reply buttons for playing this roleplay with ${char(p, s).card.data.name}. Examples: a "Continue" nudge, a "Summarize the scene so far" button using /gen with its result echoed, a scene or status tracker using chat variables, and a dice roll only if the story involves chance. Keep them safe: no deleting messages, no switching presets.\nStory: ${brief(s).slice(0, 1200)}`, commands: s.commandList ?? '' }),
        apply: (project, v, s) => {
            const c = char(project, s);
            let set = newSet(`${c.card.data.name} Tools`);
            for (const g of v.quickReplies) {
                const props = { label: g.label, title: g.title ?? g.explanation ?? '', message: g.message, isHidden: !!g.isHidden, automationId: g.automationId ?? '' };
                for (const [k] of QR_FLAGS) if (g[k]) props[k] = true;
                set = addQr(set, props).set;
            }
            const art = { id: uid('qrs'), name: set.name, data: set, links: { global: false, characters: [c.id] }, origin: { kind: 'ai', run: s.runId } };
            let next = upsertArtifact(project, 'qrSets', art, { action: 'create', actor: 'ai', summary: `Generated Quick Reply set (${v.quickReplies.length})` });
            next = editArtifactField(next, 'characters', s.characterId, 'links.qrSets', [...(c.links?.qrSets ?? []), art.id], { actor: 'ai', summary: 'Linked Quick Reply set' });
            return { project: next, state: track(s, 'qrSets', art.id) };
        },
    },
    {
        id: 'images', label: 'Image prompts', task: 'media.prompts', needs: ['card'],
        build: (s, p, dials) => ({ card: char(p, s).card, style: dials.genre ? `${dials.genre}${dials.tone ? `, ${dials.tone}` : ''}` : '' }),
        apply: (project, v, s) => ({ project: editArtifactField(project, 'characters', s.characterId, 'imagePrompts', v.prompts, { actor: 'ai', summary: 'Generated image prompts' }), state: s }),
    },
    {
        id: 'polish', label: 'Self-critique & revise', task: 'character.critique', needs: ['card', 'greetings'],
        build: (s, p) => {
            const c = char(p, s);
            const lore = (c.links?.lorebooks ?? []).flatMap(id => Object.values(findArtifact(p, 'lorebooks', id)?.data?.entries ?? {}));
            return { card: c.card, lore };
        },
        apply: (project, v, s) => {
            let next = project;
            let fixed = 0;
            for (const issue of v.issues ?? []) {
                if (issue.replacement && CARD_FIELDS[issue.field] && issue.severity !== 'low') {
                    const value = issue.field === 'mes_example' ? tidyExamples(issue.replacement, char(next, s).card.data.name) : issue.replacement;
                    next = editArtifactField(next, 'characters', s.characterId, `card.data.${issue.field}`, value, { actor: 'ai', summary: `Revised ${CARD_FIELDS[issue.field]}: ${issue.problem}` });
                    fixed++;
                }
            }
            const notes = (v.issues ?? []).filter(i => !i.replacement || !CARD_FIELDS[i.field]).map(i => ({ level: i.severity === 'high' ? 'error' : i.severity === 'medium' ? 'warn' : 'info', path: i.field, message: `${i.problem} — ${i.suggestion}` }));
            next = editArtifactField(next, 'characters', s.characterId, 'critique', { time: now(), strengths: v.strengths ?? [], notes }, { actor: 'ai', summary: `Self-critique: ${fixed} field(s) revised` });
            return { project: next, state: { ...s, polished: fixed } };
        },
    },
];

export const DEFAULT_STEPS = STEPS.map(s => s.id);

/** A new run record (stored in project.generationRuns so it survives reloads and can be retried or discarded). */
export function newRun({ idea = '', dials = {}, steps = DEFAULT_STEPS } = {}) {
    const id = uid('run');
    return { id, started: now(), idea, dials, selected: steps, status: 'running', steps: Object.fromEntries(STEPS.map(s => [s.id, { status: steps.includes(s.id) ? 'pending' : 'skipped' }])), state: { runId: id, idea, created: [] } };
}

/**
 * Run (or resume) a generation. Steps whose dependencies failed are blocked, not attempted.
 * @param {object} opts
 * @param {() => object} opts.getProject
 * @param {(updater: (p: object) => object, label: string) => void} opts.update
 * @param {(taskId: string, args: object) => Promise<{value: any, generation: object}>} opts.runTask
 * @param {object} opts.run run record
 * @param {(run: object) => void} [opts.onRun] called after every state change
 * @param {AbortSignal} [opts.signal]
 */
export async function runPipeline({ getProject, update, runTask, run, onRun = () => {}, signal }) {
    let r = clone(run);
    const save = () => {
        onRun(r);
        update(p => ({ ...p, generationRuns: [...(p.generationRuns ?? []).filter(x => x.id !== r.id), clone(r)] }), 'generation progress');
    };
    r.status = 'running';
    save();
    for (const step of STEPS) {
        const st = r.steps[step.id];
        if (!st || st.status === 'done' || st.status === 'skipped') continue;
        if (signal?.aborted) { r.status = 'cancelled'; save(); return r; }
        const blocked = step.needs.filter(n => r.selected.includes(n) && r.steps[n]?.status !== 'done');
        if (blocked.length) { r.steps[step.id] = { status: 'blocked', error: `Needs: ${blocked.join(', ')}` }; save(); continue; }
        r.steps[step.id] = { status: 'running', startedAt: now() };
        save();
        try {
            const args = step.build(r.state, getProject(), r.dials ?? {});
            let res;
            try {
                res = await runTask(step.task, args);
            } catch (e) {
                // One automatic retry for a stuck or failed call, so a hands-free run survives a provider hiccup.
                if (signal?.aborted) throw e;
                r.steps[step.id] = { status: 'running', startedAt: r.steps[step.id].startedAt, retrying: e?.message ?? String(e) };
                save();
                res = await runTask(step.task, args);
            }
            if (!res) throw new Error('No result');
            let newState = r.state;
            update(p => {
                const out = step.apply(p, res.value, r.state);
                newState = out.state;
                return out.project;
            }, `generate: ${step.label}`);
            r.state = newState;
            let durationMs = res.generation?.durationMs ?? 0;
            // Models sometimes skip parts of a structured answer: ask again for exactly what is still missing.
            let still = step.missing?.(getProject(), r.state) ?? [];
            for (let attempt = 0; still.length && attempt < 2 && !signal?.aborted; attempt++) {
                const fix = await runTask(step.task, { ...step.build(r.state, getProject(), r.dials ?? {}), only: still });
                if (!fix) break;
                const keep = r.state.fillOnly;
                update(p => {
                    const out = step.apply(p, fix.value, { ...r.state, fillOnly: true });
                    newState = { ...out.state, fillOnly: keep };
                    return out.project;
                }, `generate: ${step.label} (missing parts)`);
                r.state = newState;
                durationMs += fix.generation?.durationMs ?? 0;
                still = step.missing(getProject(), r.state);
            }
            r.steps[step.id] = { status: 'done', endedAt: now(), model: res.generation?.label ?? '', durationMs, ...(still.length ? { warning: `Still empty: ${still.join(', ')}` } : {}) };
        } catch (e) {
            r.steps[step.id] = { status: signal?.aborted ? 'cancelled' : 'failed', error: e?.message ?? String(e), endedAt: now() };
            if (signal?.aborted) { r.status = 'cancelled'; save(); return r; }
        }
        save();
    }
    const vals = Object.values(r.steps);
    r.status = vals.some(x => x.status === 'failed' || x.status === 'blocked') ? 'partial' : 'done';
    r.ended = now();
    save();
    return r;
}

/** Mark failed/blocked/cancelled steps pending again so runPipeline retries only those. */
export function retryable(run, stepId) {
    const r = clone(run);
    for (const [id, st] of Object.entries(r.steps)) {
        if ((stepId ? id === stepId : true) && ['failed', 'blocked', 'cancelled', 'running'].includes(st.status)) r.steps[id] = { status: 'pending' };
    }
    return r;
}

/** Remove everything a run created (characters, lorebooks, presets, QR sets). */
export function discardRun(project, run) {
    let p = project;
    for (const { type, id } of run.state?.created ?? []) p = { ...p, [type]: p[type].filter(a => a.id !== id) };
    p = { ...p, generationRuns: (p.generationRuns ?? []).map(x => (x.id === run.id ? { ...x, status: 'discarded' } : x)) };
    return logHistory(p, { actor: 'user', action: 'discard-run', summary: `Discarded generation “${run.state?.premise?.title ?? run.id}”` });
}
