// Module worker: evaluates regex previews off the main thread so a catastrophic pattern cannot freeze SillyTavern.
import { stageMatrix, makeMacros, orderConflicts } from './regex.js';

self.onmessage = ev => {
    const { id, ordered, fixtures, depth, macroValues, conflicts } = ev.data;
    try {
        const macros = makeMacros(macroValues);
        const results = fixtures.map(f => stageMatrix(ordered, f, { depth: f.depth ?? depth ?? 0, macros }));
        const conf = conflicts ? orderConflicts(ordered, fixtures) : [];
        self.postMessage({ id, ok: true, results, conflicts: conf });
    } catch (e) {
        self.postMessage({ id, ok: false, error: e.message });
    }
};
