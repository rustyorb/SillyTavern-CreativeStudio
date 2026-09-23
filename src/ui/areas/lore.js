import { html, Empty } from '../kit.js';
import { uid } from '../../core/bytes.js';
export function LoreArea() {
    return html`<${Empty} icon="hammer" title="lore">Under construction.</${Empty}>`;
}
export const newLorebookArtifact = name => ({ id: uid('lb'), name, data: { entries: {} }, origin: { kind: 'new' } });
