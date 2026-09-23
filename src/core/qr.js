// Quick Reply v2 sets (SillyTavern 1.19 quick-reply extension). See docs/research/st-formats.md §D.

import { clone } from './bytes.js';

export const QR_FLAGS = [
    ['executeOnStartup', 'On startup'],
    ['executeOnUser', 'After user message'],
    ['executeOnAi', 'After AI message'],
    ['executeOnChatChange', 'On chat change'],
    ['executeOnGroupMemberDraft', 'On group member draft'],
    ['executeOnNewChat', 'On new chat'],
    ['executeBeforeGeneration', 'Before generation'],
];

export function newSet(name) {
    return { version: 2, name, disableSend: false, placeBeforeInput: false, injectInput: false, color: 'transparent', onlyBorderColor: false, qrList: [], idIndex: 0 };
}

/** New QR with ST's id quirk: id = max(idIndex, maxId) + 1; idIndex = id + 1. */
export function addQr(set, props = {}) {
    const s = clone(set);
    const maxId = Math.max(0, ...s.qrList.map(q => q.id ?? 0));
    const id = Math.max(s.idIndex ?? 0, maxId) + 1;
    s.idIndex = id + 1;
    const qr = {
        id, showLabel: false, label: '', title: '', message: '', contextList: [], preventAutoExecute: true, isHidden: false,
        executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false, executeOnGroupMemberDraft: false,
        executeOnNewChat: false, executeBeforeGeneration: false, automationId: '', ...props, id,
    };
    s.qrList.push(qr);
    return { set: s, qr };
}

/** Accept v2 sets, v1 sets (migrated like ST's loadSets) and single-QR exports. */
export function importQrJson(json, fileName = '') {
    if (json && Number.isInteger(json.version) && typeof json.name === 'string') {
        return { kind: 'set', set: { ...newSet(json.name), ...clone(json), qrList: (json.qrList ?? []).map(q => ({ ...q })) }, notes: [] };
    }
    if (json && Array.isArray(json.quickReplySlots)) {
        const set = newSet(json.name ?? fileName.replace(/\.json$/i, ''));
        set.disableSend = !!json.quickActionEnabled;
        set.placeBeforeInput = !!json.placeBeforeInputEnabled;
        set.injectInput = !!json.AutoInputInject;
        set.qrList = json.quickReplySlots.map((slot, i) => ({
            id: i + 1, showLabel: false, label: slot.label ?? '', title: slot.title ?? '', message: slot.mes ?? '', contextList: (slot.contextMenu ?? []).map(c => ({ set: c.preset, isChained: !!c.chain })),
            preventAutoExecute: slot.preventAutoExecute ?? true, isHidden: !!slot.hidden, executeOnStartup: !!slot.autoExecute_appStartup, executeOnUser: !!slot.autoExecute_userMessage,
            executeOnAi: !!slot.autoExecute_botMessage, executeOnChatChange: !!slot.autoExecute_chatLoad, executeOnGroupMemberDraft: !!slot.autoExecute_groupMemberDraft,
            executeOnNewChat: !!slot.autoExecute_newChat, executeBeforeGeneration: !!slot.autoExecute_beforeGeneration, automationId: slot.automationId ?? '',
        }));
        return { kind: 'set', set, notes: ['Converted a legacy v1 set to v2 (SillyTavern’s UI importer rejects v1 files; the exported file is v2).'] };
    }
    if (json && typeof json.label === 'string' && typeof json.message === 'string') {
        return { kind: 'qr', qr: clone(json), notes: [] };
    }
    throw new Error('Not a Quick Reply set (v1/v2) or single-QR export');
}

/**
 * Validate a set in the context of a project (other sets, lorebook automation ids).
 * @returns {{level: string, path: string, message: string, qrId?: number}[]}
 */
export function lintSet(set, { setNames = [], automationIds = new Set() } = {}) {
    const issues = [];
    const labels = new Map();
    if (!set.name?.trim()) issues.push({ level: 'error', path: 'name', message: 'Set name is required.' });
    for (const q of set.qrList ?? []) {
        const p = `#${q.id} ${q.label || '(no label)'}`;
        if (!q.label?.trim() && !q.icon) issues.push({ level: 'warn', path: p, message: 'No label and no icon: the button is invisible and cannot be called by label.', qrId: q.id });
        labels.set(q.label, (labels.get(q.label) ?? 0) + 1);
        for (const c of q.contextList ?? []) if (!setNames.includes(c.set)) issues.push({ level: 'warn', path: p, message: `Context menu references set "${c.set}", which is not in this project (ST drops unknown links).`, qrId: q.id });
        if (q.automationId && !automationIds.has(q.automationId)) issues.push({ level: 'info', path: p, message: `Automation ID "${q.automationId}" is not used by any project lorebook entry.`, qrId: q.id });
        const auto = QR_FLAGS.some(([k]) => q[k]);
        if (q.isHidden && !auto && !q.automationId) issues.push({ level: 'warn', path: p, message: 'Hidden, with no auto-execute trigger or automation ID: it only runs when called by /run.', qrId: q.id });
        if (q.executeOnAi && /\/(gen|trigger|send|sendas)\b/.test(q.message ?? '') && !q.preventAutoExecute) issues.push({ level: 'warn', path: p, message: 'Runs after every AI message and itself generates/sends: this can loop. Keep “Don’t trigger auto-execute” on.', qrId: q.id });
        if (!String(q.message ?? '').trim()) issues.push({ level: 'info', path: p, message: 'Empty message.', qrId: q.id });
        if (set.disableSend && String(q.message ?? '').trimStart().startsWith('/')) issues.push({ level: 'info', path: p, message: 'Set has “Disable send” on: the script is placed in the input box instead of running.', qrId: q.id });
    }
    for (const [l, n] of labels) if (n > 1 && l) issues.push({ level: 'warn', path: l, message: `Label "${l}" is used ${n} times; /run Set.Label finds the first.` });
    return issues;
}
