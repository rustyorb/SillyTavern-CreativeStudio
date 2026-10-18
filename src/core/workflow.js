// Small, deterministic guidance. Optional extras never block a character from being tried.
const hasText = value => typeof value === 'string' && value.trim().length > 0;

export function characterProgress(character) {
    const d = character?.card?.data ?? {};
    const steps = [
        { id: 'name', label: 'Name', tab: 'core', done: hasText(d.name) && !/^New (character|scenario)$/i.test(d.name.trim()) },
        { id: 'description', label: 'Description', tab: 'core', done: hasText(d.description) },
        { id: 'scenario', label: 'Situation', tab: 'core', done: hasText(d.scenario) },
        { id: 'first_mes', label: 'Opening message', tab: 'greetings', done: hasText(d.first_mes) },
    ];
    const next = steps.find(step => !step.done);
    return { steps, complete: steps.filter(step => step.done).length, total: steps.length, ready: !next, next };
}

export const CHARACTER_TABS = [
    { id: 'core', label: 'Write', icon: 'pen-nib' },
    { id: 'greetings', label: 'Openings', icon: 'comment' },
    { id: 'examples', label: 'Voice', icon: 'comments' },
    { id: 'images', label: 'Pictures', icon: 'image' },
    { id: 'lore', label: 'World', icon: 'book' },
    { id: 'publish', label: 'Export & use', icon: 'upload' },
    { id: 'prompts', label: 'Prompt overrides', icon: 'terminal', advanced: true },
    { id: 'meta', label: 'Metadata & assets', icon: 'tags', advanced: true },
    { id: 'extensions', label: 'Extension data', icon: 'puzzle-piece', advanced: true },
    { id: 'compat', label: 'Compatibility', icon: 'list-check', advanced: true },
];

export const TAB_HELP = {
    core: 'Start with who they are and the situation you want to play. You can write yourself or ask AI beside any field.',
    greetings: 'The opening is the first message your character sends. Write one strong start; alternate openings are optional.',
    examples: 'Show how your character speaks. A few short exchanges help establish their voice.',
    images: 'Pictures stay with this character. Write a prompt and generate a picture here, or upload a portrait you already have.',
    lore: 'Add places, people and facts the AI should remember. A lorebook is optional for a simple character.',
    publish: 'Download a portable card or review changes before sending this character to SillyTavern.',
};

export const GENERATION_PRESETS = [
    { id: 'character', label: 'Character & openings', description: 'A focused start: a character card and alternate opening scenes.', steps: ['premise', 'concept', 'card', 'greetings', 'polish'] },
    { id: 'world', label: 'Character & world', description: 'Also adds a linked lorebook and written image prompts.', steps: ['premise', 'concept', 'card', 'greetings', 'lore', 'images', 'polish'] },
    { id: 'complete', label: 'Complete toolkit', description: 'Also builds presets, text cleanup and Quick Reply buttons.', steps: null },
];
