// ComfyUI through SillyTavern's own proxy (/api/sd/comfy/*): no CORS setup on the ComfyUI side, and the same
// server address SillyTavern's Image Generation extension uses. Settings hold no secrets (a URL and choices).

import { stContext, stPost } from './env.js';
import { scheduleSettingsBackup } from './studio-settings.js';
import {
    detectFamily, samplingFor, composePrompt, buildTxt2Img, buildExpression, spritePrompts, adoptWorkflow, sizeFor,
    randomSeed, spriteOptions, referenceSize, CUTOUTS, buildKontextExpression, buildKontextEdit, editInstruction, kontextModel, fluxVae,
    T5_ENCODERS, referenceLoaderOrder,
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
    spriteMethod: 'auto',   // sprites from a character's picture: 'auto' (best the server has) | 'face' | 'whole'
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
 * A character's picture made ready to send to ComfyUI: about one megapixel in its own proportions, as base64 (JPEG)
 * for inline loader nodes and as PNG bytes for an upload.
 */
export async function prepareReference(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const [width, height] = referenceSize(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    // Cover the canvas (crop the overflow evenly), the same way ComfyUI's ImageScale "center" crop would.
    const k = Math.max(width / bmp.width, height / bmp.height);
    g.drawImage(bmp, (width - bmp.width * k) / 2, (height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    const blob = type => new Promise(r => canvas.toBlob(r, type, 0.95));
    const jpeg = new Uint8Array(await (await blob('image/jpeg')).arrayBuffer());
    const png = new Uint8Array(await (await blob('image/png')).arrayBuffer());
    let bin = '';
    for (let i = 0; i < jpeg.length; i += 0x8000) bin += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
    return { width, height, base64: btoa(bin), png };
}

/**
 * Put a picture into ComfyUI's input folder. The browser talks to ComfyUI directly here (SillyTavern has no upload
 * route): without ComfyUI's CORS header the answer cannot be read, so the file is named up front and overwritten.
 */
async function uploadToComfy(url, png, name) {
    const form = () => {
        const f = new FormData();
        f.append('image', new File([png], name, { type: 'image/png' }));
        f.append('overwrite', 'true');
        return f;
    };
    const target = `${String(url).replace(/\/+$/, '')}/upload/image`;
    try {
        const res = await fetch(target, { method: 'POST', body: form() });
        if (res.ok) return (await res.json()).name ?? name;
    } catch { /* no CORS header: the upload may still have landed */ }
    await fetch(target, { method: 'POST', body: form(), mode: 'no-cors' }).catch(() => {});
    return name;
}

/** ComfyUI refused the graph itself (unknown node, missing file), as opposed to failing while painting. */
const rejected = e => /^ComfyUI returned an error\.?$/.test(String(e?.message ?? '').trim());

/** A FLUX Kontext model on the server and the VAE that goes with it, or null (found through SillyTavern's lists). */
export async function comfyKontext(url) {
    const [models, vaes] = await Promise.all([stPost('/api/sd/comfy/models', { url }), stPost('/api/sd/comfy/vaes', { url }).catch(() => [])]);
    const model = kontextModel(Array.isArray(models) ? models : []);
    return model ? { model, vae: fluxVae(Array.isArray(vaes) ? vaes : []) } : null;
}

/**
 * Paint expression sprites that share one face: the same seed and look for every label.
 * With a reference (the character's own picture, e.g. an imported avatar) every sprite is made from that picture,
 * so face, outfit and art style are the character's: edited by FLUX Kontext when the server has it, otherwise the
 * face alone repainted (FaceDetailer), otherwise the whole picture gently repainted. Without one, every sprite
 * starts from one freshly painted base portrait. Backgrounds are cut out when the server has the nodes for it.
 * @param {Uint8Array|null} reference the character's picture, or null to paint a base portrait
 * @param {(label: string, result: { bytes: Uint8Array } | { error: string }) => void|Promise<void>} onEach (awaited, in order)
 */
export async function paintSprites({ look, labels, rating = '', seed = randomSeed(), reference = null, signal, onEach = () => {}, prepare = prepareReference, findKontext = comfyKontext }) {
    const ctx = stContext();
    const s = imageSettings(ctx);
    if (s.backend !== 'comfy') throw new Error('Expression sprites need ComfyUI (AI for creation → Images).');
    const family = familyOf(s);
    const sampling = samplingFor(s.ckpt, family, { steps: num(s.steps), cfg: num(s.cfg), sampler: s.sampler, scheduler: s.scheduler });
    let [width, height] = sizeFor('expression');
    let ref = null;
    let kontext = null;
    if (reference) {
        ref = await prepare(reference);
        [width, height] = [ref.width, ref.height];
        if (!['face', 'whole'].includes(s.spriteMethod)) kontext = await findKontext(s.url).catch(() => null);
    }
    // Until one sprite has come out, try the ways this server might accept the graph (spriteOptions: best first).
    // ComfyUI refuses a graph it cannot run before painting, so the tries that fail cost almost nothing.
    const remembered = s.referenceLoader?.url === s.url ? s.referenceLoader : null;
    const options = spriteOptions({ reference: !!ref, cutouts: s.transparentSprites ? CUTOUTS : [], kontext: !!kontext, remembered })
        .filter(o => s.spriteMethod !== 'whole' || ['whole', 'fresh'].includes(o.method));
    let chosen = null;
    let uploaded = '';
    const referenceFor = async loader => {
        if (!loader) return null;
        if (loader !== 'upload') return { loader, data: ref.base64 };
        uploaded ||= await uploadToComfy(s.url, ref.png, `cstudio_ref_${hashBytes(ref.png)}.png`);
        return { loader, data: uploaded };
    };
    const done = {};
    let lastRejection = null;
    for (const label of labels) {
        if (signal?.aborted) break;
        const prompts = spritePrompts({ look, label, family, rating, fromReference: !!ref });
        // Face-only repaints can take a stronger change; a whole-picture repaint stays gentler to keep the art style.
        const strength = o => (!ref ? 0.65 : o.method === 'face' ? 0.6 : 0.55);
        const build = async o => (o.method === 'kontext'
            ? buildKontextExpression({ model: kontext.model, vae: kontext.vae, t5: o.t5, reference: await referenceFor(o.loader), width, height, instruction: editInstruction(label), seed, removeBackground: o.rb })
            : buildExpression({ ckpt: s.ckpt, ...prompts, width, height, seed, ...sampling, strength: strength(o), removeBackground: o.rb, reference: await referenceFor(o.loader), face: o.method === 'face' ? o.face : null }));
        try {
            let bytes = null;
            for (const o of chosen ? [chosen] : options) {
                try {
                    bytes = await comfyRun(s.url, await build(o), signal);
                    if (!chosen) {
                        chosen = o;
                        const keep = { url: s.url, node: o.loader, face: o.face ?? remembered?.face ?? null, t5: o.t5 ?? remembered?.t5 ?? null };
                        if (o.loader && JSON.stringify(keep) !== JSON.stringify(remembered)) saveImageSettings({ referenceLoader: keep }, ctx);
                    }
                    break;
                } catch (e) {
                    if (chosen || signal?.aborted) throw e;
                    lastRejection = e;
                }
            }
            if (!bytes) {
                throw ref && rejected(lastRejection)
                    ? new Error('This ComfyUI could not take the character\'s picture. Install ComfyUI-Easy-Use (or comfyui-tool-nodes), or start ComfyUI with --enable-cors-header; or paint sprites from a new portrait instead.')
                    : lastRejection;
            }
            done[label] = bytes;
            await onEach(label, { bytes });
        } catch (e) {
            if (signal?.aborted) break;
            await onEach(label, { error: e.message });
            if (!chosen) break; // nothing works on this server: stop instead of failing every label the same way
        }
    }
    return { seed, sprites: done, transparent: !!chosen?.rb, fromReference: !!ref, via: chosen?.loader ?? null, method: chosen?.method ?? null, faceOnly: chosen?.method === 'face' };
}

/**
 * A new picture of the character made from their own picture by FLUX Kontext: a full-body shot, a new portrait,
 * a scene in the same art style. Returns null when the server has no Kontext model (the caller paints from words).
 * @param {[number, number]|null} canvas the new picture's size, or null for the picture's own proportions
 */
export async function paintFromPicture({ reference, instruction, canvas = null, seed = randomSeed(), signal, prepare = prepareReference, findKontext = comfyKontext }) {
    const ctx = stContext();
    const s = imageSettings(ctx);
    if (s.backend !== 'comfy' || s.spriteMethod === 'face' || s.spriteMethod === 'whole') return null;
    const kontext = await findKontext(s.url).catch(() => null);
    if (!kontext) return null;
    const ref = await prepare(reference);
    const remembered = s.referenceLoader?.url === s.url ? s.referenceLoader : null;
    const t5s = remembered?.t5 && T5_ENCODERS.includes(remembered.t5) ? [remembered.t5, ...T5_ENCODERS.filter(x => x !== remembered.t5)] : T5_ENCODERS;
    let uploaded = '';
    let last = null;
    for (const loader of referenceLoaderOrder(remembered?.node)) {
        for (const t5 of t5s) {
            const picture = loader === 'upload'
                ? { loader, data: (uploaded ||= await uploadToComfy(s.url, ref.png, `cstudio_ref_${hashBytes(ref.png)}.png`)) }
                : { loader, data: ref.base64 };
            try {
                const workflow = buildKontextEdit({ model: kontext.model, vae: kontext.vae, t5, reference: picture, width: ref.width, height: ref.height, canvas, instruction, seed });
                return { bytes: await comfyRun(s.url, workflow, signal), seed, positive: instruction, negative: '' };
            } catch (e) {
                if (signal?.aborted || !rejected(e)) throw e;
                last = e;
            }
        }
    }
    throw last ?? new Error('ComfyUI could not take the character\'s picture.');
}

/** A short, stable name for a picture's bytes (so re-uploads overwrite rather than pile up). */
function hashBytes(bytes) {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i += 97) h = Math.imul(h ^ bytes[i], 16777619);
    return (h >>> 0).toString(36) + bytes.length.toString(36);
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
