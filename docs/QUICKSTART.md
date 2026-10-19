# Start with a character

Open Creative Studio with the feather in SillyTavern’s top bar, or **Ctrl+Shift+S**.

## Choose a starting point on Home

- **Import a card** opens a PNG, CHARX or JSON character file. Dropping a card on the studio works too.
- **From SillyTavern** brings a copy of an existing character, its world information and expressions into your project.
- **Write a character** starts a blank character you can fill in yourself.
- **Generate with AI** turns an idea into a character. Choose **Character & openings** for a focused start, **Character & world** to add lore and image prompts, or **Complete toolkit** for presets, text cleanup and Quick Replies too. Customize tone and individual steps if needed. Your idea and scope are saved when you leave the page.

AI generation uses the connection selected in **AI setup** and your provider’s normal usage terms. Importing, editing and exporting do not need an AI connection.

## Make the character yours

**Write** holds the name, description, personality and current situation. **Openings** holds the first message and optional alternate starts. **Voice** gives the AI examples of how the character speaks.

The basics checklist helps you see what remains to write. It is guidance, not a requirement to fill every possible field. Pictures, lorebooks, presets and scripts are optional.

Beside a text field, **Ask AI** opens a place for your directions:

- **Write it** fills an empty field.
- **Add to it** keeps the current text and adds new detail.
- **Rewrite** replaces it with a revised version.
- **3 takes** gives you versions to compare.

**Use earlier fields** lets you choose the context for that field, with every box checked initially. Personality
gets Name and Description; Scenario adds Personality; later fields build on the preceding writing fields in the
same way. Your direction and the current field's text are always included. Uncheck anything you do not want used.
These choices are remembered separately for each field and character.

For an accent, spoken quirk or specific dialogue rule, open **Voice** and fill **Voice direction — highest priority**.
It leads over other voice/style instructions for AI-written dialogue and openings. The AI controls and context
boxes work in both **Structured** and **Raw text**. For example: “Clipped London accent; questions end in ‘yeah?’;
keep slang light.” This is writing guidance, not a text-to-speech setting.

The top bar tells you whether AI edits apply directly or wait for review. You can undo project changes with **Ctrl+Z** outside text fields. **Advanced tools → AI instructions** lets you inspect, change and reset the writing instructions.

## Add a portrait and world details

Open a character, then **Pictures**. Both the character tab and the main Pictures button stay with that character. Choose a picture type, write a **Picture prompt**, then press **Generate picture**. **Help write prompt** can draft the words from the character card; you can edit them before generating. Each character keeps its own prompt draft. **Image settings** opens the generator setup directly.

The character’s **current portrait** appears at the top automatically and becomes the reference for expressions. Studio reuses its saved picture or recovers a linked/matching PNG from SillyTavern when an older import lost the image link. A name alone is never enough to choose another character’s face. Your selected portrait is kept, and deliberately deleted portraits stay deleted.

To choose a different picture, use **Upload portrait…** or **Replace portrait…**. Replacing it keeps previous pictures in the character’s gallery. The portrait travels with the exported card. Each image has **Delete picture**, followed by confirmation and Undo. **Delete character** removes the whole character instead.

For expressions, follow the three steps in **Expressions — same character, different moods**: check the reference portrait, choose **IP-Adapter Plus Face** for illustrations or **FaceID Plus v2** for photographic faces, and **Generate one expression**. If the face looks right, generate the missing moods. These require ComfyUI and the adapter models listed in the README. Generation never switches to a new person if the adapter fails. **Install in SillyTavern** uploads the results; enable SillyTavern's Character Expressions extension to display them in chat. **Delete expression** removes an unwanted mood from the project.

**Pictures → Project picture library** collects all project pictures. Search by picture or character name, filter expressions or unused pictures, and open a picture to see its uses or remove it. Removal is undoable. Returning to Pictures keeps your working character selected.

If expression background removal fails, Studio can retry once with the background kept, retaining the same face reference. The result tells you when this happened. If the GPU runs out of memory, generation stops; free memory before trying one expression again. **Image settings → Transparent expression sprites** lets you turn background removal off yourself.

**World** holds lorebooks. Each entry needs a title, trigger words and facts to recall. Link a book from the character’s World tab. Advanced matching, placement and activation settings are available in expandable sections.

## Try it and use it

**Try a conversation** opens a separate test inside the studio. Select a character and a connection, then **Start conversation** to show its opening. Sending a message asks the selected model for a reply.

In **Export & use**, **Download PNG card** is the usual choice for SillyTavern. **Download CHARX** includes additional assets and expressions. Other formats are in an expandable section.

Use **Create as new SillyTavern character**, or **Review & apply** for an existing linked character. Home’s **Use in SillyTavern** reviews the entire project before applying it. Autosave saves studio work; it does not apply changes to your chat.

## Find the rest

**Advanced tools** contains writing presets, text cleanup (regex), Quick Replies and AI instructions. The character editor’s **Advanced** button reveals prompt overrides, metadata, extension data and compatibility checks.

To remove an advanced item, use **Delete** beside its name in the project library or workshop list. **Delete set** removes a whole Quick Reply set; **Delete button** removes only the selected reply. **Delete preset** removes the whole preset; custom prompts have their own Delete control. The confirmation names the item and explains what is included. These actions affect the project copy, leaving installed SillyTavern items alone. Choose **Undo** in the notification to restore it. The top-bar Undo remains available after the notification closes. Built-in prompt slots can be disabled with their checkbox instead of deleted.

**Help** is searchable, works without AI, and has buttons that open the relevant screen. **Find** / **Ctrl+K** jumps to workshops, characters and actions. On small screens, **Project items** opens the project library.
