// Lenient JSON extraction for model output that may include prose, code fences, reasoning, or small syntax errors.

/**
 * Try hard to get a JSON value out of a model response.
 * @returns {{ ok: true, value: any, repaired: string[] } | { ok: false, error: string }}
 */
export function extractJson(text) {
    if (text !== null && typeof text === 'object') return { ok: true, value: text, repaired: [] };
    let s = String(text ?? '').trim();
    const repaired = [];
    if (!s) return { ok: false, error: 'Empty response' };

    // Drop reasoning blocks some models emit inline.
    const withoutThink = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
    if (withoutThink !== s) {
        s = withoutThink;
        repaired.push('removed reasoning block');
    }
    const direct = tryParse(s);
    if (direct.ok) return { ok: true, value: direct.value, repaired };

    // Prefer fenced ```json blocks.
    const fence = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
    if (fence) {
        const r = tryParse(fence[1].trim());
        if (r.ok) return { ok: true, value: r.value, repaired: [...repaired, 'took fenced code block'] };
        s = fence[1].trim();
    }

    // Find the first balanced {...} or [...] span.
    const span = balancedSpan(s);
    if (span) {
        const r = tryParse(span);
        if (r.ok) return { ok: true, value: r.value, repaired: [...repaired, 'extracted JSON from surrounding text'] };
        const fixed = repairJson(span);
        const r2 = tryParse(fixed.text);
        if (r2.ok) return { ok: true, value: r2.value, repaired: [...repaired, 'extracted JSON from surrounding text', ...fixed.changes] };
    }
    const fixed = repairJson(s);
    const r3 = tryParse(fixed.text);
    if (r3.ok) return { ok: true, value: r3.value, repaired: [...repaired, ...fixed.changes] };
    // Truncated output: try closing open brackets.
    const closed = closeTruncated(span ?? s);
    if (closed) {
        const r4 = tryParse(repairJson(closed).text);
        if (r4.ok) return { ok: true, value: r4.value, repaired: [...repaired, 'closed truncated JSON (output was cut off)'] };
    }
    return { ok: false, error: direct.error };
}

function tryParse(s) {
    try {
        return { ok: true, value: JSON.parse(s) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** First balanced JSON object/array, respecting strings. */
export function balancedSpan(s) {
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    const stack = [];
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
            stack.pop();
            if (!stack.length) return s.slice(start, i + 1);
        }
    }
    return null;
}

/** Common, safe syntax repairs. */
export function repairJson(s) {
    const changes = [];
    let t = s;
    const before = t;
    t = t.replace(/[“”]/g, '"');
    if (t !== before) changes.push('replaced smart quotes');
    const b2 = t;
    t = t.replace(/,\s*([}\]])/g, '$1');
    if (t !== b2) changes.push('removed trailing commas');
    // Raw newlines inside strings → \n
    let out = '';
    let inStr = false;
    let esc = false;
    let fixedNl = false;
    for (const ch of t) {
        if (inStr) {
            if (esc) { esc = false; out += ch; continue; }
            if (ch === '\\') { esc = true; out += ch; continue; }
            if (ch === '"') { inStr = false; out += ch; continue; }
            if (ch === '\n') { out += '\\n'; fixedNl = true; continue; }
            if (ch === '\r') { fixedNl = true; continue; }
            if (ch === '\t') { out += '\\t'; fixedNl = true; continue; }
            out += ch;
        } else {
            if (ch === '"') inStr = true;
            out += ch;
        }
    }
    if (fixedNl) changes.push('escaped raw control characters in strings');
    return { text: out, changes };
}

/** Close unterminated strings/brackets of truncated output. */
function closeTruncated(s) {
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    const stack = [];
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    if (!stack.length && !inStr) return null;
    let t = s.slice(start);
    if (inStr) t += '"';
    t = t.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
    return t + stack.reverse().join('');
}
