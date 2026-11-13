import {
    COMMON_FIELDS, getAtPath, displayPath, lodashPath, valueType, previewText, snippetText,
    isContainer, prepareSearchWords, matchesPrecomputed, matchesSearch, fieldRows,
    characterTemplate, worldTemplate, variableTemplate, presetTemplate, quickReplyTemplate,
    duplicateWarning, uidOverlapWarning,
} from './core.js';
import { VALID_TABS } from './adapter.js';
import { copyText, insertAtEditable, isEditableElement } from './clipboard.js';

const TAB_DEFS = [
    ['characters', '角色卡'],
    ['worlds', '世界书'],
    ['variables', '变量 Variables'],
    ['presets', '预设 / QR'],
];
const SOURCE_PREVIEW_LIMIT = 8000;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(text, className = 'srp-button') {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
}

function input(label, placeholder) {
    const wrapper = element('label', 'srp-search');
    const text = element('span', 'srp-label', label);
    const control = element('input', 'srp-input');
    control.type = 'search';
    control.placeholder = placeholder;
    control.autocomplete = 'off';
    wrapper.append(text, control);
    return { wrapper, control, text };
}

function cleanLabel(value, fallback) {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function makeState() {
    return {
        sources: null,
        source: null,
        sourceQuery: '',
        targetQuery: '',
        data: null,
        entries: [],
        items: [],
        books: [],
        lazy: false,
        selection: null,
        expanded: new Set(),
        allOpen: false,
        loaded: false,
        dirty: false,
        sourceLimit: 60,
        targetLimit: 100,
    };
}

export class ReferencePanel {
    constructor(adapter, onClose = () => {}, options = {}) {
        this.adapter = adapter;
        this.onClose = onClose;
        this.options = options ?? {};
        const initialTab = VALID_TABS.includes(this.options.tab) ? this.options.tab : adapter.lastTab();
        this.tab = initialTab;
        this.onInsert = typeof this.options.onInsert === 'function' ? this.options.onInsert : null;
        this.targetEditable = isEditableElement(this.options.targetEditable) ? this.options.targetEditable : null;
        const savedPrefs = adapter.prefs();
        this.floating = typeof this.options.floating === 'boolean'
            ? this.options.floating
            : Boolean(savedPrefs.floating);
        this.minimized = false;
        this.ignoreCloseEvents = 0;
        this.floatPos = null;

        this.prefs = {
            charScope: savedPrefs.charScope === 'current' ? 'current' : 'named',
            lazyOverride: null,
            forceRegex: Boolean(savedPrefs.forceRegex),
            worldScope: savedPrefs.worldScope === 'primary' ? 'primary' : 'named',
            worldLookup: savedPrefs.worldLookup === 'uid' ? 'uid' : 'title',
            worldAction: savedPrefs.worldAction === 'activewi' ? 'activewi' : 'getwi',
            trimNewline: savedPrefs.trimNewline !== false,
            varAction: ['getvar', 'setvar', 'incvar', 'if'].includes(savedPrefs.varAction) ? savedPrefs.varAction : 'getvar',
            varScope: ['default', 'local', 'global', 'message'].includes(savedPrefs.varScope) ? savedPrefs.varScope : 'default',
            presetMode: savedPrefs.presetMode === 'static' ? 'static' : 'current',
        };

        this.states = {
            characters: makeState(),
            worlds: makeState(),
            variables: makeState(),
            presets: makeState(),
        };
        this.basket = [];
        this.basketExpanded = false;
        this.request = 0;
        this.template = '';
        this.fullSourceText = '';
        this.sourceExpanded = false;
        this.copying = false;
        this.closed = false;
        this.cleanups = [];
        this.timers = new Set();

        this.filteredSources = [];
        this.renderedSourceCount = 0;
        this.filteredTargets = [];
        this.renderedTargetCount = 0;
        this.filteredTreeRows = [];
        this.renderedTreeCount = 0;
        this.treeContainer = null;

        this.build();
    }

    get state() { return this.states[this.tab]; }

    addManagedTimer(fn, delay) {
        const id = setTimeout(() => {
            this.timers.delete(id);
            if (!this.closed) fn();
        }, delay);
        this.timers.add(id);
        return id;
    }

    bindSearchInput(control, onChange, delay = 120) {
        let timer = null;
        let composing = false;
        let pending = false;
        const cancel = () => {
            pending = false;
            composing = false;
            if (timer !== null) {
                clearTimeout(timer);
                this.timers.delete(timer);
                timer = null;
            }
        };
        const commit = () => {
            if (timer !== null) {
                clearTimeout(timer);
                this.timers.delete(timer);
                timer = null;
            }
            pending = false;
            if (!this.closed) onChange(control.value);
        };
        const flush = () => {
            if (pending) commit();
            else cancel();
        };
        const schedule = () => {
            if (timer !== null) {
                clearTimeout(timer);
                this.timers.delete(timer);
                timer = null;
            }
            if (control.value === '') {
                pending = false;
                onChange('');
                return;
            }
            pending = true;
            timer = this.addManagedTimer(() => {
                timer = null;
                pending = false;
                onChange(control.value);
            }, delay);
        };
        control.addEventListener('compositionstart', () => { composing = true; });
        control.addEventListener('compositionend', () => {
            composing = false;
            schedule();
        });
        control.addEventListener('input', event => {
            if (control.value === '') {
                commit();
                return;
            }
            if (event.isComposing || composing) {
                pending = true;
                return;
            }
            schedule();
        });
        control.addEventListener('search', commit);
        return { cancel, flush };
    }

    build() {
        this.dialog = element('dialog', 'srp-dialog');
        this.dialog.setAttribute('aria-labelledby', 'srp-heading');

        const header = element('header', 'srp-header');
        this.headerEl = header;
        const heading = element('div', 'srp-header-title');
        const title = element('h2', '', '引用面板');
        title.id = 'srp-heading';
        heading.append(title, element('p', 'srp-muted', '角色卡 · 世界书 · 变量 · 预设与 QR 引用生成'));

        const headerActions = element('div', 'srp-header-actions');
        this.modeBtn = button('📌 悬浮小窗', 'srp-button srp-mode-btn');
        this.modeBtn.addEventListener('click', () => this.setFloating(!this.floating, true));
        this.minimizeBtn = button('—', 'srp-button srp-minimize');
        this.minimizeBtn.setAttribute('aria-label', '最小化悬浮小窗');
        this.minimizeBtn.title = '最小化为胶囊按钮';
        this.minimizeBtn.hidden = true;
        this.minimizeBtn.addEventListener('click', () => this.setMinimized(true));
        const close = button('×', 'srp-button srp-close');
        close.setAttribute('aria-label', '关闭引用面板');
        close.addEventListener('click', () => this.closePanel());
        headerActions.append(this.modeBtn, this.minimizeBtn, close);
        header.append(heading, headerActions);

        this.miniPill = button('📌 引用面板', 'srp-mini-pill');
        this.miniPill.hidden = true;
        this.miniPill.setAttribute('aria-label', '展开引用面板悬浮窗');
        this.miniPill.addEventListener('click', () => {
            if (this._pillDragged) return;
            this.setMinimized(false);
        });

        const toolbar = element('div', 'srp-toolbar');
        const tabs = element('div', 'srp-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '引用类型');
        this.tabs = {};
        const tabIds = TAB_DEFS.map(([id]) => id);
        for (const [id, label] of TAB_DEFS) {
            const tab = button(label, 'srp-button srp-tab');
            tab.id = `srp-tab-${id}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', 'srp-workspace');
            tab.addEventListener('click', () => this.switchTab(id));
            tab.addEventListener('keydown', event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const curIdx = tabIds.indexOf(this.tab);
                    const nextIdx = event.key === 'Home' ? 0
                        : event.key === 'End' ? tabIds.length - 1
                        : event.key === 'ArrowRight' ? (curIdx + 1) % tabIds.length
                        : (curIdx - 1 + tabIds.length) % tabIds.length;
                    const next = tabIds[nextIdx];
                    this.tabs[next].focus();
                    this.switchTab(next);
                }
            });
            this.tabs[id] = tab;
            tabs.append(tab);
        }
        const toolbarRight = element('div', 'srp-toolbar-right');
        this.refresh = button('刷新列表', 'srp-button srp-refresh');
        this.refresh.addEventListener('click', () => this.reload());
        toolbarRight.append(this.refresh);
        toolbar.append(tabs, toolbarRight);

        this.workspace = element('div', 'srp-workspace');
        this.workspace.id = 'srp-workspace';
        this.workspace.setAttribute('role', 'tabpanel');

        const picker = element('section', 'srp-picker');
        this.pickerEl = picker;

        this.quickDetails = element('details', 'srp-quick-access');
        this.quickSummary = element('summary', 'srp-section-label', '⭐ 收藏与最近');
        this.quickBody = element('div', 'srp-quick-list');
        this.quickDetails.append(this.quickSummary, this.quickBody);
        this.quickDetails.hidden = true;
        this.quickBody.addEventListener('click', event => this.handleQuickClick(event));

        this.sourcesDetails = element('details', 'srp-sources');
        this.sourcesDetails.open = true;
        this.sourcesSummary = element('summary', 'srp-section-label');
        this.sourceSearch = input('搜索角色', '角色名称、文件名或标签');
        this.sourcesList = element('div', 'srp-source-list');
        this.sourcesList.setAttribute('aria-label', '可引用的来源列表');
        this.sourceSearchDebounce = this.bindSearchInput(this.sourceSearch.control, value => {
            this.state.sourceQuery = value;
            this.state.sourceLimit = 60;
            this.renderSources();
        });
        this.sourcesList.addEventListener('click', event => this.handleSourcesClick(event));
        this.sourcesDetails.append(this.sourcesSummary, this.sourceSearch.wrapper, this.sourcesList);

        const targetHeading = element('div', 'srp-target-heading');
        this.targetTitle = element('h3', 'srp-section-label', '2. 选择字段');
        targetHeading.append(this.targetTitle);

        this.customVarBar = element('div', 'srp-custom-var');
        this.customVarInput = element('input', 'srp-input');
        this.customVarInput.type = 'text';
        this.customVarInput.placeholder = '手输变量路径，如 stat.hp 或 flags.met';
        this.customVarInput.setAttribute('aria-label', '自定义变量路径');
        this.customVarApply = button('生成路径', 'srp-button');
        const applyCustomVar = () => {
            const raw = this.customVarInput.value.trim();
            if (!raw) return;
            this.select({ customPath: raw, path: [], value: undefined, label: raw });
        };
        this.customVarApply.addEventListener('click', applyCustomVar);
        this.customVarInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyCustomVar();
            }
        });
        this.customVarInput.addEventListener('input', () => {
            const raw = this.customVarInput.value.trim();
            if (raw) this.select({ customPath: raw, path: [], value: undefined, label: raw }, false);
        });
        this.customVarBar.append(this.customVarInput, this.customVarApply);
        this.customVarBar.hidden = true;

        this.targetSearch = input('搜索字段', '字段名称、路径或内容');
        this.targetSearchDebounce = this.bindSearchInput(this.targetSearch.control, value => {
            this.state.targetQuery = value;
            this.state.targetLimit = 100;
            this.renderTargets();
        });
        this.targetList = element('div', 'srp-target-list');
        this.targetList.addEventListener('click', event => this.handleTargetsClick(event));

        picker.append(
            this.quickDetails,
            this.sourcesDetails,
            targetHeading,
            this.customVarBar,
            this.targetSearch.wrapper,
            this.targetList,
        );

        const preview = element('section', 'srp-preview');
        preview.setAttribute('aria-label', '引用预览');
        const previewTop = element('div', 'srp-preview-top');
        previewTop.append(element('h3', 'srp-section-label', '3. 预览并复制'));
        const previewTools = element('div', 'srp-preview-tools');
        this.pinBtn = button('☆ 收藏', 'srp-button srp-tool-btn');
        this.pinBtn.disabled = true;
        this.pinBtn.addEventListener('click', () => this.toggleCurrentPin());
        this.stageCurrentBtn = button('+ 暂存', 'srp-button srp-tool-btn');
        this.stageCurrentBtn.disabled = true;
        this.stageCurrentBtn.addEventListener('click', () => this.toggleStageCurrent());
        previewTools.append(this.pinBtn, this.stageCurrentBtn);
        previewTop.append(previewTools);

        this.selectedLabel = element('p', 'srp-selected-label', '尚未选择引用目标');
        this.warning = element('div', 'srp-warning');
        this.warning.setAttribute('role', 'status');
        this.warning.hidden = true;

        const sourcePreview = element('details', 'srp-content-details');
        sourcePreview.open = true;
        sourcePreview.append(element('summary', 'srp-label', '源内容'));
        this.sourcePreview = element('pre', 'srp-source-preview', '选择目标后在这里查看原始内容。');
        this.expandSourceBtn = button('展开完整原文', 'srp-button srp-expand-source');
        this.expandSourceBtn.hidden = true;
        this.expandSourceBtn.addEventListener('click', () => {
            this.sourceExpanded = true;
            this.sourcePreview.textContent = this.fullSourceText;
            this.expandSourceBtn.hidden = true;
        });
        sourcePreview.append(this.sourcePreview, this.expandSourceBtn);

        this.capsules = element('div', 'srp-capsules');
        this.capsules.setAttribute('aria-label', '模板选项切换');

        const templateLabel = element('label', 'srp-label', '引用模板');
        templateLabel.htmlFor = 'srp-template';
        this.templateControl = element('textarea', 'srp-template');
        this.templateControl.id = 'srp-template';
        this.templateControl.readOnly = true;
        this.templateControl.spellcheck = false;
        this.templateControl.rows = 4;
        this.templateControl.placeholder = '选择字段或条目后自动生成';
        const hint = element('p', 'srp-muted srp-hint', '源内容保持原文；模板粘贴后由 ST-Prompt-Template 执行。');
        preview.append(
            previewTop,
            this.selectedLabel,
            this.warning,
            sourcePreview,
            this.capsules,
            templateLabel,
            this.templateControl,
            hint,
        );
        this.workspace.append(picker, preview);

        this.basketSection = element('div', 'srp-basket');
        this.basketSection.hidden = true;
        const basketBar = element('div', 'srp-basket-bar');
        this.basketTitle = element('strong', '', '🧺 暂存篮（0 项）');
        const basketActions = element('div', 'srp-basket-actions');
        this.basketToggleBtn = button('查看明细', 'srp-button srp-tool-btn');
        this.basketToggleBtn.addEventListener('click', () => {
            this.basketExpanded = !this.basketExpanded;
            this.renderBasket();
        });
        this.basketCopyBtn = button('批量复制', 'srp-button srp-tool-btn srp-copy');
        this.basketCopyBtn.addEventListener('click', () => this.copyBasket());
        this.basketInsertBtn = button('批量插入', 'srp-button srp-tool-btn srp-insert');
        this.basketInsertBtn.addEventListener('click', () => this.insertBasket());
        this.basketClearBtn = button('清空暂存', 'srp-button srp-tool-btn');
        this.basketClearBtn.addEventListener('click', () => {
            this.basket = [];
            this.basketExpanded = false;
            this.renderBasket();
            this.syncStageButtons();
            this.status.textContent = '已清空暂存篮';
        });
        basketActions.append(this.basketToggleBtn, this.basketCopyBtn, this.basketInsertBtn, this.basketClearBtn);
        basketBar.append(this.basketTitle, basketActions);
        this.basketList = element('div', 'srp-basket-list');
        this.basketList.hidden = true;
        this.basketList.addEventListener('click', event => {
            const removeBtn = event.target.closest('[data-basket-remove]');
            if (!removeBtn) return;
            const idx = Number(removeBtn.dataset.basketRemove);
            if (Number.isInteger(idx) && idx >= 0 && idx < this.basket.length) {
                this.basket.splice(idx, 1);
                this.renderBasket();
                this.syncStageButtons();
            }
        });
        this.basketSection.append(basketBar, this.basketList);

        const footer = element('footer', 'srp-footer');
        this.status = element('span', 'srp-status', '请选择引用目标');
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');

        const footerButtons = element('div', 'srp-footer-buttons');
        this.manual = button('选中模板', 'srp-button srp-manual');
        this.manual.disabled = true;
        this.manual.addEventListener('click', () => this.selectTemplate());
        this.insertBtn = button('插入引用', 'srp-button srp-insert');
        this.insertBtn.disabled = true;
        this.insertBtn.hidden = true;
        this.insertBtn.addEventListener('click', () => this.insertTemplate());
        this.copy = button('复制引用', 'srp-button srp-copy');
        this.copy.disabled = true;
        this.copy.addEventListener('click', () => this.copyTemplate());
        footerButtons.append(this.manual, this.insertBtn, this.copy);
        footer.append(this.status, footerButtons);

        this.dialog.append(header, toolbar, this.workspace, this.basketSection, footer);

        this.dialog.addEventListener('close', () => {
            if (this.ignoreCloseEvents > 0) {
                this.ignoreCloseEvents--;
                return;
            }
            if (this.dialog.open) return;
            this.dispose();
        });

        // Require BOTH pointerdown and click to occur outside the dialog rect so drag-selecting text
        // inside .srp-template or .srp-source-preview and releasing outside never closes the modal.
        let pointerDownOutside = false;
        this.dialog.addEventListener('pointerdown', event => {
            if (this.floating || event.target !== this.dialog) {
                pointerDownOutside = false;
                return;
            }
            const rect = this.dialog.getBoundingClientRect();
            pointerDownOutside = event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
        });
        this.dialog.addEventListener('click', event => {
            if (this.floating || event.target !== this.dialog) {
                pointerDownOutside = false;
                return;
            }
            const rect = this.dialog.getBoundingClientRect();
            const clickOutside = event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
            // Support both genuine pointerdown+click outside AND synthetic click-only backdrop tests (detail === 0 / no prior down).
            if (clickOutside && (pointerDownOutside || event.detail === 0)) {
                pointerDownOutside = false;
                this.closePanel();
                return;
            }
            pointerDownOutside = false;
        });

        this.dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.floating && !this.minimized) {
                event.stopPropagation();
                this.closePanel();
            }
        });

        this.setupDrag();
    }

    setupDrag() {
        const startDrag = (handle, getTarget, onMovePos, ignoreClickFlag = null) => {
            let dragState = null;
            handle.addEventListener('pointerdown', event => {
                if (handle === this.headerEl && !this.floating) return;
                if (event.button !== undefined && event.button !== 0) return;
                if (event.target.closest('button, input, textarea, select, a, summary') && handle === this.headerEl) return;
                const node = getTarget();
                const rect = node.getBoundingClientRect();
                dragState = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    originLeft: rect.left,
                    originTop: rect.top,
                    moved: false,
                };
                if (ignoreClickFlag) this[ignoreClickFlag] = false;
                handle.setPointerCapture?.(event.pointerId);
            });
            handle.addEventListener('pointermove', event => {
                if (!dragState || event.pointerId !== dragState.pointerId) return;
                const dx = event.clientX - dragState.startX;
                const dy = event.clientY - dragState.startY;
                if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
                dragState.moved = true;
                if (ignoreClickFlag) this[ignoreClickFlag] = true;
                onMovePos(dragState.originLeft + dx, dragState.originTop + dy);
            });
            const finish = event => {
                if (!dragState || event.pointerId !== dragState.pointerId) return;
                handle.releasePointerCapture?.(event.pointerId);
                dragState = null;
                if (ignoreClickFlag && this[ignoreClickFlag]) {
                    this.addManagedTimer(() => { this[ignoreClickFlag] = false; }, 50);
                }
            };
            handle.addEventListener('pointerup', finish);
            handle.addEventListener('pointercancel', finish);
        };

        startDrag(this.headerEl, () => this.dialog, (left, top) => {
            this.floatPos = { left, top };
            this.clampFloatingPosition();
        });

        startDrag(this.miniPill, () => this.miniPill, (left, top) => {
            const vw = globalThis.innerWidth || 800;
            const vh = globalThis.visualViewport?.height || globalThis.innerHeight || 600;
            const rect = this.miniPill.getBoundingClientRect();
            const clampedLeft = Math.min(Math.max(6, left), Math.max(6, vw - rect.width - 6));
            const clampedTop = Math.min(Math.max(6, top), Math.max(6, vh - rect.height - 6));
            this.miniPill.style.left = `${Math.round(clampedLeft)}px`;
            this.miniPill.style.top = `${Math.round(clampedTop)}px`;
            this.miniPill.style.right = 'auto';
            this.miniPill.style.bottom = 'auto';
        }, '_pillDragged');
    }

    syncViewport() {
        if (this.closed) return;
        const vv = globalThis.visualViewport;
        const innerH = globalThis.innerHeight || 0;
        if (vv) {
            const effectiveH = innerH > 0 ? Math.min(vv.height, innerH) : vv.height;
            this.dialog.style.setProperty('--srp-vv-height', `${Math.round(effectiveH)}px`);
            this.dialog.style.setProperty('--srp-vv-offset-top', `${Math.round(vv.offsetTop)}px`);
        } else {
            this.dialog.style.removeProperty('--srp-vv-height');
            this.dialog.style.removeProperty('--srp-vv-offset-top');
        }
        if (this.floating && !this.minimized) {
            this.clampFloatingPosition();
        }
    }

    clampFloatingPosition() {
        if (!this.floating || this.minimized || !this.dialog.isConnected) return;
        const vv = globalThis.visualViewport;
        const vw = vv?.width || globalThis.innerWidth || 1024;
        const vh = vv?.height || globalThis.innerHeight || 768;
        const offsetTop = vv?.offsetTop || 0;
        const rect = this.dialog.getBoundingClientRect();
        const width = rect.width || Math.min(680, vw - 16);
        const height = rect.height || Math.min(680, vh - 16);
        const defaultLeft = Math.max(8, vw - width - 18);
        const defaultTop = Math.max(offsetTop + 42, offsetTop + Math.round((vh - height) / 2));
        const rawLeft = this.floatPos?.left ?? defaultLeft;
        const rawTop = this.floatPos?.top ?? defaultTop;
        const left = Math.min(Math.max(6, rawLeft), Math.max(6, vw - width - 6));
        const top = Math.min(Math.max(offsetTop + 6, rawTop), Math.max(offsetTop + 6, offsetTop + vh - height - 6));
        this.floatPos = { left, top };
        this.dialog.style.left = `${Math.round(left)}px`;
        this.dialog.style.top = `${Math.round(top)}px`;
    }

    rescueToastr() {
        // SillyTavern's popup.js `fixToastrForDialogs()` moves global `#toast-container` into open `<dialog>` nodes.
        // Always return it to `document.body` before closing or removing `.srp-dialog`.
        const toast = this.dialog?.querySelector?.('#toast-container');
        if (toast && globalThis.document?.body) {
            globalThis.document.body.append(toast);
        }
    }

    setMinimized(minimized) {
        if (!this.floating) return;
        this.minimized = Boolean(minimized);
        this.dialog.classList.toggle('srp-minimized', this.minimized);
        this.miniPill.hidden = !this.minimized;
        if (!this.minimized) {
            this.clampFloatingPosition();
            this.tabs[this.tab]?.focus({ preventScroll: true });
        } else {
            this.miniPill.focus({ preventScroll: true });
        }
    }

    setFloating(floating, persist = false) {
        const nextFloating = Boolean(floating);
        this.floating = nextFloating;
        if (!nextFloating) {
            this.minimized = false;
            this.miniPill.hidden = true;
            this.dialog.classList.remove('srp-minimized');
        }
        this.modeBtn.textContent = nextFloating ? '🗖 模态窗口' : '📌 悬浮小窗';
        this.minimizeBtn.hidden = !nextFloating;
        if (persist) this.adapter.savePrefs({ floating: nextFloating });

        if (!this.dialog.isConnected) return;
        this.rescueToastr();
        if (this.dialog.open) {
            this.ignoreCloseEvents++;
            this.dialog.close();
        }
        if (nextFloating) {
            this.dialog.classList.add('srp-floating');
            this.dialog.show();
            this.clampFloatingPosition();
        } else {
            this.dialog.classList.remove('srp-floating');
            this.dialog.style.removeProperty('left');
            this.dialog.style.removeProperty('top');
            this.dialog.showModal();
        }
    }

    registerEnvironmentListeners() {
        const onResize = () => this.syncViewport();
        globalThis.addEventListener?.('resize', onResize);
        this.cleanups.push(() => globalThis.removeEventListener?.('resize', onResize));

        if (globalThis.visualViewport) {
            globalThis.visualViewport.addEventListener('resize', onResize);
            globalThis.visualViewport.addEventListener('scroll', onResize);
            this.cleanups.push(() => {
                globalThis.visualViewport?.removeEventListener('resize', onResize);
                globalThis.visualViewport?.removeEventListener('scroll', onResize);
            });
        }

        if (typeof globalThis.matchMedia === 'function') {
            const media = globalThis.matchMedia('(max-width: 680px)');
            const onMediaChange = event => {
                if (!event.matches) this.sourcesDetails.open = true;
                else if (this.state.source) this.sourcesDetails.open = false;
            };
            media.addEventListener?.('change', onMediaChange);
            this.cleanups.push(() => media.removeEventListener?.('change', onMediaChange));
        }
    }

    canInsert() {
        return typeof this.onInsert === 'function' || isEditableElement(this.targetEditable);
    }

    syncInsertControls() {
        const available = this.canInsert();
        this.insertBtn.hidden = !available;
        this.insertBtn.textContent = typeof this.onInsert === 'function' ? '插入引用' : '插入光标处';
        this.insertBtn.disabled = !available || !this.template;
        this.basketInsertBtn.hidden = !available;
        this.basketInsertBtn.textContent = typeof this.onInsert === 'function' ? '批量插入' : '批量插入光标';
    }

    async applyOpenOptions(options = {}) {
        if ('onInsert' in options) {
            this.onInsert = typeof options.onInsert === 'function' ? options.onInsert : null;
        }
        if (options.targetEditable && isEditableElement(options.targetEditable)) {
            this.targetEditable = options.targetEditable;
        }
        if (typeof options.floating === 'boolean' && options.floating !== this.floating) {
            this.setFloating(options.floating, false);
        }
        if (this.minimized) this.setMinimized(false);
        this.syncInsertControls();
        if (options.tab && VALID_TABS.includes(options.tab) && options.tab !== this.tab) {
            await this.switchTab(options.tab);
        } else {
            this.dialog.focus?.({ preventScroll: true });
        }
    }

    async open() {
        document.body.append(this.dialog, this.miniPill);
        this.registerEnvironmentListeners();
        this.syncViewport();
        this.setFloating(this.floating, false);
        // Avoid summoning the phone keyboard just by opening the panel.
        this.tabs[this.tab]?.focus({ preventScroll: true });
        this.renderQuickAccess();
        this.syncInsertControls();
        await this.switchTab(this.tab);
    }

    closePanel() {
        if (this.closed) return;
        this.rescueToastr();
        if (this.dialog.open) this.dialog.close();
        else this.dispose();
    }

    dispose() {
        if (this.closed) return;
        this.closed = true;
        ++this.request;
        for (const id of this.timers) clearTimeout(id);
        this.timers.clear();
        while (this.cleanups.length) {
            try { this.cleanups.pop()(); } catch { /* Ignore cleanup errors. */ }
        }
        this.rescueToastr();
        this.miniPill?.remove();
        this.dialog?.remove();
        this.onClose();
    }

    isNarrowViewport() {
        return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(max-width: 680px)').matches;
    }

    tabSourceNoun(tab = this.tab) {
        return {
            characters: '角色',
            worlds: '世界书',
            variables: '变量作用域',
            presets: '预设或 QR 集合',
        }[tab] ?? '来源';
    }

    tabTargetNoun(tab = this.tab) {
        return {
            characters: '字段',
            worlds: '条目',
            variables: '变量',
            presets: '条目',
        }[tab] ?? '目标';
    }

    async switchTab(tab) {
        if (!VALID_TABS.includes(tab)) return;
        this.sourceSearchDebounce?.flush();
        this.targetSearchDebounce?.flush();
        ++this.request;
        this.tab = tab;
        this.workspace.removeAttribute('aria-busy');
        this.adapter.saveTab(tab);
        for (const [id, control] of Object.entries(this.tabs)) {
            control.setAttribute('aria-selected', String(id === tab));
            control.tabIndex = id === tab ? 0 : -1;
        }
        this.workspace.setAttribute('aria-labelledby', `srp-tab-${tab}`);

        const sourceName = cleanLabel(this.state.source?.name, '（无名称）');
        this.sourcesSummary.textContent = this.state.source
            ? `1. ${sourceName}`
            : `1. 选择${this.tabSourceNoun(tab)}`;
        this.sourcesDetails.open = !this.state.source || !this.isNarrowViewport();

        const searchMeta = {
            characters: ['搜索角色', '角色名称、文件名或标签', '搜索字段', '字段名称、路径或内容'],
            worlds: ['搜索世界书', '世界书名称', '搜索条目', '条目标题、关键词或内容'],
            variables: ['搜索作用域', '作用域名称', '搜索变量', '变量名、路径或当前值'],
            presets: ['搜索预设或 QR', '预设名或快速回复集合名', '搜索条目', '提示词名称、标识符或 QR 标签'],
        }[tab];
        this.sourceSearch.text.textContent = searchMeta[0];
        this.sourceSearch.control.placeholder = searchMeta[1];
        this.sourceSearch.control.value = this.state.sourceQuery;
        this.targetSearch.text.textContent = searchMeta[2];
        this.targetSearch.control.placeholder = searchMeta[3];
        this.targetSearch.control.value = this.state.targetQuery;
        this.targetTitle.textContent = `2. 选择${this.tabTargetNoun(tab)}`;
        this.customVarBar.hidden = tab !== 'variables';
        this.refresh.disabled = false;

        this.renderQuickAccess();
        this.renderSources();
        this.renderTargets();
        this.renderPreview();

        if (!this.state.sources || this.state.dirty) {
            const wasDirty = this.state.dirty;
            this.state.dirty = false;
            const prevSource = this.state.source;
            const prevSelection = this.state.selection;
            const ok = await this.loadSources();
            if (ok && !this.closed && this.tab === tab) {
                if (prevSource) {
                    const matched = this.state.sources?.find(item => item.id === prevSource.id);
                    if (matched && (wasDirty || !this.state.loaded)) {
                        await this.chooseSource(matched, { preserveUi: true, prevSelection });
                        return;
                    }
                } else if (tab === 'variables' && this.state.sources?.length) {
                    await this.chooseSource(this.state.sources[0]);
                    return;
                } else if (tab === 'presets' && this.state.sources?.length === 1) {
                    await this.chooseSource(this.state.sources[0]);
                    return;
                }
            }
        }
        if (!this.closed && this.tab === tab && this.state.source && !this.state.loaded) {
            await this.chooseSource(this.state.source);
        }
    }

    async loadSources() {
        const token = ++this.request;
        const state = this.state;
        this.sourcesList.replaceChildren(element('p', 'srp-empty', '正在读取列表…'));
        this.refresh.disabled = true;
        try {
            const sources = await this.adapter.sources(this.tab);
            if (token !== this.request || this.closed) return false;
            state.sources = sources;
            this.renderSources();
            return true;
        } catch (error) {
            if (token !== this.request || this.closed) return false;
            this.sourcesList.replaceChildren(element('p', 'srp-error', error.message || '列表读取失败，请重试。'));
            this.status.textContent = '读取失败，可点击刷新列表重试';
            return false;
        } finally {
            if (token === this.request && !this.closed) this.refresh.disabled = false;
        }
    }

    async reload() {
        this.sourceSearchDebounce?.flush();
        this.targetSearchDebounce?.flush();
        const tab = this.tab;
        const prevState = this.state;
        const sourceId = prevState.source?.id;
        const preserved = {
            sourceQuery: prevState.sourceQuery,
            targetQuery: prevState.targetQuery,
            expanded: new Set(prevState.expanded),
            allOpen: prevState.allOpen,
            selection: prevState.selection,
        };
        this.refresh.disabled = true;
        try {
            await this.adapter.refreshSources(tab);
        } catch { /* Allow local source reload to proceed and report any actual read failure. */ }

        if (this.tab !== tab || this.closed) return;
        this.states[tab] = makeState();
        this.state.sourceQuery = preserved.sourceQuery;
        this.state.targetQuery = preserved.targetQuery;
        this.state.expanded = preserved.expanded;
        this.state.allOpen = preserved.allOpen;
        this.targetSearch.control.value = preserved.targetQuery;
        this.sourcesSummary.textContent = `1. 选择${this.tabSourceNoun(tab)}`;
        this.renderTargets();
        this.renderPreview();

        if (!await this.loadSources()) return;
        if (this.tab !== tab || this.closed) return;
        const matched = sourceId ? this.state.sources?.find(item => item.id === sourceId) : null;
        if (matched) {
            await this.chooseSource(matched, {
                force: true,
                preserveUi: true,
                prevSelection: preserved.selection,
            });
        }
    }

    async hotSync(kind, worldName = '') {
        if (this.closed) return;
        if (kind === 'worlds') {
            this.states.worlds.dirty = true;
            this.states.variables.dirty = true;
            if (this.tab !== 'worlds' && this.tab !== 'variables') return;
        } else if (kind === 'characters') {
            this.states.characters.dirty = true;
            if (this.tab !== 'characters') return;
        } else if (kind === 'presets') {
            this.states.presets.dirty = true;
            if (this.tab !== 'presets') return;
        } else if (kind === 'context') {
            for (const s of Object.values(this.states)) s.dirty = true;
        }

        const tab = this.tab;
        const state = this.state;
        state.dirty = false;
        const prevSource = state.source;
        const prevSelection = state.selection;
        const pickerScroll = this.pickerEl.scrollTop;
        const listScroll = this.targetList.scrollTop;

        const ok = await this.loadSources();
        if (!ok || this.closed || this.tab !== tab || !prevSource) return;
        const matched = state.sources?.find(item => item.id === prevSource.id);
        if (!matched) {
            state.source = null;
            state.selection = null;
            this.renderTargets();
            this.renderPreview();
            return;
        }
        if (kind === 'worlds' && worldName && tab === 'worlds' && matched.name !== worldName) {
            state.source = matched;
            this.renderSources();
            return;
        }
        await this.chooseSource(matched, { preserveUi: true, prevSelection, keepDrawerState: true });
        this.pickerEl.scrollTop = pickerScroll;
        this.targetList.scrollTop = listScroll;
    }

    renderQuickAccess() {
        const pinned = this.adapter.pinned();
        const recent = this.adapter.recent().filter(r => !pinned.some(p => p.template === r.template));
        if (!pinned.length && !recent.length) {
            this.quickDetails.hidden = true;
            this.quickBody.replaceChildren();
            return;
        }
        this.quickDetails.hidden = false;
        this.quickSummary.textContent = `⭐ 收藏与最近（收藏 ${pinned.length} · 最近 ${recent.length}）`;
        const frag = document.createDocumentFragment();

        for (let i = 0; i < pinned.length; i++) {
            const item = pinned[i];
            const row = element('div', 'srp-quick-row');
            const pick = button(`★ ${item.label || item.template}`, 'srp-quick-item');
            pick.dataset.quickKind = 'pinned';
            pick.dataset.quickIdx = String(i);
            pick.title = item.template;
            const unpin = button('取消收藏', 'srp-button srp-icon-btn');
            unpin.dataset.unpinIdx = String(i);
            row.append(pick, unpin);
            frag.append(row);
        }
        for (let i = 0; i < recent.length; i++) {
            const item = recent[i];
            const row = element('div', 'srp-quick-row');
            const pick = button(`🕘 ${item.label || item.template}`, 'srp-quick-item');
            pick.dataset.quickKind = 'recent';
            pick.dataset.quickIdx = String(i);
            pick.title = item.template;
            const pin = button('☆', 'srp-button srp-icon-btn');
            pin.title = '加入收藏置顶';
            pin.dataset.pinRecentIdx = String(i);
            row.append(pick, pin);
            frag.append(row);
        }
        if (recent.length) {
            const clearBtn = button('清空最近记录', 'srp-button srp-icon-btn');
            clearBtn.dataset.clearRecent = 'true';
            frag.append(clearBtn);
        }
        this.quickBody.replaceChildren(frag);
    }

    handleQuickClick(event) {
        const pinned = this.adapter.pinned();
        const recent = this.adapter.recent().filter(r => !pinned.some(p => p.template === r.template));

        if (event.target.closest('[data-clear-recent]')) {
            this.adapter.clearRecent();
            this.renderQuickAccess();
            return;
        }
        const unpinBtn = event.target.closest('[data-unpin-idx]');
        if (unpinBtn) {
            const record = pinned[Number(unpinBtn.dataset.unpinIdx)];
            if (record) this.adapter.togglePin(record);
            this.renderQuickAccess();
            this.syncPinButton();
            return;
        }
        const pinRecentBtn = event.target.closest('[data-pin-recent-idx]');
        if (pinRecentBtn) {
            const record = recent[Number(pinRecentBtn.dataset.pinRecentIdx)];
            if (record) this.adapter.togglePin(record);
            this.renderQuickAccess();
            this.syncPinButton();
            return;
        }
        const pickBtn = event.target.closest('[data-quick-kind]');
        if (!pickBtn) return;
        const list = pickBtn.dataset.quickKind === 'pinned' ? pinned : recent;
        const record = list[Number(pickBtn.dataset.quickIdx)];
        if (!record) return;
        this.state.selection = null;
        this.template = record.template;
        this.selectedLabel.textContent = record.label || '快捷引用';
        this.warning.hidden = true;
        this.sourcePreview.textContent = '（来自收藏／最近复制记录）';
        this.expandSourceBtn.hidden = true;
        this.capsules.replaceChildren();
        this.templateControl.value = this.template;
        this.copy.disabled = !this.template;
        this.manual.disabled = !this.template;
        this.stageCurrentBtn.disabled = !this.template;
        this.syncPinButton();
        this.syncStageButtons();
        this.syncInsertControls();
        this.status.textContent = '已载入快捷引用，可直接复制或插入';
    }

    buildSourceRow(source, index) {
        const row = button('', 'srp-source srp-row');
        row.dataset.sourceIdx = String(index);
        row.setAttribute('aria-pressed', String(this.state.source?.id === source.id));
        row.title = source.detail || source.name;
        if (this.tab === 'characters') {
            const avatar = this.adapter.thumbnail(source);
            if (avatar) {
                const image = element('img', 'srp-avatar');
                image.src = avatar;
                image.alt = '';
                image.loading = 'lazy';
                image.addEventListener('error', () => image.remove(), { once: true });
                row.append(image);
            }
        }
        const text = element('span', 'srp-row-text');
        const head = element('span', 'srp-row-head');
        head.append(element('strong', '', cleanLabel(source.name, '（无名称）')));
        if (source.contextBadges?.length) {
            const badges = element('span', 'srp-badges');
            for (const badge of source.contextBadges) {
                badges.append(element('span', 'srp-badge', badge));
            }
            head.append(badges);
        }
        text.append(head, element('small', 'srp-muted', source.detail));
        row.append(text);
        return row;
    }

    renderSources() {
        const state = this.state;
        this.sourcesList.replaceChildren();
        this.filteredSources = [];
        this.renderedSourceCount = 0;
        if (!state.sources) return;

        const words = prepareSearchWords(state.sourceQuery);
        const matched = state.sources.filter(source => source._searchText !== undefined
            ? matchesPrecomputed(words, source._searchText)
            : matchesSearch(words, source.name, source.detail, source.search));

        if (!matched.length) {
            this.sourcesList.append(element('p', 'srp-empty', state.sources.length ? '没有匹配的结果。' : '尚无可引用的内容。'));
            return;
        }

        // Pin active session-associated items into the collapsible top section without duplicating DOM nodes.
        const hasQuery = Boolean(words);
        const contextItems = !hasQuery ? matched.filter(item => item.contextBadges?.length) : [];
        const regularItems = !hasQuery ? matched.filter(item => !item.contextBadges?.length) : matched;
        this.filteredSources = [...contextItems, ...regularItems];

        const initialCount = Math.min(this.filteredSources.length, state.sourceLimit);
        const frag = document.createDocumentFragment();
        let idx = 0;

        if (contextItems.length) {
            const group = element('details', 'srp-context-group');
            group.open = true;
            group.append(element('summary', '', `⚡ 当前会话关联（${contextItems.length}）`));
            const contextLimit = Math.min(contextItems.length, initialCount);
            for (; idx < contextLimit; idx++) {
                group.append(this.buildSourceRow(this.filteredSources[idx], idx));
            }
            frag.append(group);
        }

        for (; idx < initialCount; idx++) {
            frag.append(this.buildSourceRow(this.filteredSources[idx], idx));
        }
        this.renderedSourceCount = initialCount;

        if (this.filteredSources.length > this.renderedSourceCount) {
            const more = button(`显示更多（还有 ${this.filteredSources.length - this.renderedSourceCount} 项）`);
            more.dataset.more = 'sources';
            frag.append(more);
        }
        this.sourcesList.append(frag);
    }

    handleSourcesClick(event) {
        const moreBtn = event.target.closest('[data-more="sources"]');
        if (moreBtn) {
            const state = this.state;
            state.sourceLimit += 60;
            const prevCount = this.renderedSourceCount;
            const nextCount = Math.min(this.filteredSources.length, state.sourceLimit);
            const frag = document.createDocumentFragment();
            let firstNew = null;
            for (let i = prevCount; i < nextCount; i++) {
                const row = this.buildSourceRow(this.filteredSources[i], i);
                if (!firstNew) firstNew = row;
                frag.append(row);
            }
            this.renderedSourceCount = nextCount;
            this.sourcesList.insertBefore(frag, moreBtn);
            if (this.filteredSources.length > this.renderedSourceCount) {
                moreBtn.textContent = `显示更多（还有 ${this.filteredSources.length - this.renderedSourceCount} 项）`;
            } else {
                moreBtn.remove();
            }
            firstNew?.focus({ preventScroll: true });
            return;
        }

        const row = event.target.closest('[data-source-idx]');
        if (!row) return;
        const source = this.filteredSources[Number(row.dataset.sourceIdx)];
        if (source) this.chooseSource(source);
    }

    restoreSelection(prevSelection) {
        if (!prevSelection) return null;
        const state = this.state;
        if (this.tab === 'characters') {
            if (!Array.isArray(prevSelection.path) || !state.data) return null;
            const value = prevSelection.path.length ? getAtPath(state.data, prevSelection.path) : state.data;
            if (value === undefined && prevSelection.path.length) return null;
            return { path: prevSelection.path, value, label: prevSelection.label };
        }
        if (this.tab === 'worlds') {
            const prevEntry = prevSelection.entry;
            if (!prevEntry) return null;
            const match = state.entries.find(item => item.uid === prevEntry.uid && item.comment === prevEntry.comment)
                ?? state.entries.find(item => item.uid !== undefined && item.uid === prevEntry.uid)
                ?? state.entries.find(item => item.comment && item.comment === prevEntry.comment);
            return match ? { entry: match } : null;
        }
        if (this.tab === 'variables') {
            if (prevSelection.customPath) return prevSelection;
            if (!Array.isArray(prevSelection.path) || !state.data) return null;
            const value = prevSelection.path.length ? getAtPath(state.data, prevSelection.path) : state.data;
            if (value === undefined && prevSelection.path.length) return null;
            return { path: prevSelection.path, value, label: prevSelection.label };
        }
        if (this.tab === 'presets') {
            const prevItem = prevSelection.item;
            if (!prevItem) return null;
            const match = state.items.find(item => item._selectionKey === prevItem._selectionKey)
                ?? state.items.find(item => (item.name && item.name === prevItem.name) || (item.label && item.label === prevItem.label));
            return match ? { item: match } : null;
        }
        return null;
    }

    async chooseSource(source, { force = false, preserveUi = false, prevSelection = null, keepDrawerState = false } = {}) {
        const token = ++this.request;
        const state = this.state;
        state.source = source;
        state.data = null;
        state.entries = [];
        state.items = [];
        state.books = [];
        state.selection = null;
        state.loaded = false;
        if (!preserveUi) {
            this.targetSearchDebounce?.cancel();
            state.targetQuery = '';
            state.expanded.clear();
            state.allOpen = false;
            state.targetLimit = 100;
            this.targetSearch.control.value = '';
            if (this.tab === 'characters') this.prefs.lazyOverride = null;
        }
        if (this.tab === 'variables' && source.scope) {
            this.prefs.varScope = source.scope;
        }
        this.sourcesSummary.textContent = `1. ${cleanLabel(source.name, '（无名称）')}`;
        for (const node of this.sourcesList.querySelectorAll('[data-source-idx]')) {
            const item = this.filteredSources[Number(node.dataset.sourceIdx)];
            node.setAttribute('aria-pressed', String(item?.id === source.id));
        }
        this.renderPreview();
        this.targetList.replaceChildren(element('p', 'srp-empty', '正在读取内容…'));
        this.refresh.disabled = false;
        this.workspace.setAttribute('aria-busy', 'true');
        try {
            if (this.tab === 'characters') {
                const result = await this.adapter.character(source);
                if (token !== this.request || this.closed) return;
                state.data = result.data;
                state.lazy = result.lazy;
            } else if (this.tab === 'worlds') {
                const entries = await this.adapter.world(source, { force });
                if (token !== this.request || this.closed) return;
                state.entries = entries;
            } else if (this.tab === 'variables') {
                const result = await this.adapter.variables(source);
                if (token !== this.request || this.closed) return;
                state.data = result.data;
                state.books = result.books ?? [];
            } else if (this.tab === 'presets') {
                const items = await this.adapter.presetItems(source);
                if (token !== this.request || this.closed) return;
                state.items = items;
            }
            state.loaded = true;
            if (prevSelection) {
                state.selection = this.restoreSelection(prevSelection);
            }
            if (!keepDrawerState && this.isNarrowViewport() && this.tab !== 'variables') {
                this.sourcesDetails.open = false;
            }
            this.renderTargets();
            if (state.selection) this.renderPreview();
        } catch (error) {
            if (token !== this.request || this.closed) return;
            this.targetList.replaceChildren(element('p', 'srp-error', error.message || '内容读取失败。'));
            this.status.textContent = '读取失败，可刷新列表重试';
        } finally {
            if (token === this.request && !this.closed) this.workspace.removeAttribute('aria-busy');
        }
    }

    selectionKeyFor(selection) {
        if (!selection) return '';
        if (selection.entry) return selection.entry._selectionKey ?? `entry:${selection.entry.uid}`;
        if (selection.item) return selection.item._selectionKey;
        if (selection.customPath) return `custom:${selection.customPath}`;
        if (Array.isArray(selection.path)) return JSON.stringify(selection.path);
        return '';
    }

    basketKeyFor(tab, sourceId, selectionKey) {
        return `${tab}::${sourceId ?? ''}::${selectionKey}`;
    }

    buildTemplateForSelection(selection) {
        const state = this.state;
        const messages = [];
        let template = '';
        let label = '';
        let rawSource = '';

        if (this.tab === 'characters') {
            const { path, value, label: fieldLabel } = selection;
            const name = state.data?.name ?? '';
            const names = (state.sources ?? []).map(source => source.name);
            const dynamicCurrent = this.prefs.charScope === 'current';
            const useLazy = !dynamicCurrent && (this.prefs.lazyOverride ?? state.lazy);
            const displayName = dynamicCurrent ? '当前角色（动态）' : cleanLabel(name, '（无名称）');
            label = `${displayName} / ${fieldLabel}`;
            rawSource = previewText(value);
            template = characterTemplate({
                name,
                path,
                value,
                names,
                lazy: useLazy,
                dynamicCurrent,
                forceRegex: this.prefs.forceRegex,
            });
            if (!dynamicCurrent) messages.push(duplicateWarning(name, names, '角色'));
            if (isContainer(value)) messages.push('对象或数组将输出为 JSON 文本；展开字段可引用其中一项。');
            if (value === '' || value === null) messages.push('这个字段当前为空。');
            if (useLazy) messages.push('已加入完整角色读取步骤，适配角色懒加载。');
        } else if (this.tab === 'worlds') {
            const entry = selection.entry;
            const titles = state.entries.map(item => item.comment ?? '');
            const entryTitle = cleanLabel(entry.comment, '（无标题）');
            const primaryBook = this.prefs.worldScope === 'primary';
            const bookLabel = primaryBook ? '当前角色主世界书' : cleanLabel(state.source?.name, '（无名称）');
            label = `${bookLabel} / ${entryTitle}`;
            rawSource = previewText(entry.content ?? '');
            template = worldTemplate(state.source?.name ?? '', entry.comment ?? '', titles, {
                primaryBook,
                lookup: this.prefs.worldLookup,
                action: this.prefs.worldAction,
                trimNewline: this.prefs.trimNewline,
                forceRegex: this.prefs.forceRegex,
                uid: entry.uid,
            });
            if (this.prefs.worldLookup === 'uid' || (this.prefs.worldAction === 'activewi' && !String(entry.comment ?? '').trim())) {
                messages.push(uidOverlapWarning(entry.uid, state.entries, entry));
            } else {
                messages.push(duplicateWarning(entry.comment, titles, '条目'));
            }
            if (!entry.content) messages.push('这个条目当前没有内容。');
        } else if (this.tab === 'variables') {
            const customPath = selection.customPath ?? '';
            const path = selection.path ?? [];
            const value = selection.value;
            const shownPath = customPath || lodashPath(path) || '整个变量表 (null)';
            label = `变量 / ${shownPath}`;
            rawSource = customPath && value === undefined ? '（自定义变量路径）' : previewText(value);
            template = variableTemplate({
                path,
                customPath,
                value,
                action: this.prefs.varAction,
                scope: this.prefs.varScope,
                trimNewline: this.prefs.trimNewline,
            });
            if (state.source?.id === 'var:initial' && !state.books?.length) {
                messages.push('当前会话未检测到含 [InitialVariables] 的启用世界书条目。');
            }
        } else if (this.tab === 'presets') {
            const item = selection.item;
            if (item.kind === 'qr') {
                label = `QR ${cleanLabel(item.setName, '（无名称）')} / ${cleanLabel(item.label, '（无标签）')}`;
                rawSource = previewText(item.content ?? '');
                template = quickReplyTemplate({
                    setName: item.setName,
                    setNames: item.setNames,
                    label: item.label,
                    labels: item.labels,
                    trimNewline: this.prefs.trimNewline,
                    forceRegex: this.prefs.forceRegex,
                });
                messages.push(duplicateWarning(item.label, item.labels, '快速回复标签'));
                if (!item.content) messages.push('此快速回复条目当前没有正文。');
            } else {
                label = `预设 ${cleanLabel(item.presetName, '（无名称）')} / ${cleanLabel(item.name, '（无标题）')}`;
                rawSource = previewText(item.content ?? '');
                template = presetTemplate({
                    presetName: item.presetName,
                    promptName: item.name,
                    promptNames: item.promptNames,
                    mode: this.prefs.presetMode,
                    trimNewline: this.prefs.trimNewline,
                    forceRegex: this.prefs.forceRegex,
                });
                messages.push(duplicateWarning(item.name, item.promptNames, '预设提示词'));
                if (item.marker && !item.content) {
                    messages.push('此项为预设占位标记（Marker），本身不包含静态提示词文本。');
                } else if (!item.content) {
                    messages.push('此预设条目当前内容为空，getpreset 执行时将输出空字符串。');
                }
                if (!item.isActivePreset && this.prefs.presetMode === 'current') {
                    messages.push('提示：getpreset(条目名) 在运行时读取当前已激活预设中的同名条目；若需跨预设读取此预设原文，可切换为“指定预设静态读取”。');
                }
            }
        }

        if (template.includes('new RegExp(')) {
            messages.push('已按名称精确匹配，避免相似名称或特殊字符影响定位。');
        }
        return { template, label, rawSource, messages: messages.filter(Boolean) };
    }

    targetButton(label, detail, value, selected) {
        const row = button('', 'srp-target srp-row');
        row.setAttribute('aria-pressed', String(Boolean(selected)));
        const text = element('span', 'srp-row-text');
        text.append(element('strong', '', label), element('small', 'srp-muted', detail));
        text.append(element('span', 'srp-snippet', snippetText(value, 100)));
        row.append(text);
        return row;
    }

    createStageButton(selectionKey, targetMeta) {
        const bKey = this.basketKeyFor(this.tab, this.state.source?.id, selectionKey);
        const staged = this.basket.some(item => item.key === bKey);
        const btn = button(staged ? '✓ 已暂存' : '+ 暂存', 'srp-button srp-stage-btn');
        btn.setAttribute('aria-pressed', String(staged));
        btn.dataset.stageKey = selectionKey;
        btn._stageSelection = targetMeta;
        return btn;
    }

    buildWorldTargetRow(entry, index) {
        const keyList = entry._keys ?? [];
        const label = cleanLabel(entry.comment, '（无标题）');
        const detail = `UID ${entry.uid} · ${entry.disable ? '已禁用 · ' : ''}${keyList.join('、')}`;
        const selectionKey = entry._selectionKey ?? `entry:${entry.uid}`;
        const wrapper = element('div', 'srp-target-item');
        const row = this.targetButton(label, detail, entry.content, this.state.selection?.entry === entry);
        row.dataset.selectionKey = selectionKey;
        row.dataset.targetIdx = String(index);
        wrapper.append(row, this.createStageButton(selectionKey, { entry }));
        return wrapper;
    }

    buildPresetTargetRow(item, index) {
        const label = item.kind === 'qr'
            ? cleanLabel(item.label, '（无标签）')
            : cleanLabel(item.name, '（无名称）');
        const detail = item.kind === 'qr'
            ? `快速回复${item.disabled ? ' · 已隐藏' : ''}${item.title ? ` · ${item.title}` : ''}`
            : `${item.role} · ${item.marker ? '标记位' : (item.enabled ? '已启用' : '未启用')}${item.identifier ? ` · ${item.identifier}` : ''}`;
        const selectionKey = item._selectionKey;
        const wrapper = element('div', 'srp-target-item');
        const row = this.targetButton(label, detail, item.content, this.state.selection?.item === item);
        row.dataset.selectionKey = selectionKey;
        row.dataset.targetIdx = String(index);
        wrapper.append(row, this.createStageButton(selectionKey, { item }));
        return wrapper;
    }

    buildFieldRowNode(field, tree = false) {
        const id = JSON.stringify(field.path);
        const group = element('div', 'srp-field-row');
        if (tree) group.style.setProperty('--srp-depth', String(Math.min(field.path.length, 5)));
        if (tree && field.container && field.path.length) {
            const expanded = this.state.expanded.has(id);
            const toggle = button(expanded ? '−' : '+', 'srp-button srp-expand');
            toggle.dataset.expandId = id;
            toggle.dataset.expandLabel = field.label;
            toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${field.label}`);
            toggle.setAttribute('aria-expanded', String(expanded));
            group.append(toggle);
        }
        const rootLabel = this.tab === 'variables' ? '整个变量表' : '整个角色数据';
        const shownPath = this.tab === 'variables'
            ? (lodashPath(field.path) || rootLabel)
            : displayPath(field.path, rootLabel);
        const selected = !this.state.selection?.customPath && JSON.stringify(this.state.selection?.path) === id;
        const row = this.targetButton(field.label, `${shownPath} · ${valueType(field.value)}`, field.value, selected);
        row.dataset.selectionKey = id;
        const selectionPayload = { path: field.path, value: field.value, label: field.label };
        row._fieldSelection = selectionPayload;
        row.dataset.fieldSelect = 'true';
        group.append(row, this.createStageButton(id, selectionPayload));
        return group;
    }

    renderTargets() {
        this.targetList.replaceChildren();
        this.filteredTargets = [];
        this.renderedTargetCount = 0;
        this.filteredTreeRows = [];
        this.renderedTreeCount = 0;
        this.treeContainer = null;

        const state = this.state;
        if (!state.source) {
            this.targetList.append(element('p', 'srp-empty', `先选择一个${this.tabSourceNoun()}。`));
            return;
        }

        const words = prepareSearchWords(state.targetQuery);
        const hasQuery = Boolean(words);

        if (this.tab === 'worlds') {
            this.filteredTargets = state.entries.filter(entry => entry._searchText !== undefined
                ? matchesPrecomputed(words, entry._searchText)
                : matchesSearch(words, entry.comment, entry.content));
            if (!this.filteredTargets.length) {
                this.targetList.append(element('p', 'srp-empty', '没有匹配的条目。'));
                return;
            }
            const count = Math.min(this.filteredTargets.length, state.targetLimit);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                frag.append(this.buildWorldTargetRow(this.filteredTargets[i], i));
            }
            this.renderedTargetCount = count;
            if (this.filteredTargets.length > count) {
                const more = button(`显示更多（还有 ${this.filteredTargets.length - count} 项）`);
                more.dataset.more = 'targets';
                frag.append(more);
            }
            this.targetList.append(frag);
            return;
        }

        if (this.tab === 'presets') {
            this.filteredTargets = state.items.filter(item => matchesPrecomputed(words, item._searchText));
            if (!this.filteredTargets.length) {
                this.targetList.append(element('p', 'srp-empty', '没有匹配的提示词或快速回复条目。'));
                return;
            }
            const count = Math.min(this.filteredTargets.length, state.targetLimit);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                frag.append(this.buildPresetTargetRow(this.filteredTargets[i], i));
            }
            this.renderedTargetCount = count;
            if (this.filteredTargets.length > count) {
                const more = button(`显示更多（还有 ${this.filteredTargets.length - count} 项）`);
                more.dataset.more = 'targets';
                frag.append(more);
            }
            this.targetList.append(frag);
            return;
        }

        if (this.tab === 'variables') {
            if (!state.data) return;
            const keysCount = Object.keys(state.data).length;
            if (!keysCount && !hasQuery) {
                this.targetList.append(element('p', 'srp-empty', '当前作用域暂无已存变量，可在上方手输任意变量路径（如 stat.hp）直接生成引用。'));
                return;
            }
            this.filteredTreeRows = fieldRows(state.data, {
                expanded: state.expanded,
                query: state.targetQuery,
                includeRoot: true,
                rootLabel: '整个变量表',
            });
            if (!this.filteredTreeRows.length) {
                this.targetList.append(element('p', 'srp-empty', '没有匹配的变量，可在上方手输自定义路径。'));
                return;
            }
            const count = Math.min(this.filteredTreeRows.length, state.targetLimit);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                frag.append(this.buildFieldRowNode(this.filteredTreeRows[i], true));
            }
            this.renderedTreeCount = count;
            if (this.filteredTreeRows.length > count) {
                const more = button(`显示更多字段（还有 ${this.filteredTreeRows.length - count} 项）`);
                more.dataset.more = 'vars';
                frag.append(more);
            }
            this.targetList.append(frag);
            return;
        }

        if (!state.data) return;
        const commonFrag = document.createDocumentFragment();
        const common = COMMON_FIELDS.filter(([label, path]) => {
            const val = getAtPath(state.data, path);
            if (val === undefined) return false;
            if (!hasQuery) return true;
            return matchesSearch(words, label, displayPath(path), isContainer(val) ? snippetText(val) : val);
        });
        if (common.length) commonFrag.append(element('p', 'srp-group-label', '常用字段'));
        for (const [label, path] of common) {
            commonFrag.append(this.buildFieldRowNode({ path, label, value: getAtPath(state.data, path) }, false));
        }

        const all = element('details', 'srp-all-fields');
        all.open = state.allOpen || hasQuery;
        all.append(element('summary', 'srp-section-label', '全部字段（含嵌套字段）'));
        const tree = element('div', 'srp-field-tree');
        this.treeContainer = tree;

        const renderTree = () => {
            tree.replaceChildren();
            this.filteredTreeRows = fieldRows(state.data, { expanded: state.expanded, query: state.targetQuery });
            if (!this.filteredTreeRows.length) {
                tree.append(element('p', 'srp-empty', '没有匹配的字段。'));
                this.renderedTreeCount = 0;
                return;
            }
            const count = Math.min(this.filteredTreeRows.length, state.targetLimit);
            const treeFrag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                treeFrag.append(this.buildFieldRowNode(this.filteredTreeRows[i], true));
            }
            this.renderedTreeCount = count;
            if (this.filteredTreeRows.length > count) {
                const more = button(`显示更多字段（还有 ${this.filteredTreeRows.length - count} 项）`);
                more.dataset.more = 'tree';
                treeFrag.append(more);
            }
            tree.append(treeFrag);
        };

        all.addEventListener('toggle', () => {
            state.allOpen = all.open;
            if (all.open && !tree.childElementCount) renderTree();
        });
        if (all.open) renderTree();
        all.append(tree);
        commonFrag.append(all);
        this.targetList.append(commonFrag);
    }

    handleTargetsClick(event) {
        const state = this.state;

        const moreTargetsBtn = event.target.closest('[data-more="targets"]');
        if (moreTargetsBtn) {
            state.targetLimit += 100;
            const prevCount = this.renderedTargetCount;
            const nextCount = Math.min(this.filteredTargets.length, state.targetLimit);
            const frag = document.createDocumentFragment();
            let firstNew = null;
            for (let i = prevCount; i < nextCount; i++) {
                const wrapper = this.tab === 'worlds'
                    ? this.buildWorldTargetRow(this.filteredTargets[i], i)
                    : this.buildPresetTargetRow(this.filteredTargets[i], i);
                if (!firstNew) firstNew = wrapper.querySelector('.srp-target');
                frag.append(wrapper);
            }
            this.renderedTargetCount = nextCount;
            this.targetList.insertBefore(frag, moreTargetsBtn);
            if (this.filteredTargets.length > this.renderedTargetCount) {
                moreTargetsBtn.textContent = `显示更多（还有 ${this.filteredTargets.length - this.renderedTargetCount} 项）`;
            } else {
                moreTargetsBtn.remove();
            }
            firstNew?.focus({ preventScroll: true });
            return;
        }

        const moreTreeBtn = event.target.closest('[data-more="tree"], [data-more="vars"]');
        if (moreTreeBtn) {
            state.targetLimit += 100;
            const container = moreTreeBtn.dataset.more === 'tree' ? this.treeContainer : this.targetList;
            if (!container) return;
            const prevCount = this.renderedTreeCount;
            const nextCount = Math.min(this.filteredTreeRows.length, state.targetLimit);
            const frag = document.createDocumentFragment();
            let firstNew = null;
            for (let i = prevCount; i < nextCount; i++) {
                const group = this.buildFieldRowNode(this.filteredTreeRows[i], true);
                if (!firstNew) firstNew = group.querySelector('.srp-target');
                frag.append(group);
            }
            this.renderedTreeCount = nextCount;
            container.insertBefore(frag, moreTreeBtn);
            if (this.filteredTreeRows.length > this.renderedTreeCount) {
                moreTreeBtn.textContent = `显示更多字段（还有 ${this.filteredTreeRows.length - this.renderedTreeCount} 项）`;
            } else {
                moreTreeBtn.remove();
            }
            firstNew?.focus({ preventScroll: true });
            return;
        }

        const expandBtn = event.target.closest('[data-expand-id]');
        if (expandBtn) {
            const id = expandBtn.dataset.expandId;
            const label = expandBtn.dataset.expandLabel;
            const pickerScroll = this.pickerEl.scrollTop;
            const listScroll = this.targetList.scrollTop;
            if (state.expanded.has(id)) state.expanded.delete(id);
            else state.expanded.add(id);
            this.renderTargets();
            this.pickerEl.scrollTop = pickerScroll;
            this.targetList.scrollTop = listScroll;
            const next = [...this.targetList.querySelectorAll('.srp-expand')]
                .find(node => node.dataset.expandId === id || node.getAttribute('aria-label')?.endsWith(` ${label}`));
            next?.focus({ preventScroll: true });
            return;
        }

        const stageBtn = event.target.closest('[data-stage-key]');
        if (stageBtn) {
            const selection = stageBtn._stageSelection;
            if (selection) this.toggleStageSelection(stageBtn.dataset.stageKey, selection);
            return;
        }

        const fieldRow = event.target.closest('[data-field-select]');
        if (fieldRow?._fieldSelection) {
            if (this.tab === 'variables') this.customVarInput.value = '';
            this.select(fieldRow._fieldSelection);
            return;
        }

        const targetRow = event.target.closest('[data-target-idx]');
        if (targetRow) {
            const item = this.filteredTargets[Number(targetRow.dataset.targetIdx)];
            if (!item) return;
            if (this.tab === 'worlds') this.select({ entry: item });
            else if (this.tab === 'presets') this.select({ item });
        }
    }

    select(selection, scrollMobile = true) {
        this.state.selection = selection;
        const key = this.selectionKeyFor(selection);
        for (const row of this.targetList.querySelectorAll('[data-selection-key]')) {
            row.setAttribute('aria-pressed', String(row.dataset.selectionKey === key));
        }
        this.renderPreview();
        if (scrollMobile && this.isNarrowViewport()) {
            this.templateControl.scrollIntoView?.({ block: 'nearest' });
        }
    }

    buildSegmentedGroup(options, activeValue, onSelect) {
        const group = element('div', 'srp-capsule-group');
        for (const [value, label] of options) {
            const btn = button(label, 'srp-capsule');
            btn.setAttribute('aria-pressed', String(value === activeValue));
            btn.addEventListener('click', () => {
                if (value === activeValue) return;
                onSelect(value);
            });
            group.append(btn);
        }
        return group;
    }

    buildCheckCapsule(label, checked, onToggle) {
        const btn = button(`${checked ? '☑' : '☐'} ${label}`, 'srp-capsule-check');
        btn.setAttribute('aria-pressed', String(Boolean(checked)));
        btn.addEventListener('click', () => onToggle(!checked));
        return btn;
    }

    renderCapsules() {
        this.capsules.replaceChildren();
        const state = this.state;
        const updatePref = (patch) => {
            Object.assign(this.prefs, patch);
            const persistable = { ...patch };
            delete persistable.lazyOverride;
            if (Object.keys(persistable).length) this.adapter.savePrefs(persistable);
            this.renderPreview();
        };

        if (this.tab === 'characters') {
            this.capsules.append(
                this.buildSegmentedGroup(
                    [['named', '指定角色'], ['current', '动态当前角色']],
                    this.prefs.charScope,
                    val => updatePref({ charScope: val }),
                ),
            );
            if (this.prefs.charScope === 'named') {
                const effectiveLazy = this.prefs.lazyOverride ?? state.lazy;
                this.capsules.append(
                    this.buildCheckCapsule('兼容懒加载', effectiveLazy, next => updatePref({ lazyOverride: next })),
                    this.buildCheckCapsule('精确正则匹配', this.prefs.forceRegex, next => updatePref({ forceRegex: next })),
                );
            }
            return;
        }

        if (this.tab === 'worlds') {
            this.capsules.append(
                this.buildSegmentedGroup(
                    [['named', '指定书名'], ['primary', '当前角色主书']],
                    this.prefs.worldScope,
                    val => updatePref({ worldScope: val }),
                ),
                this.buildSegmentedGroup(
                    [['title', '按标题'], ['uid', '按 UID']],
                    this.prefs.worldLookup,
                    val => updatePref({ worldLookup: val }),
                ),
                this.buildSegmentedGroup(
                    [['getwi', 'getwi 读取'], ['activewi', 'activewi 激活']],
                    this.prefs.worldAction,
                    val => updatePref({ worldAction: val }),
                ),
                this.buildSegmentedGroup(
                    [[true, '吞换行 -%>'], [false, '保留换行 %>']],
                    this.prefs.trimNewline,
                    val => updatePref({ trimNewline: val }),
                ),
            );
            if (this.prefs.worldLookup === 'title') {
                this.capsules.append(
                    this.buildCheckCapsule('精确正则匹配', this.prefs.forceRegex, next => updatePref({ forceRegex: next })),
                );
            }
            return;
        }

        if (this.tab === 'variables') {
            this.capsules.append(
                this.buildSegmentedGroup(
                    [['getvar', 'getvar'], ['setvar', 'setvar'], ['incvar', 'incvar'], ['if', 'if (getvar)']],
                    this.prefs.varAction,
                    val => updatePref({ varAction: val }),
                ),
                this.buildSegmentedGroup(
                    [['default', '默认作用域'], ['local', 'local'], ['global', 'global'], ['message', 'message']],
                    this.prefs.varScope,
                    val => updatePref({ varScope: val }),
                ),
                this.buildSegmentedGroup(
                    [[true, '吞换行 -%>'], [false, '保留换行 %>']],
                    this.prefs.trimNewline,
                    val => updatePref({ trimNewline: val }),
                ),
            );
            return;
        }

        if (this.tab === 'presets') {
            const isQr = state.selection?.item?.kind === 'qr' || state.source?.kind === 'qr';
            if (!isQr) {
                this.capsules.append(
                    this.buildSegmentedGroup(
                        [['current', '当前预设 getpreset'], ['static', '指定预设静态读取']],
                        this.prefs.presetMode,
                        val => updatePref({ presetMode: val }),
                    ),
                );
            }
            this.capsules.append(
                this.buildSegmentedGroup(
                    [[true, '吞换行 -%>'], [false, '保留换行 %>']],
                    this.prefs.trimNewline,
                    val => updatePref({ trimNewline: val }),
                ),
                this.buildCheckCapsule('精确正则匹配', this.prefs.forceRegex, next => updatePref({ forceRegex: next })),
            );
        }
    }

    setSourcePreviewText(rawText) {
        this.fullSourceText = String(rawText ?? '');
        this.sourceExpanded = false;
        if (this.fullSourceText.length > SOURCE_PREVIEW_LIMIT) {
            this.sourcePreview.textContent = `${this.fullSourceText.slice(0, SOURCE_PREVIEW_LIMIT)}\n…`;
            this.expandSourceBtn.textContent = `展开完整原文（共 ${this.fullSourceText.length} 字符）`;
            this.expandSourceBtn.hidden = false;
        } else {
            this.sourcePreview.textContent = this.fullSourceText;
            this.expandSourceBtn.hidden = true;
        }
    }

    syncPinButton() {
        const pinned = this.template && this.adapter.isPinned(this.template);
        this.pinBtn.disabled = !this.template;
        this.pinBtn.textContent = pinned ? '★ 已收藏' : '☆ 收藏';
        this.pinBtn.setAttribute('aria-pressed', String(Boolean(pinned)));
    }

    syncStageButtons() {
        const stagedTemplates = new Set(this.basket.map(item => item.template));
        const currentStaged = Boolean(this.template && stagedTemplates.has(this.template));
        this.stageCurrentBtn.disabled = !this.template;
        this.stageCurrentBtn.textContent = currentStaged ? '✓ 已暂存' : '+ 暂存';
        this.stageCurrentBtn.setAttribute('aria-pressed', String(currentStaged));

        const stagedKeys = new Set(this.basket.map(item => item.key));
        for (const btn of this.targetList.querySelectorAll('[data-stage-key]')) {
            const bKey = this.basketKeyFor(this.tab, this.state.source?.id, btn.dataset.stageKey);
            const active = stagedKeys.has(bKey);
            btn.textContent = active ? '✓ 已暂存' : '+ 暂存';
            btn.setAttribute('aria-pressed', String(active));
        }
    }

    renderPreview() {
        const state = this.state;
        this.template = '';
        this.warning.hidden = true;
        this.warning.textContent = '';
        this.status.textContent = '请选择引用目标';
        this.selectedLabel.textContent = '尚未选择引用目标';
        this.setSourcePreviewText('选择目标后在这里查看原始内容。');
        this.renderCapsules();

        let messages = [];
        if (state.selection) {
            try {
                const built = this.buildTemplateForSelection(state.selection);
                this.template = built.template;
                this.selectedLabel.textContent = built.label;
                this.setSourcePreviewText(built.rawSource);
                messages = built.messages;
                this.status.textContent = '模板已就绪';
            } catch (error) {
                if (this.tab === 'worlds' && state.selection.entry) {
                    const entry = state.selection.entry;
                    this.selectedLabel.textContent = `${cleanLabel(state.source?.name, '（无名称）')} / ${cleanLabel(entry.comment, '（无标题）')}`;
                    this.setSourcePreviewText(previewText(entry.content ?? ''));
                } else if (this.tab === 'presets' && state.selection.item) {
                    const item = state.selection.item;
                    this.selectedLabel.textContent = `${cleanLabel(state.source?.name, '（无名称）')} / ${cleanLabel(item.name || item.label, '（无标题）')}`;
                    this.setSourcePreviewText(previewText(item.content ?? ''));
                }
                messages.push(error.message);
                this.status.textContent = '此目标暂时无法生成名称引用';
            }
        }

        const warning = messages.filter(Boolean).join('\n');
        this.warning.textContent = warning;
        this.warning.hidden = !warning;
        this.templateControl.value = this.template;
        this.copy.disabled = !this.template;
        this.manual.disabled = !this.template;
        this.syncPinButton();
        this.syncStageButtons();
        this.syncInsertControls();
    }

    toggleCurrentPin() {
        if (!this.template) return;
        const pinned = this.adapter.togglePin({
            label: this.selectedLabel.textContent,
            template: this.template,
            tab: this.tab,
        });
        this.renderQuickAccess();
        this.syncPinButton();
        this.status.textContent = pinned ? '已加入收藏置顶' : '已取消收藏';
    }

    toggleStageSelection(selectionKey, selection) {
        const bKey = this.basketKeyFor(this.tab, this.state.source?.id, selectionKey);
        const existingIdx = this.basket.findIndex(item => item.key === bKey);
        if (existingIdx >= 0) {
            this.basket.splice(existingIdx, 1);
            this.renderBasket();
            this.syncStageButtons();
            this.status.textContent = `已移出暂存篮（当前 ${this.basket.length} 项）`;
            return;
        }
        try {
            const built = this.buildTemplateForSelection(selection);
            this.basket.push({ key: bKey, label: built.label, template: built.template });
            this.renderBasket();
            this.syncStageButtons();
            this.status.textContent = `已加入暂存篮（共 ${this.basket.length} 项）`;
        } catch (error) {
            this.select(selection);
            this.status.textContent = error.message || '此目标无法加入暂存篮';
        }
    }

    toggleStageCurrent() {
        if (!this.template) return;
        const existingIdx = this.basket.findIndex(item => item.template === this.template);
        if (existingIdx >= 0) {
            this.basket.splice(existingIdx, 1);
            this.renderBasket();
            this.syncStageButtons();
            this.status.textContent = `已移出暂存篮（当前 ${this.basket.length} 项）`;
            return;
        }
        const selKey = this.selectionKeyFor(this.state.selection) || `manual:${this.template}`;
        const bKey = this.basketKeyFor(this.tab, this.state.source?.id, selKey);
        this.basket.push({
            key: bKey,
            label: this.selectedLabel.textContent,
            template: this.template,
        });
        this.renderBasket();
        this.syncStageButtons();
        this.status.textContent = `已加入暂存篮（共 ${this.basket.length} 项）`;
    }

    renderBasket() {
        if (!this.basket.length) {
            this.basketSection.hidden = true;
            this.basketList.replaceChildren();
            return;
        }
        this.basketSection.hidden = false;
        this.basketTitle.textContent = `🧺 暂存篮（${this.basket.length} 项）`;
        this.basketToggleBtn.textContent = this.basketExpanded ? '收起明细' : '查看明细';
        this.basketList.hidden = !this.basketExpanded;
        this.syncInsertControls();
        if (!this.basketExpanded) return;

        const frag = document.createDocumentFragment();
        this.basket.forEach((item, idx) => {
            const row = element('div', 'srp-basket-item');
            const label = element('span', '', `${idx + 1}. ${item.label}`);
            label.title = item.template;
            const rm = button('×', 'srp-button srp-icon-btn');
            rm.dataset.basketRemove = String(idx);
            rm.setAttribute('aria-label', `移除暂存项 ${item.label}`);
            row.append(label, rm);
            frag.append(row);
        });
        this.basketList.replaceChildren(frag);
    }

    selectTemplate() {
        this.templateControl.focus({ preventScroll: true });
        this.templateControl.select();
        this.templateControl.setSelectionRange(0, this.template.length);
        this.templateControl.scrollIntoView?.({ block: 'nearest' });
        this.status.textContent = '已选中模板，可使用系统复制菜单';
    }

    async copyTemplate() {
        const text = this.template;
        if (!text || this.copying) return;
        // Do NOT disable `this.copy` prior to `copyText`: disabling blurs the button to `document.body`
        // and breaks focus restoration when `execCommand('copy')` runs under LAN HTTP.
        this.copying = true;
        try {
            const success = await copyText(text, this.templateControl);
            if (this.closed || this.template !== text) return;
            if (success) {
                this.adapter.addRecent({
                    label: this.selectedLabel.textContent,
                    template: text,
                    tab: this.tab,
                });
                this.renderQuickAccess();
            }
            this.status.textContent = success ? '已复制，可继续选择其他引用' : '自动复制失败，模板已选中，请使用系统复制菜单';
        } finally {
            this.copying = false;
        }
    }

    async copyBasket() {
        if (!this.basket.length || this.copying) return;
        const combined = this.basket.map(item => item.template).join('\n');
        const prevValue = this.templateControl.value;
        this.templateControl.value = combined;
        this.copying = true;
        try {
            const success = await copyText(combined, this.templateControl);
            if (this.closed) return;
            if (success) {
                this.templateControl.value = prevValue;
                this.adapter.addRecent({
                    label: `批量引用（${this.basket.length} 项）`,
                    template: combined,
                    tab: this.tab,
                });
                this.renderQuickAccess();
                this.status.textContent = `已批量复制 ${this.basket.length} 条引用`;
            } else {
                this.status.textContent = '自动复制失败，批量模板已填入并选中，请使用系统复制菜单';
            }
        } finally {
            this.copying = false;
        }
    }

    performInsert(text, meta) {
        if (!text) return false;
        if (typeof this.onInsert === 'function') {
            this.onInsert(text, meta);
            return true;
        }
        if (isEditableElement(this.targetEditable)) {
            return insertAtEditable(this.targetEditable, text);
        }
        return false;
    }

    insertTemplate() {
        const text = this.template;
        if (!text) return;
        const ok = this.performInsert(text, {
            mode: 'single',
            tab: this.tab,
            label: this.selectedLabel.textContent,
            source: this.state.source?.name ?? '',
        });
        if (ok) {
            this.adapter.addRecent({
                label: this.selectedLabel.textContent,
                template: text,
                tab: this.tab,
            });
            this.renderQuickAccess();
            this.status.textContent = '已插入引用，可继续选择其他目标';
        } else {
            this.syncInsertControls();
            this.status.textContent = '目标输入框已失效，请复制引用后手动粘贴';
        }
    }

    insertBasket() {
        if (!this.basket.length) return;
        const combined = this.basket.map(item => item.template).join('\n');
        const ok = this.performInsert(combined, {
            mode: 'batch',
            count: this.basket.length,
            tab: this.tab,
            items: this.basket.map(item => ({ label: item.label, template: item.template })),
        });
        if (ok) {
            this.adapter.addRecent({
                label: `批量引用（${this.basket.length} 项）`,
                template: combined,
                tab: this.tab,
            });
            this.renderQuickAccess();
            this.status.textContent = `已批量插入 ${this.basket.length} 条引用`;
        } else {
            this.syncInsertControls();
            this.status.textContent = '目标输入框已失效，请使用批量复制';
        }
    }
}
