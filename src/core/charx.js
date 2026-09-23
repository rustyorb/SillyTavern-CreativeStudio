// CHARX (Character Card V3 zip container) read/write.
// Spec: card.json at the zip root; assets referenced by `embeded://<path inside zip>` URIs.
// Files we do not understand (e.g. RisuAI `module.risum`, x_meta/) are preserved as-is.

import { unzipSync, zipSync, strFromU8, strToU8 } from '../../vendor/fflate.mjs';
import { normalizeToV3, toSpecV3 } from './card.js';

const EMBED_PREFIXES = ['embeded://', 'embedded://', '__asset:'];

/** @param {string} uri @returns {string|null} path inside the zip, if the URI is an embedded reference */
export function embeddedPath(uri) {
    if (typeof uri !== 'string') return null;
    for (const p of EMBED_PREFIXES) if (uri.startsWith(p)) return uri.slice(p.length).replace(/^\/+/, '');
    return null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ card: any, topLevelExtras: any, report: any[], files: Record<string, Uint8Array>, assets: {asset: any, path: string|null, bytes: Uint8Array|null}[], diagnostics: string[] }}
 */
export function readCharx(bytes) {
    const files = unzipSync(bytes);
    const diagnostics = [];
    const cardName = Object.keys(files).find(n => n.replace(/^\/+/, '') === 'card.json');
    if (!cardName) throw new Error('CHARX has no card.json at the archive root');
    const json = JSON.parse(strFromU8(files[cardName]));
    const { card, topLevelExtras, report } = normalizeToV3(json);
    const assets = (card.data.assets ?? []).map(asset => {
        const path = embeddedPath(asset.uri);
        if (path === null) return { asset, path: null, bytes: null };
        const entry = files[path] ?? files[decodeURI(path)];
        if (!entry) diagnostics.push(`Asset "${asset.name}" points to missing file ${path}`);
        return { asset, path, bytes: entry ?? null };
    });
    const referenced = new Set(assets.map(a => a.path).filter(Boolean));
    const unreferenced = Object.keys(files).filter(n => n !== cardName && !n.endsWith('/') && !referenced.has(n));
    if (unreferenced.length) diagnostics.push(`Preserving ${unreferenced.length} unreferenced file(s): ${unreferenced.slice(0, 5).join(', ')}${unreferenced.length > 5 ? '…' : ''}`);
    return { card, topLevelExtras, report, files, assets, diagnostics };
}

/**
 * Build a CHARX archive.
 * @param {any} card V3 card (assets with embeded:// URIs must have matching files)
 * @param {Record<string, Uint8Array>} files additional files keyed by zip path (asset bytes, preserved extras)
 * @returns {{ bytes: Uint8Array, diagnostics: string[] }}
 */
export function writeCharx(card, files = {}) {
    const diagnostics = [];
    const out = {};
    for (const [name, data] of Object.entries(files)) {
        if (name === 'card.json') continue;
        out[name] = [data, { level: /\.(png|jpe?g|webp|gif|mp3|ogg|mp4|webm|zip|risum)$/i.test(name) ? 0 : 6 }];
    }
    const v3 = toSpecV3(card);
    for (const a of v3.data.assets ?? []) {
        const p = embeddedPath(a.uri);
        if (p && !out[p]) diagnostics.push(`Asset "${a.name}" references ${p}, which is not in the archive`);
    }
    out['card.json'] = [strToU8(JSON.stringify(v3, null, 2)), { level: 6 }];
    return { bytes: zipSync(out), diagnostics };
}

/** Conventional zip path for an asset, per the spec's suggested layout. */
export function suggestedAssetPath(type, name, ext) {
    const kind = /^(png|jpe?g|webp|gif|avif)$/i.test(ext) ? 'images' : /^(mp3|ogg|wav|flac)$/i.test(ext) ? 'audio' : /^(mp4|webm)$/i.test(ext) ? 'video' : 'other';
    const safe = String(name).replace(/[^\w.-]+/g, '_') || 'asset';
    return `assets/${type || 'other'}/${kind}/${safe}.${String(ext).toLowerCase()}`;
}
