// Playtest sandbox: assemble what a turn would send from project artifacts, and record reproducible runs.
import { clone, hashString, stableStringify, uid } from './bytes.js';
import { assembleCc, sceneFromCard, emptyCcPreset } from './preset.js';
import { simulateActivation, POSITION, WI_SETTINGS_DEFAULTS } from './lorebook.js';
import { applyAt, makeMacros } from './regex.js';
import { findArtifact } from './project.js';
import { characterBookToWorld, normalizeWorld } from './lorebook.js';

/**
 * @param {object} project
 * @param {object} cfg
 * @param {string} cfg.characterId
 * @param {string} [cfg.presetId] project CC preset (default: ST-like default)
 * @param {string[]} [cfg.lorebookIds] project lorebooks to scan (character-linked ones are added automatically)
 * @param {boolean} [cfg.useEmbeddedBook] scan the card's embedded book (only if the user would import it in ST)
 * @param {{role: 'user'|'assistant', text: string}[]} cfg.chat oldest first (stored text)
 * @param {string} [cfg.user]
 * @param {string} [cfg.persona]
 * @param {object} [cfg.wiSettings]
 * @param {number} [cfg.maxContext]
 * @param {string} [cfg.generationType]
 * @returns {{ messages: {role: string, content: string}[], activation: any, config: object, blocks: any[] }}
 */
export function buildSandboxTurn(project, cfg) {
    const ch = findArtifact(project, 'characters', cfg.characterId);
    if (!ch) throw new Error('Pick a character for the playtest');
    const preset = cfg.presetId ? findArtifact(project, 'presets', cfg.presetId) : null;
    const presetData = preset?.data ?? emptyCcPreset();
    const user = cfg.user || 'User';
    const card = ch.card;
    const macros = makeMacros({ char: card.data.name, user });

    // Regex: prompt-stage scripts (global → preset → character) rewrite history before it is sent.
    const ordered = [
        ...project.regexScripts.map(r => ({ scope: 'global', script: r.script })),
        ...(presetData.extensions?.regex_scripts ?? []).map(s => ({ scope: 'preset', script: s })),
        ...(card.data.extensions?.regex_scripts ?? []).map(s => ({ scope: 'character', script: s })),
    ];
    const chat = cfg.chat.map((m, i) => {
        const depth = cfg.chat.length - 1 - i;
        const site = { placement: m.role === 'user' ? 1 : 2, isPrompt: true, depth };
        return { role: m.role, text: applyAt(ordered, m.text, site, { macros }).output };
    });

    // Lore activation across linked + chosen books.
    const bookIds = [...new Set([...(ch.links?.lorebooks ?? []), ...(cfg.lorebookIds ?? [])])];
    const books = bookIds.map(id => findArtifact(project, 'lorebooks', id)).filter(Boolean).map(b => ({ name: b.name, world: b.data }));
    if (cfg.useEmbeddedBook && card.data.character_book?.entries?.length) {
        books.push({ name: `${card.data.name} (embedded)`, world: normalizeWorld(characterBookToWorld(card.data.character_book)).world });
    }
    const activation = simulateActivation({
        books,
        chat: chat.map(m => ({ name: m.role === 'user' ? user : card.data.name, mes: m.text })),
        settings: { ...WI_SETTINGS_DEFAULTS, ...(cfg.wiSettings ?? {}) },
        maxContext: cfg.maxContext ?? presetData.openai_max_context ?? 8192,
        generationType: cfg.generationType ?? 'normal',
        probabilityMode: 'assume',
        random: () => 0.5,
        macros,
        scanData: { characterDescription: card.data.description, characterPersonality: card.data.personality, scenario: card.data.scenario, creatorNotes: card.data.creator_notes, personaDescription: cfg.persona ?? '' },
    });
    const wiRegex = text => applyAt(ordered, text, { placement: 5, isPrompt: true, isMarkdown: false }, { macros }).output;
    const join = list => (list ?? []).map(a => wiRegex(a.content)).join('\n');
    const scene = sceneFromCard(card, { user, persona: cfg.persona ?? '', chat });
    scene.wiBefore = join(activation.placed[POSITION.before]);
    scene.wiAfter = join(activation.placed[POSITION.after]);
    const blocks = assembleCc(presetData, scene, { generationType: cfg.generationType ?? 'normal' });
    // At-depth lore goes into chat at its depth (system role unless specified).
    const depthLore = [];
    for (const [key, list] of Object.entries(activation.placed[POSITION.atDepth] ?? {})) {
        const [depth, role] = key.split(':').map(Number);
        depthLore.push({ depth, role: ['system', 'user', 'assistant'][role] ?? 'system', content: join(list) });
    }
    let messages = blocks.filter(b => b.source !== 'note').map(b => ({ role: b.role, content: b.content, _src: b.source }));
    const chatIdx = messages.map((m, i) => (m._src === 'chat' ? i : -1)).filter(i => i >= 0);
    for (const dl of depthLore.sort((a, b) => b.depth - a.depth)) {
        const at = chatIdx.length ? (dl.depth >= chatIdx.length ? chatIdx[0] : chatIdx[chatIdx.length - dl.depth] ?? chatIdx[chatIdx.length - 1] + 1) : messages.length;
        messages.splice(at, 0, { role: dl.role, content: dl.content, _src: 'lore@depth' });
    }
    messages = messages.map(({ role, content }) => ({ role, content }));

    const config = {
        mode: 'sandbox',
        character: { id: ch.id, name: card.data.name, cardHash: hashString(stableStringify(card)) },
        preset: preset ? { id: preset.id, name: preset.name, hash: hashString(stableStringify(preset.data)), version: preset.versions?.length ?? 0 } : { id: '', name: '(default prompts)', hash: '' },
        lorebooks: books.map(b => ({ name: b.name, hash: hashString(stableStringify(b.world)) })),
        activatedLore: activation.activated.map(a => ({ world: a.world, uid: a.uid, comment: a.comment })),
        regex: ordered.filter(o => !o.script.disabled).map(o => ({ scope: o.scope, name: o.script.scriptName })),
        wiSettings: activation.settings,
        generationType: cfg.generationType ?? 'normal',
    };
    return { messages, activation, config, blocks };
}

/** Post-process a model reply as ST would store and display it (AI output stages). */
export function processReply(project, cfg, text) {
    const ch = findArtifact(project, 'characters', cfg.characterId);
    const preset = cfg.presetId ? findArtifact(project, 'presets', cfg.presetId) : null;
    const macros = makeMacros({ char: ch?.card.data.name ?? 'Char', user: cfg.user || 'User' });
    const ordered = [
        ...project.regexScripts.map(r => ({ scope: 'global', script: r.script })),
        ...(preset?.data?.extensions?.regex_scripts ?? []).map(s => ({ scope: 'preset', script: s })),
        ...(ch?.card.data.extensions?.regex_scripts ?? []).map(s => ({ scope: 'character', script: s })),
    ];
    const stored = applyAt(ordered, text, { placement: 2 }, { macros }).output;
    const display = applyAt(ordered, stored, { placement: 2, isMarkdown: true, depth: 0 }, { macros }).output;
    return { stored, display };
}

export function newPlaytestRecord(scenario, config) {
    return { id: uid('pt'), time: new Date().toISOString(), scenarioId: scenario?.id ?? '', scenarioName: scenario?.name ?? 'Ad-hoc', config: clone(config), transcript: [], rating: 0, notes: '' };
}

export function newScenario(name, characterId) {
    return { id: uid('sc'), name, characterId, greeting: 0, userTurns: ['*I look around, taking in the scene.*', 'What happened here?', 'I decide to help. Where do we start?'], notes: '' };
}
