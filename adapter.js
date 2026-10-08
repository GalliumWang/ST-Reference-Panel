export class TavernAdapter {
    constructor(getContext = () => globalThis.SillyTavern.getContext()) {
        this.getContext = getContext;
        this.legacyWorldModule = null;
    }

    async worldApi() {
        const context = this.getContext();
        if (context.getWorldInfoNames && context.loadWorldInfo) return context;
        this.legacyWorldModule ??= import('../../../world-info.js');
        const module = await this.legacyWorldModule;
        return { getWorldInfoNames: () => [...module.world_names], loadWorldInfo: module.loadWorldInfo };
    }

    async sources(tab) {
        if (tab === 'characters') {
            return (this.getContext().characters ?? []).map((character, index) => ({
                id: character.avatar || `index:${index}`,
                name: character.name ?? '',
                detail: character.avatar ?? '',
                search: (character.tags ?? []).join(' '),
                avatar: character.avatar,
            })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        }
        const api = await this.worldApi();
        return api.getWorldInfoNames().map(name => ({ id: name, name, detail: '世界书' }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    async character(source) {
        let context = this.getContext();
        const findIndex = () => source.avatar
            ? context.characters.findIndex(c => c.avatar === source.avatar)
            : Number(source.id.slice(6));
        let index = findIndex();
        if (index < 0 || !context.characters[index]) throw new Error('角色已被删除，请刷新列表。');
        const wasShallow = Boolean(context.characters[index].shallow);
        if (wasShallow) {
            if (typeof context.unshallowCharacter === 'function') await context.unshallowCharacter(String(index));
            else throw new Error('酒馆没有提供完整角色读取接口，请先打开该角色或更新 SillyTavern。');
            context = this.getContext();
            index = findIndex();
        }
        const data = context.characters[index];
        if (!data || data.shallow) throw new Error('完整角色数据读取失败，请重试。');
        return { data, lazy: typeof context.unshallowCharacter === 'function'
            && (wasShallow || Boolean(context.powerUserSettings?.lazy_load_characters)) };
    }

    async world(source) {
        const api = await this.worldApi();
        const book = await api.loadWorldInfo(source.name);
        if (!book || !book.entries || typeof book.entries !== 'object') {
            throw new Error('世界书读取失败，请检查它是否仍然存在，然后重试。');
        }
        return Object.values(book.entries).filter(entry => entry && typeof entry === 'object')
            .sort((a, b) => (a.displayIndex ?? a.uid ?? 0) - (b.displayIndex ?? b.uid ?? 0));
    }

    thumbnail(source) {
        if (!source.avatar) return '';
        const context = this.getContext();
        return context.getThumbnailUrl?.('avatar', source.avatar) ?? '';
    }

    lastTab() {
        return this.getContext().extensionSettings?.st_reference_panel?.lastTab === 'worlds' ? 'worlds' : 'characters';
    }

    saveTab(lastTab) {
        const context = this.getContext();
        if (!context.extensionSettings) return;
        context.extensionSettings.st_reference_panel ??= {};
        context.extensionSettings.st_reference_panel.lastTab = lastTab;
        context.saveSettingsDebounced?.();
    }
}
