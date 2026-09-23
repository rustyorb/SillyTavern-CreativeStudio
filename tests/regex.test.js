import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regexFromString, runRegexScript, eligibility, applyAt, stageMatrix, lintScripts, orderConflicts, defaultScript, makeMacros, parseRegexImport } from '../src/core/regex.js';

const S = o => ({ ...defaultScript('t'), ...o });

test('regexFromString mirrors ST (flags, bare pattern, invalid flags fallback)', () => {
    assert.deepEqual([regexFromString('/a+b/gi').source, regexFromString('/a+b/gi').flags], ['a+b', 'gi']);
    const bare = regexFromString('cat');
    assert.equal(bare.flags, '');
    assert.equal(regexFromString('/x/gg').source, new RegExp('/x/gg').source); // duplicate flag → whole input as pattern
    assert.equal(regexFromString('/(/g'), undefined);
});

test('replacement semantics: {{match}}, $1, $<name>, trim strings, literal $&', () => {
    const r1 = runRegexScript(S({ findRegex: String.raw`/(\w+)@(\w+)/g`, replaceString: '[$2:$1]' }), 'a@b c@d');
    assert.equal(r1.output, '[b:a] [d:c]');
    const r2 = runRegexScript(S({ findRegex: String.raw`/\*(.+?)\*/g`, replaceString: '<i>{{match}}</i>', trimStrings: ['*'] }), 'say *hi* now');
    assert.equal(r2.output, 'say <i>hi</i> now'); // trim applies to $0 via {{match}}
    const r3 = runRegexScript(S({ findRegex: String.raw`/(?<w>\d+)/g`, replaceString: '#$<w>' }), 'x1y22');
    assert.equal(r3.output, 'x#1y#22');
    const r4 = runRegexScript(S({ findRegex: '/b/', replaceString: '[$&]' }), 'abc');
    assert.equal(r4.output, 'a[$&]c'); // function replacer: $& literal
    const r5 = runRegexScript(S({ findRegex: 'o', replaceString: '0' }), 'foo');
    assert.equal(r5.output, 'f0o'); // bare pattern: first match only
    const r6 = runRegexScript(S({ findRegex: '/{{char}}/g', replaceString: 'X', substituteRegex: 1 }), 'Mira and Mira', { macros: makeMacros({ char: 'Mira' }) });
    assert.equal(r6.output, 'X and X');
    const r7 = runRegexScript(S({ findRegex: '/{{char}}/g', replaceString: 'X', substituteRegex: 2 }), 'a.b axb', { macros: makeMacros({ char: 'a.b' }) });
    assert.equal(r7.output, 'X axb'); // escaped substitution
});

test('eligibility gates: mode, edit, depth, placement', () => {
    const disp = S({ markdownOnly: true, promptOnly: false, placement: [2] });
    assert.equal(eligibility(disp, { placement: 2, isMarkdown: true }).ok, true);
    assert.equal(eligibility(disp, { placement: 2, isPrompt: true }).ok, false);
    assert.equal(eligibility(disp, { placement: 2 }).ok, false);
    const stored = S({ markdownOnly: false, promptOnly: false, placement: [2], runOnEdit: false });
    assert.equal(eligibility(stored, { placement: 2 }).ok, true);
    assert.equal(eligibility(stored, { placement: 2, isEdit: true }).ok, false);
    const deep = S({ promptOnly: true, markdownOnly: false, placement: [2], minDepth: 2, maxDepth: 4 });
    assert.equal(eligibility(deep, { placement: 2, isPrompt: true, depth: 1 }).ok, false);
    assert.equal(eligibility(deep, { placement: 2, isPrompt: true, depth: 3 }).ok, true);
    assert.equal(eligibility(deep, { placement: 1, isPrompt: true, depth: 3 }).ok, false);
});

test('stage matrix: stored rewrite feeds display and prompt', () => {
    const ordered = [
        { scope: 'global', script: S({ scriptName: 'strip-ooc', findRegex: String.raw`/\(OOC:.*?\)/g`, replaceString: '', markdownOnly: false, promptOnly: false, placement: [2] }) },
        { scope: 'global', script: S({ scriptName: 'hide-think', findRegex: String.raw`/<think>[\s\S]*?<\/think>/g`, replaceString: '', markdownOnly: true, placement: [2] }) },
    ];
    const m = stageMatrix(ordered, { ai: '<think>plan</think>Hello (OOC: hi) there' });
    assert.equal(m['ai-saved'].output, '<think>plan</think>Hello  there');
    assert.equal(m['ai-display'].output, 'Hello  there');
    assert.equal(m['ai-prompt'].output, '<think>plan</think>Hello  there');
});

test('lint and order conflicts', () => {
    const list = [
        { scope: 'global', script: S({ scriptName: 'a', findRegex: '/cat/', replaceString: 'dog', markdownOnly: false, placement: [2] }) },
        { scope: 'global', script: S({ scriptName: 'b', findRegex: '/dog/g', replaceString: 'wolf$&', markdownOnly: false, placement: [2] }) },
        { scope: 'global', script: S({ scriptName: '', findRegex: '/(/', placement: [] }) },
    ];
    const msgs = lintScripts(list).map(i => `${i.level}:${i.message.slice(0, 20)}`);
    assert.ok(msgs.some(m => m.startsWith('info:No g flag')));
    assert.ok(msgs.some(m => m.startsWith('warn:Replacement uses')));
    assert.ok(msgs.some(m => m.startsWith('error:Script name')));
    assert.ok(msgs.some(m => m.startsWith('error:Invalid regex')));
    const conflicts = orderConflicts(list.slice(0, 2), [{ ai: 'a cat' }], ['ai-saved']);
    assert.equal(conflicts.length, 1);
});

test('import assigns fresh UUIDs and fills defaults', () => {
    const [s] = parseRegexImport({ scriptName: 'x', findRegex: '/a/', id: 'old' });
    assert.notEqual(s.id, 'old');
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.equal(s.runOnEdit, true);
});
