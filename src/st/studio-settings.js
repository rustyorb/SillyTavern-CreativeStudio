// Self-healing studio settings. SillyTavern saves its whole settings file from whichever tab saves last, so a tab that
// was opened long ago can silently wipe newer extension settings and Connection Manager profiles. The studio keeps
// a copy of what it owns in its own user file and puts back anything that went missing. The copy holds no secrets:
// profiles refer to keys by secret id only.

const FILE = 'cstudio-settings.json';
let storage = null;
let timer = null;

/** What the studio owns: its settings plus the Connection Manager profiles it created. */
export function studioSnapshot(extensionSettings) {
    const cs = extensionSettings?.creativeStudio ?? {};
    const ids = new Set(cs.profileIds ?? []);
    const profiles = (extensionSettings?.connectionManager?.profiles ?? []).filter(p => ids.has(p.id)).map(p => ({ ...p }));
    return { version: 1, saved: new Date().toISOString(), settings: JSON.parse(JSON.stringify(cs)), profiles };
}

/**
 * Put back what a stale tab removed. Live values always win. Profiles come back only when the studio's own records
 * were wiped too (the stale-tab signature); a profile that is gone while the studio still lists it was deleted on
 * purpose in Connection Manager, so the studio forgets it instead.
 * @returns {string[]} what was restored
 */
export function healSettings(extensionSettings, backup) {
    const restored = [];
    extensionSettings.creativeStudio ??= {};
    const cs = extensionSettings.creativeStudio;
    const wiped = !Array.isArray(cs.profileIds) || (!cs.profileIds.length && (backup?.settings?.profileIds ?? []).length > 0);
    for (const [k, v] of Object.entries(backup?.settings ?? {})) {
        if (cs[k] === undefined || (k === 'profileIds' && wiped)) {
            cs[k] = JSON.parse(JSON.stringify(v));
            restored.push(`studio setting "${k}"`);
        }
    }
    const cm = extensionSettings.connectionManager;
    if (cm && Array.isArray(cm.profiles)) {
        const have = new Set(cm.profiles.map(p => p.id));
        if (wiped) {
            for (const p of backup?.profiles ?? []) {
                if (!have.has(p.id) && (cs.profileIds ?? []).includes(p.id)) {
                    cm.profiles.push({ ...p });
                    have.add(p.id);
                    restored.push(`profile "${p.name}"`);
                }
            }
        }
        // Deleted in Connection Manager: stop tracking it (and stop using it as the default).
        const gone = (cs.profileIds ?? []).filter(id => !have.has(id));
        if (gone.length) {
            cs.profileIds = cs.profileIds.filter(id => have.has(id));
            if (gone.includes(cs.defaultCreationProfileId)) delete cs.defaultCreationProfileId;
        }
    }
    return restored;
}

/** Called once when the studio opens: read the backup, heal, and save ST settings if anything came back. */
export async function attachSettingsBackup(ctx, store) {
    storage = store;
    let backup = null;
    try { backup = await storage.readSettingsBackup(); } catch { backup = null; }
    const restored = healSettings(ctx.extensionSettings, backup);
    if (restored.length) ctx.saveSettingsDebounced();
    scheduleSettingsBackup(ctx);
    return restored;
}

/** Write the backup a moment after studio settings change (debounced). */
export function scheduleSettingsBackup(ctx) {
    if (!storage) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
        storage.writeSettingsBackup(studioSnapshot(ctx.extensionSettings)).catch(() => {});
    }, 800);
}
