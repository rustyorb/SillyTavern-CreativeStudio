// Byte, text and base64 helpers that behave identically in Node (tests) and the browser (SillyTavern).

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** @param {string} text @returns {Uint8Array} */
export function utf8Encode(text) {
    return encoder.encode(text);
}

/** @param {Uint8Array} bytes @returns {string} */
export function utf8Decode(bytes) {
    return decoder.decode(bytes);
}

/** Latin-1 decode (PNG tEXt chunks are Latin-1 by specification). */
export function latin1Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return out;
}

/** Latin-1 encode; throws on characters outside 0..255. */
export function latin1Encode(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 255) throw new Error(`Character U+${c.toString(16)} cannot be stored as Latin-1`);
        out[i] = c;
    }
    return out;
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
    return btoa(latin1Decode(bytes));
}

/** @param {string} b64 @returns {Uint8Array} */
export function base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Base64 of the UTF-8 encoding of a string (what character card chunks contain). */
export function textToBase64(text) {
    return bytesToBase64(utf8Encode(text));
}

/** Inverse of textToBase64. */
export function base64ToText(b64) {
    return utf8Decode(base64ToBytes(b64));
}

/** Concatenate byte arrays. */
export function concatBytes(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** Stable JSON stringify with sorted keys; used for hashing and change detection. */
export function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Small, fast, non-cryptographic hash (FNV-1a 32-bit) rendered as hex. */
export function hashString(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deep clone JSON-compatible data. */
export function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

/** Random id suitable for local object ids. */
export function uid(prefix = '') {
    const rnd = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    return prefix ? `${prefix}_${rnd}` : rnd;
}
