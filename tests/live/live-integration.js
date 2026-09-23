// Live integration tests: run inside a SillyTavern 1.19 page (Creative Studio loaded).
//   const m = await import('/scripts/extensions/third-party/creative-studio/tests/live/live-integration.js');
//   await m.runLiveTests();   // → { passed, failed, results[] }
// Every item it creates is prefixed CSTEST_ and removed at the end.

import { stContext, stPost, readStWorldInfoSettings } from '../../src/st/env.js';
import * as live from '../../src/st/live.js';
import { importCardFile, exportCard } from '../../src/core/cardio.js';
import { emptyCardV3 } from '../../src/core/card.js';
import { newEntry } from '../../src/core/lorebook.js';
import { emptyCcPreset, sceneFromCard, INSTRUCT_DEFAULT } from '../../src/core/preset.js';
import { newSet, addQr } from '../../src/core/qr.js';
import { parseLive, commandRegistry, installQrSetLive } from '../../src/st/stscript-live.js';
import { renderTcPrompt } from '../../src/st/render.js';
import { blankPng } from '../../src/core/png.js';

export async function runLiveTests() {
    const results = [];
    const cleanup = [];
    const t = async (name, fn) => {
        const started = performance.now();
        try {
            const detail = await fn();
            results.push({ name, ok: true, detail: detail ?? '', ms: Math.round(performance.now() - started) });
        } catch (e) {
            results.push({ name, ok: false, detail: e?.message ?? String(e), ms: Math.round(performance.now() - started) });
        }
    };
    const assert = (c, m) => { if (!c) throw new Error(m); };
    const ctx = stContext();

    await t('ST version and context surface', async () => {
        const v = await fetch('/version').then(r => r.json());
        for (const k of ['generateRaw', 'ConnectionManagerRequestService', 'getPresetManager', 'loadWorldInfo', 'saveWorldInfo', 'SlashCommandParser', 'executeSlashCommandsWithOptions', 'writeExtensionField', 'getOneCharacter']) assert(k in ctx, `missing ctx.${k}`);
        return `SillyTavern ${v.pkgVersion}`;
    });

    await t('Read ST default card via export PNG → V3 normalization keeps extensions', async () => {
        const avatar = (ctx.characters ?? []).find(c => c.avatar)?.avatar;
        assert(avatar, 'no characters in ST');
        const png = await live.exportStCharacterPng(avatar);
        const r = importCardFile(png, avatar);
        assert(r.card.spec === 'chara_card_v3', 'not normalized');
        assert(r.format.startsWith('png/'), r.format);
        return `${avatar}: ${r.format}, ${Object.keys(r.card.data.extensions).length} extension keys`;
    });

    let avatar = null;
    const name = `CSTEST_Card_${Date.now().toString(36)}`;
    await t('Create character via /api/characters/import (spec V3 PNG) and read back', async () => {
        const card = emptyCardV3(name);
        card.data.description = 'Integration test card.';
        card.data.first_mes = 'Hello from the studio test.';
        card.data.alternate_greetings = ['Alt one'];
        card.data.nickname = 'Testy';
        card.data.group_only_greetings = ['Group hello'];
        card.data.creator_notes_multilingual = { en: 'notes' };
        card.data.extensions = { 'studio/test': { keep: true } };
        const png = exportCard('png-v3', { card, image: blankPng() }).bytes;
        avatar = await live.importIntoSt(png, 'png', `${name}.png`);
        cleanup.push(async () => stPost('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).then(() => ctx.getCharacters?.()));
        const stored = await live.getStCharacter(avatar);
        const diff = live.fidelityReport(card, stored);
        assert(stored.data.nickname === 'Testy', 'nickname lost');
        assert(stored.data.extensions['studio/test']?.keep === true, 'unknown extension lost');
        assert(stored.data.group_only_greetings?.[0] === 'Group hello', 'group_only_greetings lost');
        return `created ${avatar}; ${diff.length} stored difference(s): ${diff.map(d => `${d.kind} ${d.path}`).join('; ') || 'none'}`;
    });

    await t('Apply edits via merge-attributes, removals unset, backup restores', async () => {
        assert(avatar, 'no test character');
        const before = await live.getStCharacter(avatar);
        const card = importCardFile(await live.exportStCharacterPng(avatar), avatar).card;
        card.data.description = 'Edited by apply test.';
        card.data.alternate_greetings = [];
        delete card.data.nickname;
        const { backup, fidelity } = await live.applyCardToSt(avatar, card);
        const after = await live.getStCharacter(avatar);
        assert(after.data.description === 'Edited by apply test.', 'description not applied');
        assert(after.description === 'Edited by apply test.', 'V1 mirror not applied');
        assert((after.data.alternate_greetings ?? []).length === 0, 'array not replaced');
        assert(after.data.nickname === undefined, 'removed key not unset');
        await live.restoreCharacterBackup(backup);
        const restored = await live.getStCharacter(avatar);
        assert(restored.data.description === before.data.description, 'restore failed');
        assert(restored.data.nickname === 'Testy', 'restore did not bring back nickname');
        return `applied + restored; post-apply differences: ${fidelity.length}`;
    });

    const world = `CSTEST_World_${Date.now().toString(36)}`;
    await t('Save World Info through saveWorldInfo, read back, restore (delete)', async () => {
        const data = { entries: {} };
        const e = newEntry(data, { comment: 'Test', key: ['cstest'], content: 'Test content' });
        data.entries[e.uid] = e;
        const { backup } = await live.saveStWorld(world, data);
        cleanup.push(() => stPost('/api/worldinfo/delete', { name: world }).then(() => ctx.updateWorldInfoList?.()));
        assert(!backup.existed, 'should be new');
        const names = await live.listStWorlds();
        assert(names.includes(world), 'not listed');
        const back = await stPost('/api/worldinfo/get', { name: world });
        assert(back.entries?.[0]?.content === 'Test content', 'content mismatch on disk');
        return 'saved and verified on disk';
    });

    await t('Save CC preset via /api/presets/save and read file back', async () => {
        const pname = `CSTEST_Preset_${Date.now().toString(36)}`;
        const p = emptyCcPreset();
        p.prompts.find(x => x.identifier === 'main').content = 'CSTEST main';
        await stPost('/api/presets/save', { apiId: 'openai', name: pname, preset: p });
        cleanup.push(() => stPost('/api/presets/delete', { apiId: 'openai', name: pname }));
        const settings = await stPost('/api/settings/get', {});
        const idx = settings.openai_setting_names.indexOf(pname);
        assert(idx >= 0, 'preset not listed by /api/settings/get');
        const stored = JSON.parse(settings.openai_settings[idx]);
        assert(stored.prompts.find(x => x.identifier === 'main').content === 'CSTEST main', 'content mismatch');
        return 'saved and listed';
    });

    await t('Studio-made CHARX is accepted by SillyTavern’s CHARX importer', async () => {
        const card = emptyCardV3(`CSTEST_Charx_${Date.now().toString(36)}`);
        card.data.first_mes = 'From a CHARX.';
        const bytes = exportCard('charx', { card, image: blankPng() }).bytes;
        const av = await live.importIntoSt(bytes, 'charx', `${card.data.name}.charx`);
        cleanup.push(async () => stPost('/api/characters/delete', { avatar_url: av, delete_chats: true }).then(() => ctx.getCharacters?.()));
        const stored = await live.getStCharacter(av);
        assert(stored.data.first_mes === 'From a CHARX.', 'content mismatch');
        assert(Array.isArray(stored.data.assets), 'assets not kept');
        return `imported as ${av}`;
    });

    await t('Bundle World Info JSON is accepted by /api/worldinfo/import', async () => {
        const wname = `CSTEST_Import_${Date.now().toString(36)}`;
        const data = { entries: {} };
        const e = newEntry(data, { comment: 'Imported', key: ['x'], content: 'y' });
        data.entries[e.uid] = e;
        const form = new FormData();
        form.append('avatar', new Blob([JSON.stringify(data)], { type: 'application/json' }), `${wname}.json`);
        const res = await fetch('/api/worldinfo/import', { method: 'POST', headers: ctx.getRequestHeaders({ omitContentType: true }), body: form });
        assert(res.ok, `HTTP ${res.status}`);
        const { name: created } = await res.json();
        cleanup.push(() => stPost('/api/worldinfo/delete', { name: created }).then(() => ctx.updateWorldInfoList?.()));
        const back = await stPost('/api/worldinfo/get', { name: created });
        assert(back.entries?.[0]?.comment === 'Imported', 'entry missing');
        return `imported as ${created}`;
    });

    await t('STscript: real parser accepts valid script, reports errors with position', async () => {
        const ok = parseLive('/setvar key=x 1 | /getvar x | /echo {{pipe}}');
        assert(ok.available && ok.ok, `valid script rejected: ${ok.error?.message}`);
        const bad = parseLive('/if left=1 rule=eq right=1 {: /echo a');
        assert(bad.available && !bad.ok, 'unclosed closure accepted');
        const unk = parseLive('/definitely-not-a-command x');
        assert(!unk.ok && /Unknown command/.test(unk.error.message), 'unknown command not reported');
        const reg = commandRegistry();
        assert(reg.byName.has('echo') && reg.byName.has('setvar'), 'registry missing core commands');
        return `${reg.byName.size} commands registered; error: "${bad.error.message}"`;
    });

    await t('Quick Reply: install via QR importer; set available immediately', async () => {
        if (!globalThis.quickReplyApi) throw new Error('Quick Reply extension not active');
        const sname = `CSTEST_QR_${Date.now().toString(36)}`;
        const { set } = addQr(newSet(sname), { label: 'Ping', message: '/echo pong' });
        const r = await installQrSetLive(set);
        // QuickReplySet.save() is debounced (200 ms): wait it out, or the pending save recreates the file after deletion.
        cleanup.push(async () => {
            await new Promise(r => setTimeout(r, 600));
            await globalThis.quickReplyApi.deleteSet(sname).catch(() => {});
            await stPost('/api/quick-replies/delete', { name: sname }).catch(() => {});
        });
        assert(r.ok, r.error ?? 'install failed');
        const labels = globalThis.quickReplyApi.listQuickReplies(sname);
        assert(labels.includes('Ping'), 'QR not present');
        return `installed ${sname} with ${labels.length} QR`;
    });

    await t('Text Completion preview renders with SillyTavern’s own functions', async () => {
        const r = await renderTcPrompt({ instruct: { ...INSTRUCT_DEFAULT, input_sequence: '<|im_start|>user', output_sequence: '<|im_start|>assistant', input_suffix: '<|im_end|>\n', output_suffix: '<|im_end|>\n', stop_sequence: '<|im_end|>' }, sysprompt: { content: 'Be {{char}}.' } }, sceneFromCard(emptyCardV3('Mira')));
        assert(r.renderer === 'sillytavern', 'fell back to approximation');
        assert(r.text.includes('<|im_start|>user'), 'instruct sequences missing');
        assert(r.text.includes('Be Mira.'), 'system prompt missing');
        return `${r.text.length} chars, ${r.stops.length} stop strings`;
    });

    await t('Live World Info settings are readable', async () => {
        const s = await readStWorldInfoSettings();
        assert(s && Number.isFinite(s.depth), 'not readable');
        return JSON.stringify(s);
    });

    await t('Dry-run prompt capture (requires an open character chat)', async () => {
        if (ctx.characterId == null && !ctx.groupId) return 'skipped: no chat open';
        const r = await live.dryRunPrompt();
        return r.messages ? `${r.messages.length} messages` : `${r.text.length} chars`;
    });

    for (const c of cleanup.reverse()) {
        try { await c(); } catch (e) { results.push({ name: 'cleanup', ok: false, detail: e.message }); }
    }
    const passed = results.filter(r => r.ok).length;
    return { passed, failed: results.length - passed, results };
}
