// The author's versions of the studio's AI instructions, kept in SillyTavern's extension settings (no secrets) and
// in the studio's settings backup. Only instructions that differ from the default are stored.
import { stContext } from './env.js';
import { scheduleSettingsBackup } from './studio-settings.js';
import { PROMPT_DEFAULTS } from '../ai/tasks.js';

export function promptOverrides(ctx = stContext()) {
    return ctx?.extensionSettings?.creativeStudio?.prompts ?? {};
}

/** Store the author's version of an instruction; the default text (or nothing) removes the override. */
export function setPromptOverride(key, text, ctx = stContext()) {
    ctx.extensionSettings.creativeStudio ??= {};
    const all = { ...(ctx.extensionSettings.creativeStudio.prompts ?? {}) };
    const value = String(text ?? '');
    if (!value.trim() || value === PROMPT_DEFAULTS[key]) delete all[key];
    else all[key] = value;
    ctx.extensionSettings.creativeStudio.prompts = all;
    ctx.saveSettingsDebounced?.();
    scheduleSettingsBackup(ctx);
    return all;
}

export function resetAllPrompts(ctx = stContext()) {
    ctx.extensionSettings.creativeStudio ??= {};
    ctx.extensionSettings.creativeStudio.prompts = {};
    ctx.saveSettingsDebounced?.();
    scheduleSettingsBackup(ctx);
}
