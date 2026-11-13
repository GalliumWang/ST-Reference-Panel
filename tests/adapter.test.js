import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TavernAdapter } from '../adapter.js';

test('loads only the selected shallow card, remembers server lazy-load mode across active cards, and does not switch chats', async () => {
    const context = {
        characterId: 0,
        characters: [
            { name: 'ActiveCard', avatar: 'active.png', shallow: false, description: '已加载的当前卡' },
            { name: 'ShallowCard', avatar: 'shallow.png', shallow: true },
        ],
        unshallowCharacter: async index => {
            context.characters[index] = { ...context.characters[index], shallow: false, description: '完整' };
        },
    };
    const adapter = new TavernAdapter(() => context);
    const sources = await adapter.sources('characters');
    assert.equal(sources[0].name, 'ActiveCard');
    assert.deepEqual(sources[0].contextBadges, ['当前角色']);

    // Even though ActiveCard is already unshallowed in memory, another card in the roster is shallow,
    // so server-side lazy loading is active and exported templates must stay lazy-safe!
    const activeResult = await adapter.character(sources[0]);
    assert.equal(activeResult.lazy, true);
    assert.ok(context.characters[1].shallow);

    const shallowResult = await adapter.character(sources[1]);
    assert.equal(shallowResult.data.description, '完整');
    assert.equal(shallowResult.lazy, true);
    // Re-selecting after unshallowing retains lazy: true for the session.
    const secondRead = await adapter.character(sources[1]);
    assert.equal(secondRead.lazy, true);
});

test('character sources merge SillyTavern UI tagMap + tags with comma-separated embedded tags and group badges', async () => {
    const context = {
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['lin.png'] }],
        tags: [{ id: 't1', name: '治愈系' }, { id: 't2', name: '现代都市' }],
        tagMap: { 'lin.png': ['t1', 't2'] },
        characters: [
            { name: '林晚', avatar: 'lin.png', tags: '店主, 书店' },
        ],
    };
    const adapter = new TavernAdapter(() => context);
    const [lin] = await adapter.sources('characters');
    assert.deepEqual(lin.contextBadges, ['群聊角色']);
    assert.ok(lin.search.includes('治愈系'));
    assert.ok(lin.search.includes('现代都市'));
    assert.ok(lin.search.includes('店主'));
});

test('world picker marks all 5 lorebook binding scopes, falls back to outer key for missing uid, and normalizes string keys', async () => {
    const reads = [];
    const context = {
        characterId: 0,
        characters: [{
            name: '林晚',
            avatar: 'lin.png',
            data: { extensions: { world: '主设定书' } },
        }],
        worldInfo: {
            charLore: [{ name: 'lin', extraBooks: ['附加设定书'] }],
        },
        chatMetadata: { world_info: '当前聊天书' },
        powerUserSettings: { persona_description_lorebook: '人设世界书' },
        selectedWorldInfo: ['全局常识书'],
        getWorldInfoNames: () => ['普通书', '主设定书', '附加设定书', '当前聊天书', '人设世界书', '全局常识书'],
        loadWorldInfo: async name => {
            reads.push(name);
            return {
                entries: {
                    4: { uid: 4, displayIndex: 1, comment: '', key: '关键字A, 关键字B', disable: true },
                    9: { displayIndex: 0, comment: '缺失内层UID条目', key: ['单关键字'], content: '正文' },
                },
            };
        },
    };
    const adapter = new TavernAdapter(() => context);
    const sources = await adapter.sources('worlds');
    assert.deepEqual(reads, []);
    const badgeByBook = Object.fromEntries(sources.map(s => [s.name, s.contextBadges]));
    assert.deepEqual(badgeByBook['主设定书'], ['主书']);
    assert.deepEqual(badgeByBook['附加设定书'], ['附加书']);
    assert.deepEqual(badgeByBook['当前聊天书'], ['聊天书']);
    assert.deepEqual(badgeByBook['人设世界书'], ['Persona 书']);
    assert.deepEqual(badgeByBook['全局常识书'], ['全局书']);
    assert.deepEqual(badgeByBook['普通书'], []);

    const entries = await adapter.world({ name: '主设定书' });
    assert.deepEqual(entries.map(e => e.uid), [9, 4]);
    assert.deepEqual(entries[1]._keys, ['关键字A', '关键字B']);
});

test('forced world refresh bypasses stale worldInfoCache via api/worldinfo/get and writes fresh data back', async () => {
    const cache = new Map([['城市设定', { entries: { 0: { uid: 0, comment: '旧缓存条目' } } }]]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        assert.equal(url, 'api/worldinfo/get');
        assert.equal(init.cache, 'no-cache');
        assert.deepEqual(JSON.parse(init.body), { name: '城市设定' });
        return {
            ok: true,
            json: async () => ({ entries: { 0: { uid: 0, comment: '最新后端条目', content: '新内容' } } }),
        };
    };
    try {
        const adapter = new TavernAdapter(() => ({
            worldInfoCache: cache,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getWorldInfoNames: () => ['城市设定'],
            loadWorldInfo: async name => cache.get(name),
        }));
        const entries = await adapter.world({ name: '城市设定' }, { force: true });
        assert.equal(entries[0].comment, '最新后端条目');
        assert.equal(cache.get('城市设定').entries[0].comment, '最新后端条目');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('variables tab aggregates global, [InitialVariables], local, and latest message variables', async () => {
    const context = {
        characterId: 0,
        characters: [{ name: '林晚', avatar: 'lin.png', data: { extensions: { world: '主设定书' } } }],
        chatMetadata: { variables: { stat: { hp: 75 }, localOnly: 'yes' } },
        extensionSettings: { variables: { global: { theme: 'night', stat: { maxHp: 100 } } } },
        chat: [
            { mes: 'hi', swipe_id: 0, variables: [{ turn: 1 }] },
            { mes: 'reply', swipe_id: 1, variables: [{ turn: 2 }, { turn: 3, mood: 'calm' }] },
        ],
        getWorldInfoNames: () => ['主设定书'],
        loadWorldInfo: async () => ({
            entries: {
                0: { uid: 0, comment: '[InitialVariables] 默认状态', content: 'stat:\n  hp: 100\n  stamina: 50\n' },
                1: { uid: 1, comment: '[InitialVariables] 已禁用', disable: true, content: 'ignored: true' },
            },
        }),
    };
    const adapter = new TavernAdapter(() => context);
    const sources = await adapter.sources('variables');
    assert.equal(sources.length, 5);

    const merged = await adapter.variables(sources[0]);
    assert.deepEqual(merged.data, {
        theme: 'night',
        stat: { maxHp: 100, hp: 75, stamina: 50 },
        localOnly: 'yes',
        turn: 3,
        mood: 'calm',
    });
    assert.deepEqual(merged.books, ['主设定书']);

    const initOnly = await adapter.variables(sources[4]);
    assert.deepEqual(initOnly.data, { stat: { hp: 100, stamina: 50 } });
});

test('presets tab collects active/inactive OpenAI presets and QuickReply v2 sets', async () => {
    const context = {
        chatCompletionSettings: {
            prompts: [{ identifier: 'main', name: '主系统提示', role: 'system', content: '保持角色性格' }],
        },
        getPresetManager: () => ({
            getSelectedPresetName: () => 'Reborn 主预设',
            getPresetList: () => ({
                preset_names: { 'Reborn 主预设': 0, '备用预设': 1 },
                presets: [
                    { prompts: [{ identifier: 'main', name: '主系统提示', role: 'system', content: '保持角色性格' }] },
                    { prompts: [{ identifier: 'cot', name: '思维链', role: 'system', content: '<thinking>' }] },
                ],
            }),
        }),
        extensionSettings: {
            quickReplyV2: {
                config: { setList: [{ set: { name: '全局面板', qrList: [{ label: '状态栏', message: '/echo ok' }] } }] },
                chatConfig: { setList: [{ set: { name: '聊天专属', qrList: [{ label: '推进剧情', message: '继续' }] } }] },
            },
        },
    };
    const adapter = new TavernAdapter(() => context);
    const sources = await adapter.sources('presets');
    assert.equal(sources[0].name, 'Reborn 主预设');
    assert.deepEqual(sources[0].contextBadges, ['当前预设']);
    assert.ok(sources.some(s => s.kind === 'qr' && s.name === '全局面板' && s.contextBadges.includes('全局 QR')));
    assert.ok(sources.some(s => s.kind === 'qr' && s.name === '聊天专属' && s.contextBadges.includes('聊天 QR')));

    const prompts = await adapter.presetItems(sources[0]);
    assert.equal(prompts[0].name, '主系统提示');

    const qrSource = sources.find(s => s.name === '全局面板');
    const qrs = await adapter.presetItems(qrSource);
    assert.equal(qrs[0].label, '状态栏');
    assert.equal(qrs[0].content, '/echo ok');
});

test('failed card, lorebook, and legacy module imports surface actionable errors without permanent cache poisoning', async () => {
    const context = {
        characters: [{ name: '角色', avatar: 'c.png', shallow: true }],
        unshallowCharacter: async () => {},
        getWorldInfoNames: () => ['书'],
        loadWorldInfo: async () => null,
    };
    const adapter = new TavernAdapter(() => context);
    await assert.rejects(adapter.character({ id: 'c.png', avatar: 'c.png' }), /读取失败/);
    await assert.rejects(adapter.character({ id: 'missing.png', avatar: 'missing.png' }), /删除/);
    await assert.rejects(adapter.world({ name: '书' }), /读取失败/);

    const fallbackAdapter = new TavernAdapter(() => ({}));
    await assert.rejects(fallbackAdapter.importWorldModule());
    assert.equal(fallbackAdapter.legacyWorldModule, null);
});

test('settings bucket persists lastTab, prefs, pinned, and recent while preserving sibling extension settings', () => {
    let saves = 0;
    const context = { extensionSettings: { other: { untouched: true } }, saveSettingsDebounced: () => ++saves };
    const adapter = new TavernAdapter(() => context);
    assert.equal(adapter.lastTab(), 'characters');
    adapter.saveTab('variables');
    assert.equal(adapter.lastTab(), 'variables');

    adapter.savePrefs({ floating: true, worldLookup: 'uid' });
    assert.equal(adapter.prefs().floating, true);

    assert.equal(adapter.togglePin({ label: 'HP', template: "<%- getvar('hp') ?? '' -%>", tab: 'variables' }), true);
    assert.equal(adapter.isPinned("<%- getvar('hp') ?? '' -%>"), true);
    assert.equal(adapter.togglePin({ label: 'HP', template: "<%- getvar('hp') ?? '' -%>", tab: 'variables' }), false);
    assert.equal(adapter.pinned().length, 0);

    adapter.addRecent({ label: '最近1', template: 'tpl1', tab: 'worlds' });
    adapter.addRecent({ label: '最近2', template: 'tpl2', tab: 'worlds' });
    adapter.addRecent({ label: '最近1更新', template: 'tpl1', tab: 'worlds' });
    assert.deepEqual(adapter.recent().map(r => r.template), ['tpl1', 'tpl2']);
    adapter.clearRecent();
    assert.equal(adapter.recent().length, 0);

    assert.deepEqual(context.extensionSettings.other, { untouched: true });
    assert.ok(saves >= 6);
});
