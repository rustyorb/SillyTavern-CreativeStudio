// Structural (path-level) JSON diffs and token-level text diffs.
// Self-contained so it runs in Node tests; the UI may also use SillyTavern's DiffMatchPatch.

import { stableStringify } from './bytes.js';

/**
 * Path-level differences between two JSON values.
 * Arrays of primitives are compared as a whole; arrays of objects element-wise.
 * @returns {{ path: string, kind: 'added'|'removed'|'changed', before?: any, after?: any }[]}
 */
export function jsonDiff(before, after, path = '') {
    const out = [];
    const same = (a, b) => stableStringify(a) === stableStringify(b);
    if (same(before, after)) return out;
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(before) && isObj(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const k of keys) {
            const p = path ? `${path}.${k}` : k;
            if (!(k in after) || after[k] === undefined) out.push({ path: p, kind: 'removed', before: before[k] });
            else if (!(k in before) || before[k] === undefined) out.push({ path: p, kind: 'added', after: after[k] });
            else out.push(...jsonDiff(before[k], after[k], p));
        }
        return out;
    }
    if (Array.isArray(before) && Array.isArray(after) && (before.some(isObj) || after.some(isObj))) {
        const n = Math.max(before.length, after.length);
        for (let i = 0; i < n; i++) {
            const p = `${path}[${i}]`;
            if (i >= after.length) out.push({ path: p, kind: 'removed', before: before[i] });
            else if (i >= before.length) out.push({ path: p, kind: 'added', after: after[i] });
            else out.push(...jsonDiff(before[i], after[i], p));
        }
        return out;
    }
    out.push({ path: path || '(root)', kind: 'changed', before, after });
    return out;
}

/** Get a value by a path produced by jsonDiff ("data.alternate_greetings[2]"). */
export function getPath(obj, path) {
    if (!path || path === '(root)') return obj;
    let cur = obj;
    for (const part of parsePath(path)) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

/** Set a value by path, creating intermediate objects/arrays. Returns the mutated object. */
export function setPath(obj, path, value) {
    const parts = parsePath(path);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = typeof parts[i + 1] === 'number' ? [] : {};
        cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (value === undefined) {
        if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
        else delete cur[last];
    } else {
        cur[last] = value;
    }
    return obj;
}

/** @returns {(string|number)[]} */
export function parsePath(path) {
    const parts = [];
    const re = /([^.[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(path))) parts.push(m[2] !== undefined ? Number(m[2]) : m[1]);
    return parts;
}

/** Split text into word/whitespace/punctuation tokens that re-join losslessly. */
export function tokenize(text) {
    return String(text ?? '').match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/**
 * Token-level diff (LCS with a size guard). Returns segments to render inline.
 * @returns {{ op: 'eq'|'ins'|'del', text: string }[]}
 */
export function textDiff(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    // Trim common prefix/suffix to keep the DP small.
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a2 = A.slice(pre, A.length - suf);
    const b2 = B.slice(pre, B.length - suf);
    const segs = [];
    const push = (op, text) => {
        if (!text) return;
        const last = segs[segs.length - 1];
        if (last && last.op === op) last.text += text;
        else segs.push({ op, text });
    };
    push('eq', A.slice(0, pre).join(''));
    if (a2.length * b2.length > 4_000_000) {
        // Too large for a DP table: fall back to a block replacement.
        push('del', a2.join(''));
        push('ins', b2.join(''));
    } else {
        const n = a2.length;
        const m = b2.length;
        const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (a2[i] === b2[j]) {
                push('eq', a2[i]);
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                push('del', a2[i++]);
            } else {
                push('ins', b2[j++]);
            }
        }
        while (i < n) push('del', a2[i++]);
        while (j < m) push('ins', b2[j++]);
    }
    push('eq', A.slice(A.length - suf).join(''));
    return segs;
}

/** Summary counts for a text diff. */
export function diffStats(segs) {
    let ins = 0;
    let del = 0;
    for (const s of segs) {
        const words = (s.text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
        if (s.op === 'ins') ins += words;
        if (s.op === 'del') del += words;
    }
    return { insertedWords: ins, deletedWords: del };
}
