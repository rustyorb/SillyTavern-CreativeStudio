// STscript structural scanner for dependency/effect analysis and lint.
// Authoritative syntax errors come from SillyTavern's own SlashCommandParser in the browser (src/st/stscript-live.js);
// this scanner mirrors the grammar in docs/research/st-formats.md §F.1 closely enough to extract structure offline.

/** Side-effect categories shown before anything runs. */
export const EFFECT = {
    'sends-message': 'Adds a message to the chat',
    generates: 'Calls the model (uses tokens)',
    'writes-chat-var': 'Writes chat (local) variables',
    'writes-global-var': 'Writes global variables (saved in settings)',
    'modifies-chat': 'Edits, deletes or hides chat messages',
    'modifies-lore': 'Changes World Info',
    'modifies-character': 'Changes characters or personas',
    'switches-config': 'Switches API, preset, profile or settings',
    'runs-script': 'Runs another Quick Reply or closure',
    'modifies-qr': 'Creates or changes Quick Replies',
    ui: 'Shows UI (toasts, popups, input box)',
    network: 'Fetches external content',
    unknown: 'Unknown command (effects not classified)',
};

const EFFECTS_BY_COMMAND = {
    send: ['sends-message'], sendas: ['sends-message'], sys: ['sends-message'], nar: ['sends-message'], comment: ['sends-message'], ask: ['sends-message', 'generates'],
    gen: ['generates'], genraw: ['generates'], trigger: ['generates', 'sends-message'], continue: ['generates', 'sends-message'], impersonate: ['generates'], swipe: ['generates'],
    sysgen: ['generates', 'sends-message'], summarize: ['generates'], 'profile-gen': ['generates'], 'profile-genstream': ['generates'], genstream: ['generates'],
    setvar: ['writes-chat-var'], setchatvar: ['writes-chat-var'], addvar: ['writes-chat-var'], addchatvar: ['writes-chat-var'], incvar: ['writes-chat-var'], decvar: ['writes-chat-var'], flushvar: ['writes-chat-var'], incchatvar: ['writes-chat-var'], decchatvar: ['writes-chat-var'], flushchatvar: ['writes-chat-var'],
    setglobalvar: ['writes-global-var'], addglobalvar: ['writes-global-var'], incglobalvar: ['writes-global-var'], decglobalvar: ['writes-global-var'], flushglobalvar: ['writes-global-var'],
    del: ['modifies-chat'], cut: ['modifies-chat'], hide: ['modifies-chat'], unhide: ['modifies-chat'], messages: [], 'message-edit': ['modifies-chat'], delswipe: ['modifies-chat'], addswipe: ['modifies-chat'], 'delchat': ['modifies-chat'], 'closechat': ['modifies-chat'], 'newchat': ['modifies-chat'], branch: ['modifies-chat'], 'checkpoint-create': ['modifies-chat'],
    createentry: ['modifies-lore'], setentryfield: ['modifies-lore'], 'wi-set-timed-effect': ['modifies-lore'], world: ['modifies-lore', 'switches-config'],
    'char-create': ['modifies-character'], 'char-update': ['modifies-character'], 'char-delete': ['modifies-character'], 'char-duplicate': ['modifies-character'], persona: ['switches-config'], 'persona-set': ['switches-config'],
    api: ['switches-config'], preset: ['switches-config'], profile: ['switches-config'], model: ['switches-config'], context: ['switches-config'], instruct: ['switches-config'], 'instruct-on': ['switches-config'], 'instruct-off': ['switches-config'], sysprompt: ['switches-config'], tokenizer: ['switches-config'], 'reasoning-template': ['switches-config'], theme: ['switches-config'], bg: ['switches-config'], go: ['switches-config'], char: ['switches-config'],
    run: ['runs-script'], call: ['runs-script'], exec: ['runs-script'], ':': ['runs-script'], import: ['runs-script'],
    'qr-create': ['modifies-qr'], 'qr-update': ['modifies-qr'], 'qr-delete': ['modifies-qr'], 'qr-set-create': ['modifies-qr'], 'qr-set-update': ['modifies-qr'], 'qr-set-delete': ['modifies-qr'], 'qr-set': ['switches-config'], 'qr-set-on': ['switches-config'], 'qr-set-off': ['switches-config'], 'qr-chat-set': ['switches-config'], 'qr-chat-set-on': ['switches-config'], 'qr-chat-set-off': ['switches-config'], 'qr-contextadd': ['modifies-qr'], 'qr-contextdel': ['modifies-qr'], 'qr-contextclear': ['modifies-qr'],
    echo: ['ui'], popup: ['ui'], input: ['ui'], buttons: ['ui'], setinput: ['ui'], 'regex-toggle': ['switches-config'], inject: ['modifies-chat'], listinjects: [], flushinject: ['modifies-chat'],
    fetch: ['network'], yt: ['network'],
    // Pure/read-only commands
    getvar: [], getchatvar: [], getglobalvar: [], listvar: [], let: [], var: [], if: [], while: [], times: [], pass: [], return: [], abort: [], break: [], breakpoint: [], 'parser-flag': [],
    len: [], trim: [], add: [], sub: [], mul: [], div: [], mod: [], rand: [], round: [], max: [], min: [], abs: [], sqrt: [], pow: [], sort: [], split: [], join: [], replace: [], substr: [], 'test': [], match: [], tokens: [], 'qr-list': [], 'qr-set-list': [], 'qr-get': [], getentryfield: [], findentry: [], 'getchatbook': [], 'getcharbook': [], 'getglobalbooks': [], 'getpersonabook': [], 'wi-get-timed-effect': [], 'char-get': [], 'char-find': [], 'regex-state': [], 'closure-serialize': [], 'closure-deserialize': [], '/': [], '#': [], '*': [], '?': [], help: [], delay: [], 'closure': [],
};

export function effectsOf(name) {
    const e = EFFECTS_BY_COMMAND[name];
    return e ?? null;
}

/**
 * Scan a script into statements, tracking closure depth, pipes, quotes, comments and macros.
 * @returns {{ statements: {cmd: string, named: Record<string,string>, unnamed: string, depth: number, start: number, end: number, line: number}[], macros: {name: string, args: string[], start: number}[], problems: {level: string, message: string, index: number, line: number}[], plainText: {text: string, index: number}[] }}
 */
export function scan(text) {
    const src = String(text ?? '');
    const statements = [];
    const problems = [];
    const plainText = [];
    const lineAt = i => src.slice(0, i).split('\n').length;
    let i = 0;
    let depth = 0;
    const stack = [];

    const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const atEnd = () => i >= src.length || (src[i] === '|' && !inMacro()) || src.startsWith(':}', i);
    let macroOpen = 0;
    const inMacro = () => macroOpen > 0;

    // Read until command end, handling nested closures/quotes/macros; returns raw text.
    const readUntilEnd = () => {
        const start = i;
        let q = false;
        let localDepth = 0;
        let stmtStart = false; // true right after "{:" or "|" inside a nested closure
        macroOpen = 0;
        while (i < src.length) {
            const c = src[i];
            if (stmtStart && /\s/.test(c)) { i++; continue; }
            if (stmtStart && localDepth && (src.startsWith('//', i) || src.startsWith('/#', i))) {
                // Comments end only at an unescaped "|", so a ":}" inside them does not close the closure.
                const cs = i;
                while (i < src.length && !(src[i] === '|' && src[i - 1] !== '\\')) i++;
                if (src.slice(cs, i).includes(':}')) problems.push({ level: 'error', message: 'Comment swallows ":}" (comments end only at "|"): the closure stays open', index: cs, line: lineAt(cs) });
                stmtStart = false;
                continue;
            }
            stmtStart = false;
            if (c === '\\') { i += 2; continue; }
            if (q) { if (c === '"') q = false; i++; continue; }
            if (src.startsWith('{{', i)) { macroOpen++; i += 2; continue; }
            if (src.startsWith('}}', i) && macroOpen) { macroOpen--; i += 2; continue; }
            if (src.startsWith('{:', i)) { localDepth++; i += 2; stmtStart = true; continue; }
            if (c === '|' && localDepth && !macroOpen) { i++; stmtStart = true; continue; }
            if (src.startsWith(':}', i)) {
                if (!localDepth) break;
                localDepth--; i += 2;
                if (src.startsWith('()', i)) i += 2;
                continue;
            }
            if (c === '"' && !macroOpen) { q = true; i++; continue; }
            if (c === '|' && !localDepth && !macroOpen) break;
            i++;
        }
        if (q) problems.push({ level: 'error', message: 'Unclosed quote', index: start, line: lineAt(start) });
        if (localDepth) problems.push({ level: 'error', message: 'Unclosed closure {: … :}', index: start, line: lineAt(start) });
        if (macroOpen) problems.push({ level: 'warn', message: 'Unclosed {{ macro: every later | is swallowed into it', index: start, line: lineAt(start) });
        macroOpen = 0;
        return src.slice(start, i);
    };

    const parseArgs = raw => {
        const named = {};
        let rest = raw.trim();
        // named args come first: key=value (value may be quoted, closure, list or bare)
        while (true) {
            const m = rest.match(/^([A-Za-z0-9_]+)=/);
            if (!m) break;
            let j = m[0].length;
            let val = '';
            if (rest.startsWith('{:', j)) {
                let d = 0;
                let k = j;
                for (; k < rest.length; k++) {
                    if (rest.startsWith('{:', k)) { d++; k++; continue; }
                    if (rest.startsWith(':}', k)) { d--; k++; if (!d) { k++; break; } }
                }
                val = rest.slice(j, k);
                j = k;
            } else if (rest[j] === '"') {
                let k = j + 1;
                while (k < rest.length && rest[k] !== '"') { if (rest[k] === '\\') k++; k++; }
                val = rest.slice(j + 1, k);
                j = k + 1;
            } else if (rest[j] === '[') {
                const k = rest.indexOf(']', j);
                val = rest.slice(j, k < 0 ? rest.length : k + 1);
                j = k < 0 ? rest.length : k + 1;
            } else {
                const m2 = rest.slice(j).match(/^\S*/);
                val = m2[0];
                j += val.length;
            }
            named[m[1]] = val;
            rest = rest.slice(j).trimStart();
        }
        return { named, unnamed: rest };
    };

    const statement = () => {
        skipWs();
        if (i >= src.length) return false;
        if (src.startsWith(':}', i)) {
            if (!stack.length) problems.push({ level: 'error', message: 'Unexpected :} with no open closure', index: i, line: lineAt(i) });
            else stack.pop();
            depth = Math.max(0, depth - 1);
            i += 2;
            if (src.startsWith('()', i)) i += 2;
            return true;
        }
        if (src[i] === '|') { i++; if (src[i] === '|') i++; return true; }
        if (src.startsWith('/*', i)) {
            const end = src.indexOf('*|', i);
            if (end < 0) { problems.push({ level: 'error', message: 'Unclosed block comment (block comments end with *| in STscript)', index: i, line: lineAt(i) }); i = src.length; }
            else i = end + 2;
            return true;
        }
        if (src.startsWith('//', i) || src.startsWith('/#', i)) {
            const start = i;
            let j = i;
            while (j < src.length && !(src[j] === '|' && src[j - 1] !== '\\')) j++;
            const body = src.slice(start, j);
            if (body.includes(':}')) problems.push({ level: 'error', message: 'Comment swallows ":}" (comments end only at "|"): the closure stays open', index: start, line: lineAt(start) });
            i = j;
            return true;
        }
        if (src[i] === '/') {
            const start = i;
            i++;
            let name;
            if (src[i] === ':') { name = ':'; i++; }
            else {
                const m = src.slice(i).match(/^[^\s|{}]+/);
                name = m ? m[0] : '';
                i += name.length;
            }
            const raw = readUntilEnd();
            const { named, unnamed } = parseArgs(raw);
            statements.push({ cmd: name, named, unnamed, depth: stack.length, start, end: i, line: lineAt(start) });
            // descend into closures inside args (named or unnamed)
            for (const v of [...Object.values(named), unnamed]) {
                const inner = /\{:([\s\S]*):\}/.exec(v);
                if (inner) {
                    const sub = scan(inner[1]);
                    for (const s of sub.statements) statements.push({ ...s, depth: s.depth + stack.length + 1, line: s.line + lineAt(start) - 1, nested: true });
                    for (const p of sub.problems) problems.push({ ...p, line: p.line + lineAt(start) - 1 });
                }
            }
            return true;
        }
        if (src.startsWith('{:', i)) { stack.push(i); depth++; i += 2; return true; }
        // plain text before a command without a pipe is discarded by ST
        const start = i;
        readUntilEnd();
        const t = src.slice(start, i).trim();
        if (t) plainText.push({ text: t.slice(0, 80), index: start, line: lineAt(start) });
        return true;
    };
    let guard = 0;
    while (i < src.length && guard++ < 100000) if (!statement()) break;
    if (stack.length) problems.push({ level: 'error', message: 'Unclosed closure {: … :}', index: stack[stack.length - 1], line: lineAt(stack[stack.length - 1]) });

    const macros = [];
    const macroRe = /\{\{([a-zA-Z/.$][\w-]*|\/\/)((?:::[^}]*?)*)\}\}/g;
    let m;
    while ((m = macroRe.exec(src))) macros.push({ name: m[1], args: m[2] ? m[2].split('::').slice(1) : [], start: m.index });
    return { statements: dedupe(statements), macros, problems, plainText };
}

function dedupe(list) {
    const seen = new Set();
    return list.filter(s => {
        const k = `${s.line}:${s.cmd}:${s.unnamed}:${JSON.stringify(s.named)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * Dependency & effect analysis.
 * @param {string} text
 * @param {{ knownCommands?: Set<string>|null }} [opts]
 */
export function analyze(text, { knownCommands = null } = {}) {
    const s = scan(text);
    const effects = new Map();
    const commands = new Map();
    const vars = { readLocal: new Set(), writeLocal: new Set(), readGlobal: new Set(), writeGlobal: new Set(), scoped: new Set() };
    const calls = [];
    const lints = [...s.problems];
    const addEffect = (e, cmd, line) => {
        if (!effects.has(e)) effects.set(e, []);
        effects.get(e).push({ cmd, line });
    };
    for (const st of s.statements) {
        commands.set(st.cmd, (commands.get(st.cmd) ?? 0) + 1);
        const known = knownCommands ? knownCommands.has(st.cmd) || st.cmd === ':' : true;
        if (!known) lints.push({ level: 'error', message: `Unknown command /${st.cmd} (not registered in this SillyTavern)`, line: st.line });
        const eff = effectsOf(st.cmd);
        if (eff === null) addEffect('unknown', st.cmd, st.line);
        else for (const e of eff) addEffect(e, st.cmd, st.line);
        const key = st.named.key ?? st.named.name ?? st.unnamed.split(/\s+/)[0];
        if (['setvar', 'setchatvar', 'addvar', 'addchatvar'].includes(st.cmd)) vars.writeLocal.add(st.named.key ?? st.named.name ?? '?');
        if (['incvar', 'decvar', 'flushvar', 'incchatvar', 'decchatvar', 'flushchatvar'].includes(st.cmd)) {
            vars.writeLocal.add(st.unnamed.trim() || st.named.key || '?');
            if (st.named.key) lints.push({ level: 'warn', message: `/${st.cmd} key=… is ignored; use the unnamed form: /${st.cmd} ${st.named.key}`, line: st.line });
        }
        if (['setglobalvar', 'addglobalvar'].includes(st.cmd)) vars.writeGlobal.add(st.named.key ?? st.named.name ?? '?');
        if (['incglobalvar', 'decglobalvar', 'flushglobalvar'].includes(st.cmd)) vars.writeGlobal.add(st.unnamed.trim() || '?');
        if (['getvar', 'getchatvar'].includes(st.cmd)) vars.readLocal.add(key);
        if (st.cmd === 'getglobalvar') vars.readGlobal.add(key);
        if (st.cmd === 'let' || st.cmd === 'var') vars.scoped.add(st.named.key ?? st.unnamed.split(/\s+/)[0]);
        if (['run', 'call', 'exec', ':'].includes(st.cmd)) {
            const raw = (st.unnamed || Object.keys(st.named)[0] || '').trim();
            const quoted = raw.match(/^"([^"]*)"/);
            calls.push({ target: quoted ? quoted[1] : raw.split(/\s+/)[0], line: st.line });
        }
        if (st.cmd === 'return') lints.push({ level: 'info', message: '/return is an alias of /pass and does not exit early; use /abort or /break.', line: st.line });
        if (st.cmd === 'if' && /\belse=\{:/.test(st.unnamed)) lints.push({ level: 'error', message: 'else= appears after the unnamed closure, so ST treats it as text. Put else= before the closure.', line: st.line });
        if ((st.cmd === 'while' || st.cmd === 'times') && st.named.guard !== 'off') lints.push({ level: 'info', message: `/${st.cmd} stops after 100 iterations unless guard=off.`, line: st.line });
        if (Object.keys(st.named).length && /\b[A-Za-z0-9_]+=/.test(st.unnamed) && !['echo', 'send', 'sendas', 'sys', 'comment', 'run', ':'].includes(st.cmd)) {
            lints.push({ level: 'info', message: `/${st.cmd}: "name=value" after unnamed text is treated as text, not a named argument.`, line: st.line });
        }
    }
    for (const mm of s.macros) {
        const n = mm.name.toLowerCase();
        if (['getvar', 'hasvar', 'varexists'].includes(n)) vars.readLocal.add(mm.args[0] ?? '?');
        if (['getglobalvar', 'hasglobalvar'].includes(n)) vars.readGlobal.add(mm.args[0] ?? '?');
        if (['setvar', 'addvar', 'incvar', 'decvar', 'deletevar'].includes(n)) vars.writeLocal.add(mm.args[0] ?? '?');
        if (['setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'deleteglobalvar'].includes(n)) vars.writeGlobal.add(mm.args[0] ?? '?');
        if (n === 'var' && mm.args[0] && !vars.scoped.has(mm.args[0])) lints.push({ level: 'warn', message: `{{var::${mm.args[0]}}} reads a scoped variable that is never declared with /let or a closure parameter here.`, line: null });
        if ((n === 'getvar' || n === 'getglobalvar') && mm.args.length > 1 && mm.args[mm.args.length - 1] === '') lints.push({ level: 'warn', message: `{{${mm.name}::${mm.args.join('::')}}} has a trailing "::" and will not resolve.`, line: null });
    }
    // A Quick Reply whose message does not start with "/" is sent as a user message (QuickReplySet.executeWithOptions),
    // so stray text only matters inside a slash-command script.
    if (/^\s*\//.test(String(text ?? ''))) for (const pt of s.plainText) lints.push({ level: 'warn', message: `Text outside any command is discarded by ST: “${pt.text}”`, line: pt.line });
    else if (/(^|\s)\/[a-z][\w-]*(\s|\||$)/im.test(String(text ?? ''))) lints.push({ level: 'warn', message: 'The message starts with plain text, so SillyTavern sends all of it to the chat and none of its /commands run. Start it with a /command to make it a script.', line: 1 });
    for (const v of vars.readLocal) if (v && v !== '?' && !vars.writeLocal.has(v)) lints.push({ level: 'info', message: `Reads chat variable "${v}" that this script never sets (it may come from elsewhere).`, line: null });
    return {
        statements: s.statements,
        commands: [...commands.entries()].map(([name, count]) => ({ name, count })),
        effects: [...effects.entries()].map(([id, uses]) => ({ id, label: EFFECT[id] ?? id, uses })),
        vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, [...v].filter(Boolean)])),
        calls,
        macros: s.macros,
        lints,
        isScript: /^\s*\//.test(String(text ?? '')),
    };
}

/** Is it reasonably safe to run without side effects beyond UI/scoped state? */
export function isSideEffectFree(analysis) {
    return analysis.effects.every(e => e.id === 'ui');
}
