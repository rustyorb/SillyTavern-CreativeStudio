// Render Text Completion prompts with SillyTavern's own functions and the project's templates.
// renderStoryString(params, {customStoryString, customInstructSettings, customContextSettings}) — power-user.js
// formatInstructModeStoryString / formatInstructModeChat / formatInstructModePrompt / getInstructStoppingSequences — instruct-mode.js
// All accept custom templates, so no live settings are modified.
// Paths: served at /scripts/extensions/third-party/<folder>/src/st/ → five levels up is /scripts/.

import { assembleTcFallback, fillMacros, INSTRUCT_DEFAULT, CONTEXT_DEFAULT } from '../core/preset.js';

let mods = null;
async function stModules() {
    if (mods) return mods;
    try {
        const [pu, im] = await Promise.all([import('../../../../../power-user.js'), import('../../../../../instruct-mode.js')]);
        mods = { renderStoryString: pu.renderStoryString, ...im };
    } catch {
        mods = {};
    }
    return mods;
}

/**
 * @param {{context?: object, instruct?: object, sysprompt?: object}} tpl project templates (missing = ST defaults)
 * @param {object} scene from sceneFromCard
 * @returns {Promise<{ text: string, stops: string[], renderer: 'sillytavern'|'fallback', notes: string[] }>}
 */
export async function renderTcPrompt(tpl, scene) {
    const m = await stModules();
    const notes = [];
    const instruct = { ...INSTRUCT_DEFAULT, ...(tpl.instruct ?? {}), enabled: tpl.instructEnabled ?? true };
    const context = { ...CONTEXT_DEFAULT, ...(tpl.context ?? {}) };
    const system = tpl.sysprompt?.content ? fillMacros(tpl.sysprompt.content, scene) : '';
    if (!m.renderStoryString || !m.formatInstructModeChat) {
        notes.push('SillyTavern renderer unavailable; showing an approximation.');
        return { text: assembleTcFallback({ context, instruct, sysprompt: tpl.sysprompt }, scene), stops: [], renderer: 'fallback', notes };
    }
    const params = {
        description: scene.description, personality: scene.personality, persona: scene.persona, scenario: scene.scenario, system,
        char: scene.char, user: scene.user, wiBefore: scene.wiBefore ?? '', wiAfter: scene.wiAfter ?? '', loreBefore: scene.wiBefore ?? '', loreAfter: scene.wiAfter ?? '',
        anchorBefore: '', anchorAfter: '', mesExamples: '', mesExamplesRaw: '',
    };
    let story = m.renderStoryString(params, { customStoryString: context.story_string, customInstructSettings: instruct, customContextSettings: context });
    if (instruct.enabled && m.formatInstructModeStoryString) story = m.formatInstructModeStoryString(story, { customContext: context, customInstruct: instruct });
    const parts = [story];
    if (context.story_string_position === 1) notes.push('Story string position is In-Chat; it is shown at the top here for readability.');
    if (context.chat_start) parts.push(`${fillMacros(context.chat_start, scene)}\n`);
    for (const msg of scene.chat ?? []) {
        const isUser = msg.role === 'user';
        const name = isUser ? scene.user : scene.char;
        const text = fillMacros(msg.text, scene);
        parts.push(instruct.enabled
            ? m.formatInstructModeChat(name, text, isUser, false, '', scene.user, scene.char, false, instruct)
            : `${name}: ${text}\n`);
    }
    parts.push(instruct.enabled ? m.formatInstructModePrompt(scene.char, false, '', scene.user, scene.char, false, false, instruct) : `${scene.char}:`);
    let stops = [];
    try { stops = m.getInstructStoppingSequences?.({ customInstruct: instruct, useStopStrings: true }) ?? []; } catch { stops = []; }
    notes.push('Rendered by SillyTavern’s own story-string and instruct functions with the project templates. Example dialogue, World Info and Author’s Note are omitted.');
    return { text: parts.join(''), stops, renderer: 'sillytavern', notes };
}
