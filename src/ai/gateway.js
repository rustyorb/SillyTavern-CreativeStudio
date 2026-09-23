// AI gateway: one entry point for every structured creation task.
//
// Routes (verified against SillyTavern 1.19.0 source, see docs/COMPATIBILITY.md):
//  1. Creation profile → ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {extractData:false}, override)
//     Uses the profile's API/model/preset without switching the user's active connection. Cancellable.
//     Chat Completion: json_schema is passed (native enforcement where the source supports it).
//     Text Completion: no ST-level schema support; we rely on prompted JSON (+ optional backend hints).
//  2. Main API → generateRaw({prompt: messages, jsonSchema (CC only, returnInvalid:true), responseLength}).
//     Not cancellable in ST; a cancelled call is detached and its result discarded.
// We always request raw text and parse it ourselves because ST replaces unparsable JSON with "{}".

import { extractJson } from './json.js';
import { validate, coerce, schemaToPrompt } from './schema.js';
import { hashString } from '../core/bytes.js';

export class AiError extends Error {
    constructor(message, { raw = '', meta = {}, cause } = {}) {
        super(message, { cause });
        this.raw = raw;
        this.meta = meta;
    }
}

/** Describe the route that would be used, for the UI. */
export function describeRoute(ctx, profileId) {
    if (profileId) {
        const profile = safeGetProfile(ctx, profileId);
        if (!profile) return { ok: false, label: 'Creation profile not found', mode: 'profile' };
        const api = profile.api ?? '';
        const cc = isChatCompletionProfile(ctx, profile);
        return {
            ok: true,
            mode: 'profile',
            label: `${profile.name} (${cc ? 'Chat Completion' : 'Text Completion'}${profile.model ? ` · ${profile.model}` : ''})`,
            api,
            model: profile.model ?? '',
            preset: profile.preset ?? '',
            schemaEnforced: cc,
            profileName: profile.name,
        };
    }
    const cc = ctx.mainApi === 'openai';
    let model = '';
    try { model = cc ? ctx.getChatCompletionModel?.() ?? '' : ctx.onlineStatus ?? ''; } catch { /* ignore */ }
    return {
        ok: ctx.onlineStatus !== 'no_connection',
        mode: 'main',
        label: `Main connection (${cc ? 'Chat Completion' : ctx.mainApi || 'none'}${model ? ` · ${model}` : ''})`,
        api: ctx.mainApi,
        model,
        preset: '',
        schemaEnforced: cc,
    };
}

function safeGetProfile(ctx, id) {
    try {
        return ctx.ConnectionManagerRequestService?.getProfile?.(id) ?? ctx.extensionSettings?.connectionManager?.profiles?.find(p => p.id === id) ?? null;
    } catch {
        return ctx.extensionSettings?.connectionManager?.profiles?.find(p => p.id === id) ?? null;
    }
}

function isChatCompletionProfile(ctx, profile) {
    const map = ctx.CONNECT_API_MAP?.[profile.api];
    if (map) return map.selected === 'openai';
    return profile.mode === 'cc';
}

/** List connection profiles usable for creation (never exposes secrets; we only read names/ids). */
export function listProfiles(ctx) {
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    return profiles.map(p => ({ id: p.id, name: p.name, api: p.api, model: p.model ?? '', mode: p.mode, preset: p.preset ?? '' }));
}

function buildMessages({ system, user, schema, schemaName, examples }) {
    const jsonRules = schema
        ? `\n\nRespond with ONE JSON value only — no prose before or after, no code fences. It must match this JSON Schema (named "${schemaName}"):\n${schemaToPrompt(schema)}${examples ? `\n\nExample of the expected shape:\n${JSON.stringify(examples)}` : ''}`
        : '';
    return [
        { role: 'system', content: `${system}${jsonRules}` },
        { role: 'user', content: user },
    ];
}

function textFromRaw(ctx, raw, api) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    // Claude forced tool call
    const tool = Array.isArray(raw.content) ? raw.content.find(x => x?.type === 'tool_use') : null;
    if (tool?.input) return JSON.stringify(tool.input);
    try {
        const t = ctx.extractMessageFromData?.(raw, api);
        if (typeof t === 'string' && t) return t;
    } catch { /* fall through */ }
    return raw.choices?.[0]?.message?.content ?? raw.choices?.[0]?.text ?? raw.content ?? raw.results?.[0]?.text ?? JSON.stringify(raw);
}

/**
 * Run one structured task.
 * @param {object} ctx SillyTavern context
 * @param {object} req
 * @param {string} req.system
 * @param {string} req.user
 * @param {object} [req.schema] JSON schema for the result
 * @param {string} [req.schemaName]
 * @param {string} [req.profileId] creation profile id ('' = main connection)
 * @param {number} [req.maxTokens]
 * @param {AbortSignal} [req.signal]
 * @param {(s: string) => void} [req.onStatus]
 * @param {boolean} [req.repair] one repair round-trip when output is invalid
 * @returns {Promise<{ value: any, raw: string, meta: object }>}
 */
export async function runStructured(ctx, req) {
    const { schema, schemaName = 'result', profileId = '', maxTokens = 2048, signal, onStatus = () => {}, repair = true } = req;
    const route = describeRoute(ctx, profileId);
    if (!route.ok && route.mode === 'profile') throw new AiError(route.label, { meta: route });
    const messages = buildMessages(req);
    const promptHash = hashString(JSON.stringify(messages));
    const started = Date.now();
    const meta = { ...route, promptHash, attempts: 0, repaired: [], startedAt: new Date(started).toISOString() };

    const callOnce = async msgs => {
        meta.attempts++;
        if (signal?.aborted) throw new AiError('Cancelled', { meta });
        if (route.mode === 'profile') {
            const override = {};
            if (schema && route.schemaEnforced) override.json_schema = { name: schemaName, value: schema, strict: false };
            let raw;
            try {
                raw = await ctx.ConnectionManagerRequestService.sendRequest(profileId, msgs, maxTokens, { stream: false, signal, extractData: false }, override);
            } catch (e) {
                const cause = e?.cause?.message ?? e?.message;
                throw new AiError(signal?.aborted ? 'Cancelled' : `Request failed: ${cause}`, { meta, cause: e });
            }
            return textFromRaw(ctx, raw, route.schemaEnforced ? 'openai' : 'textgenerationwebui');
        }
        // Main API route; not abortable inside ST, so race it against our signal.
        const gen = ctx.generateRaw({
            prompt: msgs,
            responseLength: maxTokens,
            jsonSchema: schema && route.schemaEnforced ? { name: schemaName, value: schema, strict: false, returnInvalid: true } : null,
        });
        const abort = new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new AiError('Cancelled (the request may still finish in the background)', { meta })), { once: true }));
        try {
            return String(await Promise.race([gen, abort]));
        } catch (e) {
            if (e instanceof AiError) throw e;
            throw new AiError(`Request failed: ${e?.message ?? e}`, { meta, cause: e });
        }
    };

    onStatus(`Generating via ${route.label}…`);
    let raw = await callOnce(messages);
    if (!schema) {
        meta.durationMs = Date.now() - started;
        return { value: raw, raw, meta };
    }
    let parsed = extractJson(raw);
    let value = parsed.ok ? coerce(schema, parsed.value) : undefined;
    let errors = parsed.ok ? validate(schema, value) : [{ path: '$', message: parsed.error }];
    if (parsed.ok) meta.repaired.push(...parsed.repaired);

    if (errors.length && repair && !signal?.aborted) {
        onStatus('Output did not match the expected structure; asking the model to fix it…');
        const fixMsgs = [
            ...messages,
            { role: 'assistant', content: String(raw).slice(0, 12000) },
            { role: 'user', content: `That response is not valid for the required JSON Schema. Problems:\n${errors.slice(0, 12).map(e => `- ${e.path}: ${e.message}`).join('\n')}\nReturn the corrected JSON only.` },
        ];
        const raw2 = await callOnce(fixMsgs);
        const p2 = extractJson(raw2);
        if (p2.ok) {
            const v2 = coerce(schema, p2.value);
            const e2 = validate(schema, v2);
            if (e2.length < errors.length || !e2.length) {
                raw = raw2;
                value = v2;
                errors = e2;
                meta.repaired.push('model repair round-trip', ...p2.repaired);
            }
        }
    }
    meta.durationMs = Date.now() - started;
    meta.validationErrors = errors;
    if (value === undefined) throw new AiError(`Could not read JSON from the model output (${errors[0]?.message ?? 'unknown error'})`, { raw, meta });
    return { value, raw, meta };
}
