import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteString, characterTemplate, worldTemplate, nameReference, duplicateWarning,
    getAtPath, fieldRows, matchesSearch } from '../core.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function renderExpression(template, context) {
    // Test execution separately from EJS parsing (the integration runner also
    // checks these templates with ST-Prompt-Template's actual EJS engine).
    const expression = template.slice(4).replace(/-?%>$/, '').trim();
    return new AsyncFunction(...Object.keys(context), `return (${expression});`)(...Object.values(context));
}

function upstreamLookup(characters) {
    return name => characters[name] || characters.find(c => c.name === name || c.name.match(name)) || null;
}

test('JavaScript literals round-trip quotes, controls, macro and EJS delimiters', () => {
    const names = ["O'Brien\\森", '名字\n换行\t\r\0', "<% throw 'bad' %>", '{{char}}', '\u2028\u2029', ''];
    for (const name of names) {
        const literal = quoteString(name);
        assert.equal(new Function(`return ${literal}`)(), name);
        assert.ok(!literal.includes('<%') && !literal.includes('%>') && !literal.includes('{{'));
    }
});

test('ordinary world references use the chosen title, not UID', async () => {
    const template = worldTemplate('世界书', '条目名称');
    assert.equal(template, "<%- await getwi('世界书', '条目名称') -%>");
    const args = [];
    assert.equal(await renderExpression(template, { getwi: (...values) => { args.push(...values); return '正文'; } }), '正文');
    assert.deepEqual(args, ['世界书', '条目名称']);
});

test('precise name matching prevents longer and regex names from taking precedence', async () => {
    for (const name of ['Alice', 'A[1]', 'a.b', '1', '名字(旧)', 'A\\B']) {
        const characters = [{ name: `${name}的姐姐`, description: '错误' }, { name, description: '正确' }];
        const template = characterTemplate({ name, path: ['description'], value: '正确', names: characters.map(c => c.name) });
        assert.equal(await renderExpression(template, { getCharData: upstreamLookup(characters) }), '正确');
    }
});

test('world title punctuation is escaped as an exact name', async () => {
    const name = "条目[1] O'Brien";
    const template = worldTemplate('书\\名', name, [name, '其他']);
    await renderExpression(template, { getwi: (book, selector) => {
        assert.equal(book, '书\\名');
        assert.ok(selector instanceof RegExp);
        assert.ok(selector.test(name));
        assert.ok(!selector.test(`${name}附录`));
        return '';
    } });
});

test('nested unusual property keys and array elements retain their actual paths', async () => {
    const character = { name: '角色', data: { extensions: { 'a.b': { "x'y": ['第零项', '第一项'] } } } };
    const path = ['data', 'extensions', 'a.b', "x'y", 1];
    const template = characterTemplate({ name: character.name, path, value: '第一项' });
    assert.equal(await renderExpression(template, { getCharData: () => character }), '第一项');
    assert.equal(getAtPath(character, path), '第一项');
    assert.equal(getAtPath(character, ['toString']), undefined);
});

test('JSON outputs preserve arrays/objects while scalars retain false and zero', async () => {
    for (const value of [false, 0, '', null, [1, '你好'], { nested: true }]) {
        const template = characterTemplate({ name: '角色', path: ['field'], value });
        const result = await renderExpression(template, { getCharData: () => ({ field: value }) });
        const expected = value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : value ?? '';
        assert.equal(result, expected);
    }
});

test('missing characters or nested fields render an empty string', async () => {
    const template = characterTemplate({ name: '角色', path: ['data', 'extensions', 'missing'], value: 'x' });
    assert.equal(await renderExpression(template, { getCharData: () => null }), '');
    assert.equal(await renderExpression(template, { getCharData: () => ({}) }), '');
});

test('lazy loading resolves the current index at render time', async () => {
    const characters = [{ name: '其他' }, { name: '角色', shallow: true }];
    const loads = [];
    const template = characterTemplate({ name: '角色', path: ['description'], value: '完整', lazy: true });
    const context = {
        SillyTavern: { characters, unshallowCharacter: async index => {
            loads.push(index); characters[index].description = '完整';
        } }, getCharData: upstreamLookup(characters),
    };
    assert.equal(await renderExpression(template, context), '完整');
    characters.reverse();
    assert.equal(await renderExpression(template, context), '完整');
    assert.deepEqual(loads, ['1', '0']);
});

test('blank titles are rejected, duplicates are reported without substituting UID', () => {
    assert.throws(() => worldTemplate('书', '   '), /标题/);
    assert.ok(duplicateWarning('条目', ['条目', '条目'], '条目').includes('第一个'));
    assert.equal(worldTemplate('书', '条目', ['条目', '条目']), "<%- await getwi('书', '条目') -%>");
});

test('field search finds collapsed descendants and expansion exposes array indices', () => {
    const data = { data: { alternate_greetings: ['第一条', '第二条'] }, description: '你好' };
    const collapsed = fieldRows(data);
    assert.ok(!collapsed.some(row => row.path.length === 3));
    const searched = fieldRows(data, { query: '第二条' });
    assert.deepEqual(searched.map(row => row.path), [['data', 'alternate_greetings', 1]]);
    const expanded = fieldRows(data, { expanded: new Set(['["data"]', '["data","alternate_greetings"]']) });
    assert.ok(expanded.some(row => row.path.at(-1) === 1));
    assert.ok(matchesSearch('Ａlice 森林', 'Alice', '森林角色'));
});

test('name selectors never use world entry indices', () => {
    assert.equal(nameReference('普通条目', ['普通条目']), "'普通条目'");
    const selector = new Function(`return ${nameReference('条目', ['条目', '条目附录'])}`)();
    assert.ok(selector.test('条目'));
    assert.ok(!selector.test('条目附录'));
    const trailingNewline = new Function(`return ${nameReference('条目', ['条目', '条目\n'])}`)();
    assert.ok(!trailingNewline.test('条目\n'));
});
