// Proposal review: original vs proposal, rationale, consequences, accept / revise / reject.
import { html, useState, Button, Icon, Badge, SideBySide, cx } from './kit.js';
import { acceptProposal, rejectProposal, isProposalStale, findArtifact, artifactName, addProposals, createProposal } from '../core/project.js';
import { diffCc } from '../core/preset.js';

export function ProposalCard({ store, project, proposal, compact }) {
    const [revising, setRevising] = useState(false);
    const [draft, setDraft] = useState(() => (typeof proposal.after === 'string' ? proposal.after : JSON.stringify(proposal.after, null, 2)));
    const [err, setErr] = useState('');
    const stale = proposal.status === 'pending' && isProposalStale(project, proposal);
    const target = proposal.target.id ? findArtifact(project, proposal.target.type, proposal.target.id) : null;
    const targetLabel = proposal.target.id ? `${target ? artifactName(proposal.target.type, target) : '(deleted)'}${proposal.target.path ? ` · ${prettyPath(proposal.target.path)}` : ''}` : `New ${proposal.target.type.replace(/s$/, '')}`;

    const accept = value => {
        try {
            store.update(p => acceptProposal(p, proposal.id, value), `accept: ${proposal.title || proposal.task}`);
            setErr('');
        } catch (e) { setErr(e.message); }
    };
    const acceptRevised = () => {
        if (typeof proposal.after === 'string') return accept(draft);
        try { accept(JSON.parse(draft)); } catch (e) { setErr(`Invalid JSON: ${e.message}`); }
    };
    const reject = () => store.update(p => rejectProposal(p, proposal.id), 'reject proposal');

    return html`<article class=${cx('cs-proposal', stale && 'stale')} aria-label=${`Proposal: ${proposal.title || proposal.task}`}>
        <div class="cs-proposal-head">
            <div>
                <div class="cs-proposal-title">${proposal.title || proposal.task}</div>
                <div class="cs-proposal-meta">${targetLabel}</div>
            </div>
            <${Badge} kind=${proposal.status === 'accepted' ? 'ok' : proposal.status === 'rejected' ? 'err' : proposal.status === 'pending' ? 'accent' : ''}>${proposal.status}</${Badge}>
        </div>
        ${proposal.rationale && html`<div class="cs-rationale">${proposal.rationale}</div>`}
        ${stale && html`<div class="cs-warn-text cs-small"><${Icon} name="triangle-exclamation" /> The target changed since this was generated. Review the diff against the current value before accepting.</div>`}
        ${proposal.consequences?.length > 0 && html`<ul class="cs-small cs-muted">${proposal.consequences.map(c => html`<li>${c}</li>`)}</ul>`}
        ${!compact && (revising
            ? html`<textarea class="text_pole cs-textarea" rows="8" value=${draft} onInput=${e => setDraft(e.currentTarget.value)} aria-label="Revise proposal"></textarea>`
            : html`<${ProposalBody} proposal=${proposal} before=${stale ? currentValue(target, proposal) : proposal.before} />`)}
        ${err && html`<div class="cs-err-text cs-small">${err}</div>`}
        <div class="cs-proposal-meta">${proposal.generation?.label ?? proposal.generation?.profileName ?? ''}${proposal.generation?.model ? ` · ${proposal.generation.model}` : ''} · ${new Date(proposal.created).toLocaleString()}</div>
        ${proposal.status === 'pending' && html`<div class="cs-row">
            ${revising
                ? html`<${Button} small kind="primary" icon="check" label="Accept revised" onClick=${acceptRevised} />
                       <${Button} small label="Cancel edit" onClick=${() => setRevising(false)} />`
                : html`<${Button} small kind="primary" icon="check" label="Accept" onClick=${() => accept()} />
                       <${Button} small icon="pen" label="Revise…" onClick=${() => setRevising(true)} />`}
            <${Button} small icon="xmark" kind="danger" label="Reject" onClick=${reject} />
        </div>`}
    </article>`;
}

/** Type-aware rendering of what a proposal would change. */
function ProposalBody({ proposal, before }) {
    const after = proposal.after;
    if (!proposal.target.id) {
        if (proposal.target.type === 'characters') {
            const c = after?.concept;
            return html`<div class="cs-small">${c ? html`<strong>${c.name}</strong> — ${c.hook}<br /><span class="cs-muted">Voice: ${c.voice}</span>` : html`New character <strong>${after?.card?.data?.name}</strong>`}</div>`;
        }
        if (proposal.target.type === 'lorebooks') {
            const entries = Object.values(after?.data?.entries ?? {});
            return html`<div class="cs-small"><strong>${after?.name}</strong>: ${entries.length} entries<ul style="margin:2px 0 0 16px;padding:0">${entries.slice(0, 12).map(e => html`<li>${e.comment} <span class="cs-muted">(${(e.key ?? []).join(', ')})</span></li>`)}</ul></div>`;
        }
        return html`<pre class="cs-pre">${summarize(after)}</pre>`;
    }
    if (proposal.target.type === 'presets' && proposal.target.path === 'data' && Array.isArray(after?.prompts) && before) {
        const d = diffCc(before, after);
        return html`<div class="cs-small">
            ${d.prompts.map(x => html`<div><${Badge} kind=${x.kind === 'added' ? 'ok' : x.kind === 'removed' ? 'err' : 'warn'}>${x.kind}</${Badge}> ${x.name ?? x.id}</div>`)}
            ${d.orderChanged && html`<div class="cs-muted">Prompt order changed.</div>`}
            ${d.settings.length > 0 && html`<div class="cs-muted">Settings: ${d.settings.map(s => s.path).join(', ')}</div>`}
            <div class="cs-muted">Open the preset to review each prompt.</div>
        </div>`;
    }
    if (Array.isArray(after) && after.every(x => typeof x === 'string') && (before === undefined || Array.isArray(before))) {
        const prev = new Set(before ?? []);
        const next = new Set(after);
        const added = after.filter(x => !prev.has(x));
        const removed = (before ?? []).filter(x => !next.has(x));
        return html`<div class="cs-diff"><div class="cs-diff-body">
            ${added.map(x => html`<div class="cs-seg-ins">+ ${x}</div>`)}
            ${removed.map(x => html`<div class="cs-seg-del">− ${x}</div>`)}
            ${!added.length && !removed.length && html`<div class="cs-muted">Order changes only.</div>`}
        </div></div>`;
    }
    if (after && typeof after === 'object' && !Array.isArray(after) && 'content' in after && 'key' in after) {
        return html`<div class="cs-small"><strong>${after.comment}</strong> <span class="cs-muted">keys: ${(after.key ?? []).join(', ')}</span><div style="white-space:pre-wrap">${after.content}</div></div>`;
    }
    return html`<${SideBySide} before=${before ?? ''} after=${after} leftLabel="Current" />`;
}

function summarize(v) {
    const s = JSON.stringify(v, null, 1) ?? '';
    return s.length > 1500 ? `${s.slice(0, 1500)}…` : s;
}

function currentValue(target, proposal) {
    if (!target) return '';
    let cur = target;
    for (const part of proposal.target.path?.match(/[^.[\]]+/g) ?? []) cur = cur?.[/^\d+$/.test(part) ? Number(part) : part];
    return cur ?? '';
}

export function prettyPath(path) {
    return path.replace(/^card\.data\./, '').replace(/^data\.entries\./, 'entry ').replace(/_/g, ' ');
}

/** Convenience: add several proposals in one undoable step. */
export function pushProposals(store, specs, label = 'AI proposals') {
    store.update(p => addProposals(p, specs.map(s => createProposal(p, s))), label);
}

/** Inline list of pending proposals for one artifact (shown next to the editor). */
export function PendingFor({ store, project, type, id, path }) {
    const list = project.proposals.filter(p => p.status === 'pending' && p.target.type === type && p.target.id === id && (!path || p.target.path === path));
    if (!list.length) return null;
    return html`<div class="cs-stack">${list.map(p => html`<${ProposalCard} key=${p.id} store=${store} project=${project} proposal=${p} />`)}</div>`;
}
