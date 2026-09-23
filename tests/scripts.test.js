import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scan, analyze, isSideEffectFree } from '../src/core/stscript.js';
import { newSet, addQr, importQrJson, lintSet } from '../src/core/qr.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = n => readFileSync(join(here, 'fixtures', n), 'utf8');

test('scanner handles the research sample (valid for ST’s real parser) without errors', () => {
    const s = scan(fx('example.stscript'));
    assert.deepEqual(s.problems.filter(p => p.level === 'error'), []);
    const cmds = s.statements.map(x => x.cmd);
    for (const c of ['let', 'times', 'incvar', 'echo', 'setvar', 'if', ':', 'run']) assert.ok(cmds.includes(c), `found /${c}`);
    const setvar = s.statements.find(x => x.cmd === 'setvar');
    assert.deepEqual(setvar.named, { key: 'last', as: 'number' });
    assert.equal(setvar.unnamed, '42');
});

test('analysis reports effects, variables, calls and lints', () => {
    const a = analyze(fx('example.stscript'));
    const effects = a.effects.map(e => e.id);
    assert.ok(effects.includes('writes-chat-var'));
    assert.ok(effects.includes('runs-script'));
    assert.ok(effects.includes('ui'));
    assert.ok(a.vars.writeLocal.includes('last'));
    assert.ok(a.vars.writeLocal.includes('hits'));
    assert.ok(a.calls.some(c => c.target.includes('Studio Tools.Roll')));
    assert.equal(isSideEffectFree(a), false);
    assert.equal(isSideEffectFree(analyze('/echo hi')), true);
});

test('lint catches common STscript traps', () => {
    const lead = analyze('hello there /echo x |\n/trigger');
    assert.ok(lead.lints.some(l => /starts with plain text/.test(l.message)), 'leading text turns the whole QR into a chat message');
    const bad = analyze([
        '/echo start |',
        'hello there /echo x |',
        '/if left=1 rule=eq right=1 {: /echo y :} else={: /echo n :} |',
        '/incvar key=score |',
        '/return 5 |',
        '/echo {{getvar::mood::}} |',
        '/while left=1 rule=eq right=1 {: /echo loop :}',
    ].join('\n'), { knownCommands: new Set(['echo', 'if', 'incvar', 'return', 'while']) });
    const msgs = bad.lints.map(l => l.message);
    assert.ok(msgs.some(m => m.startsWith('Text outside any command')));
    assert.ok(msgs.some(m => m.startsWith('else= appears after')));
    assert.ok(msgs.some(m => m.includes('/incvar key=')));
    assert.ok(msgs.some(m => m.includes('/return is an alias')));
    assert.ok(msgs.some(m => m.includes('trailing "::"')));
    assert.ok(msgs.some(m => m.includes('100 iterations')));
    const unk = analyze('/frobnicate x', { knownCommands: new Set(['echo']) });
    assert.ok(unk.lints.some(l => l.message.startsWith('Unknown command /frobnicate')));
    assert.ok(unk.effects.some(e => e.id === 'unknown'));
});

test('structural errors: unclosed closure, comment swallowing :}, unclosed quote', () => {
    assert.ok(scan('/if left=1 {: /echo a').problems.some(p => p.message.startsWith('Unclosed closure')));
    assert.ok(scan('/times 2 {: // note :}').problems.some(p => p.message.startsWith('Comment swallows')));
    assert.ok(scan('/echo "abc').problems.some(p => p.message === 'Unclosed quote'));
});

test('QR sets: id quirk, v1 migration, lint', () => {
    let set = newSet('Tools');
    let r = addQr(set, { label: 'A', message: '/echo a' });
    assert.equal(r.qr.id, 1);
    assert.equal(r.set.idIndex, 2);
    r = addQr(r.set, { label: 'B', message: '/echo b' });
    assert.equal(r.qr.id, 3);
    set = r.set;
    const v1 = importQrJson(JSON.parse(fx('qr-v1-default.json')), 'Default.json');
    assert.equal(v1.set.version, 2);
    assert.ok(v1.notes.length);
    const v2 = importQrJson(JSON.parse(fx('qr-v2-studio-tools.json')));
    assert.equal(v2.kind, 'set');
    set.qrList.push({ ...set.qrList[0], id: 9, label: 'A', contextList: [{ set: 'Missing', isChained: false }], isHidden: true, automationId: 'x' });
    const lint = lintSet(set, { setNames: ['Tools'], automationIds: new Set() }).map(i => i.message);
    assert.ok(lint.some(m => m.includes('Label "A" is used 2 times')));
    assert.ok(lint.some(m => m.includes('"Missing"')));
    assert.ok(lint.some(m => m.includes('Automation ID "x"')));
});

test('plain-text Quick Reply messages are user messages, not discarded text; stray text inside a script still warns', () => {
    const plain = analyze('Continue, please.');
    assert.equal(plain.isScript, false);
    assert.ok(!plain.lints.some(l => /discarded/.test(l.message)));
    const script = analyze('/echo hi |\nstray words\n/trigger');
    assert.ok(script.lints.some(l => /discarded/.test(l.message)));
});
