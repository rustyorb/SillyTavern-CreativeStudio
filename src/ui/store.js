// Minimal observable store for the open project with undo/redo and autosave hooks.
import { useEffect, useState } from '../../vendor/preact-htm.mjs';

const MAX_UNDO = 150;

/**
 * @param {object} initial
 * @param {object} [opts]
 * @param {string[]} [opts.sticky] top-level keys that undo/redo leave as they are (records of what happened, not content)
 */
export function createStore(initial, { sticky = [] } = {}) {
    let state = initial;
    const listeners = new Set();
    const undo = [];
    const redo = [];
    let lastLabel = '';
    let lastTime = 0;

    const emit = () => listeners.forEach(l => l(state));
    const keepSticky = restored => (sticky.length ? { ...restored, ...Object.fromEntries(sticky.filter(k => k in state).map(k => [k, state[k]])) } : restored);

    return {
        get: () => state,
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        /**
         * Replace the state with the result of `fn(state)`.
         * Consecutive edits with the same label within 1.5s coalesce into one undo step (typing).
         */
        update(fn, label = 'edit', { history = true } = {}) {
            const prev = state;
            const next = fn(state);
            if (next === prev) return;
            if (!history) {
                // Bookkeeping (e.g. generation progress): saved, but not an undo step.
                state = next;
                emit();
                return;
            }
            const t = Date.now();
            const coalesce = label === lastLabel && t - lastTime < 1500 && undo.length;
            if (!coalesce) {
                undo.push({ state: prev, label });
                if (undo.length > MAX_UNDO) undo.shift();
            }
            lastLabel = label;
            lastTime = t;
            redo.length = 0;
            state = next;
            emit();
        },
        /** Replace without recording undo (loading a project). */
        reset(next) {
            state = next;
            undo.length = 0;
            redo.length = 0;
            lastLabel = '';
            emit();
        },
        undo() {
            const step = undo.pop();
            if (!step) return null;
            redo.push({ state, label: step.label });
            state = keepSticky(step.state);
            lastLabel = '';
            emit();
            return step.label;
        },
        redo() {
            const step = redo.pop();
            if (!step) return null;
            undo.push({ state, label: step.label });
            state = keepSticky(step.state);
            lastLabel = '';
            emit();
            return step.label;
        },
        canUndo: () => undo.length > 0,
        canRedo: () => redo.length > 0,
        peekUndo: () => undo[undo.length - 1]?.label ?? '',
        peekRedo: () => redo[redo.length - 1]?.label ?? '',
    };
}

/** Subscribe a component to a store. */
export function useStore(store) {
    const [, setTick] = useState(0);
    useEffect(() => store.subscribe(() => setTick(t => t + 1)), [store]);
    return store.get();
}
