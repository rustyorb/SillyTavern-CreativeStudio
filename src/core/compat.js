// Character Card V3 feature support in SillyTavern 1.19.0.
// Distinguishes "valid in the V3 specification" from "used by SillyTavern". Source citations live in
// docs/research/st-formats.md §A.7 (verified against the 1.19.0 release source; some items verified by running ST's modules).

/** status: 'used' | 'partial' | 'kept' (stored, not used) | 'lost' | 'n/a' */
export const V3_SUPPORT = [
    { path: 'data.name', label: 'Name', st: 'used', note: 'Becomes {{char}} and the file name. Characters illegal in file names (/\\?<>:*|") are stripped on import.' },
    { path: 'data.description', label: 'Description', st: 'used' },
    { path: 'data.personality', label: 'Personality', st: 'used' },
    { path: 'data.scenario', label: 'Scenario', st: 'used' },
    { path: 'data.first_mes', label: 'First message', st: 'used' },
    { path: 'data.mes_example', label: 'Example dialogue', st: 'used' },
    { path: 'data.alternate_greetings', label: 'Alternate greetings', st: 'used', note: 'Offered as first-message swipes.' },
    { path: 'data.system_prompt', label: 'System prompt', st: 'used', note: 'Replaces the system prompt when "Prefer Char. Prompt" is on (default). Supports {{original}}.' },
    { path: 'data.post_history_instructions', label: 'Post-history instructions', st: 'used', note: 'Replaces post-history instructions when "Prefer Char. Instructions" is on (default). Supports {{original}}.' },
    { path: 'data.creator_notes', label: 'Creator notes', st: 'used', note: 'Shown in the UI; can be scanned by World Info (matchCreatorNotes).' },
    { path: 'data.tags', label: 'Tags', st: 'used', note: 'Imported into ST tags per the tag-import setting; ST stores tags outside the card afterwards.' },
    { path: 'data.creator', label: 'Creator', st: 'used', note: 'Display only.' },
    { path: 'data.character_version', label: 'Character version', st: 'used', note: 'Display and {{charVersion}}.' },
    { path: 'data.extensions', label: 'Extensions', st: 'used', note: 'Unknown keys survive import, edit and export. ST reads talkativeness, fav, world, depth_prompt, regex_scripts.' },
    { path: 'data.character_book', label: 'Embedded lorebook', st: 'partial', note: 'Not active until imported as a World Info file (ST asks once). With a linked world, ST regenerates the book on save: book-level settings and entry name/priority are lost.' },
    { path: 'data.character_book.entries[].use_regex', label: 'Lorebook: use_regex', st: 'lost', note: 'Ignored on read; ST treats a key as regex only when written /pattern/flags, and writes use_regex:true on every entry.' },
    { path: 'data.character_book (decorators)', label: 'Lorebook decorators (@@depth…)', st: 'partial', note: 'Only @@activate and @@dont_activate work. Other leading @@ lines are silently stripped and NOT applied.' },
    { path: 'data.group_only_greetings', label: 'Group-only greetings', st: 'kept', note: 'Stored but never used. ST does not add the field when missing.' },
    { path: 'data.nickname', label: 'Nickname', st: 'kept', note: 'Stored but not used: {{char}} is always the name.' },
    { path: 'data.creator_notes_multilingual', label: 'Multilingual creator notes', st: 'kept', note: 'Stored, not displayed.' },
    { path: 'data.source', label: 'Source', st: 'kept', note: 'Stored, not used (ST uses extensions.source_url / chub).' },
    { path: 'data.creation_date', label: 'Creation date', st: 'kept', note: 'Stored unchanged; ST keeps its own create_date.' },
    { path: 'data.modification_date', label: 'Modification date', st: 'kept', note: 'Stored but not updated by ST on export.' },
    { path: 'data.assets', label: 'Assets', st: 'partial', note: 'Used only when importing CHARX: the main icon becomes the avatar, emotion/expression assets become sprites, backgrounds go to character backgrounds, other images to the gallery. Audio/video/other files are dropped. ST cannot export CHARX.' },
    { path: 'spec / spec_version', label: 'Spec label', st: 'partial', note: 'The first in-app save rewrites the stored card as chara_card_v2; ST exports relabel it chara_card_v3 in both PNG chunks.' },
];

export const STATUS_LABEL = {
    used: 'Used by ST',
    partial: 'Partly used',
    kept: 'Kept, not used',
    lost: 'Ignored/rewritten',
};

/** Which V3 features a given card actually uses, with ST status: drives the per-card compatibility view. */
export function cardFeatureUsage(card) {
    const d = card?.data ?? {};
    const present = row => {
        switch (row.path) {
            case 'data.character_book': return !!d.character_book?.entries?.length;
            case 'data.character_book.entries[].use_regex': return (d.character_book?.entries ?? []).some(e => e.use_regex === true && (e.keys ?? []).some(k => !/^\/.*\/[a-z]*$/.test(k)));
            case 'data.character_book (decorators)': return (d.character_book?.entries ?? []).some(e => /^@@(?!activate\b|dont_activate\b)/m.test(e.content ?? ''));
            case 'data.group_only_greetings': return !!d.group_only_greetings?.length;
            case 'data.assets': return !!d.assets?.length;
            case 'spec / spec_version': return true;
            default: {
                const key = row.path.replace(/^data\./, '');
                const v = d[key];
                return Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v;
            }
        }
    };
    return V3_SUPPORT.map(row => ({ ...row, present: present(row) }));
}

/** Lorebook entry fields that exist in ST world files but not in V3 character_book (kept under entry.extensions). */
export const WI_ONLY_ENTRY_FIELDS = ['excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'probability', 'useProbability', 'group', 'groupOverride', 'groupWeight', 'useGroupScoring', 'scanDepth', 'matchWholeWords', 'automationId', 'sticky', 'cooldown', 'delay', 'triggers', 'outletName', 'vectorized', 'ignoreBudget', 'characterFilter', 'role', 'depth'];
