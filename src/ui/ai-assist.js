// The AI controls every text field shares: say what you want, then Add to it (every word already there stays),
// Rewrite, or compare 3 takes. An empty field is written from its context. Character fields and lore entries use it.
import { html, useState, Button } from './kit.js';
import { useAiTask, AiStatus } from './ai.js';
import { pushProposals, isHandsFree } from './proposals.js';
import { joinAddition } from '../ai/tasks.js';
import { uid } from '../core/bytes.js';

/** One-click directions for a field that already has text (the author can always type their own instead). */
export const QUICK_DIRECTIONS = [
    { label: 'More detail', mode: 'add', how: 'more concrete, specific detail the roleplay can use' },
    { label: 'Tighter', mode: 'rewrite', how: 'Make it tighter: keep all the content and facts, use fewer words.' },
    { label: 'Punchier', mode: 'rewrite', how: 'Make it more vivid and specific, stronger for roleplay; keep every fact.' },
];

/**
 * @param {object} o
 * @param {string} o.label      the field's name as the author sees it ("Description", "Content")
 * @param {string} o.value      the text now (drives empty vs. filled)
 * @param {object} o.target     where proposals land ({ type, id, path })
 * @param {() => string} o.current   the text as the store has it right now (what an addition is joined onto)
 * @param {{ id: string, args: (how: string, count: number) => object }} o.rewrite   task that returns { variants }
 * @param {{ id: string, args: (how: string) => object }} o.add                      task that returns { addition, joiner }
 * @param {(text: string) => string} [o.tidy]    clean-up before the text lands
 * @param {string} [o.emptyHint] placeholder when the field is empty
 * @returns {{ actions, panel, status }} header buttons, the direction panel (when open) and the AI status line
 */
export function useAiAssist({ store, project, label, value, target, current, rewrite: rw, add: ad, tidy = t => t, emptyHint }) {
    const [open, setOpen] = useState(false);
    const [instruction, setInstruction] = useState('');
    const ai = useAiTask(store);
    const empty = !String(value ?? '').trim();
    const name = label.toLowerCase();

    /** Write or rewrite: one take lands straight away in hands-free mode; several takes are offered side by side. */
    const rewrite = async (count = 1, how = instruction) => {
        const r = await ai.run(rw.id, rw.args(how, count));
        if (!r) return;
        const group = uid('grp');
        pushProposals(store, r.value.variants.slice(0, count).map(v => ({
            task: rw.id, title: `${label}: ${v.label || 'take'}`, group, target, after: tidy(v.text), rationale: v.rationale, generation: r.generation,
        })), count > 1 ? 'AI takes' : `AI ${empty ? 'wrote' : 'rewrote'} ${label}`, { forceReview: count > 1 });
        setOpen(false);
    };
    /** Add to it: the AI writes only new material, joined on after what the field says now (kept word for word). */
    const add = async (how = instruction) => {
        const before = current();
        const r = await ai.run(ad.id, ad.args(how));
        if (!r) return;
        pushProposals(store, [{
            task: ad.id, title: `${label}: added`, target, rationale: r.value.rationale, generation: r.generation,
            after: tidy(joinAddition(before, r.value.addition, r.value.joiner)),
        }], `AI added to ${label}`);
        setOpen(false);
    };
    const primary = () => (empty ? rewrite(1) : add());

    const actions = html`${empty && html`<${Button} small kind="ai" icon="wand-magic-sparkles" label="Write it" title=${`AI writes the ${name} from its context`} onClick=${() => rewrite(1, '')} disabled=${ai.busy} />`}
        <${Button} small kind=${empty ? '' : 'ai'} icon="wand-magic-sparkles" label="AI" title=${`Tell the AI what to ${empty ? 'write' : 'add or change'} in the ${name}`} onClick=${() => setOpen(!open)} ariaPressed=${open} />`;

    const panel = open && html`<div class="cs-ai-box">
        <input class="text_pole" placeholder=${empty ? (emptyHint ?? `What should the ${name} say? (optional: the AI works from its context)`) : 'What should the AI do? e.g. "add a fear of deep water", "make the voice drier", "mention the scar"'} value=${instruction}
            onInput=${e => setInstruction(e.currentTarget.value)} onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); primary(); } }} aria-label=${`Direction for the ${name}`} />
        <div class="cs-row">
            ${empty
                ? html`<${Button} kind="ai" icon="wand-magic-sparkles" label="Write it" title="Write the field (with your direction, if any)" onClick=${() => rewrite(1)} disabled=${ai.busy} />`
                : html`<${Button} kind="ai" icon="plus" label="Add to it" title="Keeps every word already there and adds new material" onClick=${() => add()} disabled=${ai.busy} />
                    <${Button} icon="rotate" label="Rewrite" title="Replaces the text with a new version (Ctrl+Z brings the old one back)" onClick=${() => rewrite(1)} disabled=${ai.busy} />`}
            <${Button} icon="clone" label="3 takes" title="Three different versions to pick from" onClick=${() => rewrite(3)} disabled=${ai.busy} />
            ${!empty && html`<span class="cs-chips" role="group" aria-label="Quick directions">${QUICK_DIRECTIONS.map(q => html`<button key=${q.label} type="button" class="cs-chip" disabled=${ai.busy}
                title=${q.mode === 'add' ? 'Add to it: more detail' : `Rewrite: ${q.how}`} onClick=${() => (q.mode === 'add' ? add(q.how) : rewrite(1, q.how))}>${q.label}</button>`)}</span>`}
        </div>
        <div class="cs-muted cs-small">${isHandsFree(project) ? 'Lands straight away; Ctrl+Z undoes it.' : 'Waits in the inspector for your OK (Review mode).'} Enter = ${empty ? 'Write it' : 'Add to it'}.</div>
    </div>`;

    return { actions, panel, status: html`<${AiStatus} ai=${ai} />` };
}
