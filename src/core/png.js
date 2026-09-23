// PNG chunk reading/writing for character cards.
//
// Mirrors SillyTavern 1.19.0 src/character-card-parser.js semantics:
//  - read: the first tEXt chunk with keyword 'ccv3' (case-insensitive) wins, otherwise 'chara'.
//  - write: remove every tEXt 'chara'/'ccv3' chunk, insert new ones immediately before IEND.
// Other chunks (including unknown ancillary chunks) are preserved byte-for-byte.

import { base64ToBytes, base64ToText, concatBytes, latin1Decode, latin1Encode, textToBase64 } from './bytes.js';

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable = null;
function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} bytes */
export function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Split a PNG into chunks.
 * @param {Uint8Array} bytes
 * @returns {{name: string, data: Uint8Array, crcOk: boolean}[]}
 */
export function extractChunks(bytes) {
    if (!isPng(bytes)) throw new Error('Not a PNG file (bad signature)');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const name = latin1Decode(bytes.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) throw new Error(`Truncated PNG chunk '${name}'`);
        const data = bytes.slice(dataStart, dataEnd);
        const storedCrc = view.getUint32(dataEnd);
        const crcOk = crc32(bytes.subarray(offset + 4, dataEnd)) === storedCrc;
        chunks.push({ name, data, crcOk });
        offset = dataEnd + 4;
        if (name === 'IEND') break;
    }
    if (!chunks.length || chunks[chunks.length - 1].name !== 'IEND') throw new Error('PNG has no IEND chunk');
    return chunks;
}

/** Re-assemble chunks into PNG bytes. */
export function encodeChunks(chunks) {
    const parts = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        const header = new Uint8Array(8);
        const hv = new DataView(header.buffer);
        hv.setUint32(0, chunk.data.length);
        header.set(latin1Encode(chunk.name), 4);
        const crcInput = concatBytes([header.subarray(4, 8), chunk.data]);
        const crc = new Uint8Array(4);
        new DataView(crc.buffer).setUint32(0, crc32(crcInput));
        parts.push(header, chunk.data, crc);
    }
    return concatBytes(parts);
}

/** Decode a tEXt chunk payload. */
export function decodeText(data) {
    const nul = data.indexOf(0);
    if (nul < 0) return { keyword: latin1Decode(data), text: '' };
    return { keyword: latin1Decode(data.subarray(0, nul)), text: latin1Decode(data.subarray(nul + 1)) };
}

/** Encode a tEXt chunk. Base64 payloads are pure ASCII so Latin-1 is safe. */
export function encodeText(keyword, text) {
    return { name: 'tEXt', data: concatBytes([latin1Encode(keyword), Uint8Array.of(0), latin1Encode(text)]) };
}

/**
 * Read all card-relevant metadata from a PNG.
 * @param {Uint8Array} bytes
 * @returns {{ chara: string|null, ccv3: string|null, winner: 'ccv3'|'chara'|null, textKeywords: string[], otherTextChunks: string[], diagnostics: string[] }}
 */
export function readCardChunks(bytes) {
    const chunks = extractChunks(bytes);
    const diagnostics = [];
    const texts = chunks.filter(c => c.name === 'tEXt').map(c => decodeText(c.data));
    const otherText = chunks.filter(c => c.name === 'iTXt' || c.name === 'zTXt').map(c => c.name);
    if (otherText.length) diagnostics.push(`PNG contains ${otherText.join(', ')} chunk(s); SillyTavern only reads tEXt, so these are ignored.`);
    if (chunks.some(c => !c.crcOk)) diagnostics.push('One or more PNG chunks have a bad CRC.');
    const find = kw => texts.find(t => t.keyword.toLowerCase() === kw);
    const count = kw => texts.filter(t => t.keyword.toLowerCase() === kw).length;
    for (const kw of ['chara', 'ccv3']) {
        if (count(kw) > 1) diagnostics.push(`PNG contains ${count(kw)} '${kw}' chunks; SillyTavern reads the first.`);
    }
    const decode = t => {
        if (!t) return null;
        try {
            return base64ToText(t.text);
        } catch (e) {
            diagnostics.push(`'${t.keyword}' chunk is not valid base64: ${e.message}`);
            return null;
        }
    };
    const ccv3 = decode(find('ccv3'));
    const chara = decode(find('chara'));
    return {
        chara,
        ccv3,
        winner: ccv3 !== null ? 'ccv3' : chara !== null ? 'chara' : null,
        textKeywords: texts.map(t => t.keyword),
        otherTextChunks: otherText,
        diagnostics,
    };
}

/**
 * Write card metadata into a PNG, replacing any existing chara/ccv3 tEXt chunks.
 * @param {Uint8Array} bytes source PNG
 * @param {{ chara?: string|null, ccv3?: string|null }} payload JSON strings (not base64)
 * @returns {Uint8Array}
 */
export function writeCardChunks(bytes, payload) {
    const chunks = extractChunks(bytes).filter(c => {
        if (c.name !== 'tEXt') return true;
        const kw = decodeText(c.data).keyword.toLowerCase();
        return kw !== 'chara' && kw !== 'ccv3';
    });
    const insert = [];
    if (payload.chara != null) insert.push(encodeText('chara', textToBase64(payload.chara)));
    if (payload.ccv3 != null) insert.push(encodeText('ccv3', textToBase64(payload.ccv3)));
    chunks.splice(chunks.length - 1, 0, ...insert);
    return encodeChunks(chunks);
}

/** A 1x1 transparent PNG, used when a card has no image yet. */
export function blankPng() {
    return base64ToBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
}
