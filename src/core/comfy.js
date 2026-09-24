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
export function spritePrompts({ look, label, family = 'realistic', rating = '', fromReference = false }) {
    // Started from the character's own picture, the framing is that picture's: no framing words to fight it.
    const frame = fromReference ? '' : family === 'realistic' ? 'head and shoulders portrait, plain studio background' : 'portrait, upper body, looking at viewer, simple background';
    const join = (...parts) => parts.map(x => String(x ?? '').trim()).filter(Boolean).join(', ');
    const base = composePrompt({ prompt: join(look, frame), family, rating });
    const tags = EXPRESSIONS[label] ?? label;
    const expr = composePrompt({ prompt: join(`(${tags}:1.35)`, look, frame), family, rating });
    return { basePositive: base.positive, expressionPositive: expr.positive, negative: base.negative };
}

/** Nodes that read a picture sent inside the workflow (base64), so nothing has to be uploaded; tried in this order. */
export const REFERENCE_LOADERS = {
    'easy loadImageBase64': data => ({ base64_data: data, image_output: 'Hide', save_prefix: 'CreativeStudio_ref' }),
    ETN_LoadImageBase64: data => ({ image: data }),
};

/** The order to try ways of getting a reference picture into ComfyUI: the one that worked last time first, upload last. */
export function referenceLoaderOrder(remembered = '') {
    const all = [...Object.keys(REFERENCE_LOADERS), 'upload'];
    return remembered && all.includes(remembered) ? [remembered, ...all.filter(x => x !== remembered)] : all;
}

/** Face detectors for Impact Pack's FaceDetailer (Ultralytics models from the ADetailer set), most common first. */
export const FACE_MODELS = ['bbox/face_yolov8m.pt', 'bbox/face_yolov8n.pt', 'bbox/face_yolov8s.pt', 'bbox/face_yolov9c.pt'];

/** T5 text encoders FLUX is usually paired with (ComfyUI's text_encoders folder), most common first. */
export const T5_ENCODERS = ['t5xxl_fp8_e4m3fn_scaled.safetensors', 't5xxl_fp8_e4m3fn.safetensors', 't5xxl_fp16.safetensors', 't5xxl_enconly.safetensors'];

/** Background removal, best first: InSPyReNet keeps long hair that isnet loses (tested on anime art); then isnet. */
export const CUTOUTS = [{ node: 'inspyrenet' }, { node: 'essentials' }];

const front = (list, first) => (first && list.includes(first) ? [first, ...list.filter(x => x !== first)] : list);

/**
 * Every way a server might accept a sprite graph, best first. With the character's picture: for each way of getting
 * the picture in, an image editor's edit (FLUX Kontext, when the server has one), then the face alone repainted
 * (FaceDetailer, each face model), then the whole picture; each with the best background removal, the next, none.
 * What worked last time only moves to the front of its kind, so something installed later is still found (ComfyUI
 * refuses a graph it cannot run at once, before any painting). Without a picture: the cutout choice only.
 * @returns {{ loader: string|null, method: 'kontext'|'face'|'whole'|'fresh', face?: string, t5?: string, rb: object|null }[]}
 */
export function spriteOptions({ reference = false, cutouts = CUTOUTS, kontext = false, remembered = null } = {}) {
    const rbs = [...cutouts, null];
    if (!reference) return rbs.map(rb => ({ loader: null, method: 'fresh', rb }));
    const methods = [
        ...(kontext ? front(T5_ENCODERS, remembered?.t5).map(t5 => ({ method: 'kontext', t5 })) : []),
        ...front(FACE_MODELS, remembered?.face).map(face => ({ method: 'face', face })),
        { method: 'whole' },
    ];
    const out = [];
    for (const rb of rbs) for (const loader of referenceLoaderOrder(remembered?.node)) for (const m of methods) out.push({ loader, rb, ...m });
    return out;
}

/**
 * What each expression asks of an instruction-following image editor ("Make the character look …"). Faces in
 * character art usually smile, so the darker moods say what replaces the smile (otherwise the editor keeps it).
 * Tested on FLUX Kontext: subtle moods need the full-size picture; the wording "a frown instead of a smile" works.
 */
export const EDIT_EXPRESSIONS = {
    neutral: 'calm and neutral: no smile, mouth gently closed, relaxed eyebrows',
    joy: 'happy: a big joyful smile and bright eyes',
    amusement: 'amused: a playful grin, laughing softly with slightly squinted eyes',
    love: 'in love: dreamy half-closed eyes, a warm loving smile and rosy blushing cheeks',
    admiration: 'starry-eyed with admiration: sparkling eyes with star-like highlights, raised eyebrows and lips parted in awe',
    approval: 'approving: both eyes closed in a contented smile, like a satisfied nod',
    caring: 'caring: soft, concerned eyes with gently raised eyebrows and a small reassuring smile',
    gratitude: 'grateful: a heartfelt smile with happy tears glistening in the eyes',
    optimism: 'hopeful: bright shining eyes looking upward and an eager, open smile',
    pride: 'proud: a smug, self-satisfied smirk with the chin raised',
    relief: 'relieved: eyes closed, eyebrows relaxed and a soft smile, as if letting out a long sigh',
    excitement: 'excited: wide sparkling eyes and a big open-mouthed smile',
    desire: 'longing: half-lidded yearning eyes, a blush and softly parted lips, no smile',
    curiosity: 'curious: one eyebrow raised, wide attentive eyes and a small round open mouth, no smile',
    realization: 'struck by a sudden realization: wide eyes, raised eyebrows and an open mouth, no smile',
    surprise: 'surprised: wide eyes, raised eyebrows and an open mouth',
    confusion: 'confused: a puzzled frown instead of a smile, a furrowed brow and the head tilted',
    nervousness: 'nervous: anxious eyes, worried raised eyebrows, an awkward uneasy smile and a drop of sweat',
    embarrassment: 'embarrassed: a deep blush across the cheeks, a flustered look and eyes glancing away',
    fear: 'frightened: wide terrified eyes, raised eyebrows and a trembling open mouth, no smile',
    sadness: 'sad: a frown instead of a smile, eyebrows raised in the middle, teary downcast eyes',
    grief: 'grief-stricken: crying, with tears streaming down the cheeks and an anguished, sobbing face, no smile',
    remorse: 'remorseful: a guilty frown instead of a smile, downcast eyes and a furrowed brow',
    disappointment: 'disappointed: a downturned mouth instead of a smile and drooping eyes, as if sighing',
    annoyance: 'annoyed: narrowed eyes, a pout and an irritated frown instead of a smile',
    anger: 'furious: a scowl instead of a smile, glaring eyes, sharply lowered eyebrows and clenched teeth',
    disgust: 'disgusted: a wrinkled nose, a grimace instead of a smile and narrowed eyes',
    disapproval: 'disapproving: a stern frown instead of a smile and narrowed, judging eyes',
};

/** Expressions that need a command of their own: "Remove the smile" is what moves a smiling face to neutral. */
const EDIT_COMMANDS = {
    neutral: 'Remove the smile: the character now has a blank, neutral expression with lips closed in a straight line.',
};

/** The editing instruction for one expression; the character, outfit, pose, background and art style stay. */
export function editInstruction(label) {
    const change = EDIT_COMMANDS[label] ?? `Make the character look ${EDIT_EXPRESSIONS[label] ?? label}.`;
    return `${change} Keep the same character, hairstyle, outfit, pose, background and art style.`;
}

/** The instruction that turns the character's own picture into the picture a written prompt asks for. */
export function pictureInstruction(purpose = '', prompt = '') {
    const what = String(prompt).trim().replace(/[\s.,;]+$/, '');
    if (/background|scene|location|landscape/i.test(purpose)) return `Show only the place, with no people in it: ${what}. Keep the art style.`;
    if (/full|body/i.test(purpose)) return `Show the same character in a full-body picture from head to toe: ${what}. Keep the same face, hairstyle, outfit and art style.`;
    return `Show the same character in a new portrait: ${what}. Keep the same face, hairstyle, outfit and art style.`;
}

/** The FLUX VAE among a server's VAEs (ComfyUI's list; "ae.safetensors" is Black Forest Labs' own name for it). */
export function fluxVae(vaes = []) {
    const names = (vaes ?? []).map(v => (typeof v === 'string' ? v : v?.value)).filter(Boolean);
    const base = n => n.split(/[\\/]/).pop();
    return names.find(n => /^ae\.(safetensors|sft)$/i.test(base(n))) ?? names.find(n => /flux.*vae|vae.*flux/i.test(n)) ?? 'ae.safetensors';
}

/** A FLUX Kontext model among the diffusion models SillyTavern lists ("UNet: …" / "GGUF: …" entries), if any. */
export function kontextModel(models = []) {
    const m = (models ?? []).find(x => /^(UNet|GGUF):/i.test(String(x?.text ?? '')) && /kontext/i.test(String(x?.value ?? '')));
    return m ? m.value : null;
}

/** Background removal nodes after an image; returns the image to save. */
function cutoutNodes(wf, image, removeBackground) {
    if (removeBackground?.node === 'inspyrenet') {
        wf.rembgSession = { class_type: 'TransparentBGSession+', inputs: { mode: 'base', use_jit: true } };
    } else if (removeBackground?.node === 'essentials') {
        wf.rembgSession = { class_type: 'RemBGSession+', inputs: { model: 'isnet-general-use: general purpose', providers: 'CUDA' } };
    } else {
        return image;
    }
    wf.rembg = { class_type: 'ImageRemoveBackground+', inputs: { rembg_session: ['rembgSession', 0], image } };
    wf.alpha = { class_type: 'InvertMask', inputs: { mask: ['rembg', 1] } };
    wf.cutout = { class_type: 'JoinImageWithAlpha', inputs: { image: ['rembg', 0], alpha: ['alpha', 0] } };
    return ['cutout', 0];
}

/** The character's own picture: loaded (sent inline, or an uploaded file) and fitted to the canvas. */
function referenceNodes(wf, reference, width, height) {
    wf.ref = reference.loader === 'upload'
        ? { class_type: 'LoadImage', inputs: { image: reference.data }, _meta: { title: 'Character picture' } }
        : { class_type: reference.loader, inputs: REFERENCE_LOADERS[reference.loader](reference.data), _meta: { title: 'Character picture' } };
    wf.refFit = { class_type: 'ImageScale', inputs: { image: ['ref', 0], upscale_method: 'lanczos', width, height, crop: 'center' } };
    return ['refFit', 0];
}

/**
 * An expression made by an instruction-following image editor (FLUX Kontext): the picture itself is edited, so the
 * art style, face, outfit and background stay; only the expression changes. The loader follows the model file:
 * Nunchaku's "svdq-" builds, GGUF, or a plain diffusion model. (Tested: Nunchaku FP4 Kontext; subtle moods such
 * as sadness need the full-size picture and 20 steps, about 35 s a sprite on a laptop RTX 5070 Ti.)
 */
export function buildKontextExpression(args) {
    return buildKontextEdit({ prefix: 'CreativeStudio_expr', ...args });
}

/**
 * Any picture made by editing the character's own picture with FLUX Kontext. The new picture has the reference's
 * size unless another canvas is given (a wide scene from a tall portrait): the editor reads the picture as a
 * reference and paints the canvas from scratch.
 */
export function buildKontextEdit({ model, t5 = T5_ENCODERS[0], vae = 'ae.safetensors', reference, width = 832, height = 1216, canvas = null, instruction, seed, steps = 20, guidance = 2.5, removeBackground = null, prefix = 'CreativeStudio_edit' }) {
    const wf = {};
    const file = String(model).split(/[\\/]/).pop();
    wf.unet = /^svdq-/i.test(file)
        ? { class_type: 'NunchakuFluxDiTLoader', inputs: { model_path: model, cache_threshold: 0, attention: 'nunchaku-fp16', cpu_offload: 'auto', device_id: 0, data_type: 'bfloat16', i2f_mode: 'enabled' } }
        : /\.gguf$/i.test(file)
            ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: model } }
            : { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } };
    wf.clip = { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: t5, type: 'flux' } };
    wf.vae = { class_type: 'VAELoader', inputs: { vae_name: vae } };
    const picture = referenceNodes(wf, reference, width, height);
    wf.encode = { class_type: 'VAEEncode', inputs: { pixels: picture, vae: ['vae', 0] } };
    wf.expr = { class_type: 'CLIPTextEncode', inputs: { text: instruction, clip: ['clip', 0] }, _meta: { title: 'Edit instruction' } };
    wf.reference = { class_type: 'ReferenceLatent', inputs: { conditioning: ['expr', 0], latent: ['encode', 0] } };
    wf.guidance = { class_type: 'FluxGuidance', inputs: { conditioning: ['reference', 0], guidance } };
    wf.neg = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['expr', 0] } };
    if (canvas) wf.canvas = { class_type: 'EmptySD3LatentImage', inputs: { width: canvas[0], height: canvas[1], batch_size: 1 } };
    wf.express = { class_type: 'KSampler', inputs: { seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['unet', 0], positive: ['guidance', 0], negative: ['neg', 0], latent_image: canvas ? ['canvas', 0] : ['encode', 0] } };
    wf.decode = { class_type: 'VAEDecode', inputs: { samples: ['express', 0], vae: ['vae', 0] } };
    wf.save = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: cutoutNodes(wf, ['decode', 0], removeBackground) } };
    return wf;
}

/** A canvas of about one megapixel in the reference picture's own proportions (multiples of 64, SDXL-friendly). */
export function referenceSize(width, height, pixels = 1024 * 1024) {
    const aspect = Math.min(2, Math.max(0.5, (width || 1) / (height || 1)));
    const snap = v => Math.max(512, Math.round(v / 64) * 64);
    return [snap(Math.sqrt(pixels * aspect)), snap(Math.sqrt(pixels / aspect))];
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
export function buildExpression({ ckpt, basePositive, expressionPositive, negative, width = 832, height = 1216, seed, steps = 25, cfg = 5, sampler = 'euler', scheduler = 'normal', clipSkip = 1, strength = 0.65, removeBackground = null, reference = null, face = null, prefix = 'CreativeStudio_expr' }) {
    const wf = {};
    const clip = baseNodes(wf, { ckpt, clipSkip });
    wf.neg = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip }, _meta: { title: 'Negative' } };
    wf.expr = { class_type: 'CLIPTextEncode', inputs: { text: expressionPositive, clip }, _meta: { title: 'Expression' } };
    let image;
    if (reference) referenceNodes(wf, reference, width, height);
    if (reference && face) {
        // Only the face is repainted (Impact Pack's FaceDetailer): body, outfit, pose and art style stay the picture's.
        wf.faceModel = { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: face } };
        wf.face = {
            class_type: 'FaceDetailer', _meta: { title: 'Expression on the face' },
            inputs: {
                image: ['refFit', 0], model: ['ckpt', 0], clip, vae: ['ckpt', 2], guide_size: 512, guide_size_for: true, max_size: 1024,
                seed: seed + 1, steps, cfg, sampler_name: sampler, scheduler, positive: ['expr', 0], negative: ['neg', 0], denoise: strength,
                feather: 5, noise_mask: true, force_inpaint: true, bbox_threshold: 0.5, bbox_dilation: 10, bbox_crop_factor: 3,
                sam_detection_hint: 'center-1', sam_dilation: 0, sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7,
                sam_mask_hint_use_negative: 'False', drop_size: 10, bbox_detector: ['faceModel', 0], wildcard: '', cycle: 1,
            },
        };
        image = ['face', 0];
    } else {
        let base;
        if (reference) {
            wf.encode = { class_type: 'VAEEncode', inputs: { pixels: ['refFit', 0], vae: ['ckpt', 2] } };
            base = ['encode', 0];
        } else {
            wf.pos = { class_type: 'CLIPTextEncode', inputs: { text: basePositive, clip }, _meta: { title: 'Base portrait' } };
            wf.latent = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
            wf.sample = { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, model: ['ckpt', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0] } };
            base = ['sample', 0];
        }
        wf.express = { class_type: 'KSampler', inputs: { seed: seed + 1, steps, cfg, sampler_name: sampler, scheduler, denoise: strength, model: ['ckpt', 0], positive: ['expr', 0], negative: ['neg', 0], latent_image: base } };
        wf.decode = { class_type: 'VAEDecode', inputs: { samples: ['express', 0], vae: ['ckpt', 2] } };
        image = ['decode', 0];
    }
    wf.save = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: cutoutNodes(wf, image, removeBackground) } };
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
