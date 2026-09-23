// Card import/export orchestration (format-agnostic, no DOM, no ST).
import { readCardChunks, writeCardChunks, isPng, blankPng } from './png.js';
import { normalizeToV3, toSpecV2, toSpecV3, toSillyTavernShape, validateCardV3 } from './card.js';
import { readCharx, writeCharx, embeddedPath, suggestedAssetPath } from './charx.js';
import { utf8Decode, utf8Encode } from './bytes.js';

/**
 * Parse any supported card file.
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @returns {{ card: any, topLevelExtras: any, format: string, report: any[], diagnostics: string[], image: Uint8Array|null, assetFiles: Record<string, Uint8Array> }}
 */
export function importCardFile(bytes, fileName = '') {
    const lower = fileName.toLowerCase();
    if (isPng(bytes)) {
        const meta = readCardChunks(bytes);
        if (!meta.winner) throw new Error('This PNG has no character card data (no chara/ccv3 chunk).');
        const raw = meta.winner === 'ccv3' ? meta.ccv3 : meta.chara;
        const json = JSON.parse(raw);
        const { card, topLevelExtras, report } = normalizeToV3(json);
        const diagnostics = [...meta.diagnostics, `Read the '${meta.winner}' chunk${meta.ccv3 && meta.chara ? " (PNG has both; 'ccv3' wins, as in SillyTavern)" : ''}.`];
        if (meta.ccv3 && meta.chara) {
            try {
                const other = JSON.parse(meta.chara);
                if (other?.data?.name !== card.data.name) diagnostics.push("The 'chara' and 'ccv3' chunks disagree about the name; the V2 fallback may be stale.");
            } catch { diagnostics.push("The 'chara' chunk is not valid JSON."); }
        }
        return { card, topLevelExtras, format: `png/${meta.winner}`, report, diagnostics, image: bytes, assetFiles: {} };
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const r = readCharx(bytes);
        const icon = r.assets.find(a => a.asset.type === 'icon' && a.asset.name === 'main' && a.bytes) ?? r.assets.find(a => a.asset.type === 'icon' && a.bytes);
        const assetFiles = { ...r.files };
        delete assetFiles['card.json'];
        return { card: r.card, topLevelExtras: r.topLevelExtras, format: 'charx', report: r.report, diagnostics: r.diagnostics, image: icon?.bytes ?? null, assetFiles };
    }
    const text = utf8Decode(bytes).replace(/^﻿/, '');
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) throw new Error('YAML cards: import them through SillyTavern (Characters → Import), then pull them into the studio from ST.');
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error(`Not a PNG, CHARX or JSON card: ${e.message}`);
    }
    const { card, topLevelExtras, report } = normalizeToV3(json);
    return { card, topLevelExtras, format: 'json', report, diagnostics: [], image: null, assetFiles: {} };
}

/**
 * Export a card.
 * @param {'png-st'|'png-v3'|'json-v3'|'json-v2'|'json-st'|'charx'} kind
 * @param {{ card: any, topLevelExtras?: any, image?: Uint8Array|null, assetFiles?: Record<string, Uint8Array> }} src
 * @returns {{ bytes: Uint8Array, ext: string, mime: string, notes: string[] }}
 */
export function exportCard(kind, { card, topLevelExtras = {}, image = null, assetFiles = {} }) {
    const notes = [];
    const errors = validateCardV3(card).filter(i => i.level === 'error');
    if (errors.length) notes.push(`${errors.length} specification error(s) remain (see Compatibility).`);
    switch (kind) {
        case 'png-st': {
            // Exactly what SillyTavern 1.19 writes: the same V2-shaped JSON in 'chara' and (relabelled) 'ccv3'.
            const st = toSillyTavernShape(card, topLevelExtras);
            const v3 = { ...st, spec: 'chara_card_v3', spec_version: '3.0' };
            notes.push("SillyTavern-style PNG: both chunks carry the same data; 'ccv3' is relabelled V2-shaped JSON, as ST itself writes.");
            return { bytes: writeCardChunks(image ?? blankPng(), { chara: JSON.stringify(st), ccv3: JSON.stringify(v3) }), ext: 'png', mime: 'image/png', notes };
        }
        case 'png-v3': {
            const { card: v2, dropped } = toSpecV2(card);
            if (dropped.length) notes.push(`V2 fallback chunk omits V3-only fields: ${dropped.join(', ')} (they are in the ccv3 chunk).`);
            const embedded = (card.data.assets ?? []).filter(a => embeddedPath(a.uri));
            if (embedded.length) notes.push(`${embedded.length} asset(s) use embeded:// URIs, which only resolve inside CHARX. Use CHARX to ship them.`);
            return { bytes: writeCardChunks(image ?? blankPng(), { chara: JSON.stringify(v2), ccv3: JSON.stringify(toSpecV3(card)) }), ext: 'png', mime: 'image/png', notes };
        }
        case 'json-v3':
            return { bytes: utf8Encode(JSON.stringify(toSpecV3(card), null, 2)), ext: 'json', mime: 'application/json', notes };
        case 'json-v2': {
            const { card: v2, dropped } = toSpecV2(card);
            if (dropped.length) notes.push(`Lossy: V2 cannot hold ${dropped.join(', ')}.`);
            return { bytes: utf8Encode(JSON.stringify(v2, null, 2)), ext: 'json', mime: 'application/json', notes };
        }
        case 'json-st':
            return { bytes: utf8Encode(JSON.stringify(toSillyTavernShape(card, topLevelExtras), null, 2)), ext: 'json', mime: 'application/json', notes };
        case 'charx': {
            const files = { ...assetFiles };
            const c = structuredClone(card);
            c.data.assets ??= [];
            if (image && !c.data.assets.some(a => a.type === 'icon')) {
                const p = suggestedAssetPath('icon', 'main', 'png');
                files[p] = image;
                c.data.assets.push({ type: 'icon', uri: `embeded://${p}`, name: 'main', ext: 'png' });
                notes.push('Added the card image as the main icon asset.');
            }
            if (!c.data.assets.length) c.data.assets.push({ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' });
            const r = writeCharx(c, files);
            notes.push(...r.diagnostics);
            notes.push('SillyTavern 1.19 imports CHARX but cannot export it; keep this file as your master copy.');
            return { bytes: r.bytes, ext: 'charx', mime: 'application/zip', notes };
        }
        default:
            throw new Error(`Unknown export kind ${kind}`);
    }
}

export const EXPORT_KINDS = [
    { id: 'png-st', label: 'PNG (SillyTavern-style)', hint: 'Matches what SillyTavern 1.19 writes. Best for sharing with ST users.' },
    { id: 'png-v3', label: 'PNG (spec V3 + V2 fallback)', hint: "Full V3 card in 'ccv3', V2 fallback in 'chara'." },
    { id: 'charx', label: 'CHARX (V3 zip with assets)', hint: 'Carries embedded assets. ST imports it; ST cannot export it.' },
    { id: 'json-v3', label: 'JSON (V3)', hint: 'Plain Character Card V3 JSON.' },
    { id: 'json-v2', label: 'JSON (V2, lossy)', hint: 'For older tools; V3-only fields are dropped and reported.' },
    { id: 'json-st', label: 'JSON (SillyTavern shape)', hint: 'V2 JSON with V1 mirror fields, like ST JSON export.' },
];
