// ComfyUI workflows built in code (API format), so authors never have to edit a graph.
// Pure: no network. src/st/comfy.js sends them through SillyTavern's ComfyUI proxy.
//
// Core nodes only by default; optional extras (background removal) are used when the server has them.

/** Checkpoint families differ in how they want to be prompted and sampled. */
export const FAMILIES = {
    pony: {
        label: 'Pony (booru tags + score tags)', tags: true,
        prefix: 'score_9, score_8_up, score_7_up, ', negative: 'score_6, score_5, score_4, worst quality, low quality, blurry, bad anatomy, bad hands, extra fingers, watermark, signature, text',
        steps: 25, cfg: 5, sampler: 'dpmpp_2m_sde_gpu', scheduler: 'exponential', clipSkip: 2,
    },
    illustrious: {
        label: 'Illustrious / anime (booru tags)', tags: true,
        prefix: 'masterpiece, best quality, amazing quality, ', negative: 'worst quality, low quality, lowres, blurry, bad anatomy, bad hands, extra fingers, watermark, signature, text',
        steps: 28, cfg: 5.5, sampler: 'euler_ancestral', scheduler: 'normal', clipSkip: 2,
    },
    realistic: {
        label: 'SDXL (natural language)', tags: false,
        prefix: '', negative: 'lowres, blurry, cartoon, illustration, bad anatomy, deformed, extra fingers, watermark, signature, text, jpeg artifacts',
        steps: 30, cfg: 5, sampler: 'dpmpp_2m_sde_gpu', scheduler: 'karras', clipSkip: 1,
    },
};

/** Distilled checkpoints (DMD2, Lightning, Turbo, Hyper, LCM) need few steps and almost no CFG. */
export const FAST = { steps: 8, cfg: 1.2, sampler: 'lcm', scheduler: 'karras' };

/** Guess the family from the checkpoint file name; the author can override it. */
export function detectFamily(ckpt = '') {
    const n = String(ckpt).toLowerCase();
    if (/pony/.test(n)) return 'pony';
    if (/illustrious|noob|animagine|\bilxl\b|anime/.test(n)) return 'illustrious';
    return 'realistic';
}

export function isFast(ckpt = '') {
    return /dmd2|lightning|turbo|hyper|lcm/i.test(String(ckpt));
}

/** SDXL-friendly sizes per purpose. */
export const SIZES = {
    avatar: [832, 1216],
    'full body': [832, 1216],
    background: [1216, 832],
    expression: [832, 1216],
    square: [1024, 1024],
};

export function sizeFor(purpose = '') {
    const p = String(purpose).toLowerCase();
    if (/background|scene|landscape|location/.test(p)) return SIZES.background;
    if (/full|body/.test(p)) return SIZES['full body'];
    if (/expression|sprite|emotion/.test(p)) return SIZES.expression;
    return SIZES.avatar;
}

/** SillyTavern's 28 default expression labels, each with the tags that draw it. */
export const EXPRESSIONS = {
    neutral: 'neutral expression, calm, closed mouth',
    joy: 'happy, big smile, joyful, bright eyes',
    amusement: 'amused, grin, laughing softly',
    love: 'loving expression, warm smile, blush, soft eyes',
    admiration: 'admiring, wide eyes, impressed smile',
    approval: 'approving nod, satisfied smile',
    caring: 'caring, gentle smile, soft eyes',
    gratitude: 'grateful, thankful smile, soft eyes',
    optimism: 'hopeful, optimistic smile, looking up',
    pride: 'proud, confident smirk, chin up',
    relief: 'relieved, exhaling, relaxed smile',
    excitement: 'excited, open mouth smile, sparkling eyes',
    desire: 'longing gaze, half-lidded eyes, slight blush',
    curiosity: 'curious, head tilt, raised eyebrow',
    realization: 'realization, eyes widening, lips parted',
    surprise: 'surprised, wide eyes, open mouth',
    confusion: 'confused, furrowed brow, head tilt',
    nervousness: 'nervous, anxious, sweat drop, awkward smile',
    embarrassment: 'embarrassed, heavy blush, looking away',
    fear: 'scared, fearful, wide eyes, trembling',
    sadness: 'sad, downcast eyes, frown',
    grief: 'grieving, crying, tears, anguished',
    remorse: 'remorseful, guilty, looking down',
    disappointment: 'disappointed, sighing, frown',
    annoyance: 'annoyed, irritated, narrowed eyes, pout',
    anger: 'angry, furious, clenched teeth, glaring',
    disgust: 'disgusted, grimace, wrinkled nose',
    disapproval: 'disapproving, frown, crossed arms',
};

/** A small set that covers most scenes; the full 28 are optional. */
export const CORE_EXPRESSIONS = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'fear', 'embarrassment', 'love'];

/**
 * Prompts for a sprite set: one neutral base portrait plus one per expression. The expression goes first and is
 * weighted, which (tested on SDXL/Pony) is what makes it read clearly while the look stays the same.
 */
export function spritePrompts({ look, label, family = 'realistic', rating = '' }) {
    const frame = family === 'realistic' ? 'head and shoulders portrait, plain studio background' : 'portrait, upper body, looking at viewer, simple background';
    const base = composePrompt({ prompt: `${look}, ${frame}`, family, rating });
    const tags = EXPRESSIONS[label] ?? label;
    const expr = composePrompt({ prompt: `(${tags}:1.35), ${look}, ${frame}`, family, rating });
    return { basePositive: base.positive, expressionPositive: expr.positive, negative: base.negative };
}

/**
 * The prompt for a picture of the character: their fixed appearance first (so every picture shows the same person),
 * then what this picture is. Scenes without the character use the prompt alone.
 */
export function characterPrompt({ appearance = '', prompt = '', purpose = '' }) {
    if (/background|scene|location|landscape/i.test(purpose) || !String(appearance).trim()) return String(prompt).trim();
    return `${String(appearance).trim()}, ${String(prompt).trim()}`.replace(/,\s*$/, '');
}

/** A picture of the character must not have "people" in its negative (models copy it from background prompts). */
export function characterNegative({ negative = '', purpose = '' }) {
    const clean = cleanNegative(negative);
    if (/background|scene|location|landscape/i.test(purpose)) return clean;
    return clean.split(', ').filter(t => t && !/^(people|persons?|humans?|characters?|figures?|crowds?|man|men|woman|women|1boy|1girl|solo)$/i.test(t)).join(', ');
}

/** Negative prompts are lists of things to avoid: "no people, without text" → "people, text". */
export function cleanNegative(neg = '') {
    return String(neg).split(',').map(s => s.trim().replace(/^(no|without|avoid|not)\s+/i, '')).filter(Boolean).join(', ');
}

/** Is the project's content rating one that allows explicit images? Everything else keeps them out. */
export function explicitAllowed(rating = '') {
    return /unrestricted|explicit|nsfw/i.test(String(rating));
}

/**
 * Turn a written prompt into the final positive/negative pair for a family, including rating control.
 * @returns {{ positive: string, negative: string }}
 */
export function composePrompt({ prompt, negative = '', family = 'realistic', rating = '' }) {
    const f = FAMILIES[family] ?? FAMILIES.realistic;
    const sfw = !explicitAllowed(rating);
    const ratingPos = family === 'pony' ? (sfw ? 'rating_safe, ' : '') : '';
    const ratingNeg = sfw ? (family === 'pony' ? 'rating_explicit, rating_questionable, nsfw, nude, ' : 'nsfw, nude, nipples, ') : '';
    const positive = `${f.prefix}${ratingPos}${String(prompt ?? '').trim()}`.replace(/\s*,\s*,/g, ',').trim();
    const neg = [ratingNeg + f.negative, cleanNegative(negative)].filter(Boolean).join(', ');
    return { positive, negative: neg };
}

/** Sampling settings: family defaults, fast-checkpoint overrides, then the author's own values. */
export function samplingFor(ckpt, family, overrides = {}) {
    const f = FAMILIES[family] ?? FAMILIES.realistic;
    const base = { steps: f.steps, cfg: f.cfg, sampler: f.sampler, scheduler: f.scheduler, clipSkip: f.clipSkip };
    const fast = isFast(ckpt) ? FAST : {};
    const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== '' && v != null));
    return { ...base, ...fast, ...clean };
}

export function randomSeed() {
    return Math.floor(Math.random() * 2 ** 48);
}

/**
 * Text-to-image with an optional second "hires" pass (latent upscale + light denoise) for sharper detail.
 * @returns {object} ComfyUI API workflow
 */
export function buildTxt2Img({ ckpt, positive, negative, width = 832, height = 1216, seed = randomSeed(), steps = 25, cfg = 5, sampler = 'euler', scheduler = 'normal', clipSkip = 1, hires = null, prefix = 'CreativeStudio' }) {
    const wf = {};
    const clip = baseNodes(wf, { ckpt, clipSkip });
    wf.pos = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip }, _meta: { title: 'Positive' } };
    wf.neg = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip }, _meta: { title: 'Negative' } };
    wf.latent = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    wf.sample = { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, model: ['ckpt', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0] } };
    let out = ['sample', 0];
    if (hires?.scale > 1) {
        wf.upscale = { class_type: 'LatentUpscaleBy', inputs: { upscale_method: 'nearest-exact', scale_by: hires.scale, samples: out } };
        wf.refine = { class_type: 'KSampler', inputs: { seed, steps: hires.steps ?? Math.max(6, Math.round(steps * 0.5)), cfg, sampler_name: sampler, scheduler, denoise: hires.denoise ?? 0.45, model: ['ckpt', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['upscale', 0] } };
        out = ['refine', 0];
    }
    wf.decode = { class_type: 'VAEDecode', inputs: { samples: out, vae: ['ckpt', 2] } };
    wf.save = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['decode', 0] } };
    return wf;
}

/**
 * One expression sprite. The base portrait (same seed and prompt for every expression) is sampled first and
 * ComfyUI caches it between runs, so each expression only costs a partial re-sample of that portrait: the face,
 * hair and outfit stay the same while the expression changes.
 * @param {object} o
 * @param {string} o.basePositive the character's portrait prompt (neutral)
 * @param {string} o.expressionPositive the same prompt with the expression tags
 * @param {number} [o.strength] how far the expression may move away from the base (0.65 reads clearly and keeps the face)
 * @param {object|null} [o.removeBackground] { node: 'essentials' } to cut the sprite out (transparent PNG)
 */
export function buildExpression({ ckpt, basePositive, expressionPositive, negative, width = 832, height = 1216, seed, steps = 25, cfg = 5, sampler = 'euler', scheduler = 'normal', clipSkip = 1, strength = 0.65, removeBackground = null, prefix = 'CreativeStudio_expr' }) {
    const wf = {};
    const clip = baseNodes(wf, { ckpt, clipSkip });
    wf.pos = { class_type: 'CLIPTextEncode', inputs: { text: basePositive, clip }, _meta: { title: 'Base portrait' } };
    wf.neg = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip }, _meta: { title: 'Negative' } };
    wf.latent = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    wf.sample = { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, model: ['ckpt', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0] } };
    wf.expr = { class_type: 'CLIPTextEncode', inputs: { text: expressionPositive, clip }, _meta: { title: 'Expression' } };
    wf.express = { class_type: 'KSampler', inputs: { seed: seed + 1, steps, cfg, sampler_name: sampler, scheduler, denoise: strength, model: ['ckpt', 0], positive: ['expr', 0], negative: ['neg', 0], latent_image: ['sample', 0] } };
    wf.decode = { class_type: 'VAEDecode', inputs: { samples: ['express', 0], vae: ['ckpt', 2] } };
    let image = ['decode', 0];
    if (removeBackground?.node === 'essentials') {
        wf.rembgSession = { class_type: 'RemBGSession+', inputs: { model: 'isnet-general-use: general purpose', providers: 'CUDA' } };
        wf.rembg = { class_type: 'ImageRemoveBackground+', inputs: { rembg_session: ['rembgSession', 0], image } };
        wf.alpha = { class_type: 'InvertMask', inputs: { mask: ['rembg', 1] } };
        wf.cutout = { class_type: 'JoinImageWithAlpha', inputs: { image: ['rembg', 0], alpha: ['alpha', 0] } };
        image = ['cutout', 0];
    }
    wf.save = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: image } };
    return wf;
}

function baseNodes(wf, { ckpt, clipSkip }) {
    wf.ckpt = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } };
    if (clipSkip > 1) {
        wf.clipskip = { class_type: 'CLIPSetLastLayer', inputs: { stop_at_clip_layer: -clipSkip, clip: ['ckpt', 1] } };
        return ['clipskip', 0];
    }
    return ['ckpt', 1];
}

/** Which optional extras the server can do, from its /object_info node list. */
export function detectExtras(nodeTypes = []) {
    const has = new Set(nodeTypes);
    return {
        removeBackground: has.has('RemBGSession+') && has.has('ImageRemoveBackground+') && has.has('JoinImageWithAlpha') && has.has('InvertMask') ? { node: 'essentials' } : null,
    };
}

// ---------------------------------------------------------------------------------------------- imported workflows

/**
 * Use an author's own API-format workflow. SillyTavern-style placeholders ("%prompt%", "%seed%"...) are filled
 * when present; otherwise the graph is read: the KSampler that feeds the output and the prompt, latent and
 * checkpoint nodes it uses.
 * @returns {{ mode: 'placeholders'|'mapped', fill: (v: object) => object }} or throws when it cannot be used
 */
export function adoptWorkflow(json) {
    const wf = typeof json === 'string' ? JSON.parse(json) : json;
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new Error('Not a ComfyUI workflow.');
    if (wf.nodes && wf.links) throw new Error('This is the editor format. In ComfyUI use Workflow → Export (API) and pick that file.');
    const text = JSON.stringify(wf);
    if (/"%(prompt|negative_prompt|seed|width|height)%"/.test(text)) {
        return {
            mode: 'placeholders',
            fill: v => {
                const values = { prompt: v.positive, negative_prompt: v.negative, seed: v.seed, width: v.width, height: v.height, steps: v.steps, scale: v.cfg, sampler: v.sampler, scheduler: v.scheduler, model: v.ckpt, denoise: 1, clip_skip: -(v.clipSkip ?? 1) };
                let out = text;
                for (const [k, val] of Object.entries(values)) if (val !== undefined) out = out.replaceAll(`"%${k}%"`, JSON.stringify(val));
                return JSON.parse(out);
            },
        };
    }
    const ids = Object.keys(wf);
    const samplers = ids.filter(id => /KSampler/.test(wf[id].class_type ?? ''));
    if (!samplers.length) throw new Error('No KSampler node found; use the Export (API) file of a text-to-image workflow.');
    // The first sampler whose latent comes from an empty latent is the main one.
    const main = samplers.find(id => { const l = wf[id].inputs?.latent_image; return Array.isArray(l) && /EmptyLatent/.test(wf[l[0]]?.class_type ?? ''); }) ?? samplers[0];
    const s = wf[main].inputs;
    const textNode = ref => (Array.isArray(ref) && /CLIPTextEncode/.test(wf[ref[0]]?.class_type ?? '') ? ref[0] : null);
    const posId = textNode(s.positive);
    const negId = textNode(s.negative);
    if (!posId) throw new Error('Could not find the positive prompt node (a CLIPTextEncode connected to the KSampler).');
    const latentId = Array.isArray(s.latent_image) && /EmptyLatent/.test(wf[s.latent_image[0]]?.class_type ?? '') ? s.latent_image[0] : null;
    const ckptId = ids.find(id => wf[id].class_type === 'CheckpointLoaderSimple') ?? null;
    return {
        mode: 'mapped',
        nodes: { sampler: main, positive: posId, negative: negId, latent: latentId, checkpoint: ckptId },
        fill: v => {
            const out = structuredClone(wf);
            out[posId].inputs.text = v.positive;
            if (negId) out[negId].inputs.text = v.negative;
            if (latentId && v.width) Object.assign(out[latentId].inputs, { width: v.width, height: v.height });
            if (ckptId && v.ckpt) out[ckptId].inputs.ckpt_name = v.ckpt;
            for (const id of samplers) if (out[id].inputs && 'seed' in out[id].inputs && v.seed != null) out[id].inputs.seed = v.seed;
            if (v.steps) out[main].inputs.steps = v.steps;
            if (v.cfg != null) out[main].inputs.cfg = v.cfg;
            if (v.sampler) out[main].inputs.sampler_name = v.sampler;
            if (v.scheduler) out[main].inputs.scheduler = v.scheduler;
            return out;
        },
    };
}
