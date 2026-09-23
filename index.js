// Creative Studio — SillyTavern UI extension entry point.
// Keeps startup cheap: registers the launcher and lazily imports the workbench on first open.

const EXT_ID = 'creative-studio';
const ROOT_ID = 'cs-root';
let appModule = null;
let opening = null;

async function openStudio(route) {
    if (opening) return opening;
    opening = (async () => {
        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            document.body.appendChild(root);
        }
        appModule ??= await import('./src/ui/app.js');
        await appModule.mountStudio(root, { route, onClose: closeStudio });
        root.classList.add('cs-open');
        document.body.classList.add('cs-studio-open');
        setTopIcon(true);
    })().finally(() => { opening = null; });
    return opening;
}

function closeStudio() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('cs-open');
    document.body.classList.remove('cs-studio-open');
    setTopIcon(false);
    appModule?.unmountStudio(root);
}

function toggleStudio() {
    const root = document.getElementById(ROOT_ID);
    if (root?.classList.contains('cs-open')) closeStudio();
    else openStudio();
}

/**
 * A feather in SillyTavern's top bar, next to the Extensions icon. It uses ST's own .drawer / .drawer-icon look
 * (dim until hovered) but not .drawer-toggle, so ST's drawer logic never treats it as a panel.
 */
function addLauncher() {
    if (document.getElementById('cs-top-button')) return;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    const button = document.createElement('div');
    button.id = 'cs-top-button';
    button.className = 'drawer';
    const icon = document.createElement('div');
    icon.className = 'drawer-icon fa-solid fa-feather-pointed fa-fw closedIcon';
    icon.title = 'Creative Studio (Ctrl+Shift+S)';
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', 'Open Creative Studio');
    icon.tabIndex = 0;
    icon.addEventListener('click', toggleStudio);
    icon.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleStudio();
        }
    });
    button.appendChild(icon);
    const after = document.getElementById('extensions-settings-button');
    if (after?.parentElement === holder) after.after(button);
    else holder.appendChild(button);
}

function setTopIcon(open) {
    const icon = document.querySelector('#cs-top-button .drawer-icon');
    if (!icon) return;
    icon.classList.toggle('openIcon', open);
    icon.classList.toggle('closedIcon', !open);
}

function registerCommand() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx ?? {};
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'studio',
        callback: async (_args, value) => {
            await openStudio(String(value ?? '').trim() || undefined);
            return '';
        },
        unnamedArgumentList: SlashCommandArgument?.fromProps ? [SlashCommandArgument.fromProps({
            description: 'area to open: characters, lore, prompts, regex, scripts, project, playtest',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })] : [],
        helpString: 'Opens Creative Studio, optionally at a workshop area.',
    }));
}

document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        toggleStudio();
    }
});

addLauncher();
registerCommand();
// In case the top bar is not built yet when the extension loads.
globalThis.SillyTavern?.getContext?.().eventSource?.on?.('app_ready', addLauncher);

globalThis.CreativeStudio = { open: openStudio, close: closeStudio, id: EXT_ID };
