// AI instructions: every instruction the studio gives the model, readable and editable, and the project's content
// level. Edited instructions live in SillyTavern's extension settings (and the studio's settings backup).
import { html, useState, Button, Icon, Badge, Modal, cx } from './kit.js';
import { PROMPT_DEFAULTS, PROMPT_INFO, ADULTS_ONLY } from '../ai/tasks.js';
import { promptOverrides, setPromptOverride, resetAllPrompts } from '../st/prompt-store.js';
import { CONTENT_LEVELS, contentOf } from '../core/content.js';

/** Ask the studio shell to open AI instructions (from the AI setup, the palette or the content pill). */
export function openPromptSettings() {
    globalThis.dispatchEvent(new CustomEvent('cs-prompt-settings'));
}

/** Each content level's sigil (the top-bar pill, the level cards, the level instructions). */
const SIGIL = { sfw: 'shield-halved', mature: 'masks-theater', adult: 'fire' };

/** The project's content level as a small pill for the top bar; opens AI instructions. */
export function ContentPill({ project }) {
    const level = contentOf(project);
    return html`<button class=${cx('cs-content-pill', `is-${level}`)} onClick=${openPromptSettings}
        title=${`Content: ${CONTENT_LEVELS[level].label}. ${CONTENT_LEVELS[level].hint} Click for AI instructions.`}>
        <${Icon} name=${SIGIL[level]} /><span>${CONTENT_LEVELS[level].label}</span>
    </button>`;
}

export function PromptSettings({ store, env, project, onClose }) {
    const [overrides, setOverrides] = useState(() => ({ ...promptOverrides() }));
    const [filter, setFilter] = useState('');
    const [openKey, setOpenKey] = useState(null);
    const level = contentOf(project);
    const setLevel = v => store.update(p => ({ ...p, settings: { ...p.settings, content: v } }), 'content level');
    const text = key => overrides[key] ?? PROMPT_DEFAULTS[key] ?? '';
    const edit = (key, value) => setOverrides({ ...setPromptOverride(key, value) });
    const reset = key => setOverrides({ ...setPromptOverride(key, PROMPT_DEFAULTS[key]) });
    const resetAll = async () => {
        if (!(await env.confirm('Put every instruction back to the default?', 'Your edited instructions are replaced by the studio\'s own.'))) return;
        resetAllPrompts();
        setOverrides({});
    };
    const q = filter.trim().toLowerCase();
    const shown = PROMPT_INFO.filter(i => !q || `${i.group} ${i.label} ${i.key} ${text(i.key)}`.toLowerCase().includes(q));
    const groups = [...new Set(shown.map(i => i.group))];
    const edited = Object.keys(overrides).length;

    return html`<${Modal} title="AI instructions" onClose=${onClose} wide>
        <section class="cs-section">
            <div class="cs-section-head"><span>Content for this project</span></div>
            <div class="cs-content-levels" role="radiogroup" aria-label="Content level">
                ${Object.entries(CONTENT_LEVELS).map(([k, c]) => html`<button key=${k} type="button" role="radio" aria-checked=${level === k}
                    class=${cx('cs-content-level', `is-${k}`, level === k && 'active')} onClick=${() => setLevel(k)}>
                    <span class="cs-content-sigil"><${Icon} name=${SIGIL[k]} /></span>
                    <span class="cs-content-level-text"><strong>${c.label}</strong><span class="cs-muted cs-small">${c.hint}</span></span>
                </button>`)}
            </div>
            <div class="cs-muted cs-small">Goes into every writing task and every picture in this project. The generator's rating dial sets it too. For mature and adult projects the studio always adds: “${ADULTS_ONLY}”</div>
        </section>
        <div class="cs-row">
            <input class="text_pole" style="flex:1" placeholder="Search instructions…" value=${filter} onInput=${e => setFilter(e.currentTarget.value)} aria-label="Search instructions" />
            ${edited > 0 && html`<${Badge} kind="accent">${edited} edited</${Badge}>`}
            <${Button} small icon="rotate-left" label="Reset all" onClick=${resetAll} disabled=${!edited} />
        </div>
        <div class="cs-muted cs-small">These are the instructions the AI gets before your card, lore and request. Edit one to change how the studio writes; the studio fills in the rest.</div>
        ${groups.map(g => html`<div key=${g} class="cs-prompt-group">
            <div class="cs-prompt-group-head">${g}</div>
            ${shown.filter(i => i.group === g).map(i => {
                const isOpen = openKey === i.key || !!q;
                const changed = overrides[i.key] !== undefined;
                const lv = i.key.startsWith('content.') ? i.key.slice(8) : '';
                return html`<div key=${i.key} class=${cx('cs-prompt-item', isOpen && 'open', lv && `is-${lv}`, lv === level && 'current')} title=${lv === level ? 'In use for this project' : undefined}>
                    <button type="button" class="cs-prompt-head" aria-expanded=${isOpen} onClick=${() => setOpenKey(openKey === i.key ? null : i.key)}>
                        <${Icon} name=${isOpen ? 'caret-down' : 'caret-right'} />
                        ${lv && html`<span class="cs-prompt-sigil"><${Icon} name=${SIGIL[lv]} /></span>`}
                        <span class="cs-grow">${i.label}</span>
                        ${changed && html`<${Badge} kind="accent">edited</${Badge}>`}
                    </button>
                    ${isOpen && html`<div class="cs-prompt-body">
                        ${i.note && html`<div class="cs-muted cs-small">${i.note}</div>`}
                        <textarea class="text_pole cs-textarea cs-prompt-text" rows=${Math.min(14, Math.max(4, Math.ceil(text(i.key).length / 110)))} value=${text(i.key)}
                            onInput=${e => edit(i.key, e.currentTarget.value)} aria-label=${i.label}></textarea>
                        <div class="cs-row cs-small">
                            <span class="cs-muted">${changed ? 'Your version is used.' : 'The studio\'s default.'}</span>
                            <span class="cs-spacer"></span>
                            ${changed && html`<${Button} small icon="rotate-left" label="Reset to default" onClick=${() => reset(i.key)} />`}
                        </div>
                    </div>`}
                </div>`;
            })}
        </div>`)}
        ${!groups.length && html`<div class="cs-muted">No instruction matches.</div>`}
    </${Modal}>`;
}
