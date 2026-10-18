// One character-owned picture workspace, shared by both Pictures entry points.
import { html, useState, useRef, Button, Icon, Badge, TextArea, Select, Toggle, Section, Modal, pickFile, fileBytes, cx } from './kit.js';
import { imageSettings, imageReady, familyOf, paint, paintSprites, paintFromPicture, installSprites } from '../st/comfy.js';
import { FAMILIES, EXPRESSIONS, CORE_EXPRESSIONS, randomSeed, characterPrompt, characterNegative, pictureInstruction, sizeFor } from '../core/comfy.js';
import { useAiTask, AiStatus } from './ai.js';
import { ImageSetup } from './image-setup.js';
import { contentOf, imageRating } from '../core/content.js';
import { findArtifact, editArtifactField } from '../core/project.js';
import { stSpriteFolder } from '../st/live.js';
import { saveMedia, saveCharacterPicture, mediaBytes, toPngBytes } from './media.js';
import { pictureDraft, pictureTarget } from '../core/pictures.js';
import { navigateStudio } from './guide.js';

/**
 * Pictures for a character: the AI writes the prompts (in the style the checkpoint wants), ComfyUI (or SillyTavern's
 * Image Generation) paints them, and expression sprites share one face. Nothing here needs ComfyUI knowledge.
 */
/** Expressions by family of feeling: the sprite grid reads warm to cold, each family in its own colour. */
const MOOD_FAMILIES = {
    plain: ['neutral'],
    bright: ['joy', 'amusement', 'excitement', 'optimism', 'pride', 'relief', 'approval', 'admiration', 'gratitude'],
    tender: ['love', 'caring', 'desire', 'embarrassment'],
    wonder: ['curiosity', 'realization', 'surprise', 'confusion'],
    dread: ['nervousness', 'fear'],
    blue: ['sadness', 'grief', 'remorse', 'disappointment'],
    ember: ['annoyance', 'anger', 'disgust', 'disapproval'],
};
const MOOD_FAMILY = Object.fromEntries(Object.entries(MOOD_FAMILIES).flatMap(([f, labels]) => labels.map(l => [l, f])));
const MOOD_RANK = Object.fromEntries(Object.values(MOOD_FAMILIES).flat().map((l, i) => [l, i]));
const moodOrder = labels => [...labels].sort((a, b) => (MOOD_RANK[a] ?? 99) - (MOOD_RANK[b] ?? 99));

export function CharacterPictures({ store, env, project, ch }) {
    const ai = useAiTask(store);
    const [busy, setBusy] = useState('');
    const [setupOpen, setSetupOpen] = useState(false);
    const [result, setResult] = useState('');
    const [error, setError] = useState('');
    const job = useRef(false);
    const [spriteSet, setSpriteSet] = useState('core');
    const [progress, setProgress] = useState(null);
    const [mood, setMood] = useState('neutral');
    const stop = useRef(null);
    const d = ch.card.data;
    const draft = pictureDraft(ch);
    const currentCharacter = () => pictureTarget(store.get(), project.id, ch.id);
    const setDraft = patch => store.update(p => {
        const current = pictureTarget(p, project.id, ch.id);
        return editArtifactField(p, 'characters', ch.id, 'pictureDraft', { ...pictureDraft(current), ...patch }, { summary: 'Edited picture prompt' });
    }, `picture draft ${ch.id}`);
    let settings = null;
    let ready = false;
    try { settings = imageSettings(); ready = imageReady(); } catch { /* no ST context */ }
    const comfy = settings?.backend === 'comfy';
    const family = settings ? familyOf(settings) : 'realistic';
    const promptStyle = FAMILIES[family]?.tags ? 'tags' : 'natural';
    const rating = imageRating(contentOf(project));
    const prompts = ch.imagePrompts ?? [];
    const sprites = ch.sprites ?? {};
    const spriteIds = new Set(Object.values(sprites));
    const gallery = project.media.filter(m => ((ch.links?.media ?? []).includes(m.id) || m.id === ch.avatarMediaId) && !spriteIds.has(m.id));
    const stLinked = ch.origin?.kind === 'st' ? ch.origin.avatar : ch.stAvatar;
    // Sprites start from the character's own picture when there is one (imported characters above all). Sprites
    // already painted from a fresh portrait keep that source unless the author switches, so a set never mixes.
    const avatarPic = ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null;
    const spriteSource = ch.spriteSource ?? (['st', 'import'].includes(ch.origin?.kind) || !Object.keys(sprites).length ? 'avatar' : 'fresh');
    const fromAvatar = !!avatarPic && spriteSource === 'avatar';
    const uploadPortrait = async () => {
        const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
        if (!file) return;
        setBusy('upload');
        try {
            const bitmap = await createImageBitmap(file);
            bitmap.close();
            const bytes = await toPngBytes(await fileBytes(file));
            const { media, apply } = await saveMedia(env, project, bytes, { name: `${d.name} portrait`, role: 'avatar', mime: 'image/png' });
            if (store.get().id !== project.id || !findArtifact(store.get(), 'characters', ch.id)) return;
            store.update(p => {
                const current = findArtifact(p, 'characters', ch.id);
                let next = editArtifactField(apply(p), 'characters', ch.id, 'avatarMediaId', media.id, { summary: 'Chose a portrait' });
                return editArtifactField(next, 'characters', ch.id, 'links.media', [...new Set([...(current.links?.media ?? []), media.id])], { summary: 'Added portrait to gallery' });
            }, 'upload portrait', { merge: false });
            env.toast('Portrait added. Previous pictures stay in the gallery. Ctrl+Z undoes this.', 'ok');
        } catch (e) { env.toast(`Could not add that picture: ${e.message}`, 'error', 7000); }
        finally { setBusy(''); }
    };

    const writePrompts = async (fillDraft = true) => {
        const current = currentCharacter();
        const before = pictureDraft(current);
        const r = await ai.run('media.prompts', { card: current.card, style: before.prompt, promptStyle });
        if (!r) return null;
        currentCharacter();
        store.update(p => {
            const latest = pictureTarget(p, project.id, ch.id);
            let n = editArtifactField(p, 'characters', ch.id, 'imagePrompts', r.value.prompts.map(x => ({ ...x, model: r.generation.label })), { actor: 'ai', summary: 'AI image prompts' });
            if (r.value.appearance) n = editArtifactField(n, 'characters', ch.id, 'appearance', r.value.appearance, { actor: 'ai', summary: 'AI appearance' });
            // A late AI response must not overwrite words the author typed while it was running.
            if (fillDraft && JSON.stringify(pictureDraft(latest)) === JSON.stringify(before)) {
                const suggestion = r.value.prompts.find(pr => pr.purpose === before.purpose) ?? r.value.prompts[0];
                if (suggestion) n = editArtifactField(n, 'characters', ch.id, 'pictureDraft', { ...before, ...suggestion }, { actor: 'ai', summary: 'Drafted picture prompt' });
            }
            return editArtifactField(n, 'characters', ch.id, 'imagePromptStyle', promptStyle, { actor: 'ai', summary: 'Prompt style' });
        }, 'image prompts', { merge: false });
        return r.value;
    };

    /** Save a painted picture; the first portrait becomes the avatar if there is none yet. */
    const paintOne = async pr => {
        const current = currentCharacter();
        // A character with a picture of their own gets new pictures made from it (FLUX Kontext), in its art style;
        // without Kontext on the server, pictures are painted from the words as before.
        const own = pr.reference !== false ? findArtifact(store.get(), 'media', current.avatarMediaId) : null;
        const scene = /background|scene|location|landscape/i.test(pr.purpose ?? '');
        const r = (own && await paintFromPicture({ reference: await mediaBytes(env, own), instruction: pictureInstruction(pr.purpose, pr.prompt), canvas: scene ? sizeFor('background') : null }))
            ?? await paint({ prompt: characterPrompt({ appearance: current.appearance, prompt: pr.prompt, purpose: pr.purpose }), negative: characterNegative(pr), purpose: pr.purpose, rating });
        await saveCharacterPicture(env, store, project.id, ch.id, r.bytes, { purpose: pr.purpose, prompt: r.positive, seed: r.seed });
        setResult(`Picture saved to ${d.name}’s gallery below.`);
        env.toast(`Picture generated for ${d.name}. Ctrl+Z undoes it.`, 'ok');
    };
    const run = async (key, fn) => {
        if (job.current) return;
        job.current = true;
        setResult('');
        setError('');
        setBusy(key);
        try { await fn(); }
        catch (e) { setError(e.message); env.toast(`Could not finish for ${d.name}: ${e.message}`, 'error', 8000); }
        finally { job.current = false; setBusy(''); setProgress(null); }
    };
    const paintAll = () => run('all', async () => { for (const pr of prompts) await paintOne(pr); });

    const paintSpriteSet = labels => run('sprites', async () => {
        const now = currentCharacter;
        const lookOf = c => c.appearance || (c.imagePrompts ?? []).find(pr => /avatar|portrait/i.test(pr.purpose))?.prompt || '';
        // Sprites need words for the character's look too: the AI writes them from the card when nothing says yet.
        if (!lookOf(now())) await writePrompts(false);
        const lookNow = lookOf(now());
        const reference = fromAvatar ? findArtifact(store.get(), 'media', now().avatarMediaId) : null;
        if (!lookNow && !reference) throw new Error('Write the image prompts first: sprites reuse the character\'s appearance.');
        const ac = new AbortController();
        stop.current = ac;
        const seed = ch.spriteSeed ?? randomSeed();
        const failed = [];
        const failures = [];
        setProgress({ done: 0, total: labels.length, current: labels[0] });
        store.update(p => editArtifactField(p, 'characters', ch.id, 'spriteSeed', seed, { actor: 'ai', summary: 'Sprite seed' }), 'sprite seed');
        const res = await paintSprites({
            look: lookNow, labels, rating, seed, signal: ac.signal, reference: reference ? await mediaBytes(env, reference) : null,
            onEach: async (label, r) => {
                if (r.bytes) {
                    await saveCharacterPicture(env, store, project.id, ch.id, r.bytes, { label, prompt: r.positive, seed: r.seed });
                } else {
                    failed.push(label);
                    failures.push(r.error);
                }
                setProgress(pg => ({ ...pg, done: pg.done + 1, current: labels[labels.indexOf(label) + 1] }));
            },
        });
        setProgress(null);
        const made = Object.keys(res.sprites).length;
        const how = { kontext: ' from the avatar (FLUX Kontext edit)', face: ' from the avatar (face repainted)', whole: ' from the avatar (whole picture repainted)' }[res.method] ?? '';
        env.toast(made ? `${made} sprite(s) painted${how}${res.transparent ? ' with transparent backgrounds' : ''}${failed.length ? `; failed: ${failed.join(', ')}` : ''}.`
            : `No sprites painted. ${failures.at(-1) ?? ''}`.trim(), failed.length ? 'error' : 'ok', 9000);
    });
    const newFace = async () => {
        if (!(await env.confirm(fromAvatar ? 'Paint every sprite again from the avatar?' : 'Paint every sprite again with a new face?', 'The current sprites are replaced (Ctrl+Z brings them back).'))) return;
        store.update(p => editArtifactField(p, 'characters', ch.id, 'spriteSeed', randomSeed(), { summary: 'New sprite seed' }), 'sprite seed');
        paintSpriteSet(Object.keys(sprites).length ? Object.keys(sprites) : CORE_EXPRESSIONS);
    };
    const install = () => run('install', async () => {
        const bytes = {};
        for (const [label, id] of Object.entries(sprites)) {
            const m = findArtifact(project, 'media', id);
            if (m) bytes[label] = await mediaBytes(env, m);
        }
        const folder = stLinked ? stSpriteFolder(stLinked, d.name) : d.name;
        const r = await installSprites(folder, bytes);
        const ok = r.filter(x => x.ok).length;
        env.toast(`Installed ${ok} of ${r.length} sprite(s) in characters/${folder}. Turn on Character Expressions in SillyTavern's extensions to see them.`, ok === r.length ? 'ok' : 'error', 8000);
    });

    const labels = spriteSet === 'all' ? Object.keys(EXPRESSIONS) : CORE_EXPRESSIONS;
    // The stage: the painted scene as the set, the character standing in it with the chosen mood.
    const scene = gallery.find(m => /background|scene/i.test(m.purpose ?? m.name ?? ''));
    const spriteOf = label => (sprites[label] ? findArtifact(project, 'media', sprites[label]) : null);
    const figure = spriteOf(mood) ?? spriteOf('neutral') ?? spriteOf(Object.keys(sprites)[0]);
    const shownMood = spriteOf(mood) ? mood : figure ? (spriteOf('neutral') ? 'neutral' : Object.keys(sprites)[0]) : '';
    const backdrop = !scene && figure ? (ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null) ?? gallery[0] ?? null : null;
    return html`
        <section class="cs-picture-compose" aria-label="Create a picture">
            <div class="cs-row"><h3>Create a picture for ${d.name || 'this character'}</h3><span class="cs-spacer"></span>
                <${Button} small icon="plug" label=${ready ? 'Image settings' : 'Set up image generation'} onClick=${() => setSetupOpen(true)} />
            </div>
            <${Select} label="Picture type" value=${draft.purpose} options=${[{ value: 'avatar', label: 'Portrait / avatar' }, { value: 'full body', label: 'Full body' }, { value: 'background', label: 'Background / scene' }, ...(!['avatar', 'full body', 'background'].includes(draft.purpose) ? [{ value: draft.purpose, label: draft.purpose }] : [])]} onChange=${purpose => setDraft({ purpose })} />
            <${TextArea} label="Picture prompt" value=${draft.prompt} rows=${4} stats=${false}
                placeholder="Describe the picture you want, or use Help write prompt to start from this character’s details."
                hint="This draft is saved with this character. You can edit it before generating."
                onChange=${prompt => setDraft({ prompt })} />
            <div class="cs-picture-actions">
                <${Button} kind="primary" icon="image" label=${busy === 'picture' ? 'Generating picture…' : 'Generate picture'} onClick=${() => run('picture', () => paintOne({ ...draft }))} disabled=${!!busy || ai.busy || !ready || !draft.prompt.trim()} />
                <${Button} icon="wand-magic-sparkles" label=${busy === 'prompt' ? 'Writing prompt…' : 'Help write prompt'} onClick=${() => run('prompt', () => writePrompts())} disabled=${!!busy || ai.busy} />
                <span class="cs-muted cs-small">Prompt help writes words; Generate picture makes the image.</span>
            </div>
            <div class=${cx('cs-small', !ready ? 'cs-warn-text' : 'cs-muted')}>
                ${!ready ? 'Set up an image generator to enable Generate picture.' : !draft.prompt.trim() ? 'Add a picture prompt above, or use Help write prompt.' : `Ready to generate for ${d.name}.`}
                ${ready && html`<span> Using ${comfy ? `ComfyUI · ${String(settings.ckpt || settings.workflow?.name || 'custom workflow').replace(/\.(safetensors|ckpt|gguf)$/i, '')}` : 'SillyTavern Image Generation'}.</span>`}
            </div>
            ${busy === 'picture' && html`<div role="status" class="cs-muted">Generating for ${d.name}. This may take a minute…</div>`}
            ${result && html`<div role="status" class="cs-ok-text">${result}</div>`}
            ${error && html`<div role="alert" class="cs-err-text">${error} Your prompt is still here; you can try again.</div>`}
            <${AiStatus} ai=${ai} />
            <${Section} title="Appearance & picture options" open=${false}>
                <${TextArea} label="Character appearance" value=${ch.appearance ?? ''} rows=${2} stats=${false} hint="Reused for portraits, full-body pictures and expressions. Backgrounds use their own prompt."
                    onChange=${v => store.update(p => editArtifactField(p, 'characters', ch.id, 'appearance', v, { summary: 'Edited appearance' }), 'appearance')} />
                <${TextArea} label="Avoid in this picture" value=${draft.negative} rows=${2} stats=${false} onChange=${negative => setDraft({ negative })} />
                ${avatarPic && html`<${Toggle} label="Use this character’s portrait as a reference when supported" checked=${draft.reference} onChange=${reference => setDraft({ reference })} />
                    <p class="cs-muted cs-small">FLUX Kontext can use the portrait. Other setups use the written appearance and prompt.</p>`}
            </${Section}>
        </section>
        ${setupOpen && html`<${Modal} title="Image generation settings" onClose=${() => setSetupOpen(false)}><${ImageSetup} env=${env} /><div class="cs-row"><${Button} kind="primary" label="Done — back to picture" onClick=${() => setSetupOpen(false)} /></div></${Modal}>`}
        <div class="cs-portrait-start">
            ${avatarPic ? html`<img src=${avatarPic.url} alt=${`${d.name}'s portrait`} />` : html`<div class="cs-portrait-placeholder"><${Icon} name="user" /></div>`}
            <div><strong>${avatarPic ? 'Portrait on the character card' : 'Already have a portrait?'}</strong><p>${avatarPic ? 'Generate more pictures above, or upload a replacement. Previous pictures stay in the gallery.' : 'Upload it here, or generate a portrait above. The first portrait becomes the picture on your exported card.'}</p>
                <${Button} icon="file-image" label=${avatarPic ? 'Replace portrait…' : 'Upload portrait…'} onClick=${uploadPortrait} disabled=${!!busy} /></div>
        </div>
        ${prompts.length > 0 && html`<${Section} title=${`Saved prompt ideas (${prompts.length})`} open=${false}>
            <p class="cs-muted cs-small">Choose an idea to put it in the prompt box above. You can edit it before generating.</p>
            <${Button} icon="images" label=${busy === 'all' ? 'Generating saved prompts…' : 'Generate all saved prompts'} onClick=${paintAll} disabled=${!!busy || ai.busy || !ready} />
            ${ch.imagePromptStyle && ch.imagePromptStyle !== promptStyle && html`<div class="cs-warn-text cs-small">These prompts were written as ${ch.imagePromptStyle === 'tags' ? 'tags' : 'sentences'}; the current checkpoint prefers ${promptStyle === 'tags' ? 'tags' : 'sentences'}. Rewrite them for best results.</div>`}
            ${prompts.map((pr, i) => html`<div key=${i} class="cs-proposal">
                <div class="cs-proposal-head"><strong>${pr.purpose}</strong>
                    <div class="cs-row">
                        <${Button} small icon="copy" title="Copy prompt" onClick=${() => navigator.clipboard?.writeText(pr.prompt)} />
                        <${Button} small icon="arrow-up" label="Use this prompt" onClick=${e => { setDraft({ ...pr, negative: pr.negative ?? '' }); const box = e.currentTarget.closest('.cs-area-body')?.querySelector('.cs-picture-compose textarea'); box?.focus(); box?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} disabled=${!!busy} />
                    </div></div>
                <div class="cs-small">${pr.prompt}</div>${pr.negative && html`<div class="cs-small cs-muted">Negative: ${pr.negative}</div>`}
            </div>`)}
        </${Section}>`}
        <${Section} title=${`${d.name}’s pictures (${gallery.length})`}>
            ${!gallery.length && html`<p class="cs-muted">Your generated and uploaded pictures will appear here.</p>`}
            <div class="cs-gallery">${[...gallery].reverse().map(m => html`<figure key=${m.id} class="cs-gallery-item">
                <a href=${m.url} target="_blank" rel="noopener"><img src=${m.url} alt=${m.name} title=${m.prompt ?? m.name} loading="lazy" /></a>
                <figcaption>${m.purpose ?? ''}
                    ${m.id !== ch.avatarMediaId ? html`<${Button} small label="Use as avatar" onClick=${() => store.update(p => editArtifactField(p, 'characters', ch.id, 'avatarMediaId', m.id, { summary: 'Set avatar image' }), 'set avatar')} />` : html`<${Badge} kind="ok">avatar</${Badge}>`}
                    <${Button} small icon="image" label="View / remove" onClick=${() => navigateStudio({ area: 'media', selection: { type: 'media', id: m.id } })} />
                </figcaption>
            </figure>`)}</div>
        </${Section}>
        <${Section} title=${`Expression sprites (${Object.keys(sprites).length})`} open=${false}>
            <div class="cs-muted cs-small">One face, many moods, for SillyTavern's Character Expressions. ${fromAvatar ? 'Every sprite is made from the avatar, so face, outfit and art style stay the character\'s own.' : 'Every sprite starts from the same portrait, so hair, face and outfit stay the same.'}${comfy ? '' : ' Needs ComfyUI; choose Image settings above.'}</div>
            <div class="cs-row">
                <select class="text_pole cs-input" style="width:auto" value=${spriteSet} onChange=${e => setSpriteSet(e.currentTarget.value)} aria-label="Which expressions">
                    <option value="core" selected=${spriteSet === 'core'}>8 core expressions</option>
                    <option value="all" selected=${spriteSet === 'all'}>All 28 SillyTavern expressions</option>
                </select>
                ${avatarPic && html`<select class="text_pole cs-input" style="width:auto" aria-label="What the sprites start from"
                    onChange=${e => store.update(p => editArtifactField(p, 'characters', ch.id, 'spriteSource', e.currentTarget.value, { summary: 'Sprites start from' }), 'sprite source')}>
                    <option value="avatar" selected=${fromAvatar}>From the avatar</option>
                    <option value="fresh" selected=${!fromAvatar}>From a new portrait</option>
                </select>`}
                <${Button} kind="ai" icon="face-smile" label=${busy === 'sprites' ? 'Generating expressions…' : Object.keys(sprites).length ? 'Generate missing expressions' : 'Generate expressions'}
                    onClick=${() => paintSpriteSet(labels.filter(l => !sprites[l]).length ? labels.filter(l => !sprites[l]) : labels)} disabled=${!!busy || ai.busy || !comfy || !ready} />
                ${busy === 'sprites' && html`<${Button} small icon="stop" label="Stop" onClick=${() => stop.current?.abort()} />`}
                ${Object.keys(sprites).length > 0 && !busy && html`<${Button} small icon="rotate" label=${fromAvatar ? 'Regenerate all expressions' : 'New face'} onClick=${newFace} disabled=${!comfy || !ready} />`}
                ${Object.keys(sprites).length > 0 && html`<${Button} small icon="upload" label=${busy === 'install' ? 'Installing…' : 'Install in SillyTavern'} onClick=${install} disabled=${!!busy}
                    title=${stLinked ? `Upload to characters/${d.name}/ (Character Expressions)` : 'Uploads to characters/<name>/ in SillyTavern; create the character there too (Export & SillyTavern tab)'} />`}
            </div>
            ${progress && html`<div class="cs-fuse-wrap">
                <div class="cs-fuse">${Array.from({ length: progress.total }, (_, i) => html`<span key=${i} class=${cx('cs-fuse-seg', i < progress.done ? 'is-done' : i === progress.done ? 'is-running' : '')}></span>`)}</div>
                <div class="cs-muted cs-small">${progress.current ? `Painting ${progress.current} (${progress.done + 1} of ${progress.total})` : `${progress.done} of ${progress.total}`}. ${fromAvatar ? 'Each one starts from the avatar.' : 'The first one also paints the base portrait.'}</div>
            </div>`}
            ${Object.keys(sprites).length > 0 && html`<div class="cs-sprites" role="group" aria-label="Expressions: choose one to show on the stage">${moodOrder(Object.keys(EXPRESSIONS).filter(l => sprites[l])).map(l => {
                const m = findArtifact(project, 'media', sprites[l]);
                return m && html`<button key=${l} type="button" class=${cx('cs-sprite', `cs-mood-${MOOD_FAMILY[l] ?? 'plain'}`, shownMood === l && 'active')} aria-pressed=${shownMood === l} title=${`Show ${l} on the stage`} onClick=${() => setMood(l)}>
                    <img src=${m.url} alt="" loading="lazy" /><span class="cs-sprite-label">${l}</span>
                </button>`;
            })}</div>
            <div class="cs-muted cs-small">Sprites also travel inside CHARX exports as emotion assets; SillyTavern turns them back into sprites on import.</div>`}
            ${(scene || figure) && html`<div class=${cx('cs-stage', backdrop && 'has-backdrop', shownMood && `cs-mood-${MOOD_FAMILY[shownMood] ?? 'plain'}`)} style=${scene ? `background-image:url("${scene.url}")` : ''} role="img" aria-label=${`${d.name}${shownMood ? `, ${shownMood}` : ''}${scene ? ', in the generated scene' : ''}`}>
                ${backdrop && html`<div class="cs-stage-backdrop" style=${`background-image:url("${backdrop.url}")`}></div><div class="cs-stage-light"></div>`}
                ${shownMood && html`<div class="cs-stage-tint" aria-hidden="true"></div><div class="cs-stage-title" key=${shownMood} aria-hidden="true">${shownMood}</div>`}
                ${figure && html`<img class="cs-stage-figure" src=${figure.url} alt="" />`}
                <div class="cs-stage-caption"><span class="cs-stage-name">${d.name}</span>${shownMood && html`<span class="cs-stage-mood">${shownMood}</span>`}</div>
            </div>`}
        </${Section}>`;
}
