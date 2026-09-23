// Proposal review: original vs proposal, rationale, consequences, accept / revise / reject.
import { html, useState, Button, Icon, Badge, SideBySide, cx } from './kit.js';
import { acceptProposal, rejectProposal, isProposalStale, findArtifact, artifactName, addProposals, createProposal } from '../core/project.js';

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
            : html`<${SideBySide} before=${stale ? currentValue(target, proposal) : proposal.before ?? ''} after=${proposal.after} leftLabel=${stale ? 'Current (changed)' : 'Current'} />`)}
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
