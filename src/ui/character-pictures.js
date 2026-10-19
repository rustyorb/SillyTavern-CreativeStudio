// One character-owned picture workspace, shared by both Pictures entry points.
import { html, useState, useRef, useEffect, Button, Icon, TextArea, Select, Toggle, Section, Modal, pickFile, fileBytes, cx } from './kit.js';
import { imageSettings, imageReady, familyOf, paint, paintSprites, paintFromPicture, installSprites } from '../st/comfy.js';
import { FAMILIES, EXPRESSIONS, CORE_EXPRESSIONS, randomSeed, characterPrompt, characterNegative, pictureInstruction, sizeFor } from '../core/comfy.js';
import { useAiTask, AiStatus } from './ai.js';
import { ImageSetup } from './image-setup.js';
import { contentOf, imageRating } from '../core/content.js';
import { findArtifact, editArtifactField } from '../core/project.js';
import { stSpriteFolder } from '../st/live.js';
import { saveMedia, saveCharacterPicture, mediaBytes, toPngBytes } from './media.js';
import { pictureDraft, pictureTarget, selectCharacterAvatar } from '../core/pictures.js';
import { navigateStudio } from './guide.js';
import { DeletePictureButton } from './deletion.js';
import { ensureCharacterPortrait } from './portrait.js';

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
    const [portraitLoading, setPortraitLoading] = useState(false);
    const [portraitError, setPortraitError] = useState('');
    const [portraitAttempt, setPortraitAttempt] = useState(0);
    useEffect(() => {
        let active = true;
        setPortraitLoading(true);
        setPortraitError('');
        ensureCharacterPortrait(store, env, project.id, ch.id, { retry: portraitAttempt > 0 })
            .catch(e => { if (active) setPortraitError(e.message); })
            .finally(() => { if (active) setPortraitLoading(false); });
        return () => { active = false; };
    }, [store, env, project.id, ch.id, portraitAttempt]);
    const job = useRef(false);
    const [spriteSet, setSpriteSet] = useState('core');
    const [progress, setProgress] = useState(null);
    const [expressionStatus, setExpressionStatus] = useState('');
    const [expressionError, setExpressionError] = useState('');
    const [testExpression, setTestExpression] = useState('joy');
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
    const gallery = project.media.filter(m => m.kind === 'image' && (m.id === ch.avatarMediaId || ((ch.links?.media ?? []).includes(m.id) && !spriteIds.has(m.id))));
    const stLinked = ch.origin?.kind === 'st' ? ch.origin.avatar : ch.stAvatar;
    // Legacy spriteSource='fresh' never overrides the character's visible portrait reference.
    const avatarPic = ch.avatarMediaId ? findArtifact(project, 'media', ch.avatarMediaId) : null;
    const fromAvatar = !!avatarPic;
    const adapter = ch.expressionAdapter ?? 'plus-face';
    const chooseAvatar = mediaId => {
        try {
            store.update(p => selectCharacterAvatar(p, project.id, ch.id, mediaId), 'choose avatar', { merge: false });
            env.toast(`Avatar selected for ${d.name}. Ctrl+Z restores the previous choice.`, 'ok');
        } catch (e) { env.toast(e.message, 'error'); }
    };
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
            store.update(p => selectCharacterAvatar(apply(p), project.id, ch.id, media.id), 'upload portrait', { merge: false });
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
        setResult(`Picture saved. Choose it in “Choose avatar” above to use it on ${d.name}’s card.`);
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
        setExpressionError('');
        setExpressionStatus('Preparing expressions…');
        const current = currentCharacter();
        const reference = findArtifact(store.get(), 'media', current.avatarMediaId);
        if (!reference) { setExpressionStatus('Choose a portrait first.'); return; }
        const lookNow = current.appearance || '';
        const ac = new AbortController();
        stop.current = ac;
        const seed = ch.spriteSeed ?? randomSeed();
        const failed = [];
        setProgress({ done: 0, total: labels.length, current: labels[0] });
        store.update(p => editArtifactField(p, 'characters', ch.id, 'spriteSeed', seed, { actor: 'ai', summary: 'Sprite seed' }), 'sprite seed');
        let res;
        try { res = await paintSprites({
            look: lookNow, labels, rating, seed, identity: adapter, signal: ac.signal, reference: await mediaBytes(env, reference), onStatus: setExpressionStatus,
            onEach: async (label, r) => {
                if (r.bytes) {
                    await saveCharacterPicture(env, store, project.id, ch.id, r.bytes, { label, prompt: r.positive, seed: r.seed, referenceMediaId: reference.id, method: r.method });
                } else {
                    failed.push(label);
                    setExpressionError(r.error);
                }
                setProgress(pg => ({ ...pg, done: pg.done + 1, current: labels[labels.indexOf(label) + 1] }));
            },
        }); } catch (e) { setExpressionError(e.message); setExpressionStatus('Expressions stopped.'); throw e; }
        setProgress(null);
        const made = Object.keys(res.sprites).length;
        const summary = res.cancelled ? `Stopped. ${made} expression(s) saved.` : failed.length ? `${made} expression(s) saved; generation stopped at ${failed[0]}.` : `${made} expression(s) saved using this portrait and ${adapter === 'faceid' ? 'FaceID Plus v2' : 'IP-Adapter Plus Face'}.`;
        const report = [summary, ...(res.warnings ?? [])].join(' ');
        setExpressionStatus(report);
        env.toast(report, failed.length ? 'error' : 'ok', 9000);
    });
    const newFace = async () => {
        if (!(await env.confirm('Regenerate expressions from this portrait?', 'The current expressions are replaced one at a time. Undo in the top bar restores each replacement.'))) return;
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
        setExpressionStatus(`Installed ${ok} of ${r.length} expressions for ${d.name}. Enable Character Expressions in SillyTavern and open a chat with this character.`);
        env.toast(`Installed ${ok} of ${r.length} sprite(s) in characters/${folder}. Turn on Character Expressions in SillyTavern's extensions to see them.`, ok === r.length ? 'ok' : 'error', 8000);
    });

    const labels = spriteSet === 'all' ? Object.keys(EXPRESSIONS) : CORE_EXPRESSIONS;
    // Only actual backgrounds belong behind expressions. A portrait must never become a second face.
    const scene = gallery.find(m => m.id !== ch.avatarMediaId && /^(background|scene|location|landscape)$/i.test(m.purpose ?? ''));
    const spriteOf = label => (sprites[label] ? findArtifact(project, 'media', sprites[label]) : null);
    const figure = spriteOf(mood) ?? spriteOf('neutral') ?? spriteOf(Object.keys(sprites)[0]);
    const shownMood = spriteOf(mood) ? mood : figure ? (spriteOf('neutral') ? 'neutral' : Object.keys(sprites)[0]) : '';
    return html`
        <section class="cs-portrait-start" aria-label="Current character portrait">
            ${avatarPic ? html`<img src=${avatarPic.url} alt=${`${d.name}'s current portrait`} />` : html`<div class="cs-portrait-placeholder"><${Icon} name="user" /></div>`}
            <div><strong>${avatarPic ? `${d.name}’s current avatar` : portraitLoading ? 'Loading character portrait…' : 'No avatar selected'}</strong>
                <p>${avatarPic ? 'This single image is your character card’s avatar and the reference for new expressions. Click a saved picture below to change it.' : portraitLoading ? 'Checking for this character’s existing image.' : 'Upload a portrait here or generate one below. The first portrait becomes the picture on your character card.'}</p>
                ${avatarPic && ch.portraitSource?.mediaId === avatarPic.id && html`<p class="cs-small cs-muted">Loaded from this character’s PNG in SillyTavern.</p>`}
                ${!avatarPic && portraitError && html`<p role="alert" class="cs-err-text">Could not load the existing portrait: ${portraitError}</p>
                    <${Button} small label="Retry loading portrait" onClick=${() => setPortraitAttempt(v => v + 1)} disabled=${portraitLoading} />`}
                <${Button} icon="file-image" label="Upload portrait…" onClick=${uploadPortrait} disabled=${!!busy} />
            </div>
        </section>
        <${Section} title=${`Choose avatar — ${gallery.length} saved picture${gallery.length === 1 ? '' : 's'}`}>
            <p class="cs-muted cs-small">Click the image you want as ${d.name}’s avatar. Only one is selected. Generating another picture keeps your current choice.</p>
            ${!gallery.length && html`<p class="cs-muted">Your generated and uploaded pictures will appear here.</p>`}
            <div class="cs-gallery" role="group" aria-label=${`Choose avatar for ${d.name}`}>${[...gallery].reverse().map(m => html`<figure key=${m.id} class=${cx('cs-gallery-item', m.id === ch.avatarMediaId && 'is-avatar')}>
                <label class="cs-avatar-choice" title=${m.prompt ?? m.name}>
                    <input type="radio" name=${`avatar-${ch.id}`} value=${m.id} aria-label=${`Use ${m.name} as avatar`} checked=${m.id === ch.avatarMediaId} onChange=${() => chooseAvatar(m.id)} />
                    <img src=${m.url} alt=${m.name} loading="lazy" />
                    <span>${m.id === ch.avatarMediaId ? '✓ Current avatar' : 'Choose as avatar'}</span>
                </label>
                <figcaption>
                    <span class="cs-picture-purpose">${m.purpose ?? m.name}</span>
                    <${Button} small icon="image" label="Details" onClick=${() => navigateStudio({ area: 'media', selection: { type: 'media', id: m.id } })} />
                    <${DeletePictureButton} store=${store} env=${env} project=${project} media=${m} />
                </figcaption>
            </figure>`)}</div>
        </${Section}>
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
                <${Button} kind="primary" icon="image" label=${busy === 'picture' ? 'Generating picture…' : 'Generate picture'} onClick=${() => run('picture', () => paintOne({ ...draft }))} disabled=${!!busy || portraitLoading || ai.busy || !ready || !draft.prompt.trim()} />
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
        <${Section} title=${`Expressions — same character, different moods (${Object.keys(sprites).length})`} open=${true}>
            <p class="cs-muted">Expressions are pictures for moods such as joy or anger. Make one, check the face, then generate the rest. Installing them lets SillyTavern display them beside your chat.</p>
            <div class="cs-expression-reference">
                ${avatarPic && html`<img src=${avatarPic.url} alt=${`Expression reference for ${d.name}`} />`}
                <div><strong>1. Reference portrait: ${d.name}</strong><p>${avatarPic ? 'New expressions use this exact picture with a face-reference adapter. Select another image in Choose avatar above to change it. Saved expressions stay as they are until you regenerate them.' : 'Upload a portrait or select a saved picture in Choose avatar above.'}</p>
                ${!avatarPic && html`<${Button} label="Upload reference portrait…" onClick=${uploadPortrait} disabled=${!!busy} />`}
                <span class="cs-muted cs-small">Face matching is not perfect. Start with a clear, close portrait and check one result before making a set.</span></div>
            </div>
            <${Select} label="2. Face-reference method" value=${adapter} options=${[{ value: 'plus-face', label: 'Illustrated / anime — IP-Adapter Plus Face' }, { value: 'faceid', label: 'Photographic — FaceID Plus v2' }]}
                onChange=${value => store.update(p => editArtifactField(p, 'characters', ch.id, 'expressionAdapter', value, { summary: 'Expression face adapter' }), 'expression face adapter')} />
            ${(!comfy || !ready || !settings?.ckpt) && html`<div class="cs-warn-text">Expressions need ComfyUI with a full SDXL or SD1.5 checkpoint and the selected adapter installed. <${Button} small label="Set up expressions" onClick=${() => setSetupOpen(true)} /></div>`}
            <div class="cs-row"><strong>3. Try one expression</strong>
                <select class="text_pole cs-input" style="width:auto" aria-label="Test expression" value=${testExpression} onChange=${e => setTestExpression(e.currentTarget.value)}>${Object.keys(EXPRESSIONS).map(l => html`<option value=${l} selected=${testExpression === l}>${l}</option>`)}</select>
                <${Button} kind="primary" icon="face-smile" label="Generate one expression" onClick=${async () => { if (sprites[testExpression] && !(await env.confirm(`Replace ${testExpression}?`, 'The existing expression can be restored with Undo.'))) return; paintSpriteSet([testExpression]); }} disabled=${!!busy || ai.busy || !comfy || !ready || !settings?.ckpt || !avatarPic} />
            </div>
            <p class="cs-muted cs-small">Satisfied with the face? Generate the missing moods below. No fallback to a new person is used if the adapter fails.</p>
            ${Object.values(sprites).some(id => { const m = findArtifact(project, 'media', id); return m && (m.referenceMediaId !== avatarPic?.id || m.method !== adapter); }) && html`<p class="cs-warn-text">Some saved expressions use an older or different setup. Use Regenerate expressions to remake them from the portrait and adapter shown here.</p>`}
            <div class="cs-row">
                <select class="text_pole cs-input" style="width:auto" value=${spriteSet} onChange=${e => setSpriteSet(e.currentTarget.value)} aria-label="Which expressions">
                    <option value="core" selected=${spriteSet === 'core'}>8 core expressions</option>
                    <option value="all" selected=${spriteSet === 'all'}>All 28 SillyTavern expressions</option>
                </select>
                <${Button} kind="ai" icon="face-smile" label=${busy === 'sprites' ? 'Generating expressions…' : Object.keys(sprites).length ? 'Generate missing expressions' : 'Generate expressions'}
                    onClick=${() => paintSpriteSet(labels.filter(l => !sprites[l]))} disabled=${!!busy || ai.busy || !comfy || !ready || !settings?.ckpt || !avatarPic || !labels.some(l => !sprites[l])} />
                ${busy === 'sprites' && html`<${Button} small icon="stop" label="Stop" onClick=${() => stop.current?.abort()} />`}
                ${Object.keys(sprites).length > 0 && !busy && html`<${Button} small icon="rotate" label="Regenerate expressions" onClick=${newFace} disabled=${!comfy || !ready || !settings?.ckpt || !avatarPic} />`}
                ${Object.keys(sprites).length > 0 && html`<${Button} small icon="upload" label=${busy === 'install' ? 'Installing…' : 'Install in SillyTavern'} onClick=${install} disabled=${!!busy}
                    title=${stLinked ? `Upload to characters/${d.name}/ (Character Expressions)` : 'Uploads to characters/<name>/ in SillyTavern; create the character there too (Export & SillyTavern tab)'} />`}
            </div>
            ${expressionStatus && html`<div role="status" class="cs-expression-status">${expressionStatus}</div>`}
            ${expressionError && html`<div role="alert" class="cs-err-text cs-expression-error">${expressionError}</div>`}
            ${progress && html`<div class="cs-fuse-wrap">
                <div class="cs-fuse">${Array.from({ length: progress.total }, (_, i) => html`<span key=${i} class=${cx('cs-fuse-seg', i < progress.done ? 'is-done' : i === progress.done ? 'is-running' : '')}></span>`)}</div>
                <div class="cs-muted cs-small">${progress.current ? `Painting ${progress.current} (${progress.done + 1} of ${progress.total})` : `${progress.done} of ${progress.total}`}. ${fromAvatar ? 'Each one starts from the avatar.' : 'The first one also paints the base portrait.'}</div>
            </div>`}
            ${Object.keys(sprites).length > 0 && html`<div class="cs-sprites" role="group" aria-label="Expressions: choose one to preview">${moodOrder(Object.keys(EXPRESSIONS).filter(l => sprites[l])).map(l => {
                const m = findArtifact(project, 'media', sprites[l]);
                return m && html`<div key=${l} class="cs-expression-card"><button type="button" class=${cx('cs-sprite', `cs-mood-${MOOD_FAMILY[l] ?? 'plain'}`, shownMood === l && 'active')} aria-pressed=${shownMood === l} title=${`Preview ${l} expression`} onClick=${() => setMood(l)}>
                    <img src=${m.url} alt="" loading="lazy" /><span class="cs-sprite-label">${l}</span>
                </button><${DeletePictureButton} store=${store} env=${env} project=${project} media=${m} label="Delete expression" /></div>`;
            })}</div>
            <div class="cs-muted cs-small">Sprites also travel inside CHARX exports as emotion assets; SillyTavern turns them back into sprites on import.</div>`}
            ${(scene || figure) && html`<p class="cs-muted cs-small">${figure ? `Expression preview — ${shownMood}. Selecting an expression here does not change your avatar.` : 'Background preview'}</p>
            <div class=${cx('cs-stage', shownMood && `cs-mood-${MOOD_FAMILY[shownMood] ?? 'plain'}`)} style=${scene ? `background-image:url("${scene.url}")` : ''} role="img" aria-label=${figure ? `${d.name}: ${shownMood} expression preview` : `${d.name}: background preview`}>
                ${shownMood && html`<div class="cs-stage-tint" aria-hidden="true"></div><div class="cs-stage-title" key=${shownMood} aria-hidden="true">${shownMood}</div>`}
                ${figure && html`<img class="cs-stage-figure" src=${figure.url} alt="" />`}
                <div class="cs-stage-caption"><span class="cs-stage-name">${d.name}</span>${shownMood && html`<span class="cs-stage-mood">${shownMood}</span>`}</div>
            </div>`}
        </${Section}>`;
}
