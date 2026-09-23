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
    })().finally(() => { opening = null; });
    return opening;
}

function closeStudio() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('cs-open');
    document.body.classList.remove('cs-studio-open');
    appModule?.unmountStudio(root);
}

function addLauncher() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('cs-launch-menu')) {
        const item = document.createElement('div');
        item.id = 'cs-launch-menu';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.title = 'Open Creative Studio (Ctrl+Shift+S)';
        item.innerHTML = '<div class="fa-fw fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div><span>Creative Studio</span>';
        item.addEventListener('click', () => openStudio());
        item.addEventListener('keydown', e => (e.key === 'Enter' || e.key === ' ') && openStudio());
        menu.appendChild(item);
    }
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
        const root = document.getElementById(ROOT_ID);
        if (root?.classList.contains('cs-open')) closeStudio();
        else openStudio();
    }
});

addLauncher();
registerCommand();
// The extensions menu can be rebuilt; make sure the launcher survives.
globalThis.SillyTavern?.getContext?.().eventSource?.on?.('app_ready', addLauncher);

globalThis.CreativeStudio = { open: openStudio, close: closeStudio, id: EXT_ID };
