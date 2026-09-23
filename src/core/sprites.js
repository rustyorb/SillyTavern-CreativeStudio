// Expression sprites as SillyTavern's Character Expressions stores them: characters/<folder>/<label>[-variant].png.

/** The folder Character Expressions reads for a character: its name, unless an override is set for its avatar file. */
export function spriteFolderFor(avatar, name, overrides = []) {
    const stem = String(avatar ?? '').replace(/\.[^/.]+$/, '');
    const override = (overrides ?? []).find(o => o?.name === stem);
    return override?.path || name;
}

/** One picture per expression from /api/sprites/get: the plain "joy.png" wins over variants such as "joy-2.png". */
export function pickSprites(list) {
    const best = {};
    for (const s of list ?? []) {
        const label = String(s?.label ?? '').toLowerCase();
        if (!label || !s.path) continue;
        const file = decodeURIComponent(String(s.path).split('?')[0].split('/').pop() ?? '');
        const plain = file.replace(/\.[^.]+$/, '').toLowerCase() === label;
        if (!best[label] || (plain && !best[label].plain)) best[label] = { path: s.path, plain };
    }
    return Object.fromEntries(Object.entries(best).map(([label, v]) => [label, v.path]));
}
