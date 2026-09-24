import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    detectFamily, isFast, samplingFor, composePrompt, buildTxt2Img, buildExpression, spritePrompts, adoptWorkflow,
    detectExtras, sizeFor, EXPRESSIONS, CORE_EXPRESSIONS, referenceSize, referenceLoaderOrder, spriteOptions, FACE_MODELS,
    CUTOUTS, T5_ENCODERS, buildKontextExpression, buildKontextEdit, editInstruction, EDIT_EXPRESSIONS, kontextModel, fluxVae, pictureInstruction,
} from '../src/core/comfy.js';
import { withSpriteAssets } from '../src/core/cardio.js';
import { emptyCardV3 } from '../src/core/card.js';

const here = dirname(fileURLToPath(import.meta.url));
// The default ComfyUI "Export (API)" workflow (SDXL, Pony checkpoint): what most people start from.
const basic = JSON.parse(readFileSync(join(here, 'fixtures', 'comfy_basic_sdxl_api.json'), 'utf8'));

/** Every link in an API workflow must point at an existing node. */
function linksResolve(wf) {
    for (const [id, node] of Object.entries(wf)) {
        for (const v of Object.values(node.inputs)) if (Array.isArray(v) && typeof v[0] === 'string') assert.ok(wf[v[0]], `${id} links to missing ${v[0]}`);
    }
}

test('checkpoint families and fast checkpoints are recognised from file names', () => {
    assert.equal(detectFamily('ponyDiffusionV6XL.safetensors'), 'pony');
    assert.equal(detectFamily('cyberrealisticPony_v180Coreshift.safetensors'), 'pony');
    assert.equal(detectFamily('Illustrious-XL-v2.0.safetensors'), 'illustrious');
    assert.equal(detectFamily('SDXL_RealVisXL_V5.safetensors'), 'realistic');
    assert.equal(isFast('someModel_v40DMD2.safetensors'), true);
    assert.equal(isFast('Juggernaut_XL_-_Ragnarok.safetensors'), false);
    const fast = samplingFor('x_DMD2.safetensors', 'realistic');
    assert.deepEqual([fast.steps, fast.cfg, fast.sampler], [8, 1.2, 'lcm']);
    assert.equal(samplingFor('a.safetensors', 'pony', { steps: 40, cfg: '' }).steps, 40);
    assert.equal(samplingFor('a.safetensors', 'pony', { cfg: '' }).cfg, 5, 'empty overrides keep the default');
    assert.deepEqual(sizeFor('background'), [1216, 832]);
    assert.deepEqual(sizeFor('full body'), [832, 1216]);
});

test('prompts get the family\'s quality tags; everything is kept SFW unless the project rating allows explicit', () => {
    const pony = composePrompt({ prompt: '1boy, goggles', family: 'pony' });
    assert.match(pony.positive, /^score_9, score_8_up, score_7_up, rating_safe, 1boy, goggles$/);
    assert.match(pony.negative, /rating_explicit.*nsfw.*score_6/);
    const open = composePrompt({ prompt: '1boy', family: 'pony', rating: 'unrestricted (the model decides)' });
    assert.ok(!/rating_safe/.test(open.positive));
    assert.ok(!/nsfw/.test(open.negative));
    const real = composePrompt({ prompt: 'photo of a keeper', negative: 'hat', family: 'realistic', rating: 'SFW' });
    assert.equal(real.positive, 'photo of a keeper');
    assert.match(real.negative, /^nsfw, nude, nipples, .*, hat$/);
});

test('built-in text-to-image graph: core nodes, clip skip for Pony, optional hires pass', () => {
    const wf = buildTxt2Img({ ckpt: 'p.safetensors', positive: 'P', negative: 'N', seed: 5, steps: 25, cfg: 5, sampler: 'euler', scheduler: 'normal', clipSkip: 2, hires: { scale: 1.5 } });
    linksResolve(wf);
    assert.equal(wf.clipskip.inputs.stop_at_clip_layer, -2);
    assert.deepEqual(wf.pos.inputs.clip, ['clipskip', 0]);
    assert.equal(wf.upscale.inputs.scale_by, 1.5);
    assert.equal(wf.refine.inputs.denoise, 0.45);
    assert.deepEqual(wf.decode.inputs.samples, ['refine', 0]);
    const plain = buildTxt2Img({ ckpt: 'r.safetensors', positive: 'P', negative: 'N', seed: 1 });
    linksResolve(plain);
    assert.equal(plain.refine, undefined);
    assert.equal(plain.clipskip, undefined);
    assert.ok(Object.values(plain).every(n => ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'].includes(n.class_type)));
});

test('expression sprites: one cached base portrait per seed, a partial re-sample per expression, optional cutout', () => {
    const p = spritePrompts({ look: '1boy, goggles', label: 'joy', family: 'pony' });
    assert.match(p.expressionPositive, /\(happy, big smile, joyful, bright eyes:1\.35\), 1boy, goggles/);
    assert.ok(!/smile/.test(p.basePositive), 'the base portrait has no expression');
    const a = buildExpression({ ckpt: 'p', ...p, seed: 9, removeBackground: detectExtras(['RemBGSession+', 'ImageRemoveBackground+', 'JoinImageWithAlpha', 'InvertMask']).removeBackground });
    const b = buildExpression({ ckpt: 'p', ...spritePrompts({ look: '1boy, goggles', label: 'anger', family: 'pony' }), seed: 9 });
    linksResolve(a);
    linksResolve(b);
    // identical base branch → ComfyUI reuses it between sprites
    for (const k of ['ckpt', 'pos', 'neg', 'latent', 'sample']) assert.deepEqual(a[k], b[k], k);
    assert.equal(a.express.inputs.denoise, 0.65);
    assert.deepEqual(a.express.inputs.latent_image, ['sample', 0]);
    assert.deepEqual(a.save.inputs.images, ['cutout', 0]);
    assert.deepEqual(b.save.inputs.images, ['decode', 0]);
    assert.equal(detectExtras(['KSampler']).removeBackground, null);
    assert.equal(Object.keys(EXPRESSIONS).length, 28);
    assert.ok(CORE_EXPRESSIONS.every(l => EXPRESSIONS[l]));
});

test('the user\'s own exported workflow is adopted: prompts, size, seed and checkpoint land in the right nodes', () => {
    const a = adoptWorkflow(basic);
    assert.equal(a.mode, 'mapped');
    assert.deepEqual(a.nodes, { sampler: '5', positive: '2', negative: '3', latent: '4', checkpoint: '1' });
    const wf = a.fill({ positive: 'P', negative: 'N', width: 832, height: 1216, seed: 7, ckpt: 'other.safetensors', steps: 30, cfg: 6 });
    assert.equal(wf['2'].inputs.text, 'P');
    assert.equal(wf['3'].inputs.text, 'N');
    assert.deepEqual([wf['4'].inputs.width, wf['4'].inputs.height], [832, 1216]);
    assert.equal(wf['5'].inputs.seed, 7);
    assert.equal(wf['5'].inputs.steps, 30);
    assert.equal(wf['1'].inputs.ckpt_name, 'other.safetensors');
    assert.equal(basic['2'].inputs.text, '', 'the original is not modified');
    assert.throws(() => adoptWorkflow({ nodes: [], links: [] }), /Export \(API\)/);
    assert.throws(() => adoptWorkflow({ 1: { class_type: 'SaveImage', inputs: {} } }), /KSampler/);
});

test('SillyTavern-style placeholder workflows are filled in', () => {
    const wf = { 3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: '%steps%' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } }, 7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } } };
    const a = adoptWorkflow(wf);
    assert.equal(a.mode, 'placeholders');
    const out = a.fill({ positive: 'say "hi"', negative: 'N', seed: 42, steps: 20 });
    assert.equal(out['6'].inputs.text, 'say "hi"');
    assert.equal(out['3'].inputs.seed, 42);
    assert.equal(out['3'].inputs.steps, 20);
});

test('CHARX export carries sprites as V3 emotion assets (SillyTavern imports them as expressions)', () => {
    const card = emptyCardV3('Tinker');
    card.data.assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }, { type: 'emotion', uri: 'embeded://old.png', name: 'joy', ext: 'png' }];
    const { card: out, files } = withSpriteAssets(card, { joy: new Uint8Array([1]), anger: new Uint8Array([2]) });
    const emo = out.data.assets.filter(a => a.type === 'emotion');
    assert.deepEqual(emo.map(a => a.name).sort(), ['anger', 'joy']);
    assert.ok(emo.every(a => a.uri.startsWith('embeded://assets/emotion/images/')));
    assert.equal(Object.keys(files).length, 2);
    assert.equal(out.data.assets.filter(a => a.type === 'icon').length, 1);
    assert.equal(card.data.assets.length, 2, 'input card untouched');
});

// ---------------------------------------------------------------------------------------------- live module (mocked ST)

let ctx;
let posted;
beforeEach(() => {
    posted = [];
    ctx = {
        extensionSettings: { creativeStudio: { image: { backend: 'comfy', url: 'http://127.0.0.1:8188', ckpt: 'ponyDiffusionV6XL.safetensors' } } },
        saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        SlashCommandParser: { commands: {} },
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        posted.push({ url, body });
        if (url === '/api/sd/comfy/generate') {
            const wf = JSON.parse(body.prompt).prompt;
            if (ctx.reject?.(wf)) return { ok: false, status: 500, text: async () => 'ComfyUI returned an error.' };
            if (Object.values(wf).some(n => ['RemBGSession+', 'TransparentBGSession+'].includes(n.class_type)) && ctx.noRembg) return { ok: false, status: 500, text: async () => 'Cannot execute because node RemBGSession+ does not exist.' };
            return { ok: true, status: 200, json: async () => ({ format: 'png', data: Buffer.from('PNGDATA').toString('base64') }) };
        }
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] };
    };
});

test('painting goes through SillyTavern\'s ComfyUI proxy with a Pony-styled, SFW prompt and the hires pass', async () => {
    const { paint } = await import('../src/st/comfy.js');
    const r = await paint({ prompt: '1boy, goggles', purpose: 'avatar', seed: 3 });
    assert.equal(new TextDecoder().decode(r.bytes), 'PNGDATA');
    const call = posted.find(p => p.url === '/api/sd/comfy/generate');
    assert.equal(call.body.url, 'http://127.0.0.1:8188');
    const wf = JSON.parse(call.body.prompt).prompt;
    assert.match(wf.pos.inputs.text, /^score_9.*rating_safe, 1boy, goggles$/);
    assert.equal(wf.ckpt.inputs.ckpt_name, 'ponyDiffusionV6XL.safetensors');
    assert.ok(wf.refine, 'portraits get the second pass');
    await paint({ prompt: 'x', purpose: 'background', seed: 3 });
    const bg = JSON.parse(posted.at(-1).body.prompt).prompt;
    assert.equal(bg.refine, undefined, 'backgrounds skip it');
    assert.deepEqual([bg.latent.inputs.width, bg.latent.inputs.height], [1216, 832]);
});

test('sprites fall back to plain backgrounds when the server lacks the background-removal nodes', async () => {
    const { paintSprites } = await import('../src/st/comfy.js');
    ctx.noRembg = true;
    const seen = [];
    const r = await paintSprites({ look: '1boy', labels: ['joy', 'anger'], seed: 11, onEach: (label, res) => seen.push([label, !!res.bytes]) });
    assert.deepEqual(seen, [['joy', true], ['anger', true]]);
    assert.equal(r.transparent, false);
    const graphs = posted.filter(p => p.url === '/api/sd/comfy/generate').map(p => JSON.parse(p.body.prompt).prompt);
    assert.equal(graphs.length, 4, 'both background removers refused, then plain for both');
    assert.ok(graphs.every(g => g.sample.inputs.seed === 11), 'same base seed for every sprite');
});

test('character pictures lead with the appearance; negatives are cleaned and never exclude the character', async () => {
    const { characterPrompt, characterNegative, cleanNegative } = await import('../src/core/comfy.js');
    assert.equal(characterPrompt({ appearance: '1boy, mature male, goggles', prompt: 'head and shoulders, workshop', purpose: 'avatar' }), '1boy, mature male, goggles, head and shoulders, workshop');
    assert.equal(characterPrompt({ appearance: '1boy', prompt: 'empty workshop', purpose: 'background' }), 'empty workshop');
    assert.equal(cleanNegative('no people, without text, blurry'), 'people, text, blurry');
    assert.equal(characterNegative({ negative: 'no people, text', purpose: 'avatar' }), 'text');
    assert.equal(characterNegative({ negative: 'no people, text', purpose: 'background' }), 'people, text');
});

test('checkpoint list leaves out diffusion-only UNet/GGUF models (they need a different loader)', async () => {
    const { comfyCheckpoints } = await import('../src/st/comfy.js');
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [
        { value: 'ponyDiffusionV6XL.safetensors', text: 'ponyDiffusionV6XL' },
        { value: 'flux1-dev.safetensors', text: 'UNet: flux1-dev' },
        { value: 'z_image_turbo.gguf', text: 'GGUF: z_image_turbo' },
    ] });
    assert.deepEqual(await comfyCheckpoints('http://127.0.0.1:8188'), ['ponyDiffusionV6XL.safetensors']);
});

test('sprites from the character\'s own picture: loaded inline, fitted, encoded, re-sampled; no base portrait', () => {
    const p = spritePrompts({ look: '1girl, pink hair', label: 'joy', family: 'pony', fromReference: true });
    assert.ok(!/upper body|portrait/.test(p.expressionPositive), 'no framing words: the picture sets the framing');
    assert.match(spritePrompts({ look: '', label: 'joy', family: 'pony', fromReference: true }).expressionPositive, /bright eyes:1\.35\)$/, 'no dangling commas without a look');
    const wf = buildExpression({ ckpt: 'p', ...p, width: 832, height: 1280, seed: 5, strength: 0.6, reference: { loader: 'easy loadImageBase64', data: 'QUJD' } });
    linksResolve(wf);
    assert.equal(wf.ref.inputs.base64_data, 'QUJD');
    assert.equal(wf.ref.inputs.image_output, 'Hide');
    assert.deepEqual([wf.refFit.inputs.width, wf.refFit.inputs.height, wf.refFit.inputs.crop], [832, 1280, 'center']);
    assert.deepEqual(wf.express.inputs.latent_image, ['encode', 0]);
    assert.equal(wf.express.inputs.denoise, 0.6);
    assert.equal(wf.sample, undefined);
    assert.equal(wf.latent, undefined);
    const etn = buildExpression({ ckpt: 'p', ...p, seed: 5, reference: { loader: 'ETN_LoadImageBase64', data: 'QUJD' } });
    assert.deepEqual(etn.ref.inputs, { image: 'QUJD' });
    const up = buildExpression({ ckpt: 'p', ...p, seed: 5, reference: { loader: 'upload', data: 'cstudio_ref_x.png' } });
    assert.deepEqual([up.ref.class_type, up.ref.inputs.image], ['LoadImage', 'cstudio_ref_x.png']);
});

test('reference canvas keeps the picture\'s proportions at about a megapixel; loaders are tried remembered-first', () => {
    assert.deepEqual(referenceSize(400, 600), [832, 1280]);
    assert.deepEqual(referenceSize(1024, 1024), [1024, 1024]);
    const [w, h] = referenceSize(3000, 500);
    assert.ok(w % 64 === 0 && h % 64 === 0 && w / h <= 2.1, 'extreme shapes are clamped');
    assert.deepEqual(referenceLoaderOrder(), ['easy loadImageBase64', 'ETN_LoadImageBase64', 'upload']);
    assert.deepEqual(referenceLoaderOrder('ETN_LoadImageBase64'), ['ETN_LoadImageBase64', 'easy loadImageBase64', 'upload']);
    assert.deepEqual(referenceLoaderOrder('gone'), ['easy loadImageBase64', 'ETN_LoadImageBase64', 'upload']);
});

const fakePrepare = async () => ({ width: 832, height: 1280, base64: 'QUJD', png: new Uint8Array([1, 2, 3]) });
const graphsSent = () => posted.filter(p => p.url === '/api/sd/comfy/generate').map(p => JSON.parse(p.body.prompt).prompt);

test('sprites from the avatar find a loader the server accepts, remember it, and skip the search next time', async () => {
    const { paintSprites } = await import('../src/st/comfy.js');
    ctx.reject = wf => wf.ref?.class_type === 'easy loadImageBase64' || !!wf.face;
    const seen = [];
    const r = await paintSprites({ look: '1girl', labels: ['joy', 'anger'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare, onEach: (l, res) => seen.push([l, !!res.bytes]) });
    assert.deepEqual(seen, [['joy', true], ['anger', true]]);
    assert.equal(r.via, 'ETN_LoadImageBase64');
    assert.equal(r.fromReference, true);
    assert.equal(r.transparent, true);
    assert.equal(r.faceOnly, false);
    let g = graphsSent();
    const accepted = g.filter(x => x.ref.class_type === 'ETN_LoadImageBase64' && !x.face);
    assert.equal(accepted.length, 2, 'whole-picture graphs for joy and anger');
    assert.equal(g.length, (FACE_MODELS.length + 1) + FACE_MODELS.length + 2, 'easy: faces + whole refused; ETN: faces refused, then whole; anger direct');
    assert.ok(g.every(x => x.refFit.inputs.height === 1280 && !x.sample));
    assert.equal(accepted[0].express.inputs.denoise, 0.55, 'whole-picture repaints stay gentle');
    assert.deepEqual(ctx.extensionSettings.creativeStudio.image.referenceLoader, { url: 'http://127.0.0.1:8188', node: 'ETN_LoadImageBase64', face: null, t5: null });
    posted.length = 0;
    await paintSprites({ look: '1girl', labels: ['joy'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare });
    g = graphsSent();
    assert.deepEqual(g.map(x => x.ref.class_type), [...FACE_MODELS.map(() => 'ETN_LoadImageBase64'), 'ETN_LoadImageBase64'], 'remembered loader first; face tries are still made (quickly refused)');
});

test('a server that can take no picture at all fails once, clearly, instead of once per sprite', async () => {
    const { paintSprites } = await import('../src/st/comfy.js');
    ctx.reject = wf => !!wf.ref;
    const seen = [];
    const r = await paintSprites({ look: '1girl', labels: ['joy', 'anger', 'fear'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare, onEach: (l, res) => seen.push([l, res.error ?? '']) });
    assert.equal(seen.length, 1);
    assert.match(seen[0][1], /could not take the character's picture.*Easy-Use/);
    assert.deepEqual(r.sprites, {});
    assert.equal(graphsSent().length, 3 * (FACE_MODELS.length + 1) * (CUTOUTS.length + 1), 'three ways in × face models and whole picture × each cutout and none');
});

test('with a face detector the face alone is repainted: the picture itself is the canvas, no latent re-sample', async () => {
    const p = spritePrompts({ look: '1girl', label: 'anger', family: 'pony', fromReference: true });
    const wf = buildExpression({ ckpt: 'p', ...p, seed: 5, strength: 0.6, reference: { loader: 'easy loadImageBase64', data: 'QUJD' }, face: 'bbox/face_yolov8m.pt', removeBackground: detectExtras(['RemBGSession+', 'ImageRemoveBackground+', 'JoinImageWithAlpha', 'InvertMask']).removeBackground });
    linksResolve(wf);
    assert.equal(wf.faceModel.inputs.model_name, 'bbox/face_yolov8m.pt');
    assert.deepEqual(wf.face.inputs.image, ['refFit', 0]);
    assert.deepEqual(wf.face.inputs.positive, ['expr', 0]);
    assert.equal(wf.face.inputs.denoise, 0.6);
    assert.equal(wf.express, undefined);
    assert.equal(wf.encode, undefined);
    assert.deepEqual(wf.rembg.inputs.image, ['face', 0], 'the cutout takes the detailed picture');
    const { paintSprites } = await import('../src/st/comfy.js');
    ctx.reject = null;
    const r = await paintSprites({ look: '1girl', labels: ['joy'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare });
    assert.equal(r.faceOnly, true);
    assert.equal(graphsSent().at(-1).face.inputs.bbox_detector[0], 'faceModel');
});

test('sprite options: Kontext, then faces, then the whole picture within each way in; best cutout first; nothing skipped', () => {
    assert.deepEqual(spriteOptions({}).map(o => o.rb?.node ?? null), ['inspyrenet', 'essentials', null]);
    assert.deepEqual(spriteOptions({ cutouts: [] }).map(o => o.rb), [null], 'transparency off: plain only');
    const all = spriteOptions({ reference: true, kontext: true });
    const perWay = T5_ENCODERS.length + FACE_MODELS.length + 1;
    assert.equal(all.length, 3 * perWay * (CUTOUTS.length + 1));
    assert.deepEqual([all[0].loader, all[0].method, all[0].t5, all[0].rb.node], ['easy loadImageBase64', 'kontext', T5_ENCODERS[0], 'inspyrenet']);
    assert.deepEqual([all[T5_ENCODERS.length].method, all[T5_ENCODERS.length].face], ['face', FACE_MODELS[0]], 'faces after Kontext');
    assert.equal(all[perWay - 1].method, 'whole', 'whole picture last');
    assert.ok(!spriteOptions({ reference: true }).some(o => o.method === 'kontext'), 'no Kontext model, no Kontext tries');
    const again = spriteOptions({ reference: true, kontext: true, cutouts: [], remembered: { node: 'upload', face: 'bbox/face_yolov9c.pt', t5: 't5xxl_fp16.safetensors' } });
    assert.deepEqual([again[0].loader, again[0].t5], ['upload', 't5xxl_fp16.safetensors']);
    assert.equal(again.find(o => o.method === 'face').face, 'bbox/face_yolov9c.pt');
    const old = spriteOptions({ reference: true, remembered: { node: 'ETN_LoadImageBase64' } });
    assert.deepEqual([old[0].loader, old[0].face], ['ETN_LoadImageBase64', FACE_MODELS[0]], 'an older memory without a face still tries faces');
});

test('Kontext edit graph: the picture is edited in place, the loader follows the model file, cutout by InSPyReNet', () => {
    const base = { t5: 't5xxl_fp8_e4m3fn_scaled.safetensors', vae: 'ae.safetensors', reference: { loader: 'easy loadImageBase64', data: 'QUJD' }, width: 704, height: 1088, instruction: editInstruction('anger'), seed: 7 };
    const nun = buildKontextExpression({ ...base, model: 'svdq-fp4_r32-flux1-kontext-dev.safetensors', removeBackground: CUTOUTS[0] });
    linksResolve(nun);
    assert.equal(nun.unet.class_type, 'NunchakuFluxDiTLoader');
    assert.deepEqual(nun.express.inputs.latent_image, ['encode', 0], 'the latent is the encoded picture');
    assert.deepEqual(nun.reference.inputs.latent, ['encode', 0]);
    assert.equal(nun.express.inputs.cfg, 1);
    assert.equal(nun.guidance.inputs.guidance, 2.5);
    assert.deepEqual([nun.refFit.inputs.width, nun.refFit.inputs.height], [704, 1088]);
    assert.equal(nun.rembgSession.class_type, 'TransparentBGSession+');
    assert.deepEqual(nun.save.inputs.images, ['cutout', 0]);
    assert.equal(buildKontextExpression({ ...base, model: 'flux1-kontext-dev-Q4_K_M.gguf' }).unet.class_type, 'UnetLoaderGGUF');
    const plain = buildKontextExpression({ ...base, model: 'flux1-dev-kontext_fp8_scaled.safetensors' });
    assert.deepEqual([plain.unet.class_type, plain.unet.inputs.weight_dtype], ['UNETLoader', 'default']);
    assert.deepEqual(plain.save.inputs.images, ['decode', 0], 'no cutout asked, none added');
    assert.equal(Object.values(nun).filter(n => n.class_type === 'SaveImage').length, 1, 'one output: SillyTavern returns the first image');
});

test('edit instructions: every label covered; darker moods remove the smile; the rest of the picture is kept', () => {
    assert.deepEqual(Object.keys(EDIT_EXPRESSIONS).sort(), Object.keys(EXPRESSIONS).sort());
    for (const l of ['sadness', 'anger', 'fear', 'grief', 'disgust', 'neutral', 'remorse', 'disapproval']) assert.match(EDIT_EXPRESSIONS[l], /instead of a smile|no smile/, l);
    assert.ok(!/instead of a smile|no smile/.test(EDIT_EXPRESSIONS.joy));
    assert.match(editInstruction('neutral'), /^Remove the smile: .* Keep the same character/, 'neutral is a command of its own');
    assert.equal(editInstruction('sadness'), 'Make the character look sad: a frown instead of a smile, eyebrows raised in the middle, teary downcast eyes. Keep the same character, hairstyle, outfit, pose, background and art style.');
});

test('Kontext model and FLUX VAE are found in SillyTavern\'s lists', () => {
    const models = [{ value: 'pony.safetensors', text: 'pony' }, { value: 'svdq-fp4_r32-flux1-kontext-dev.safetensors', text: 'UNet: svdq-fp4 r32-flux1-kontext-dev' }, { value: 'flux1-dev.safetensors', text: 'UNet: flux1-dev' }];
    assert.equal(kontextModel(models), 'svdq-fp4_r32-flux1-kontext-dev.safetensors');
    assert.equal(kontextModel([{ value: 'kontext-merge.safetensors', text: 'kontext-merge' }]), null, 'a checkpoint named kontext is not a diffusion model');
    assert.equal(kontextModel([]), null);
    assert.equal(fluxVae(['sdxl_vae.safetensors', 'Flux/ae.safetensors', 'ae.safetensors']), 'Flux/ae.safetensors');
    assert.equal(fluxVae(['sdxl_vae.safetensors', 'flux_vae.safetensors']), 'flux_vae.safetensors');
    assert.equal(fluxVae(['sdxl_vae.safetensors']), 'ae.safetensors', 'best guess when nothing matches');
});

test('with a Kontext model, sprites from the picture are Kontext edits; a server that refuses Kontext falls back to the face', async () => {
    const { paintSprites } = await import('../src/st/comfy.js');
    const findKontext = async () => ({ model: 'svdq-fp4_r32-flux1-kontext-dev.safetensors', vae: 'ae.safetensors' });
    ctx.reject = null;
    let r = await paintSprites({ look: '', labels: ['sadness'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare, findKontext });
    assert.equal(r.method, 'kontext');
    let g = graphsSent().at(-1);
    assert.match(g.expr.inputs.text, /a frown instead of a smile/);
    assert.deepEqual([g.refFit.inputs.width, g.refFit.inputs.height], [832, 1280], 'Kontext edits the full-size picture (subtle moods need it)');
    assert.equal(g.express.inputs.steps, 20);
    posted.length = 0;
    ctx.reject = wf => wf.unet?.class_type === 'NunchakuFluxDiTLoader';
    r = await paintSprites({ look: '1girl', labels: ['joy'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare, findKontext });
    assert.equal(r.method, 'face');
    assert.equal(graphsSent().length, T5_ENCODERS.length + 1, 'each text encoder refused once, then the face');
    ctx.extensionSettings.creativeStudio.image.spriteMethod = 'whole';
    ctx.reject = null;
    r = await paintSprites({ look: '1girl', labels: ['joy'], seed: 4, reference: new Uint8Array([9]), prepare: fakePrepare, findKontext });
    assert.equal(r.method, 'whole', 'the author can ask for the whole-picture repaint');
});

test('other pictures from a character picture: a wide scene canvas, the right words for each purpose', async () => {
    assert.match(pictureInstruction('full body', 'standing in a forest.'), /^Show the same character in a full-body picture from head to toe: standing in a forest\. Keep the same face/);
    assert.match(pictureInstruction('background', 'a tavern at night'), /^Show only the place, with no people in it: a tavern at night\. Keep the art style\.$/);
    assert.match(pictureInstruction('avatar', 'head and shoulders'), /^Show the same character in a new portrait: head and shoulders\./);
    const wf = buildKontextEdit({ model: 'svdq-fp4_r32-flux1-kontext-dev.safetensors', reference: { loader: 'easy loadImageBase64', data: 'QUJD' }, width: 832, height: 1280, canvas: [1216, 832], instruction: 'x', seed: 1 });
    linksResolve(wf);
    assert.deepEqual([wf.canvas.inputs.width, wf.canvas.inputs.height], [1216, 832]);
    assert.deepEqual(wf.express.inputs.latent_image, ['canvas', 0], 'the new picture is painted on its own canvas');
    assert.deepEqual(wf.reference.inputs.latent, ['encode', 0], 'the character picture is the reference');
    const { paintFromPicture } = await import('../src/st/comfy.js');
    ctx.reject = null;
    assert.equal(await paintFromPicture({ reference: new Uint8Array([9]), instruction: 'x', prepare: fakePrepare, findKontext: async () => null }), null, 'no Kontext: the caller paints from words');
    ctx.reject = wf2 => wf2.ref?.class_type === 'easy loadImageBase64';
    const r = await paintFromPicture({ reference: new Uint8Array([9]), instruction: 'Show the place', canvas: [1216, 832], prepare: fakePrepare, findKontext: async () => ({ model: 'svdq-kontext.safetensors', vae: 'ae.safetensors' }) });
    assert.equal(new TextDecoder().decode(r.bytes), 'PNGDATA');
    assert.equal(graphsSent().at(-1).ref.class_type, 'ETN_LoadImageBase64', 'a refused loader is skipped');
    ctx.extensionSettings.creativeStudio.image.spriteMethod = 'face';
    assert.equal(await paintFromPicture({ reference: new Uint8Array([9]), instruction: 'x', prepare: fakePrepare, findKontext: async () => ({ model: 'k', vae: 'ae.safetensors' }) }), null, 'Kontext switched off in the settings');
});
