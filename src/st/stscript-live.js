// Live STscript helpers: SillyTavern's own parser for syntax checks, the command registry for
// argument checks and help, and a deliberate execute path. Nothing here runs a script unless asked.
import { stContext } from './env.js';

/** Syntax-check with ST's real SlashCommandParser (pure; no callbacks, macros or variables are touched). */
export function parseLive(text) {
    const ctx = stContext();
    const Parser = ctx.SlashCommandParser;
    if (!Parser) return { available: false };
    try {
        const p = new Parser();
        p.parse(String(text ?? ''), true, null);
        return {
            available: true,
            ok: true,
            executors: (p.commandIndex ?? []).map(ex => ({ name: ex.name ?? ex.command?.name, start: ex.start, end: ex.end, named: (ex.namedArgumentList ?? []).map(a => a.name), unnamedCount: (ex.unnamedArgumentList ?? []).length })),
            macros: (p.macroIndex ?? []).map(m => ({ name: m.name, start: m.start })),
        };
    } catch (e) {
        let line = null;
        let column = null;
        let hint = '';
        try { line = e.line; column = e.column; hint = e.hint; } catch { /* some errors lack text/index */ }
        return { available: true, ok: false, error: { message: e.message, index: e.index ?? null, line: line != null ? line + 1 : null, column: column != null ? column + 1 : null, hint } };
    }
}

/** Registered commands (name → definition) without alias duplicates. */
export function commandRegistry() {
    try {
        const C = stContext().SlashCommandParser?.commands ?? {};
        const out = new Map();
        for (const k of Object.keys(C)) {
            const c = C[k];
            if (!c) continue;
            if (!out.has(c.name)) out.set(c.name, c);
        }
        return { byName: out, allNames: new Set(Object.keys(C)) };
    } catch {
        return { byName: new Map(), allNames: new Set() };
    }
}

export function describeCommand(def) {
    if (!def) return null;
    const arg = a => ({ name: a.name ?? '', description: a.description ?? '', types: a.typeList ?? [], required: !!a.isRequired, enum: (a.enumList ?? []).map(e => (typeof e === 'string' ? e : e.value)), forceEnum: !!a.forceEnum, def: a.defaultValue });
    const helpText = String(def.helpString ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { name: def.name, aliases: def.aliases ?? [], returns: def.returns ?? '', help: helpText, named: (def.namedArgumentList ?? []).map(arg), unnamed: (def.unnamedArgumentList ?? []).map(arg), source: def.source ?? '' };
}

/**
 * Argument checks the parser does not do (required args, forceEnum values, unknown named args).
 * @param {{cmd: string, named: object, unnamed: string, line: number}[]} statements from core/stscript scan()
 */
export function argumentLint(statements) {
    const { byName, allNames } = commandRegistry();
    const issues = [];
    for (const st of statements) {
        if (!allNames.has(st.cmd) || ['run', 'call', 'exec', ':', '/', '#', '*'].includes(st.cmd)) continue;
        const C = stContext().SlashCommandParser.commands;
        const def = C[st.cmd] ?? byName.get(st.cmd);
        if (!def) continue;
        const namedDefs = def.namedArgumentList ?? [];
        const known = new Set(namedDefs.flatMap(a => [a.name, ...(a.aliasList ?? [])]));
        for (const k of Object.keys(st.named)) {
            if (known.size && !known.has(k)) issues.push({ level: 'warn', line: st.line, message: `/${st.cmd}: unknown named argument "${k}" (passed through unchecked).` });
        }
        for (const a of namedDefs) {
            if (a.isRequired && !(a.name in st.named) && !(a.aliasList ?? []).some(x => x in st.named)) issues.push({ level: 'warn', line: st.line, message: `/${st.cmd}: missing required argument ${a.name}=` });
            const v = st.named[a.name];
            if (v != null && a.forceEnum && !/\{\{/.test(v)) {
                const allowed = enumValues(a);
                if (allowed.length && !allowed.includes(v)) issues.push({ level: 'error', line: st.line, message: `/${st.cmd}: ${a.name}=${v} is not one of ${allowed.join(', ')}` });
            }
        }
        const unnamedReq = (def.unnamedArgumentList ?? []).some(a => a.isRequired);
        if (unnamedReq && !st.unnamed.trim()) issues.push({ level: 'info', line: st.line, message: `/${st.cmd}: required unnamed argument is empty (it may receive the previous pipe).` });
    }
    return issues;
}

/** Static enum values, or values from a (static-type) enum provider; dynamic providers that need chat state may return nothing. */
function enumValues(a) {
    const toVal = e => (typeof e === 'string' ? e : e?.value);
    let list = (a.enumList ?? []).map(toVal).filter(x => x != null);
    if (!list.length && typeof a.enumProvider === 'function') {
        try {
            const r = a.enumProvider({ namedArgumentList: [], unnamedArgumentList: [] }, { allVariableNames: [], variables: {} });
            if (Array.isArray(r)) list = r.map(toVal).filter(x => x != null);
        } catch { /* provider needs live state */ }
    }
    return list.map(String);
}

/**
 * Execute deliberately (after the author has reviewed the effects). Parser and execution errors are returned, not thrown.
 * @returns {Promise<{ ok: boolean, pipe?: string, error?: string, aborted?: boolean }>}
 */
export async function executeLive(text, { args = {} } = {}) {
    const ctx = stContext();
    const scopeArgs = Object.entries(args).map(([k, v]) => `/let ${k} ${JSON.stringify(v)} |`).join('\n');
    try {
        const r = await ctx.executeSlashCommandsWithOptions(scopeArgs ? `${scopeArgs}\n${text}` : text, { handleParserErrors: false, handleExecutionErrors: false, source: 'creative-studio' });
        return { ok: !r?.isError, pipe: r?.pipe ?? '', aborted: !!r?.isAborted, error: r?.isError ? r.errorMessage : undefined };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Install a QR set through Quick Reply's own importer (same behaviour as the Import button). */
export async function installQrSetLive(set) {
    const api = globalThis.quickReplyApi;
    if (!api?.settingsUi?.importSingleQrSet) return { ok: false, error: 'Quick Reply extension is not available (enable it in Extensions).' };
    const file = new File([JSON.stringify(set)], `${set.name}.json`, { type: 'application/json' });
    await api.settingsUi.importSingleQrSet(file);
    const exists = !!api.getSetByName?.(set.name);
    return { ok: exists, error: exists ? undefined : 'The set was not installed (import cancelled or rejected).' };
}
