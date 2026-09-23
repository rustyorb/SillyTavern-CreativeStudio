import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    detectFamily, isFast, samplingFor, composePrompt, buildTxt2Img, buildExpression, spritePrompts, adoptWorkflow,
    detectExtras, sizeFor, EXPRESSIONS, CORE_EXPRESSIONS,
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
            if (Object.values(wf).some(n => n.class_type === 'RemBGSession+') && ctx.noRembg) return { ok: false, status: 500, text: async () => 'Cannot execute because node RemBGSession+ does not exist.' };
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
    assert.equal(graphs.length, 3, 'one rejected try, then plain for both');
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
