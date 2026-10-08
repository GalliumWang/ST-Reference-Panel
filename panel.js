import { COMMON_FIELDS, getAtPath, displayPath, valueType, previewText, isContainer,
    matchesSearch, fieldRows, characterTemplate, worldTemplate, duplicateWarning } from './core.js';
import { copyText } from './clipboard.js';

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

function makeState() {
    return { sources: null, source: null, sourceQuery: '', targetQuery: '', data: null,
        entries: [], lazy: false, selection: null, expanded: new Set(), allOpen: false,
        loaded: false, sourceLimit: 60, targetLimit: 100 };
}

export class ReferencePanel {
    constructor(adapter, onClose = () => {}) {
        this.adapter = adapter;
        this.onClose = onClose;
        this.tab = adapter.lastTab();
        this.states = { characters: makeState(), worlds: makeState() };
        this.request = 0;
        this.template = '';
        this.closed = false;
        this.build();
    }

    get state() { return this.states[this.tab]; }

    build() {
        this.dialog = element('dialog', 'srp-dialog');
        this.dialog.setAttribute('aria-labelledby', 'srp-heading');
        const header = element('header', 'srp-header');
        const heading = element('div');
        const title = element('h2', '', '引用面板');
        title.id = 'srp-heading';
        heading.append(title, element('p', 'srp-muted', '选择角色字段或世界书条目，复制引用模板。'));
        const close = button('×', 'srp-button srp-close');
        close.setAttribute('aria-label', '关闭引用面板');
        close.addEventListener('click', () => this.dialog.close());
        header.append(heading, close);

        const toolbar = element('div', 'srp-toolbar');
        const tabs = element('div', 'srp-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '引用类型');
        this.tabs = {};
        for (const [id, label] of [['characters', '角色卡'], ['worlds', '世界书']]) {
            const tab = button(label, 'srp-button srp-tab');
            tab.id = `srp-tab-${id}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', 'srp-workspace');
            tab.addEventListener('click', () => this.switchTab(id));
            tab.addEventListener('keydown', event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const next = event.key === 'Home' ? 'characters' : event.key === 'End' ? 'worlds'
                        : this.tab === 'characters' ? 'worlds' : 'characters';
                    this.tabs[next].focus();
                    this.switchTab(next);
                }
            });
            this.tabs[id] = tab;
            tabs.append(tab);
        }
        this.refresh = button('刷新列表', 'srp-button srp-refresh');
        this.refresh.addEventListener('click', () => this.reload());
        toolbar.append(tabs, this.refresh);

        this.workspace = element('div', 'srp-workspace');
        this.workspace.id = 'srp-workspace';
        this.workspace.setAttribute('role', 'tabpanel');
        const picker = element('section', 'srp-picker');
        this.sourcesDetails = element('details', 'srp-sources');
        this.sourcesDetails.open = true;
        this.sourcesSummary = element('summary', 'srp-section-label');
        this.sourceSearch = input('搜索角色', '角色名称、文件名或标签');
        this.sourcesList = element('div', 'srp-source-list');
        this.sourcesList.setAttribute('aria-label', '可引用的角色或世界书');
        this.sourceSearch.control.addEventListener('input', () => {
            this.state.sourceQuery = this.sourceSearch.control.value;
            this.state.sourceLimit = 60;
            this.renderSources();
        });
        this.sourcesDetails.append(this.sourcesSummary, this.sourceSearch.wrapper, this.sourcesList);
        const targetHeading = element('div', 'srp-target-heading');
        this.targetTitle = element('h3', 'srp-section-label', '2. 选择字段');
        targetHeading.append(this.targetTitle);
        this.targetSearch = input('搜索字段', '字段名称、路径或内容');
        this.targetSearch.control.addEventListener('input', () => {
            this.state.targetQuery = this.targetSearch.control.value;
            this.state.targetLimit = 100;
            this.renderTargets();
        });
        this.targetList = element('div', 'srp-target-list');
        picker.append(this.sourcesDetails, targetHeading, this.targetSearch.wrapper, this.targetList);

        const preview = element('section', 'srp-preview');
        preview.setAttribute('aria-label', '引用预览');
        preview.append(element('h3', 'srp-section-label', '3. 预览并复制'));
        this.selectedLabel = element('p', 'srp-selected-label', '尚未选择引用目标');
        this.warning = element('div', 'srp-warning');
        this.warning.setAttribute('role', 'status');
        this.warning.hidden = true;
        const sourcePreview = element('details', 'srp-content-details');
        sourcePreview.open = true;
        sourcePreview.append(element('summary', 'srp-label', '源内容'));
        this.sourcePreview = element('pre', 'srp-source-preview', '选择目标后在这里查看原始内容。');
        sourcePreview.append(this.sourcePreview);
        const templateLabel = element('label', 'srp-label', '引用模板');
        templateLabel.htmlFor = 'srp-template';
        this.templateControl = element('textarea', 'srp-template');
        this.templateControl.id = 'srp-template';
        this.templateControl.readOnly = true;
        this.templateControl.spellcheck = false;
        this.templateControl.rows = 4;
        this.templateControl.placeholder = '选择字段或条目后自动生成';
        const hint = element('p', 'srp-muted srp-hint', '源内容保持原文；模板粘贴后由 ST-Prompt-Template 执行。');
        preview.append(this.selectedLabel, this.warning, sourcePreview, templateLabel, this.templateControl, hint);
        this.workspace.append(picker, preview);

        const footer = element('footer', 'srp-footer');
        this.status = element('span', 'srp-status', '请选择引用目标');
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        this.manual = button('选中模板', 'srp-button srp-manual');
        this.manual.disabled = true;
        this.manual.addEventListener('click', () => this.selectTemplate());
        this.copy = button('复制引用', 'srp-button srp-copy');
        this.copy.disabled = true;
        this.copy.addEventListener('click', () => this.copyTemplate());
        footer.append(this.status, this.manual, this.copy);
        this.dialog.append(header, toolbar, this.workspace, footer);
        this.dialog.addEventListener('close', () => this.dispose(), { once: true });
        this.dialog.addEventListener('click', event => {
            if (event.target !== this.dialog) return;
            const rect = this.dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.dialog.close();
        });
    }

    async open() {
        document.body.append(this.dialog);
        this.dialog.showModal();
        // Avoid summoning the phone keyboard just by opening the panel.
        this.tabs[this.tab].focus({ preventScroll: true });
        await this.switchTab(this.tab);
    }

    dispose() {
        if (this.closed) return;
        this.closed = true;
        ++this.request;
        this.dialog.remove();
        this.onClose();
    }

    async switchTab(tab) {
        ++this.request;
        this.tab = tab;
        this.workspace.removeAttribute('aria-busy');
        this.adapter.saveTab(tab);
        for (const [id, control] of Object.entries(this.tabs)) {
            control.setAttribute('aria-selected', String(id === tab));
            control.tabIndex = id === tab ? 0 : -1;
        }
        this.workspace.setAttribute('aria-labelledby', `srp-tab-${tab}`);
        this.sourcesSummary.textContent = this.state.source
            ? `1. ${this.state.source.name}` : `1. 选择${tab === 'characters' ? '角色' : '世界书'}`;
        this.sourcesDetails.open = !this.state.source || !matchMedia('(max-width: 680px)').matches;
        this.sourceSearch.text.textContent = tab === 'characters' ? '搜索角色' : '搜索世界书';
        this.sourceSearch.control.placeholder = tab === 'characters' ? '角色名称、文件名或标签' : '世界书名称';
        this.sourceSearch.control.value = this.state.sourceQuery;
        this.targetSearch.text.textContent = tab === 'characters' ? '搜索字段' : '搜索条目';
        this.targetSearch.control.placeholder = tab === 'characters' ? '字段名称、路径或内容' : '条目标题、关键词或内容';
        this.targetSearch.control.value = this.state.targetQuery;
        this.targetTitle.textContent = tab === 'characters' ? '2. 选择字段' : '2. 选择条目';
        this.refresh.disabled = false;
        this.renderSources();
        this.renderTargets();
        this.renderPreview();
        if (!this.state.sources) await this.loadSources();
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
            if (token !== this.request || this.closed) return;
            this.sourcesList.replaceChildren(element('p', 'srp-error', error.message || '列表读取失败，请重试。'));
            this.status.textContent = '读取失败，可点击刷新列表重试';
        } finally {
            if (token === this.request && !this.closed) this.refresh.disabled = false;
        }
    }

    async reload() {
        const tab = this.tab;
        const sourceId = this.state.source?.id;
        const sourceQuery = this.state.sourceQuery;
        this.states[tab] = makeState();
        this.state.sourceQuery = sourceQuery;
        this.sourcesDetails.open = true;
        this.targetSearch.control.value = '';
        this.sourcesSummary.textContent = `1. 选择${tab === 'characters' ? '角色' : '世界书'}`;
        this.renderTargets();
        this.renderPreview();
        if (!await this.loadSources()) return;
        if (this.tab !== tab || this.closed) return;
        const source = this.state.sources?.find(item => item.id === sourceId);
        if (source) await this.chooseSource(source);
    }

    renderSources() {
        const state = this.state;
        this.sourcesList.replaceChildren();
        if (!state.sources) return;
        const filtered = state.sources.filter(source => matchesSearch(state.sourceQuery, source.name, source.detail, source.search));
        if (!filtered.length) {
            this.sourcesList.append(element('p', 'srp-empty', state.sources.length ? '没有匹配的结果。' : '尚无可引用的内容。'));
            return;
        }
        for (const source of filtered.slice(0, state.sourceLimit)) {
            const row = button('', 'srp-source srp-row');
            row.setAttribute('aria-pressed', String(state.source?.id === source.id));
            row.title = source.detail;
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
            text.append(element('strong', '', source.name || '（无名称）'), element('small', 'srp-muted', source.detail));
            row.append(text);
            row.addEventListener('click', () => this.chooseSource(source));
            this.sourcesList.append(row);
        }
        if (filtered.length > state.sourceLimit) {
            const more = button(`显示更多（还有 ${filtered.length - state.sourceLimit} 项）`);
            more.addEventListener('click', () => { state.sourceLimit += 60; this.renderSources(); });
            this.sourcesList.append(more);
        }
    }

    async chooseSource(source) {
        const token = ++this.request;
        const state = this.state;
        state.source = source;
        state.data = null;
        state.entries = [];
        state.selection = null;
        state.loaded = false;
        state.targetQuery = '';
        state.expanded.clear();
        state.allOpen = false;
        state.targetLimit = 100;
        this.targetSearch.control.value = '';
        this.sourcesSummary.textContent = `1. ${source.name}`;
        this.renderSources();
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
            } else {
                const entries = await this.adapter.world(source);
                if (token !== this.request || this.closed) return;
                state.entries = entries;
            }
            state.loaded = true;
            if (matchMedia('(max-width: 680px)').matches) this.sourcesDetails.open = false;
            this.renderTargets();
        } catch (error) {
            if (token !== this.request || this.closed) return;
            this.targetList.replaceChildren(element('p', 'srp-error', error.message || '内容读取失败。'));
            this.status.textContent = '读取失败，可刷新列表重试';
        } finally {
            if (token === this.request && !this.closed) this.workspace.removeAttribute('aria-busy');
        }
    }

    renderTargets() {
        this.targetList.replaceChildren();
        const state = this.state;
        if (!state.source) {
            this.targetList.append(element('p', 'srp-empty', `先选择一个${this.tab === 'characters' ? '角色' : '世界书'}。`));
            return;
        }
        if (this.tab === 'worlds') {
            const entries = state.entries.filter(entry => matchesSearch(state.targetQuery, entry.comment,
                (entry.key ?? []).join(' '), (entry.keysecondary ?? []).join(' '), entry.content));
            for (const entry of entries.slice(0, state.targetLimit)) {
                const row = this.targetButton(entry.comment || '（无标题）', `UID ${entry.uid} · ${entry.disable ? '已禁用 · ' : ''}${(entry.key ?? []).join('、')}`,
                    entry.content, state.selection?.entry === entry);
                row.dataset.selectionKey = `entry:${entry.uid}`;
                row.addEventListener('click', () => this.select({ entry }));
                this.targetList.append(row);
            }
            if (!entries.length) this.targetList.append(element('p', 'srp-empty', '没有匹配的条目。'));
            this.moreTargets(entries.length);
            return;
        }
        if (!state.data) return;
        const common = COMMON_FIELDS.filter(([label, path]) => getAtPath(state.data, path) !== undefined
            && matchesSearch(state.targetQuery, label, displayPath(path), previewText(getAtPath(state.data, path))));
        if (common.length) this.targetList.append(element('p', 'srp-group-label', '常用字段'));
        for (const [label, path] of common) this.addField(this.targetList, { path, label, value: getAtPath(state.data, path) });
        const all = element('details', 'srp-all-fields');
        all.open = state.allOpen || Boolean(state.targetQuery);
        all.append(element('summary', 'srp-section-label', '全部字段（含嵌套字段）'));
        const tree = element('div', 'srp-field-tree');
        const renderTree = () => {
            tree.replaceChildren();
            const rows = fieldRows(state.data, { expanded: state.expanded, query: state.targetQuery });
            for (const row of rows.slice(0, state.targetLimit)) this.addField(tree, row, true);
            if (!rows.length) tree.append(element('p', 'srp-empty', '没有匹配的字段。'));
            if (rows.length > state.targetLimit) {
                const more = button(`显示更多字段（还有 ${rows.length - state.targetLimit} 项）`);
                more.addEventListener('click', () => { state.targetLimit += 100; renderTree(); });
                tree.append(more);
            }
        };
        // Lazy-render the tree when opened. A search traverses all nested fields.
        all.addEventListener('toggle', () => {
            state.allOpen = all.open;
            if (all.open && !tree.childElementCount) renderTree();
        });
        if (all.open) renderTree();
        all.append(tree);
        this.targetList.append(all);
    }

    moreTargets(count) {
        if (count <= this.state.targetLimit) return;
        const more = button(`显示更多（还有 ${count - this.state.targetLimit} 项）`);
        more.addEventListener('click', () => { this.state.targetLimit += 100; this.renderTargets(); });
        this.targetList.append(more);
    }

    targetButton(label, detail, value, selected) {
        const row = button('', 'srp-target srp-row');
        row.setAttribute('aria-pressed', String(Boolean(selected)));
        const text = element('span', 'srp-row-text');
        text.append(element('strong', '', label), element('small', 'srp-muted', detail));
        const summary = previewText(value).replace(/\s+/g, ' ').slice(0, 100);
        text.append(element('span', 'srp-snippet', summary));
        row.append(text);
        return row;
    }

    addField(parent, field, tree = false) {
        const id = JSON.stringify(field.path);
        const group = element('div', 'srp-field-row');
        if (tree) group.style.setProperty('--srp-depth', String(Math.min(field.path.length, 5)));
        if (tree && field.container && field.path.length) {
            const expanded = this.state.expanded.has(id);
            const toggle = button(expanded ? '−' : '+', 'srp-button srp-expand');
            toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${field.label}`);
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.addEventListener('click', () => {
                const picker = this.dialog.querySelector('.srp-picker');
                const pickerScroll = picker.scrollTop;
                const listScroll = this.targetList.scrollTop;
                if (expanded) this.state.expanded.delete(id); else this.state.expanded.add(id);
                this.renderTargets();
                picker.scrollTop = pickerScroll;
                this.targetList.scrollTop = listScroll;
                const next = [...this.targetList.querySelectorAll('.srp-expand')].find(node => node.getAttribute('aria-label')?.endsWith(` ${field.label}`));
                next?.focus({ preventScroll: true });
            });
            group.append(toggle);
        }
        const row = this.targetButton(field.label, `${displayPath(field.path)} · ${valueType(field.value)}`,
            field.value, JSON.stringify(this.state.selection?.path) === id);
        row.dataset.selectionKey = id;
        row.addEventListener('click', () => this.select({ path: field.path, value: field.value, label: field.label }));
        group.append(row);
        parent.append(group);
    }

    select(selection) {
        this.state.selection = selection;
        const key = selection.entry ? `entry:${selection.entry.uid}` : JSON.stringify(selection.path);
        for (const row of this.targetList.querySelectorAll('[data-selection-key]')) {
            row.setAttribute('aria-pressed', String(row.dataset.selectionKey === key));
        }
        this.renderPreview();
        if (matchMedia('(max-width: 680px)').matches) {
            this.templateControl.scrollIntoView({ block: 'nearest' });
        }
    }

    renderPreview() {
        const state = this.state;
        this.template = '';
        this.warning.hidden = true;
        this.warning.textContent = '';
        this.status.textContent = '请选择引用目标';
        this.selectedLabel.textContent = '尚未选择引用目标';
        this.sourcePreview.textContent = '选择目标后在这里查看原始内容。';
        const messages = [];
        if (state.selection) {
            try {
                if (this.tab === 'characters') {
                    const { path, value, label } = state.selection;
                    const name = state.data.name;
                    const names = (state.sources ?? []).map(source => source.name);
                    this.template = characterTemplate({ name, path, value, names, lazy: state.lazy });
                    this.selectedLabel.textContent = `${name} / ${label}`;
                    this.sourcePreview.textContent = previewText(value);
                    messages.push(duplicateWarning(name, names, '角色'));
                    if (isContainer(value)) messages.push('对象或数组将输出为 JSON 文本；展开字段可引用其中一项。');
                    if (value === '' || value === null) messages.push('这个字段当前为空。');
                    if (state.lazy) messages.push('已加入完整角色读取步骤，适配角色懒加载。');
                } else {
                    const entry = state.selection.entry;
                    const titles = state.entries.map(item => item.comment ?? '');
                    this.selectedLabel.textContent = `${state.source.name} / ${entry.comment || '（无标题）'}`;
                    this.sourcePreview.textContent = previewText(entry.content ?? '');
                    this.template = worldTemplate(state.source.name, entry.comment ?? '', titles);
                    messages.push(duplicateWarning(entry.comment, titles, '条目'));
                    if (!entry.content) messages.push('这个条目当前没有内容。');
                }
                if (this.template.includes('new RegExp(')) messages.push('已按名称精确匹配，避免相似名称或特殊字符影响定位。');
                this.status.textContent = '模板已就绪';
            } catch (error) {
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
    }

    selectTemplate() {
        this.templateControl.focus({ preventScroll: true });
        this.templateControl.select();
        this.templateControl.setSelectionRange(0, this.template.length);
        this.status.textContent = '已选中模板，可使用系统复制菜单';
    }

    async copyTemplate() {
        const text = this.template;
        if (!text) return;
        this.copy.disabled = true;
        const success = await copyText(text, this.templateControl);
        if (this.closed || this.template !== text) return;
        this.copy.disabled = false;
        this.status.textContent = success ? '已复制，可继续选择其他引用' : '自动复制失败，模板已选中，请使用系统复制菜单';
    }
}
