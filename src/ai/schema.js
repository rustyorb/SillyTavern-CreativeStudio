// A small JSON Schema subset validator + coercer for AI task output.
// Supports: type (string|number|integer|boolean|array|object|null, or arrays of types), properties,
// required, items, enum, minItems, maxItems, minLength, additionalProperties (ignored: extra keys are kept).

/**
 * @returns {{ path: string, message: string }[]}
 */
export function validate(schema, value, path = '$') {
    const errors = [];
    if (!schema) return errors;
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
    if (types && !types.some(t => typeMatches(t, value))) {
        errors.push({ path, message: `expected ${types.join('|')}, got ${describe(value)}` });
        return errors;
    }
    if (schema.enum && !schema.enum.includes(value)) errors.push({ path, message: `must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}` });
    if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (Array.isArray(value)) {
        if (schema.minItems != null && value.length < schema.minItems) errors.push({ path, message: `needs at least ${schema.minItems} items` });
        if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, message: `allows at most ${schema.maxItems} items` });
        if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const r of schema.required ?? []) if (!(r in value) || value[r] === undefined) errors.push({ path: `${path}.${r}`, message: 'is required' });
        for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value && value[k] !== undefined) errors.push(...validate(sub, value[k], `${path}.${k}`));
    }
    return errors;
}

function typeMatches(t, v) {
    switch (t) {
        case 'string': return typeof v === 'string';
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'integer': return Number.isInteger(v);
        case 'boolean': return typeof v === 'boolean';
        case 'array': return Array.isArray(v);
        case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
        case 'null': return v === null;
        default: return true;
    }
}

function describe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/**
 * Coerce common near-misses so small local models still produce usable output:
 * numbers-as-strings, "true"/"false", single value where an array is expected, missing arrays.
 * Returns a new value; never throws.
 */
export function coerce(schema, value) {
    if (!schema) return value;
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.includes('array')) {
        if (value == null) return [];
        const arr = Array.isArray(value) ? value : typeof value === 'string' && schema.items?.type === 'string' ? value.split(/\n|,(?=\s)/).map(s => s.trim()).filter(Boolean) : [value];
        return arr.map(v => coerce(schema.items, v));
    }
    if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
        const out = { ...value };
        for (const [k, sub] of Object.entries(schema.properties ?? {})) {
            if (k in out) out[k] = coerce(sub, out[k]);
            else if ((schema.required ?? []).includes(k)) {
                const st = Array.isArray(sub.type) ? sub.type[0] : sub.type;
                if (st === 'array') out[k] = [];
                else if (st === 'string') out[k] = '';
            }
        }
        return out;
    }
    if ((types.includes('number') || types.includes('integer')) && typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
        return types.includes('integer') ? Math.round(Number(value)) : Number(value);
    }
    if (types.includes('boolean') && typeof value === 'string') {
        if (/^(true|yes)$/i.test(value)) return true;
        if (/^(false|no)$/i.test(value)) return false;
    }
    if (types.includes('string') && value != null && typeof value !== 'string' && !types.includes(typeof value)) {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return value;
}

/** Render a compact human-readable description of a schema for prompts. */
export function schemaToPrompt(schema, indent = '') {
    return JSON.stringify(stripMeta(schema), null, 1).split('\n').map(l => indent + l).join('\n');
}

function stripMeta(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(stripMeta);
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'additionalProperties' || k === '$schema') continue;
        out[k] = stripMeta(v);
    }
    return out;
}
