// Project bundle: SillyTavern-native files + manifest + install README, plus the full studio project for re-import.
// Pure: callers supply image bytes; returns a map of zip paths → bytes (zipped by the caller with fflate).

import { utf8Encode, utf8Decode, clone } from './bytes.js';
import { exportCard } from './cardio.js';
import { isPng, readCardChunks } from './png.js';
import { unzipSync } from '../../vendor/fflate.mjs';
import { artifactName, dependencyReport, cardForSt, PROJECT_SCHEMA } from './project.js';
import { KINDS, stripSensitive } from './preset.js';


const safe = s => String(s || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'untitled';

/**
 * @param {object} project
 * @param {{ images?: Record<string, Uint8Array>, assetFiles?: Record<string, Record<string, Uint8Array>>, cardFormat?: 'png-st'|'png-v3', includeCharx?: boolean, stVersion?: string }} opts
 *   images: characterId → PNG bytes; assetFiles: characterId → {zipPath: bytes}
 * @returns {{ files: Record<string, Uint8Array>, manifest: object, notes: string[] }}
 */
export function buildBundle(project, opts = {}) {
    const files = {};
    const notes = [];
    const put = (path, value) => { files[path] = typeof value === 'string' ? utf8Encode(value) : value; };
    const entries = [];
    const cardFormat = opts.cardFormat ?? 'png-v3';

    // Each card names its lorebook by the file name it has in this bundle, so ST links them on import.
    const worldOf = lb => safe(lb.name);
    const cards = new Map(project.characters.map(c => [c.id, cardForSt(project, c, worldOf)]));
    for (const c of project.characters) {
        const name = safe(c.card.data.name);
        const r = exportCard(cardFormat, { card: cards.get(c.id), topLevelExtras: c.topLevelExtras, image: opts.images?.[c.id] ?? null });
        put(`characters/${name}.png`, r.bytes);
        notes.push(...r.notes.map(n => `${name}: ${n}`));
        entries.push({ type: 'character', name: c.card.data.name, path: `characters/${name}.png`, format: cardFormat, embeddedLorebook: !!c.card.data.character_book?.entries?.length, scopedRegex: c.card.data.extensions?.regex_scripts?.length ?? 0 });
        if (opts.includeCharx) {
            const x = exportCard('charx', { card: cards.get(c.id), topLevelExtras: c.topLevelExtras, image: opts.images?.[c.id] ?? null, assetFiles: opts.assetFiles?.[c.id] ?? {} });
            put(`characters/${name}.charx`, x.bytes);
            entries.push({ type: 'character-charx', name: c.card.data.name, path: `characters/${name}.charx` });
        }
    }
    for (const lb of project.lorebooks) {
        const name = safe(lb.name);
        const data = clone(lb.data);
        delete data.originalData;
        put(`worlds/${name}.json`, JSON.stringify(data, null, 4));
        const linkedBy = project.characters.filter(c => cards.get(c.id).data.extensions?.world === name).map(c => c.card.data.name);
        entries.push({ type: 'lorebook', name: lb.name, path: `worlds/${name}.json`, entries: Object.keys(data.entries ?? {}).length, linkedBy });
    }
    for (const pr of project.presets) {
        const name = safe(pr.name);
        let data = clone(pr.data);
        if (pr.kind === 'cc') data = stripSensitive(data);
        if (['instruct', 'context', 'sysprompt', 'reasoning'].includes(pr.kind)) data.name = pr.name;
        const folder = { cc: 'OpenAI Settings', textgen: 'TextGen Settings', instruct: 'instruct', context: 'context', sysprompt: 'sysprompt', reasoning: 'reasoning' }[pr.kind];
        put(`presets/${folder}/${name}.json`, JSON.stringify(data, null, 4));
        entries.push({ type: 'preset', kind: pr.kind, apiId: KINDS[pr.kind].apiId, name: pr.name, path: `presets/${folder}/${name}.json`, presetRegex: data.extensions?.regex_scripts?.length ?? 0 });
    }
    if (project.regexScripts.length) {
        put('regex/global-regex.json', JSON.stringify(project.regexScripts.map(r => r.script), null, 4));
        entries.push({ type: 'regex', scope: 'global', path: 'regex/global-regex.json', count: project.regexScripts.length });
    }
    for (const s of project.qrSets) {
        const name = safe(s.data.name);
        put(`quick-replies/${name}.json`, JSON.stringify(s.data, null, 4));
        entries.push({ type: 'quick-reply-set', name: s.data.name, path: `quick-replies/${name}.json`, buttons: s.data.qrList.length, links: { global: s.links?.global ?? true, characters: (s.links?.characters ?? []).map(id => project.characters.find(c => c.id === id)?.card.data.name).filter(Boolean) } });
    }
    for (const cp of project.connectionProfiles) {
        entries.push({ type: 'connection-profile', name: cp.name, note: 'Reference only: recreate in Connection Profiles; API keys are never exported.', selects: pickSelections(cp.data) });
    }

    const deps = dependencyReport(project);
    const manifest = {
        schema: 'st-creative-studio/bundle',
        version: 1,
        project: { id: project.id, name: project.name, premise: project.premise ?? '' },
        created: new Date().toISOString(),
        target: { app: 'SillyTavern', version: opts.stVersion ?? '1.19.0' },
        entries,
        dependencies: deps.map(d => ({ character: d.name, needs: d.needs.map(n => ({ type: n.type, name: n.name })), missing: d.missing })),
        extensionData: [...new Set(project.characters.flatMap(c => Object.keys(c.card.data.extensions ?? {})))].filter(k => !['talkativeness', 'fav', 'world', 'depth_prompt', 'regex_scripts'].includes(k)),
    };
    put('manifest.json', JSON.stringify(manifest, null, 2));
    put('README.md', readme(project, manifest, deps));
    const studio = clone(project);
    studio.history = studio.history.slice(-500);
    put('project.studio.json', JSON.stringify(studio));
    return { files, manifest, notes };
}

function pickSelections(p) {
    const o = {};
    for (const k of ['api', 'model', 'preset', 'instruct', 'context', 'sysprompt', 'reasoning-template', 'regex-preset']) if (p?.[k]) o[k] = p[k];
    return o;
}

function readme(project, manifest, deps) {
    const L = [];
    L.push(`# ${project.name}`, '');
    if (project.premise) L.push(project.premise, '');
    L.push(`Built with Creative Studio for SillyTavern ${manifest.target.version}. This bundle contains SillyTavern-native files. Install them in the order below.`, '');
    const by = t => manifest.entries.filter(e => e.type === t);
    let n = 1;
    if (by('preset').length) {
        L.push(`## ${n++}. Presets and templates`, '');
        for (const e of by('preset')) {
            const where = {
                cc: 'AI Response Configuration (Chat Completion) → Import preset',
                textgen: 'AI Response Configuration (Text Completion) → Import preset',
                instruct: 'Advanced Formatting → Instruct Template → Import',
                context: 'Advanced Formatting → Context Template → Import',
                sysprompt: 'Advanced Formatting → System Prompt → Import',
                reasoning: 'Advanced Formatting → Reasoning → Import',
            }[e.kind];
            L.push(`- \`${e.path}\` — ${KINDS[e.kind].label} “${e.name}”: ${where}.${e.presetRegex ? ` Carries ${e.presetRegex} preset-scoped regex script(s); ST asks to allow them when the preset is selected.` : ''}`);
        }
        L.push('');
    }
    if (by('lorebook').length) {
        L.push(`## ${n++}. World Info`, '');
        for (const e of by('lorebook')) L.push(`- \`${e.path}\` (${e.entries} entries): World Info panel → Import. ${e.linkedBy?.length ? `${e.linkedBy.join(', ')} already name${e.linkedBy.length === 1 ? 's' : ''} it as ${e.linkedBy.length === 1 ? 'its' : 'their'} lorebook, so the link is made once both are imported.` : 'Then link it to a character (globe icon on the character card) or enable it globally.'}`);
        L.push('');
    }
    if (by('character').length) {
        L.push(`## ${n++}. Characters`, '');
        for (const e of by('character')) {
            L.push(`- \`${e.path}\` — “${e.name}”: Characters → Import (PNG).${e.embeddedLorebook ? ' It has an embedded lorebook; accept ST’s prompt to import it.' : ''}${e.scopedRegex ? ` It carries ${e.scopedRegex} character-scoped regex script(s); allow them when ST asks.` : ''}`);
        }
        const charx = by('character-charx');
        if (charx.length) L.push(`- CHARX copies (${charx.map(e => `\`${e.path}\``).join(', ')}) carry embedded assets; ST imports CHARX (icon → avatar, emotions → sprites, backgrounds) but cannot export it.`);
        L.push('');
    }
    if (by('regex').length) {
        L.push(`## ${n++}. Global regex`, '', '- `regex/global-regex.json`: Extensions → Regex → Import (Global). ST assigns new ids on import.', '');
    }
    if (by('quick-reply-set').length) {
        L.push(`## ${n++}. Quick Replies`, '');
        for (const e of by('quick-reply-set')) L.push(`- \`${e.path}\` (${e.buttons} buttons): Extensions → Quick Reply → Import set. Intended links: ${[e.links.global ? 'global' : null, ...e.links.characters.map(c => `character “${c}”`)].filter(Boolean).join(', ') || 'none'}.`);
        L.push('');
    }
    if (by('connection-profile').length) {
        L.push(`## ${n++}. Connection profiles (reference)`, '');
        for (const e of by('connection-profile')) L.push(`- “${e.name}”: ${Object.entries(e.selects).map(([k, v]) => `${k}=${v}`).join(', ')}. Recreate it in Connection Profiles after importing the presets above.`);
        L.push('');
    }
    if (manifest.extensionData.length) {
        L.push('## Extension data carried by cards', '', ...manifest.extensionData.map(k => `- \`${k}\`: only useful if the matching extension is installed.`), '');
    }
    const missing = deps.flatMap(d => d.missing.map(m => `${d.name}: ${m}`));
    if (missing.length) L.push('## Missing links (fix before sharing)', '', ...missing.map(m => `- ${m}`), '');
    L.push('## Re-opening in Creative Studio', '', '`project.studio.json` is the full project (including history and AI proposals). Import it from the Project area.', '');
    return L.join('\n');
}

export function isStudioProjectFile(json) {
    return json?.schema === PROJECT_SCHEMA;
}

const isJpeg = b => b[0] === 0xff && b[1] === 0xd8;
const isGif = b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
const isWebp = b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
const CARD_FIELDS_V1 = ['description', 'first_mes', 'personality', 'scenario', 'mes_example'];
const looksLikeCard = j => !!j && typeof j === 'object'
    && (/^chara_card_v[23]$/.test(j.spec ?? '') || (typeof j.name === 'string' && CARD_FIELDS_V1.some(k => k in j)));

/**
 * What a dropped or opened file is, without parsing it in full: a character card ('card'), a Creative Studio
 * project or bundle ('project'), a picture with no card data in it ('image'), or anything else ('unknown').
 * YAML counts as a card so the card importer can explain how to bring it in.
 */
export function detectImportKind(bytes, fileName = '') {
    if (isPng(bytes)) return readCardChunks(bytes).winner ? 'card' : 'image';
    if (isJpeg(bytes) || isGif(bytes) || isWebp(bytes)) return 'image';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        let names;
        try {
            names = Object.keys(unzipSync(bytes, { filter: f => f.name === 'project.studio.json' || f.name === 'card.json' }));
        } catch {
            return 'unknown';
        }
        return names.includes('project.studio.json') ? 'project' : names.includes('card.json') ? 'card' : 'unknown';
    }
    if (/\.ya?ml$/i.test(fileName)) return 'card';
    let json;
    try {
        json = JSON.parse(utf8Decode(bytes).replace(/^﻿/, ''));
    } catch {
        return 'unknown';
    }
    return isStudioProjectFile(json) ? 'project' : looksLikeCard(json) ? 'card' : 'unknown';
}

export { artifactName };
