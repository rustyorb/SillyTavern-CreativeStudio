import { html } from './kit.js';
import { precedingFields, selectedContextFields, contextValue } from '../core/field-context.js';
import { editArtifactField, findArtifact } from '../core/project.js';

/** Preferences live on the studio character, outside exported card data. Read current values at send time. */
export function characterContext({ store, project, ch, field }) {
    const fields = precedingFields(field);
    const selected = selectedContextFields(ch, field);
    const toggle = (key, checked) => store.update(p => {
        const current = p.id === project.id && findArtifact(p, 'characters', ch.id);
        if (!current) return p;
        const excluded = new Set(fields.map(([id]) => id).filter(id => !selectedContextFields(current, field).includes(id)));
        if (checked) excluded.delete(key); else excluded.add(key);
        return editArtifactField(p, 'characters', ch.id, `aiContextExcluded.${field}`, [...excluded], { summary: `Changed AI context for ${field}` });
    }, `AI context ${ch.id} ${field}`);
    return {
        args: () => {
            const current = store.get().id === project.id && findArtifact(store.get(), 'characters', ch.id);
            if (!current) throw new Error('This character is no longer open in this project.');
            return { card: current.card, field, contextFields: selectedContextFields(current, field),
                voiceDirection: ['first_mes', 'mes_example', 'alternate_greetings', 'group_only_greetings'].includes(field) ? current.voiceDirection ?? '' : '' };
        },
        panel: html`<fieldset class="cs-field-context">
            <legend>Use earlier fields</legend>
            ${fields.length ? html`<div class="cs-context-options">${fields.map(([key, label]) => html`<label key=${key} class="cs-toggle">
                <input type="checkbox" checked=${selected.includes(key)} onChange=${e => toggle(key, e.currentTarget.checked)} />
                <span>${label}${!contextValue(ch.card.data[key]).trim() && html`<small class="cs-muted"> (empty)</small>`}</span>
            </label>`)}</div>` : html`<div class="cs-muted cs-small">Name is the first field; there are no earlier fields.</div>`}
            <div class="cs-muted cs-small">Checked fields are included in full. Your direction and this field’s current text are always included. Choices are saved for this field and character.</div>
        </fieldset>`,
    };
}
