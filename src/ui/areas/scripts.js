import { html, Empty } from '../kit.js';
import { uid } from '../../core/bytes.js';
export function ScriptsArea() {
    return html`<${Empty} icon="hammer" title="scripts">Under construction.</${Empty}>`;
}
export const newQrSetArtifact = name => ({ id: uid('qrs'), name, data: { version: 2, name, qrList: [] } });
