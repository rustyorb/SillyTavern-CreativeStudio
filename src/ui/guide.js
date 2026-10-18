import { html, useState, Button, Icon, Modal } from './kit.js';

export const navigateStudio = detail => globalThis.dispatchEvent(new CustomEvent('cs-navigate', { detail }));

export const GUIDE_TOPICS = [
    { id: 'start', title: 'Where do I start?', words: 'new create beginner character scenario', text: 'Home gives you four starting points. Import a card you already have, bring in a SillyTavern character, start a blank character, or use Generate with AI. Everything is kept in this project as you work.', action: 'Go home', destination: { area: 'project' } },
    { id: 'import', title: 'Import a character card', words: 'png charx json file upload drag drop', text: 'Choose Import card on Home or Characters, then pick a PNG, CHARX or JSON file. You can also drop the file anywhere in the studio. Its character and pictures arrive together. Ctrl+Z undoes the import.', action: 'Import card…', event: 'cs-import-card' },
    { id: 'existing', title: 'Improve a SillyTavern character', words: 'existing pull copy library', text: 'Choose From SillyTavern to copy a character, its lorebook and expressions into this project. Edit the copy here. Export & use shows you the changes before you apply them back.', action: 'From SillyTavern…', event: 'cs-pull-open' },
    { id: 'write', title: 'Write or improve a character', words: 'description personality scenario opening first message greeting', text: 'Open a character and begin with Write. Give them a name, a description and a situation. Then use Openings for their first message. Ask AI beside a field lets you give directions, add details, rewrite, or compare three versions.', action: 'Open character', characterTab: 'core' },
    { id: 'pictures', title: 'Make pictures that look like the same character', words: 'avatar portrait sprites expressions comfyui image consistency style', text: 'Open the character’s Pictures tab and choose a portrait first. That portrait can guide later pictures when your image setup supports reference editing. FLUX Kontext preserves the reference more closely; text-only generation can change the face or style. Set up your image provider in AI setup → Images.', action: 'Open character pictures', characterTab: 'images' },
    { id: 'remove', title: 'Find or delete a picture', words: 'media gallery unused cleanup remove', text: 'Pictures shows all project images. Open a picture to see which characters use it and remove it from the project. The Unused filter finds leftovers. Removing a used picture clears those references too; Ctrl+Z restores them.', action: 'Open picture library', destination: { area: 'media' } },
    { id: 'ai', title: 'Choose the AI model or set up images', words: 'provider connection openrouter key comfyui ollama model settings', text: 'Open AI setup. Choose a writing provider and model, or use the current SillyTavern connection. The Images tab configures image generation separately. You can edit characters and import files without connecting an AI.', action: 'Open AI setup', event: 'cs-ai-setup' },
    { id: 'review', title: 'Control what the AI changes', words: 'undo review hands-free proposals instructions prompts content rating', text: 'The top bar shows whether AI applies edits directly or waits for review. In review mode, drafts appear in the review panel for you to accept or reject. Whole-project generation creates new items with a snapshot first. AI instructions lets you edit and reset the writing directions.', action: 'Edit AI instructions', event: 'cs-prompt-settings' },
    { id: 'world', title: 'Give the AI world details to remember', words: 'lore lorebook world info keywords activate', text: 'World holds lorebooks: entries about people, places and facts. Link a book to your character in its World tab. Keywords decide when an entry is included; use the activation preview to test a line of chat.', action: 'Open world', destination: { area: 'lore' } },
    { id: 'export', title: 'Use the finished character in SillyTavern', words: 'save export publish download apply install png charx', text: 'Open the character’s Export & use tab to download a card or review applying it to SillyTavern. Home’s Use in SillyTavern reviews the whole project. Changes to existing SillyTavern items get backups. Autosave keeps your studio work; it does not apply it to your chat.', action: 'Export this character', characterTab: 'publish' },
    { id: 'tools', title: 'Find presets, regex and scripts', words: 'advanced formatting quick replies stscript prompts', text: 'Open Advanced tools in the main navigation. Writing presets control model instructions, Text cleanup contains regex tools, and Quick Replies contains buttons and scripts. These are optional: you can create and try a character without configuring them.', action: 'Open writing presets', destination: { area: 'prompts' } },
];

export function Guide({ project, selection, onClose }) {
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState('start');
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const topics = GUIDE_TOPICS.filter(t => terms.every(w => `${t.title} ${t.words} ${t.text}`.toLowerCase().includes(w)));
    const act = topic => {
        onClose();
        if (topic.event) return globalThis.dispatchEvent(new CustomEvent(topic.event));
        if (topic.characterTab) {
            const ch = project.characters.find(c => c.id === selection?.id) ?? project.characters[0];
            return navigateStudio(ch ? { area: 'characters', selection: { type: 'characters', id: ch.id, tab: topic.characterTab } } : { area: 'characters' });
        }
        navigateStudio(topic.destination);
    };
    return html`<${Modal} title="Help me find my way" onClose=${onClose}>
        <p class="cs-muted">Practical help for this studio. Pick a task and jump straight to it.</p>
        <input class="text_pole cs-guide-search" aria-label="Search studio help" placeholder="Try import, pictures, model, undo…" value=${query} onInput=${e => setQuery(e.currentTarget.value)} />
        <div class="cs-guide-topics">${topics.map(t => html`<section key=${t.id} class="cs-guide-topic">
            <button class="cs-guide-question" aria-expanded=${expanded === t.id || !!query} onClick=${() => setExpanded(expanded === t.id ? '' : t.id)}>
                <span>${t.title}</span><${Icon} name=${expanded === t.id || query ? 'chevron-down' : 'chevron-right'} />
            </button>
            ${(expanded === t.id || query) && html`<div class="cs-guide-answer"><p>${t.text}</p><${Button} icon="location-arrow" label=${t.action} onClick=${() => act(t)} /></div>`}
        </section>`)}</div>
        ${!topics.length && html`<p class="cs-muted">No matching topic. Try a shorter word such as “picture” or “export”.</p>`}
        <p class="cs-muted cs-small">Shortcuts: Ctrl+K to find anything · Ctrl+S to save · Ctrl+Z to undo outside text fields.</p>
    </${Modal}>`;
}
