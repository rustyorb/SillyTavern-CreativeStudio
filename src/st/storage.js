// Project persistence.
// Primary: SillyTavern user files (POST /api/files/upload → data/<user>/user/files/, served at /user/files/).
// This needs no server plugin and survives browser changes. Filenames must match [A-Za-z0-9_.-].
// Fallback: an in-browser key/value cache (localforage/IndexedDB) when the server write fails.

import { bytesToBase64, utf8Encode, clone } from '../core/bytes.js';
import { migrateProject, makeSnapshot } from '../core/project.js';

const INDEX = 'cstudio-index.json';
const projectFile = id => `cstudio-p-${safe(id)}.json`;
const snapshotFile = (pid, sid) => `cstudio-s-${safe(pid)}-${safe(sid)}.json`;
const mediaFile = (pid, mid, ext) => `cstudio-m-${safe(pid)}-${safe(mid)}.${safe(ext || 'bin')}`;

function safe(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * @param {object} transport
 * @param {(name: string, base64: string) => Promise<string>} transport.upload returns client-relative path
 * @param {(path: string) => Promise<Response>} transport.fetch GET a client-relative path
 * @param {(path: string) => Promise<void>} transport.remove
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} [transport.cache]
 */
export function createStorage(transport) {
    const cache = transport.cache ?? null;
    let indexMemo = null;

    async function readJson(name) {
        const res = await transport.fetch(`user/files/${name}`);
        if (!res.ok) {
            if (res.status === 404) return null;
            throw new Error(`Failed to read ${name}: HTTP ${res.status}`);
        }
        return res.json();
    }

    async function writeJson(name, value) {
        const b64 = bytesToBase64(utf8Encode(JSON.stringify(value)));
        return transport.upload(name, b64);
    }

    async function readIndex(fresh = false) {
        if (indexMemo && !fresh) return indexMemo;
        const idx = (await readJson(INDEX).catch(() => null)) ?? { projects: [], lastOpen: '' };
        if (!Array.isArray(idx.projects)) idx.projects = [];
        indexMemo = idx;
        return idx;
    }

    async function writeIndex(idx) {
        indexMemo = idx;
        await writeJson(INDEX, idx);
    }

    return {
        async listProjects() {
            const idx = await readIndex(true);
            return [...idx.projects].sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
        },

        async loadProject(id) {
            let doc = null;
            let source = 'server';
            try {
                doc = await readJson(projectFile(id));
            } catch {
                doc = null;
            }
            if (!doc && cache) {
                doc = await cache.getItem(`project:${id}`);
                source = 'browser cache';
            }
            if (!doc) throw new Error(`Project ${id} not found`);
            const cached = cache ? await cache.getItem(`project:${id}`).catch(() => null) : null;
            // Prefer a newer unsynced browser copy (e.g. server was unreachable on last save).
            if (cached && String(cached.modified) > String(doc.modified)) {
                doc = cached;
                source = 'browser cache (newer than server copy)';
            }
            const p = migrateProject(doc);
            p._loadedFrom = source;
            return p;
        },

        async loadLastProject() {
            const idx = await readIndex();
            const id = idx.lastOpen || idx.projects[0]?.id;
            return id ? this.loadProject(id) : null;
        },

        /**
         * @param {object} project
         * @param {{ baseRevision?: string }} [opts] revision the caller last loaded/saved; a different server revision means another tab saved in between
         * @returns {Promise<{where: 'server'|'browser', error?: string, revision?: string, conflict?: {snapshotId: string}}>}
         */
        async saveProject(project, { baseRevision } = {}) {
            const doc = clone(project);
            delete doc._loadedFrom;
            doc.revision = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            if (cache) await cache.setItem(`project:${doc.id}`, doc).catch(() => {});
            let conflict;
            if (baseRevision !== undefined) {
                const server = await readJson(projectFile(doc.id)).catch(() => null);
                if (server && server.revision && server.revision !== baseRevision) {
                    // Someone else (another tab/device) saved since we loaded: keep their version as a snapshot, then save ours.
                    const snap = makeSnapshot(migrateProject(server), 'Concurrent edit from another tab (kept before overwrite)', 'conflict');
                    await writeJson(snapshotFile(doc.id, snap.id), snap).catch(() => {});
                    const idx = await readIndex(true);
                    await writeIndex({ ...idx, projects: idx.projects.map(p => (p.id === doc.id ? { ...p, snapshots: [...(p.snapshots ?? []), { id: snap.id, time: snap.time, label: snap.label, kind: 'conflict', hash: snap.hash }].slice(-200) } : p)) });
                    conflict = { snapshotId: snap.id };
                }
            }
            try {
                await writeJson(projectFile(doc.id), doc);
                const idx = await readIndex(true);
                const prev = idx.projects.find(p => p.id === doc.id) ?? {};
                const entry = { ...prev, id: doc.id, name: doc.name, modified: doc.modified, characters: doc.characters.length };
                const others = idx.projects.filter(p => p.id !== doc.id);
                await writeIndex({ ...idx, projects: [...others, entry], lastOpen: doc.id });
                return { where: 'server', revision: doc.revision, conflict };
            } catch (e) {
                return { where: 'browser', error: e.message };
            }
        },

        async deleteProject(id) {
            const idx = await readIndex(true);
            const entry = idx.projects.find(p => p.id === id);
            await writeIndex({ ...idx, projects: idx.projects.filter(p => p.id !== id), lastOpen: idx.lastOpen === id ? '' : idx.lastOpen });
            // Deletion from the server is deliberate and reversible only via snapshots exported earlier.
            await transport.remove(`user/files/${projectFile(id)}`).catch(() => {});
            for (const s of entry?.snapshots ?? []) await transport.remove(`user/files/${snapshotFile(id, s.id)}`).catch(() => {});
            if (cache) await cache.removeItem(`project:${id}`).catch(() => {});
        },

        async saveSnapshot(project, label, kind = 'manual') {
            const snap = makeSnapshot(project, label, kind);
            await writeJson(snapshotFile(project.id, snap.id), snap);
            const idx = await readIndex(true);
            const projects = idx.projects.map(p => (p.id === project.id
                ? { ...p, snapshots: [...(p.snapshots ?? []), { id: snap.id, time: snap.time, label, kind, hash: snap.hash }].slice(-200) }
                : p));
            await writeIndex({ ...idx, projects });
            return snap;
        },

        async listSnapshots(projectId) {
            const idx = await readIndex(true);
            return [...(idx.projects.find(p => p.id === projectId)?.snapshots ?? [])].reverse();
        },

        async loadSnapshot(projectId, snapshotId) {
            const s = await readJson(snapshotFile(projectId, snapshotId));
            if (!s) throw new Error('Snapshot file missing');
            return s;
        },

        /** Store binary media; returns a client-relative URL usable in <img src>. */
        async saveMedia(projectId, mediaId, ext, bytes) {
            return transport.upload(mediaFile(projectId, mediaId, ext), bytesToBase64(bytes));
        },

        async loadMediaBytes(path) {
            const res = await transport.fetch(path.replace(/^\//, ''));
            if (!res.ok) throw new Error(`Media fetch failed: HTTP ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        },

        _invalidate() {
            indexMemo = null;
        },
    };
}
