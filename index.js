import { TavernAdapter } from './adapter.js';
import { ReferencePanel } from './panel.js';

let activePanel = null;
let observer = null;
const adapter = new TavernAdapter();

function openPanel() {
    if (activePanel && !activePanel.dialog.open) activePanel.dispose();
    if (activePanel) {
        activePanel.dialog.focus();
        return;
    }
    activePanel = new ReferencePanel(adapter, () => { activePanel = null; });
    activePanel.open().catch(error => {
        console.error('[Reference Panel]', error);
        activePanel?.dialog.close();
        globalThis.toastr?.error('引用面板打开失败，请刷新页面后重试。');
    });
}

function mount() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('st-reference-panel-menu')) {
        const item = document.createElement('div');
        item.id = 'st-reference-panel-menu';
        item.className = 'list-group-item flex-container flexGap5';
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-quote-right';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = '引用面板';
        item.append(icon, label);
        item.addEventListener('click', openPanel);
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); }
        });
        menu.append(item);
    }
    const settings = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settings && !document.getElementById('st-reference-panel-settings')) {
        const block = document.createElement('div');
        block.id = 'st-reference-panel-settings';
        block.className = 'srp-settings';
        const title = document.createElement('strong');
        title.textContent = '引用面板';
        const description = document.createElement('p');
        description.textContent = '快速复制角色字段和世界书条目的 ST-Prompt-Template 引用。';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'menu_button';
        open.textContent = '打开引用面板';
        open.addEventListener('click', openPanel);
        block.append(title, description, open);
        settings.append(block);
    }
    return Boolean(menu && settings);
}

function initialize() {
    if (!globalThis.SillyTavern?.getContext) {
        console.error('[Reference Panel] SillyTavern.getContext is unavailable.');
        return;
    }
    if (!mount()) {
        observer = new MutationObserver(() => {
            if (mount()) { observer.disconnect(); observer = null; }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
}

export function onDisable() {
    observer?.disconnect();
    observer = null;
    activePanel?.dialog.close();
    activePanel?.dispose();
    document.getElementById('st-reference-panel-menu')?.remove();
    document.getElementById('st-reference-panel-settings')?.remove();
}

export function onEnable() { initialize(); }

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
