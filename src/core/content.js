// A project's content level: what the AI may write and paint. It goes into every writing task (as an instruction the
// author can edit in AI instructions) and into every picture (rating tags and what is kept out).

export const CONTENT_LEVELS = {
    sfw: { label: 'Keep it SFW', hint: 'No sexual content or nudity, no graphic gore.' },
    mature: { label: 'Mature themes', hint: 'Romance, desire, violence, dark themes and strong language; sex stays implied.' },
    adult: { label: 'Adult, explicit allowed', hint: 'Anything the story calls for, as explicit as it calls for.' },
};

/** Roleplay authors are adults writing for adults; a project starts at mature themes unless it says otherwise. */
export const DEFAULT_CONTENT = 'mature';

/** The generator's older rating dial ("SFW", "mature themes…", "unrestricted…") as a content level. */
export function contentFromRating(rating = '') {
    const r = String(rating).toLowerCase();
    if (!r) return '';
    if (/sfw|safe/.test(r) && !/nsfw/.test(r)) return 'sfw';
    // "mature themes, no explicit content" mentions explicit, so mature is read first
    if (/mature/.test(r)) return 'mature';
    if (/unrestricted|explicit|adult|nsfw/.test(r)) return 'adult';
    return '';
}

/** The content level a project writes and paints at. */
export function contentOf(project) {
    const set = project?.settings?.content;
    return CONTENT_LEVELS[set] ? set : contentFromRating(project?.lastDials?.rating) || DEFAULT_CONTENT;
}

/** The rating a picture is painted at for a content level (see composePrompt in core/comfy.js). */
export function imageRating(content = DEFAULT_CONTENT) {
    return { sfw: 'SFW', mature: 'mature', adult: 'unrestricted' }[content] ?? 'SFW';
}
