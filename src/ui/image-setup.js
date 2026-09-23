// Images: where pictures come from (ComfyUI through SillyTavern, or SillyTavern's Image Generation extension),
// which checkpoint, and the quality choices. No ComfyUI knowledge needed: the studio builds the workflows.
import { html, useState, useEffect, Button, Icon, Badge, Section, pickFile, fileBytes, cx } from './kit.js';
import { stContext } from '../st/env.js';
import { imageSettings, saveImageSettings, familyOf, comfyPing, comfyCheckpoints, comfySamplers, paint } from '../st/comfy.js';
import { FAMILIES, detectFamily, isFast, samplingFor, adoptWorkflow } from '../core/comfy.js';
import { utf8Decode } from '../core/bytes.js';

export function ImageSetup({ env }) {
    const ctx = stContext();
    const [s, setS] = useState(() => ({ ...imageSettings(ctx) }));
    const [ckpts, setCkpts] = useState([]);
    const [lists, setLists] = useState({ samplers: [], schedulers: [] });
    const [status, setStatus] = useState({ kind: '', text: '' });
    const [adjust, setAdjust] = useState(false);
    const [test, setTest] = useState(null);
    const stImagine = !!ctx.SlashCommandParser?.commands?.imagine;
    const set = patch => setS({ ...saveImageSettings(patch, ctx) });

    const connect = async (url = s.url) => {
        setStatus({ kind: 'busy', text: `Connecting to ${url}…` });
        try {
            await comfyPing(url);
            const [models, sl] = await Promise.all([comfyCheckpoints(url), comfySamplers(url).catch(() => ({ samplers: [], schedulers: [] }))]);
            setCkpts(models);
            setLists(sl);
            const patch = { url };
            if (!s.ckpt || !models.includes(s.ckpt)) patch.ckpt = models[0] ?? '';
            set(patch);
            setStatus({ kind: 'ok', text: `Connected: ${models.length} checkpoint(s).` });
        } catch (e) { setStatus({ kind: 'err', text: e.message }); }
    };
    useEffect(() => { if (s.backend === 'comfy' && s.url) connect(s.url); }, []);

    const importWorkflow = async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const json = JSON.parse(utf8Decode(await fileBytes(f)));
            const a = adoptWorkflow(json);
            set({ workflow: { name: f.name, json, mode: a.mode } });
            env.toast(a.mode === 'placeholders' ? `Using ${f.name} (SillyTavern placeholders).` : `Using ${f.name}: prompts, size, seed and checkpoint are filled in automatically.`, 'ok', 6000);
        } catch (e) { env.toast(`Cannot use that workflow: ${e.message}`, 'error', 8000); }
    };
    const runTest = async () => {
        setTest({ busy: true });
        const t0 = Date.now();
        try {
            const fam = familyOf(s);
            const prompt = FAMILIES[fam]?.tags ? 'still life, brass lantern, glowing, old wooden table, night, window, rain' : 'a brass lantern glowing on an old wooden table at night, rain on the window behind it';
            const r = await paint({ prompt, purpose: 'background' });
            const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }));
            setTest({ url, ms: Date.now() - t0 });
        } catch (e) { setTest({ error: e.message }); }
    };

    const fam = familyOf(s);
    const eff = samplingFor(s.ckpt, fam, {});
    return html`<${Section} title="Images" open=${true}>
        <div class="cs-muted cs-small">Portraits, scenes and expression sprites for your characters. The studio writes the prompts and builds the ComfyUI workflow for you.</div>
        <div class="cs-row" role="radiogroup" aria-label="Image generator">
            ${[['', 'Off'], ['comfy', 'ComfyUI'], ['st', 'SillyTavern Image Generation']].map(([v, label]) => html`<${Button} key=${v} small label=${label} ariaPressed=${s.backend === v}
                disabled=${v === 'st' && !stImagine} title=${v === 'st' && !stImagine ? 'Enable the Image Generation extension in SillyTavern first' : ''} onClick=${() => { set({ backend: v }); if (v === 'comfy') connect(); }} />`)}
        </div>
        ${s.backend === 'st' && html`<div class="cs-muted cs-small">Uses whatever SillyTavern's Image Generation extension is set to. Expression sprites need ComfyUI.</div>`}
        ${s.backend === 'comfy' && html`<div class="cs-stack">
            <div class="cs-row">
                <input class="text_pole cs-input cs-mono" style="flex:1;min-width:220px" value=${s.url} aria-label="ComfyUI address"
                    placeholder="http://127.0.0.1:8188" onChange=${e => set({ url: e.currentTarget.value.trim() })} />
                <${Button} small icon="plug" label="Connect" onClick=${() => connect(s.url)} disabled=${status.kind === 'busy'} />
                <span class=${cx('cs-small', status.kind === 'err' ? 'cs-err-text' : status.kind === 'ok' ? 'cs-ok-text' : 'cs-muted')}>
                    ${status.kind === 'busy' && html`<span class="cs-spin"><${Icon} name="spinner" /></span> `}${status.text}</span>
            </div>
            ${ckpts.length > 0 && html`<div class="cs-grid">
                <label class="cs-field"><span class="cs-field-head"><span>Checkpoint</span></span>
                    <select class="text_pole cs-input" value=${s.ckpt} onChange=${e => set({ ckpt: e.currentTarget.value })}>
                        ${ckpts.map(m => html`<option value=${m} selected=${m === s.ckpt}>${m.replace(/\.(safetensors|ckpt|gguf)$/i, '')}</option>`)}
                    </select></label>
                <label class="cs-field"><span class="cs-field-head"><span>Prompt style</span></span>
                    <select class="text_pole cs-input" value=${s.family} onChange=${e => set({ family: e.currentTarget.value })}>
                        <option value="auto" selected=${s.family === 'auto'}>Auto: ${FAMILIES[detectFamily(s.ckpt)].label}</option>
                        ${Object.entries(FAMILIES).map(([k, f]) => html`<option value=${k} selected=${s.family === k}>${f.label}</option>`)}
                    </select></label>
            </div>`}
            <div class="cs-small cs-muted">Sampling: ${num(s.steps) ?? eff.steps} steps · CFG ${num(s.cfg) ?? eff.cfg} · ${s.sampler || eff.sampler} · ${s.scheduler || eff.scheduler}${isFast(s.ckpt) ? ' (fast checkpoint)' : ''}
                <${Button} small label=${adjust ? 'Done' : 'Adjust'} onClick=${() => setAdjust(!adjust)} /></div>
            ${adjust && html`<div class="cs-grid">
                <label class="cs-field"><span class="cs-field-head"><span>Steps</span></span><input class="text_pole cs-input" type="number" min="1" max="150" placeholder=${eff.steps} value=${s.steps} onChange=${e => set({ steps: e.currentTarget.value })} /></label>
                <label class="cs-field"><span class="cs-field-head"><span>CFG</span></span><input class="text_pole cs-input" type="number" step="0.1" min="0" max="30" placeholder=${eff.cfg} value=${s.cfg} onChange=${e => set({ cfg: e.currentTarget.value })} /></label>
                <label class="cs-field"><span class="cs-field-head"><span>Sampler</span></span><select class="text_pole cs-input" value=${s.sampler} onChange=${e => set({ sampler: e.currentTarget.value })}>
                    <option value="">Auto (${eff.sampler})</option>${lists.samplers.map(x => html`<option value=${x} selected=${x === s.sampler}>${x}</option>`)}</select></label>
                <label class="cs-field"><span class="cs-field-head"><span>Scheduler</span></span><select class="text_pole cs-input" value=${s.scheduler} onChange=${e => set({ scheduler: e.currentTarget.value })}>
                    <option value="">Auto (${eff.scheduler})</option>${lists.schedulers.map(x => html`<option value=${x} selected=${x === s.scheduler}>${x}</option>`)}</select></label>
            </div>`}
            <div class="cs-row">
                <label class="cs-toggle"><input type="checkbox" checked=${s.hires} onChange=${e => set({ hires: e.currentTarget.checked })} /><span>Sharper portraits (second pass at 1.5×)</span></label>
                <label class="cs-toggle"><input type="checkbox" checked=${s.transparentSprites} onChange=${e => set({ transparentSprites: e.currentTarget.checked })} /><span>Transparent expression sprites (when ComfyUI has the RemBG nodes)</span></label>
            </div>
            <div class="cs-row cs-small">
                <span class="cs-muted">Workflow:</span>
                ${s.workflow ? html`<${Badge} kind="accent">${s.workflow.name}</${Badge}><${Button} small label="Use the built-in one" onClick=${() => set({ workflow: null })} />`
                    : html`<${Badge}>built-in (recommended)</${Badge}>`}
                <${Button} small icon="file-import" label="Use my own…" title="A ComfyUI workflow saved with Export (API). Prompts, size, seed and checkpoint are filled in for you." onClick=${importWorkflow} />
            </div>
            <div class="cs-row">
                <${Button} icon="image" label="Paint a test picture" onClick=${runTest} disabled=${test?.busy || !s.ckpt} />
                ${test?.busy && html`<span class="cs-muted cs-small"><span class="cs-spin"><${Icon} name="spinner" /></span> Painting… (the first picture also loads the checkpoint)</span>`}
                ${test?.error && html`<span class="cs-err-text cs-small">${test.error}</span>`}
                ${test?.url && html`<span class="cs-ok-text cs-small"><${Icon} name="circle-check" /> ${(test.ms / 1000).toFixed(1)} s</span>`}
            </div>
            ${test?.url && html`<img class="cs-test-image" src=${test.url} alt="Test picture from ComfyUI" />`}
        </div>`}
    </${Section}>`;
}

function num(v) {
    return v === '' || v == null ? undefined : Number(v);
}
