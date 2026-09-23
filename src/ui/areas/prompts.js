import { html, Empty } from '../kit.js';
import { uid } from '../../core/bytes.js';
export function PromptsArea() {
    return html`<${Empty} icon="hammer" title="prompts">Under construction.</${Empty}>`;
}
export const newPresetArtifact = (kind, name) => ({ id: uid('pre'), kind, name, data: {}, origin: { kind: 'new' } });
