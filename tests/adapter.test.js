import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TavernAdapter } from '../adapter.js';

test('loads only the selected shallow card and does not switch chats', async () => {
    const context = { characters: [{ name: 'B', avatar: 'b.png', shallow: true }, { name: 'A', avatar: 'a.png', shallow: true }],
        unshallowCharacter: async index => { context.characters[index] = { ...context.characters[index], shallow: false, description: '完整' }; } };
    const adapter = new TavernAdapter(() => context);
    const sources = await adapter.sources('characters');
    assert.equal(sources[0].name, 'A');
    const result = await adapter.character(sources[0]);
    assert.equal(result.data.description, '完整');
    assert.equal(result.lazy, true);
    assert.ok(context.characters[0].shallow);
});

test('world picker includes every book and disabled/untitled entries', async () => {
    const reads = [];
    const adapter = new TavernAdapter(() => ({
        getWorldInfoNames: () => ['B', 'A'],
        loadWorldInfo: async name => { reads.push(name); return { entries: {
            4: { uid: 4, displayIndex: 1, comment: '', disable: true },
            8: { uid: 8, displayIndex: 0, comment: '条目' },
        } }; },
    }));
    const sources = await adapter.sources('worlds');
    assert.deepEqual(sources.map(source => source.name), ['A', 'B']);
    assert.deepEqual(reads, []);
    const entries = await adapter.world(sources[0]);
    assert.deepEqual(reads, ['A']);
    assert.deepEqual(entries.map(entry => entry.uid), [8, 4]);
    assert.ok(entries[1].disable);
});

test('failed card and lorebook loads surface actionable errors', async () => {
    const context = { characters: [{ name: '角色', avatar: 'c.png', shallow: true }], unshallowCharacter: async () => {},
        getWorldInfoNames: () => ['书'], loadWorldInfo: async () => null };
    const adapter = new TavernAdapter(() => context);
    await assert.rejects(adapter.character({ id: 'c.png', avatar: 'c.png' }), /读取失败/);
    await assert.rejects(adapter.character({ id: 'missing.png', avatar: 'missing.png' }), /删除/);
    await assert.rejects(adapter.world({ name: '书' }), /读取失败/);
});

test('only the last tab is saved and existing extension settings are preserved', () => {
    let saves = 0;
    const context = { extensionSettings: { other: { untouched: true } }, saveSettingsDebounced: () => ++saves };
    const adapter = new TavernAdapter(() => context);
    assert.equal(adapter.lastTab(), 'characters');
    adapter.saveTab('worlds');
    assert.equal(adapter.lastTab(), 'worlds');
    assert.deepEqual(context.extensionSettings.other, { untouched: true });
    assert.equal(saves, 1);
});
