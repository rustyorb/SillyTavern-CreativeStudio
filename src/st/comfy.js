// ComfyUI through SillyTavern's own proxy (/api/sd/comfy/*): no CORS setup on the ComfyUI side, and the same
// server address SillyTavern's Image Generation extension uses. Settings hold no secrets (a URL and choices).

import { stContext, stPost } from './env.js';
import { scheduleSettingsBackup } from './studio-settings.js';
import {
    detectFamily, samplingFor, composePrompt, buildTxt2Img, buildExpression, spritePrompts, adoptWorkflow, sizeFor,
    randomSeed, detectExtras,
} from '../core/comfy.js';

export const IMAGE_DEFAULTS = {
    backend: '',            // '' (off) | 'comfy' | 'st' (SillyTavern's Image Generation extension, /imagine)
    url: 'http://127.0.0.1:8188',
    ckpt: '',
    family: 'auto',         // 'auto' | 'pony' | 'illustrious' | 'realistic'
    steps: '', cfg: '', sampler: '', scheduler: '',
    hires: true,            // second pass for sharper portraits
    transparentSprites: true,
    workflow: null,         // { name, json } an imported API-format workflow, used instead of the built-in one
};

export function imageSettings(ctx = stContext()) {
    ctx.extensionSettings.creativeStudio ??= {};
    ctx.extensionSettings.creativeStudio.image = { ...IMAGE_DEFAULTS, ...(ctx.extensionSettings.creativeStudio.image ?? {}) };
    return ctx.extensionSettings.creativeStudio.image;
}

export function saveImageSettings(patch, ctx = stContext()) {
    Object.assign(imageSettings(ctx), patch);
    ctx.saveSettingsDebounced();
    scheduleSettingsBackup(ctx);
    return imageSettings(ctx);
}

/** Is there an image backend the studio can paint with right now? */
export function imageReady(ctx = stContext()) {
    const s = imageSettings(ctx);
    if (s.backend === 'comfy') return !!(s.url && (s.ckpt || s.workflow));
    if (s.backend === 'st') return !!ctx.SlashCommandParser?.commands?.imagine;
    return false;
}

export function familyOf(s) {
    return s.family && s.family !== 'auto' ? s.family : detectFamily(s.ckpt);
}

export async function comfyPing(url) {
    const res = await stPost('/api/sd/comfy/ping', { url }, { raw: true });
    if (!res.ok) throw new Error(`ComfyUI is not reachable at ${url}. Is it running, and started with --listen if it is on another machine?`);
    return true;
}

/** Full checkpoints only: SillyTavern's list also has diffusion-only UNet/GGUF files, which CheckpointLoaderSimple cannot load. */
export async function comfyCheckpoints(url) {
    const list = await stPost('/api/sd/comfy/models', { url });
    return (Array.isArray(list) ? list : [])
        .filter(m => !/^(UNet|GGUF):/i.test(String(m.text ?? '')))
        .map(m => m.value)
        .filter(v => /\.(safetensors|ckpt)$/i.test(v));
}

export async function comfySamplers(url) {
    const [samplers, schedulers] = await Promise.all([stPost('/api/sd/comfy/samplers', { url }), stPost('/api/sd/comfy/schedulers', { url })]);
    return { samplers: Array.isArray(samplers) ? samplers : [], schedulers: Array.isArray(schedulers) ? schedulers : [] };
}

/** Queue a workflow and wait for its image. @returns {Promise<Uint8Array>} */
export async function comfyRun(url, workflow, signal) {
    const res = await fetch('/api/sd/comfy/generate', {
        method: 'POST',
        headers: stContext().getRequestHeaders(),
        signal,
        body: JSON.stringify({ url, prompt: JSON.stringify({ prompt: workflow }) }),
    });
    if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 400);
        throw new Error(text || `ComfyUI generation failed (HTTP ${res.status}).`);
    }
    const { data } = await res.json();
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/**
 * Paint one picture from a written prompt (avatar, full body, background...).
 * @returns {Promise<{ bytes: Uint8Array, seed: number, positive: string, negative: string }>}
 */
export async function paint({ prompt, negative = '', purpose = 'avatar', rating = '', seed = randomSeed(), signal }) {
    const ctx = stContext();
    const s = imageSettings(ctx);
    if (s.backend === 'st') return paintWithSt({ prompt, negative, seed });
    if (s.backend !== 'comfy') throw new Error('No image generator set up. Open AI for creation → Images.');
    const family = familyOf(s);
    const p = composePrompt({ prompt, negative, family, rating });
    const [width, height] = sizeFor(purpose);
    const sampling = samplingFor(s.ckpt, family, { steps: num(s.steps), cfg: num(s.cfg), sampler: s.sampler, scheduler: s.scheduler });
    let workflow;
    if (s.workflow?.json) {
        workflow = adoptWorkflow(s.workflow.json).fill({ ...p, ...sampling, width, height, seed, ckpt: s.ckpt });
    } else {
        const hires = s.hires && !/background/i.test(purpose) ? { scale: 1.5, denoise: 0.45 } : null;
        workflow = buildTxt2Img({ ckpt: s.ckpt, ...p, width, height, seed, ...sampling, hires });
    }
    const bytes = await comfyRun(s.url, workflow, signal);
    return { bytes, seed, ...p };
}

/**
 * Paint expression sprites that share one face: the same seed and look for every label.
 * Transparent backgrounds when the server has ComfyUI Essentials' RemBG nodes; otherwise plain backgrounds.
 * @param {(label: string, result: { bytes: Uint8Array } | { error: string }) => void|Promise<void>} onEach (awaited, in order)
 */
export async function paintSprites({ look, labels, rating = '', seed = randomSeed(), signal, onEach = () => {} }) {
    const ctx = stContext();
    const s = imageSettings(ctx);
    if (s.backend !== 'comfy') throw new Error('Expression sprites need ComfyUI (AI for creation → Images).');
    const family = familyOf(s);
    const sampling = samplingFor(s.ckpt, family, { steps: num(s.steps), cfg: num(s.cfg), sampler: s.sampler, scheduler: s.scheduler });
    let removeBackground = s.transparentSprites ? detectExtras(['RemBGSession+', 'ImageRemoveBackground+', 'JoinImageWithAlpha', 'InvertMask']).removeBackground : null;
    const [width, height] = sizeFor('expression');
    const done = {};
    for (const label of labels) {
        if (signal?.aborted) break;
        const prompts = spritePrompts({ look, label, family, rating });
        const build = rb => buildExpression({ ckpt: s.ckpt, ...prompts, width, height, seed, ...sampling, removeBackground: rb });
        try {
            let bytes;
            try {
                bytes = await comfyRun(s.url, build(removeBackground), signal);
            } catch (e) {
                // Servers without the background-removal nodes reject the graph: carry on with plain backgrounds.
                if (!removeBackground || signal?.aborted) throw e;
                removeBackground = null;
                bytes = await comfyRun(s.url, build(null), signal);
            }
            done[label] = bytes;
            await onEach(label, { bytes });
        } catch (e) {
            if (signal?.aborted) break;
            await onEach(label, { error: e.message });
        }
    }
    return { seed, sprites: done, transparent: !!removeBackground };
}

/** SillyTavern's Image Generation extension (whatever source it is set to). */
async function paintWithSt({ prompt, negative }) {
    const ctx = stContext();
    const neg = negative ? ` negative=${JSON.stringify(negative)}` : '';
    const res = await ctx.executeSlashCommandsWithOptions(`/imagine quiet=true${neg} ${JSON.stringify(prompt)}`, { handleParserErrors: false, handleExecutionErrors: false, source: 'creative-studio' });
    const url = String(res?.pipe ?? '').trim();
    if (!url) throw new Error('Image Generation returned nothing (check its settings).');
    return { bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()), seed: null, positive: prompt, negative };
}

/** Upload sprites to SillyTavern's expressions folder for a character (characters/<name>/<label>.png). */
export async function installSprites(folderName, sprites) {
    const ctx = stContext();
    const results = [];
    for (const [label, bytes] of Object.entries(sprites)) {
        const form = new FormData();
        form.append('name', folderName);
        form.append('label', label);
        form.append('spriteName', label);
        form.append('avatar', new File([bytes], `${label}.png`, { type: 'image/png' }));
        const res = await fetch('/api/sprites/upload', { method: 'POST', headers: ctx.getRequestHeaders({ omitContentType: true }), body: form });
        results.push({ label, ok: res.ok });
    }
    return results;
}

function num(v) {
    return v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v);
}
