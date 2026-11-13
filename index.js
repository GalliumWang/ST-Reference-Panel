import { TavernAdapter } from './adapter.js';
import { ReferencePanel } from './panel.js';
import { isEditableElement } from './clipboard.js';

export const PANEL_VERSION = '1.1.0';

let activePanel = null;
let observer = null;
let lastEditable = null;
let focusTrackerBound = false;
const eventUnsubs = [];
const adapter = new TavernAdapter();

function isInsidePanel(node) {
    return Boolean(node?.closest?.('.srp-dialog, .srp-mini-pill, #st-reference-panel-settings, #st-reference-panel-menu'));
}

function handleDocumentFocusIn(event) {
    const target = event?.target;
    if (target && !isInsidePanel(target) && isEditableElement(target)) {
        lastEditable = target;
    }
}

function bindFocusTracker() {
    if (focusTrackerBound || !globalThis.document) return;
    globalThis.document.addEventListener('focusin', handleDocumentFocusIn, true);
    focusTrackerBound = true;
}

function unbindFocusTracker() {
    if (!focusTrackerBound || !globalThis.document) return;
    globalThis.document.removeEventListener('focusin', handleDocumentFocusIn, true);
    focusTrackerBound = false;
    lastEditable = null;
}

function bindHostEvents() {
    if (eventUnsubs.length) return;
    const context = globalThis.SillyTavern?.getContext?.();
    const eventSource = context?.eventSource;
    if (!eventSource || typeof eventSource.on !== 'function') return;
    const types = context.eventTypes ?? context.event_types ?? {};

    const subscribe = (eventName, handler) => {
        if (!eventName) return;
        eventSource.on(eventName, handler);
        eventUnsubs.push(() => {
            if (typeof eventSource.removeListener === 'function') eventSource.removeListener(eventName, handler);
            else if (typeof eventSource.off === 'function') eventSource.off(eventName, handler);
        });
    };

    subscribe(types.WORLDINFO_UPDATED ?? 'worldinfo_updated', (worldName) => {
        activePanel?.hotSync('worlds', typeof worldName === 'string' ? worldName : '');
    });
    subscribe(types.WORLDINFO_SETTINGS_UPDATED ?? 'worldinfo_settings_updated', () => {
        activePanel?.hotSync('worlds');
    });
    subscribe(types.CHARACTER_EDITED ?? 'character_edited', () => {
        activePanel?.hotSync('characters');
    });
    subscribe(types.CHARACTER_DELETED ?? 'characterDeleted', () => {
        activePanel?.hotSync('characters');
    });
    subscribe(types.CHAT_CHANGED ?? 'chat_id_changed', () => {
        activePanel?.hotSync('context');
    });
    subscribe(types.OAI_PRESET_CHANGED_AFTER ?? 'oai_preset_changed_after', () => {
        activePanel?.hotSync('presets');
    });
    subscribe(types.PRESET_CHANGED ?? 'preset_changed', () => {
        activePanel?.hotSync('presets');
    });
}

function unbindHostEvents() {
    while (eventUnsubs.length) {
        try { eventUnsubs.pop()(); } catch { /* Ignore host listener cleanup errors. */ }
    }
}

export function openPanel(options = {}) {
    // Capture currently focused SillyTavern editor if focusin hasn't rotated away yet.
    const activeEl = globalThis.document?.activeElement;
    if (activeEl && !isInsidePanel(activeEl) && isEditableElement(activeEl)) {
        lastEditable = activeEl;
    }

    if (activePanel && (activePanel.closed || !activePanel.dialog?.isConnected)) {
        activePanel.dispose();
        activePanel = null;
    }

    const resolvedEditable = options?.targetEditable ?? (isEditableElement(lastEditable) ? lastEditable : null);
    if (activePanel) {
        return activePanel.applyOpenOptions({ ...options, targetEditable: resolvedEditable });
    }

    const panel = new ReferencePanel(
        adapter,
        () => { if (activePanel === panel) activePanel = null; },
        { ...options, targetEditable: resolvedEditable },
    );
    activePanel = panel;
    return panel.open().catch(error => {
        console.error('[Reference Panel]', error);
        panel.dispose();
        globalThis.toastr?.error('引用面板打开失败，请刷新页面后重试。');
    });
}

export function closePanel() {
    if (!activePanel) return;
    activePanel.closePanel();
}

function exposeGlobalApi() {
    globalThis.STReferencePanel = {
        version: PANEL_VERSION,
        open(options = {}) {
            return openPanel(options);
        },
        close() {
            closePanel();
        },
    };
}

function hideExtensionsMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && menu.style && menu.style.display && menu.style.display !== 'none') {
        menu.style.display = 'none';
    }
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
        item.addEventListener('click', () => openPanel());
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                hideExtensionsMenu();
                openPanel();
            }
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
        description.textContent = '快速复制或插入角色字段、世界书条目、变量与预设/QR 的 ST-Prompt-Template 引用。';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'menu_button';
        open.textContent = '打开引用面板';
        open.addEventListener('click', () => openPanel());
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
    exposeGlobalApi();
    bindFocusTracker();
    bindHostEvents();
    if (!mount()) {
        observer?.disconnect();
        observer = new MutationObserver((_records, obs) => {
            if (mount()) {
                obs.disconnect();
                if (observer === obs) observer = null;
            }
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }
}

export function onDisable() {
    observer?.disconnect();
    observer = null;
    unbindHostEvents();
    unbindFocusTracker();
    activePanel?.closePanel();
    activePanel?.dispose();
    activePanel = null;
    delete globalThis.STReferencePanel;
    document.getElementById('st-reference-panel-menu')?.remove();
    document.getElementById('st-reference-panel-settings')?.remove();
}

export function onEnable() { initialize(); }

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
}
