import { toStringList, normalizeSearchText, parseInitialVariables } from './core.js';

export const VALID_TABS = ['characters', 'worlds', 'variables', 'presets'];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeObjects(target, source) {
    if (!isPlainObject(source)) return target;
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (isPlainObject(value) && isPlainObject(target[key])) {
            deepMergeObjects(target[key], value);
        } else if (isPlainObject(value)) {
            target[key] = deepMergeObjects({}, value);
        } else if (Array.isArray(value)) {
            target[key] = structuredClone(value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

export class TavernAdapter {
    constructor(getContext = () => globalThis.SillyTavern.getContext()) {
        this.getContext = getContext;
        this.legacyWorldModule = null;
        this.serverUsesLazyLoad = false;
    }

    observeLazyLoad(context) {
        if ((context?.characters ?? []).some(character => Boolean(character?.shallow))) {
            this.serverUsesLazyLoad = true;
        }
    }

    isLazyLoadActive(context = this.getContext()) {
        this.observeLazyLoad(context);
        return typeof context?.unshallowCharacter === 'function'
            && (this.serverUsesLazyLoad || Boolean(context.powerUserSettings?.lazy_load_characters));
    }

    async importWorldModule() {
        if (!this.legacyWorldModule) {
            this.legacyWorldModule = import('../../../world-info.js').catch(error => {
                this.legacyWorldModule = null;
                throw error;
            });
        }
        return this.legacyWorldModule;
    }

    async peekWorldModule() {
        try {
            return await this.importWorldModule();
        } catch {
            return null;
        }
    }

    async worldApi() {
        const context = this.getContext();
        if (context.getWorldInfoNames && context.loadWorldInfo) return context;
        const module = await this.importWorldModule();
        return {
            getWorldInfoNames: () => Array.isArray(module.world_names) ? [...module.world_names] : [],
            loadWorldInfo: module.loadWorldInfo,
            updateWorldInfoList: module.updateWorldInfoList,
        };
    }

    tagLookup(context) {
        const map = new Map();
        for (const tag of context?.tags ?? []) {
            if (tag && tag.id !== undefined && tag.name) {
                map.set(tag.id, String(tag.name));
            }
        }
        return map;
    }

    characterBadges(context, character, index) {
        const badges = [];
        if (context?.characterId !== undefined && context?.characterId !== null && Number(context.characterId) === index) {
            badges.push('当前角色');
        }
        if (context?.groupId) {
            const group = (context.groups ?? []).find(item => String(item?.id) === String(context.groupId));
            if (character?.avatar && Array.isArray(group?.members) && group.members.includes(character.avatar)) {
                badges.push('群聊角色');
            }
        }
        return badges;
    }

    async worldBindings(context) {
        const map = new Map();
        const addBadge = (bookName, badge) => {
            const clean = String(bookName ?? '').trim();
            if (!clean) return;
            if (!map.has(clean)) map.set(clean, []);
            const list = map.get(clean);
            if (!list.includes(badge)) list.push(badge);
        };

        const worldModule = await this.peekWorldModule();
        const activeChars = [];
        if (context?.characterId !== undefined && context?.characterId !== null) {
            const current = context.characters?.[Number(context.characterId)];
            if (current) activeChars.push(current);
        }
        if (context?.groupId) {
            const group = (context.groups ?? []).find(item => String(item?.id) === String(context.groupId));
            for (const avatar of group?.members ?? []) {
                const member = (context.characters ?? []).find(item => item?.avatar === avatar);
                if (member && !activeChars.includes(member)) activeChars.push(member);
            }
        }

        // 1. Primary character lorebooks
        for (const char of activeChars) {
            addBadge(char?.data?.extensions?.world, '主书');
        }

        // 2. Character additional lorebooks (charLore.extraBooks)
        const charLore = context?.worldInfo?.charLore ?? worldModule?.world_info?.charLore;
        if (Array.isArray(charLore)) {
            for (const char of activeChars) {
                const avatar = String(char?.avatar ?? '');
                const fileBase = avatar.replace(/\.[^/.]+$/, '');
                const record = charLore.find(item => item && (item.name === fileBase || item.name === avatar));
                for (const extra of record?.extraBooks ?? []) {
                    addBadge(extra, '附加书');
                }
            }
        }

        // 3. Chat-bound lorebook
        addBadge(context?.chatMetadata?.world_info, '聊天书');

        // 4. Persona lorebook
        addBadge(context?.powerUserSettings?.persona_description_lorebook, 'Persona 书');

        // 5. Globally enabled lorebooks
        const globalBooks = context?.selectedWorldInfo
            ?? worldModule?.selected_world_info
            ?? worldModule?.world_info?.globalSelect
            ?? [];
        if (Array.isArray(globalBooks)) {
            for (const globalBook of globalBooks) {
                addBadge(globalBook, '全局书');
            }
        }
        return map;
    }

    latestMessageVariables(context) {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            const swipeId = msg?.swipe_id ?? 0;
            const vars = msg?.variables?.[swipeId];
            if (isPlainObject(vars) && Object.keys(vars).length > 0) {
                return { vars, floor: i, swipeId };
            }
        }
        const last = chat.at(-1);
        const swipeId = last?.swipe_id ?? 0;
        const fallback = last?.variables?.[swipeId];
        return { vars: isPlainObject(fallback) ? fallback : {}, floor: chat.length ? chat.length - 1 : -1, swipeId };
    }

    async scanInitialVariables(context) {
        const bindings = await this.worldBindings(context);
        const bookNames = [...bindings.keys()];
        if (!bookNames.length) return { data: {}, books: [] };
        const api = await this.worldApi();
        const merged = {};
        const matchedBooks = [];
        for (const name of bookNames) {
            try {
                const book = await api.loadWorldInfo(name);
                if (!book?.entries || typeof book.entries !== 'object') continue;
                for (const entry of Object.values(book.entries)) {
                    if (!entry || typeof entry !== 'object') continue;
                    const comment = String(entry.comment ?? '');
                    const content = String(entry.content ?? '');
                    const isInit = comment.includes('[InitialVariables]') || content.includes('@@initial_variables');
                    if (!isInit) continue;
                    if (entry.disable && !content.includes('@@always_enabled')) continue;
                    const parsed = parseInitialVariables(content);
                    if (Object.keys(parsed).length) {
                        deepMergeObjects(merged, parsed);
                        if (!matchedBooks.includes(name)) matchedBooks.push(name);
                    }
                }
            } catch { /* Ignore unreadable book while scanning initial variables. */ }
        }
        return { data: merged, books: matchedBooks };
    }

    collectPresetSources(context) {
        const results = [];
        const pm = context?.getPresetManager?.('openai') ?? context?.getPresetManager?.();
        const selectedName = String(pm?.getSelectedPresetName?.() ?? '').trim();
        const list = pm?.getPresetList?.('openai') ?? pm?.getPresetList?.();
        const seenNames = new Set();

        const addPreset = (name, presetObj, isActive = false) => {
            const cleanName = String(name ?? '').trim();
            if (!cleanName || seenNames.has(cleanName)) return;
            const prompts = Array.isArray(presetObj?.prompts) ? presetObj.prompts : null;
            if (!prompts && !isActive) return;
            seenNames.add(cleanName);
            const badges = isActive ? ['当前预设'] : [];
            const detail = `对话预设 · ${(prompts ?? context?.chatCompletionSettings?.prompts ?? []).length} 条提示词`;
            results.push({
                id: `preset:${cleanName}`,
                kind: 'preset',
                name: cleanName,
                detail,
                isActivePreset: isActive,
                contextBadges: badges,
                _prompts: prompts ?? context?.chatCompletionSettings?.prompts ?? [],
                _searchText: normalizeSearchText(cleanName, detail, badges.join(' ')),
            });
        };

        if (selectedName) {
            const activePrompts = context?.chatCompletionSettings?.prompts ?? list?.settings?.prompts;
            addPreset(selectedName, { prompts: Array.isArray(activePrompts) ? activePrompts : [] }, true);
        } else if (Array.isArray(context?.chatCompletionSettings?.prompts)) {
            addPreset('当前激活预设', { prompts: context.chatCompletionSettings.prompts }, true);
        }

        if (list?.presets && list?.preset_names) {
            if (Array.isArray(list.preset_names)) {
                list.preset_names.forEach((name, idx) => addPreset(name, list.presets[idx], name === selectedName));
            } else if (isPlainObject(list.preset_names)) {
                for (const [name, idx] of Object.entries(list.preset_names)) {
                    addPreset(name, list.presets[idx], name === selectedName);
                }
            }
        }
        return results;
    }

    collectQuickReplySources(context) {
        const results = [];
        const seenSets = new Set();
        const qrRoot = context?.extensionSettings?.quickReplyV2
            ?? globalThis.quickReplyApi?.settings
            ?? null;
        if (!qrRoot) return results;

        const activeGlobal = new Set();
        const activeChat = new Set();
        for (const link of qrRoot?.config?.setList ?? []) {
            const setName = link?.set?.name ?? link?.name;
            if (setName) activeGlobal.add(String(setName));
        }
        for (const link of qrRoot?.chatConfig?.setList ?? []) {
            const setName = link?.set?.name ?? link?.name;
            if (setName) activeChat.add(String(setName));
        }

        const candidateLists = [
            ...(qrRoot?.config?.setList ?? []),
            ...(qrRoot?.chatConfig?.setList ?? []),
            ...(qrRoot?.setList ?? []),
        ];
        for (const item of candidateLists) {
            const setObj = item?.set ?? item;
            const name = String(setObj?.name ?? '').trim();
            if (!name || seenSets.has(name)) continue;
            seenSets.add(name);
            const qrList = Array.isArray(setObj?.qrList) ? setObj.qrList : [];
            const badges = [];
            if (activeGlobal.has(name)) badges.push('全局 QR');
            if (activeChat.has(name)) badges.push('聊天 QR');
            const detail = `快速回复 · ${qrList.length} 条`;
            results.push({
                id: `qr:${name}`,
                kind: 'qr',
                name,
                detail,
                contextBadges: badges,
                _qrList: qrList,
                _searchText: normalizeSearchText(name, detail, badges.join(' ')),
            });
        }
        return results;
    }

    async sources(tab) {
        const context = this.getContext();
        if (tab === 'characters') {
            this.observeLazyLoad(context);
            const tagById = this.tagLookup(context);
            return (context.characters ?? []).map((character, index) => {
                const embeddedTags = toStringList(character?.tags);
                const uiTagIds = character?.avatar ? (context.tagMap?.[character.avatar] ?? []) : [];
                const uiTags = Array.isArray(uiTagIds)
                    ? uiTagIds.map(id => tagById.get(id)).filter(Boolean)
                    : [];
                const search = [...new Set([...embeddedTags, ...uiTags])].join(' ');
                const contextBadges = this.characterBadges(context, character, index);
                const name = character?.name ?? '';
                const detail = character?.avatar ?? '';
                return {
                    id: character?.avatar || `index:${index}`,
                    name,
                    detail,
                    search,
                    avatar: character?.avatar,
                    contextBadges,
                    _searchText: normalizeSearchText(name, detail, search, contextBadges.join(' ')),
                };
            }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        }

        if (tab === 'worlds') {
            const [api, bindings] = await Promise.all([this.worldApi(), this.worldBindings(context)]);
            return api.getWorldInfoNames().map(name => {
                const contextBadges = bindings.get(name) ?? [];
                const detail = contextBadges.length ? `世界书 · ${contextBadges.join(' / ')}` : '世界书';
                return {
                    id: name,
                    name,
                    detail: '世界书',
                    contextBadges,
                    _searchText: normalizeSearchText(name, detail, contextBadges.join(' ')),
                };
            }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        }

        if (tab === 'variables') {
            const localVars = isPlainObject(context?.chatMetadata?.variables) ? context.chatMetadata.variables : {};
            const globalVars = isPlainObject(context?.extensionSettings?.variables?.global)
                ? context.extensionSettings.variables.global : {};
            const { vars: msgVars, floor } = this.latestMessageVariables(context);
            const localCount = Object.keys(localVars).length;
            const globalCount = Object.keys(globalVars).length;
            const msgCount = Object.keys(msgVars).length;
            const list = [
                {
                    id: 'var:merged',
                    scope: 'default',
                    name: '合并变量视图（当前生效）',
                    detail: '聚合 global + InitialVariables + local + message',
                    contextBadges: ['当前生效'],
                },
                {
                    id: 'var:local',
                    scope: 'local',
                    name: '聊天局部变量 (local)',
                    detail: `chatMetadata.variables · ${localCount} 项`,
                    contextBadges: localCount ? ['聊天 local'] : [],
                },
                {
                    id: 'var:global',
                    scope: 'global',
                    name: '全局变量 (global)',
                    detail: `extensionSettings.variables.global · ${globalCount} 项`,
                    contextBadges: globalCount ? ['全局 global'] : [],
                },
                {
                    id: 'var:message',
                    scope: 'message',
                    name: '最新楼层变量 (message)',
                    detail: floor >= 0 ? `第 #${floor} 楼层变量 · ${msgCount} 项` : '当前尚无楼层消息',
                    contextBadges: msgCount ? ['楼层 message'] : [],
                },
                {
                    id: 'var:initial',
                    scope: 'default',
                    name: '世界书初始变量 [InitialVariables]',
                    detail: '扫描当前关联世界书中的 [InitialVariables] 条目',
                    contextBadges: ['初始变量'],
                },
            ];
            for (const item of list) {
                item._searchText = normalizeSearchText(item.name, item.detail, item.contextBadges.join(' '));
            }
            return list;
        }

        if (tab === 'presets') {
            const presets = this.collectPresetSources(context);
            const qrs = this.collectQuickReplySources(context);
            return [
                ...presets.sort((a, b) => Number(Boolean(b.isActivePreset)) - Number(Boolean(a.isActivePreset)) || a.name.localeCompare(b.name, 'zh-CN')),
                ...qrs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
            ];
        }

        return [];
    }

    async refreshSources(tab) {
        const context = this.getContext();
        if (tab === 'worlds') {
            const api = await this.worldApi();
            await api.updateWorldInfoList?.();
        } else if (tab === 'characters') {
            await context.getCharacters?.();
        }
    }

    async character(source) {
        let context = this.getContext();
        this.observeLazyLoad(context);
        const findIndex = () => source.avatar
            ? (context.characters ?? []).findIndex(c => c.avatar === source.avatar)
            : Number(String(source.id ?? '').slice(6));
        let index = findIndex();
        if (index < 0 || !context.characters?.[index]) throw new Error('角色已被删除，请刷新列表。');
        const wasShallow = Boolean(context.characters[index].shallow);
        if (wasShallow) {
            this.serverUsesLazyLoad = true;
            if (typeof context.unshallowCharacter === 'function') await context.unshallowCharacter(String(index));
            else throw new Error('酒馆没有提供完整角色读取接口，请先打开该角色或更新 SillyTavern。');
            context = this.getContext();
            this.observeLazyLoad(context);
            index = findIndex();
        }
        const data = context.characters?.[index];
        if (!data || data.shallow) throw new Error('完整角色数据读取失败，请重试。');
        return {
            data,
            lazy: typeof context.unshallowCharacter === 'function'
                && (wasShallow || this.serverUsesLazyLoad || Boolean(context.powerUserSettings?.lazy_load_characters)),
        };
    }

    async fetchWorldUncached(name) {
        const context = this.getContext();
        const worldModule = await this.peekWorldModule();
        const cache = context?.worldInfoCache ?? worldModule?.worldInfoCache;

        if (typeof globalThis.fetch === 'function' && typeof context?.getRequestHeaders === 'function') {
            try {
                const response = await globalThis.fetch('api/worldinfo/get', {
                    method: 'POST',
                    headers: context.getRequestHeaders(),
                    body: JSON.stringify({ name }),
                    cache: 'no-cache',
                });
                if (response.ok) {
                    const fresh = await response.json();
                    if (fresh && typeof fresh.entries === 'object') {
                        if (cache?.set) cache.set(name, fresh);
                        else if (isPlainObject(cache)) cache[name] = fresh;
                        return fresh;
                    }
                }
            } catch {
                /* Fall back to standard loadWorldInfo when offline or running against local test mocks. */
            }
        }

        if (cache?.delete) cache.delete(name);
        else if (isPlainObject(cache)) delete cache[name];
        const api = await this.worldApi();
        return api.loadWorldInfo(name);
    }

    async world(source, { force = false } = {}) {
        const book = force
            ? await this.fetchWorldUncached(source.name)
            : await (await this.worldApi()).loadWorldInfo(source.name);
        if (!book || !book.entries || typeof book.entries !== 'object') {
            throw new Error('世界书读取失败，请检查它是否仍然存在，然后重试。');
        }
        return Object.entries(book.entries)
            .filter(([, entry]) => entry && typeof entry === 'object')
            .map(([dictKey, entry], index) => {
                const hasInnerUid = entry.uid !== undefined && entry.uid !== null && String(entry.uid).trim() !== '';
                const fallbackUid = /^(0|-?[1-9]\d*)$/.test(String(dictKey)) ? Number(dictKey) : dictKey;
                const resolvedUid = hasInnerUid ? entry.uid : fallbackUid;
                const normalized = hasInnerUid ? entry : { ...entry, uid: resolvedUid };
                const keys = toStringList(normalized.key);
                const secondary = toStringList(normalized.keysecondary);
                Object.defineProperties(normalized, {
                    _keys: { value: keys, enumerable: false, configurable: true },
                    _secondary: { value: secondary, enumerable: false, configurable: true },
                    _selectionKey: { value: `entry:${String(resolvedUid ?? dictKey ?? index)}`, enumerable: false, configurable: true },
                    _searchText: {
                        value: normalizeSearchText(normalized.comment, keys.join(' '), secondary.join(' '), normalized.content),
                        enumerable: false,
                        configurable: true,
                    },
                });
                return normalized;
            })
            .sort((a, b) => {
                const orderA = a.displayIndex ?? (Number.isFinite(Number(a.uid)) ? Number(a.uid) : 0);
                const orderB = b.displayIndex ?? (Number.isFinite(Number(b.uid)) ? Number(b.uid) : 0);
                return orderA - orderB;
            });
    }

    async variables(source) {
        const context = this.getContext();
        const localVars = isPlainObject(context?.chatMetadata?.variables) ? context.chatMetadata.variables : {};
        const globalVars = isPlainObject(context?.extensionSettings?.variables?.global)
            ? context.extensionSettings.variables.global : {};
        const { vars: msgVars } = this.latestMessageVariables(context);

        if (source.id === 'var:local') return { data: structuredClone(localVars), scope: 'local' };
        if (source.id === 'var:global') return { data: structuredClone(globalVars), scope: 'global' };
        if (source.id === 'var:message') return { data: structuredClone(msgVars), scope: 'message' };
        const initial = await this.scanInitialVariables(context);
        if (source.id === 'var:initial') {
            return { data: initial.data, scope: 'default', books: initial.books };
        }
        const merged = {};
        deepMergeObjects(merged, globalVars);
        deepMergeObjects(merged, initial.data);
        deepMergeObjects(merged, localVars);
        deepMergeObjects(merged, msgVars);
        return { data: merged, scope: 'default', books: initial.books };
    }

    async presetItems(source) {
        if (source.kind === 'qr') {
            const qrSources = this.collectQuickReplySources(this.getContext());
            const fresh = qrSources.find(item => item.name === source.name) ?? source;
            const setNames = qrSources.map(item => item.name);
            const qrList = Array.isArray(fresh._qrList) ? fresh._qrList : [];
            const labels = qrList.map(qr => String(qr?.label ?? ''));
            return qrList.map((qr, index) => {
                const label = String(qr?.label ?? '');
                const message = String(qr?.message ?? qr?.mes ?? '');
                const title = String(qr?.title ?? '');
                const item = {
                    kind: 'qr',
                    setName: fresh.name,
                    setNames,
                    label,
                    labels,
                    title,
                    content: message,
                    disabled: Boolean(qr?.isHidden),
                    _selectionKey: `qr:${index}:${label}`,
                    _searchText: normalizeSearchText(label, title, message),
                };
                return item;
            });
        }

        const presetSources = this.collectPresetSources(this.getContext());
        const fresh = presetSources.find(item => item.name === source.name) ?? source;
        const rawPrompts = Array.isArray(fresh._prompts) ? fresh._prompts : [];
        const promptNames = rawPrompts.map(p => String(p?.name ?? ''));
        return rawPrompts.map((prompt, index) => {
            const name = String(prompt?.name ?? '');
            const identifier = String(prompt?.identifier ?? '');
            const role = String(prompt?.role ?? 'system');
            const content = String(prompt?.content ?? '');
            const marker = Boolean(prompt?.marker);
            const enabled = prompt?.enabled !== false;
            return {
                kind: 'preset',
                presetName: fresh.name,
                isActivePreset: Boolean(fresh.isActivePreset),
                name,
                promptNames,
                identifier,
                role,
                marker,
                enabled,
                content,
                _selectionKey: `preset:${identifier || index}:${name}`,
                _searchText: normalizeSearchText(name, identifier, role, content),
            };
        });
    }

    thumbnail(source) {
        if (!source?.avatar) return '';
        const context = this.getContext();
        return context.getThumbnailUrl?.('avatar', source.avatar) ?? '';
    }

    settingsBucket(create = false) {
        const context = this.getContext();
        if (!context?.extensionSettings) return null;
        if (create) context.extensionSettings.st_reference_panel ??= {};
        return context.extensionSettings.st_reference_panel ?? null;
    }

    lastTab() {
        const saved = this.settingsBucket(false)?.lastTab;
        return VALID_TABS.includes(saved) ? saved : 'characters';
    }

    saveTab(lastTab) {
        if (!VALID_TABS.includes(lastTab)) return;
        const context = this.getContext();
        const bucket = this.settingsBucket(true);
        if (!bucket) return;
        bucket.lastTab = lastTab;
        context.saveSettingsDebounced?.();
    }

    prefs() {
        const raw = this.settingsBucket(false)?.prefs;
        return isPlainObject(raw) ? { ...raw } : {};
    }

    savePrefs(patch) {
        if (!isPlainObject(patch)) return;
        const context = this.getContext();
        const bucket = this.settingsBucket(true);
        if (!bucket) return;
        bucket.prefs = { ...(isPlainObject(bucket.prefs) ? bucket.prefs : {}), ...patch };
        context.saveSettingsDebounced?.();
    }

    pinned() {
        const list = this.settingsBucket(false)?.pinned;
        return Array.isArray(list) ? list.filter(item => item && typeof item.template === 'string') : [];
    }

    isPinned(template) {
        if (!template) return false;
        return this.pinned().some(item => item.template === template);
    }

    togglePin(record) {
        if (!record?.template) return false;
        const context = this.getContext();
        const bucket = this.settingsBucket(true);
        if (!bucket) return false;
        const current = this.pinned();
        const exists = current.findIndex(item => item.template === record.template);
        if (exists >= 0) {
            current.splice(exists, 1);
            bucket.pinned = current;
            context.saveSettingsDebounced?.();
            return false;
        }
        current.unshift({
            label: String(record.label ?? ''),
            template: String(record.template),
            tab: String(record.tab ?? 'characters'),
        });
        bucket.pinned = current.slice(0, 50);
        context.saveSettingsDebounced?.();
        return true;
    }

    recent() {
        const list = this.settingsBucket(false)?.recent;
        return Array.isArray(list) ? list.filter(item => item && typeof item.template === 'string') : [];
    }

    addRecent(record) {
        if (!record?.template) return;
        const context = this.getContext();
        const bucket = this.settingsBucket(true);
        if (!bucket) return;
        const filtered = this.recent().filter(item => item.template !== record.template);
        filtered.unshift({
            label: String(record.label ?? ''),
            template: String(record.template),
            tab: String(record.tab ?? 'characters'),
        });
        bucket.recent = filtered.slice(0, 20);
        context.saveSettingsDebounced?.();
    }

    clearRecent() {
        const context = this.getContext();
        const bucket = this.settingsBucket(true);
        if (!bucket) return;
        bucket.recent = [];
        context.saveSettingsDebounced?.();
    }
}
