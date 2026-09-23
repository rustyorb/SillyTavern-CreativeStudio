import { html, Empty } from '../kit.js';
import { uid } from '../../core/bytes.js';
export function RegexArea() {
    return html`<${Empty} icon="hammer" title="regex">Under construction.</${Empty}>`;
}
export const newRegexArtifact = name => ({ id: uid('rx'), scope: 'global', ownerId: '', script: { id: uid(), scriptName: name, findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null } });
