// Bringing files into the studio: character cards (PNG, CHARX, JSON) and Creative Studio projects or bundles.
// Every way in (Import card…, the tree's + menu, the folder menu, Ctrl+K, Open file…, dropping a file) ends up here.
import { fileBytes } from './kit.js';
import { saveMedia } from './media.js';
import { importCardFile } from '../core/cardio.js';
import { detectImportKind, isStudioProjectFile } from '../core/bundle.js';
import { newCharacter, upsertArtifact, removeArtifact, findArtifact, isUntouchedBlank, migrateProject, logHistory } from '../core/project.js';
import { uid, utf8Decode } from '../core/bytes.js';
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';

/** What the card picker offers. */
export const CARD_FILES = '.png,.json,.charx';

/**
 * What the studio does with a drag over it. It always keeps the drag from SillyTavern, whose page-wide handler imports
 * whatever is dropped there (files and links) into its own character list. Files are the studio's to import; text
 * dragged into a field is left to the browser; anything else is swallowed, so the page never navigates away.
 * @returns {{ stop: boolean, prevent: boolean, accept: boolean }} stopPropagation, preventDefault, import + overlay
 */
export function dragDecision({ files, editable }) {
    return { stop: true, prevent: files || !editable, accept: files };
}

/**
 * Ask the studio to pick a card file and import it. The app listens and opens the file dialog while the click is
 * still being handled, so browsers allow it.
 * @param {{ replaceId?: string }} [detail] an untouched blank character the import takes the place of
 */
export function openCardImport(detail = {}) {
    globalThis.dispatchEvent(new CustomEvent('cs-import-card', { detail }));
}

/**
 * Import one card as a new character with its picture and CHARX files, as one undo step: Ctrl+Z takes the
 * character and its pictures out together.
 * @returns {Promise<object|null>} the new character, or null (a toast says why)
 */
export async function importCard(store, env, bytes, fileName, { replaceId } = {}) {
    let imported;
    try {
        imported = importCardFile(bytes, fileName);
    } catch (e) {
        env.toast(`Couldn't import ${fileName}: ${e.message}`, 'error', 8000);
        return null;
    }
    const art = newCharacter(imported.card.data.name, imported.card, {
        topLevelExtras: imported.topLevelExtras,
        origin: { kind: 'import', file: fileName, format: imported.format, report: imported.report, diagnostics: imported.diagnostics, at: new Date().toISOString() },
    });
    const adds = [];
    try {
        if (imported.image) {
            const pic = await saveMedia(env, store.get(), imported.image, { name: `${art.card.data.name} avatar`, role: 'avatar' });
            adds.push(pic.apply);
            art.avatarMediaId = pic.media.id;
            art.links.media = [pic.media.id];
        }
        const extraFiles = Object.entries(imported.assetFiles ?? {});
        if (extraFiles.length) art.assetFiles = {};
        for (const [path, data] of extraFiles) {
            const file = await saveMedia(env, store.get(), data, { name: path, role: 'charx-asset', mime: 'application/octet-stream' });
            adds.push(file.apply);
            art.assetFiles[path] = file.media.id;
        }
    } catch (e) {
        env.toast(`Couldn't save the pictures in ${fileName}: ${e.message}`, 'error', 8000);
        return null;
    }
    store.update(p => {
        let next = adds.reduce((acc, apply) => apply(acc), p);
        next = upsertArtifact(next, 'characters', art, { action: 'create', actor: 'import', summary: `Imported ${fileName} (${imported.format})` });
        const blank = replaceId ? findArtifact(next, 'characters', replaceId) : null;
        return blank && isUntouchedBlank(blank, next) ? removeArtifact(next, 'characters', replaceId) : next;
    }, `import ${art.card.data.name || fileName}`, { merge: false });
    env.toast(`Imported ${art.card.data.name || fileName}. Ctrl+Z takes it back out.`, 'ok', 5000);
    return art;
}

/** Open a Creative Studio project file or bundle zip in place of the current project (which is saved first). */
export async function openProjectBytes(store, env, bytes, fileName) {
    try {
        let json;
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
            const z = unzipSync(bytes, { filter: f => f.name === 'project.studio.json' });
            if (!z['project.studio.json']) throw new Error('This zip is not a Creative Studio bundle (no project.studio.json)');
            json = JSON.parse(strFromU8(z['project.studio.json']));
        } else json = JSON.parse(utf8Decode(bytes));
        if (!isStudioProjectFile(json)) throw new Error('Not a Creative Studio project');
        const p = migrateProject(json);
        const existing = (await env.storage.listProjects()).some(x => x.id === p.id);
        if (existing) { p.id = `prj_${uid()}`; p.name = `${p.name} (imported)`; }
        await env.saveNow();
        store.reset(logHistory(p, { actor: 'import', action: 'import-project', summary: `Imported project from ${fileName}` }));
        await env.saveNow();
        env.toast(`Opened “${p.name}”`, 'ok');
        return true;
    } catch (e) {
        env.toast(`Couldn't open ${fileName}: ${e.message}`, 'error', 7000);
        return false;
    }
}

/**
 * Bring in whatever file this is: a card becomes a character in the open project, a project or bundle opens,
 * anything else gets a toast that says what the studio can open.
 * @returns {Promise<{ kind: string, character?: object|null }>}
 */
export async function importAnyFile(store, env, file, { replaceId } = {}) {
    let bytes;
    let kind;
    try {
        bytes = await fileBytes(file);
        kind = detectImportKind(bytes, file.name);
    } catch (e) {
        env.toast(`Couldn't open ${file.name}: ${e.message}`, 'error', 8000);
        return { kind: 'error' };
    }
    if (kind === 'card') return { kind, character: await importCard(store, env, bytes, file.name, { replaceId }) };
    if (kind === 'project') {
        await openProjectBytes(store, env, bytes, file.name);
        return { kind };
    }
    env.toast(kind === 'image'
        ? `${file.name} is a picture with no character card inside. To make it an avatar, open a character's Images tab.`
        : `Creative Studio can't open ${file.name}. It takes character cards (PNG, CHARX or JSON) and Creative Studio projects.`, 'error', 8000);
    return { kind };
}
