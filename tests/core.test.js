import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    quoteString, toStringList, safeJsonStringify, snippetText, lodashPath,
    characterTemplate, worldTemplate, variableTemplate, presetTemplate, quickReplyTemplate,
    parseInitialVariables, nameReference, duplicateWarning, uidOverlapWarning,
    getAtPath, fieldRows, matchesSearch, prepareSearchWords, matchesPrecomputed,
} from '../core.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function renderExpression(template, context) {
    const expression = template.replace(/^<%-?\s*/, '').replace(/\s*-?%>$/, '').trim();
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

test('precise name matching prevents longer, regex, numeric, and Array/Object prototype names from colliding', async () => {
    for (const name of ['Alice', 'A[1]', 'a.b', '1', '名字(旧)', 'A\\B', 'map', 'at', 'keys', 'length', 'toString', 'constructor']) {
        const characters = [{ name: `${name}的姐姐`, description: '错误' }, { name, description: '正确' }];
        const template = characterTemplate({ name, path: ['description'], value: '正确', names: characters.map(c => c.name) });
        assert.equal(await renderExpression(template, { getCharData: upstreamLookup(characters) }), '正确', `failed for ${name}`);
    }
});

test('characterTemplate supports dynamicCurrent getCharData() and forceRegex option', async () => {
    const dynamicTpl = characterTemplate({ name: '被忽略', path: ['description'], value: '当前角色描述', dynamicCurrent: true });
    assert.equal(dynamicTpl, "<%- (await getCharData())?.description ?? '' %>");
    assert.equal(await renderExpression(dynamicTpl, { getCharData: () => ({ description: '当前角色描述' }) }), '当前角色描述');

    const forced = characterTemplate({ name: '普通名', path: ['description'], value: 'x', forceRegex: true });
    assert.ok(forced.includes('new RegExp('));
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

test('worldTemplate supports primaryBook, UID lookup, activewi, and newline preservation', async () => {
    assert.equal(
        worldTemplate('城市设定', '月光街区', [], { primaryBook: true }),
        "<%- await getwi('月光街区') -%>",
    );
    assert.equal(
        worldTemplate('城市设定', '月光街区', [], { lookup: 'uid', uid: '12' }),
        "<%- await getwi('城市设定', 12) -%>",
    );
    assert.equal(
        worldTemplate('城市设定', '月光街区', [], { primaryBook: true, lookup: 'uid', uid: 0 }),
        '<%- await getwi(0) -%>',
    );
    assert.equal(
        worldTemplate('城市设定', '月光街区', [], { action: 'activewi', trimNewline: false }),
        "<% await activewi('城市设定', '月光街区') %>",
    );
    // Untitled entry in activewi mode automatically falls back to numeric UID when available.
    assert.equal(
        worldTemplate('城市设定', '   ', [], { action: 'activewi', uid: 7 }),
        "<% await activewi('城市设定', 7) -%>",
    );
    assert.throws(() => worldTemplate('城市设定', '条目', [], { lookup: 'uid', uid: 'abc' }), /UID/);
    assert.throws(() => worldTemplate('', '条目'), /世界书名称为空/);
});

test('uidOverlapWarning flags duplicate UIDs and comments containing the UID substring', () => {
    const target = { uid: 12, comment: '目标条目' };
    assert.equal(uidOverlapWarning(12, [target, { uid: 99, comment: '普通条目' }], target), '');
    assert.ok(uidOverlapWarning(12, [target, { uid: 99, comment: '第12章：序幕' }], target).includes('第12章'));
    assert.ok(uidOverlapWarning(12, [target, { uid: 12, comment: '撞车条目' }], target).includes('相同 UID'));
});

test('nested unusual property keys and array elements retain their actual paths', async () => {
    const character = { name: '角色', data: { extensions: { 'a.b': { "x'y": ['第零项', '第一项'] } } } };
    const path = ['data', 'extensions', 'a.b', "x'y", 1];
    const template = characterTemplate({ name: character.name, path, value: '第一项' });
    assert.equal(await renderExpression(template, { getCharData: () => character }), '第一项');
    assert.equal(getAtPath(character, path), '第一项');
    assert.equal(getAtPath(character, ['toString']), undefined);
    assert.equal(lodashPath(path), "data.extensions['a.b']['x\\'y'][1]");
});

test('JSON outputs preserve arrays/objects while missing/null containers render empty string instead of "null"', async () => {
    for (const value of [false, 0, '', null, [1, '你好'], { nested: true }]) {
        const template = characterTemplate({ name: '角色', path: ['field'], value });
        const result = await renderExpression(template, { getCharData: () => ({ field: value }) });
        const expected = value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : value ?? '';
        assert.equal(result, expected);
    }
    const containerTpl = characterTemplate({ name: '角色', path: ['data', 'list'], value: ['a'] });
    assert.equal(await renderExpression(containerTpl, { getCharData: () => null }), '');
    assert.equal(await renderExpression(containerTpl, { getCharData: () => ({ data: { list: null } }) }), '');
});

test('missing characters or nested fields render an empty string', async () => {
    const template = characterTemplate({ name: '角色', path: ['data', 'extensions', 'missing'], value: 'x' });
    assert.equal(await renderExpression(template, { getCharData: () => null }), '');
    assert.equal(await renderExpression(template, { getCharData: () => ({}) }), '');
});

test('lazy loading resolves the current index at render time and tolerates missing unshallowCharacter', async () => {
    const characters = [{ name: '其他' }, { name: '角色', shallow: true }];
    const loads = [];
    const template = characterTemplate({ name: '角色', path: ['description'], value: '完整', lazy: true });
    assert.ok(template.includes('SillyTavern.unshallowCharacter?.('));
    const context = {
        SillyTavern: { characters, unshallowCharacter: async index => {
            loads.push(index); characters[index].description = '完整';
        } }, getCharData: upstreamLookup(characters),
    };
    assert.equal(await renderExpression(template, context), '完整');
    characters.reverse();
    assert.equal(await renderExpression(template, context), '完整');
    assert.deepEqual(loads, ['1', '0']);

    // Older SillyTavern builds without unshallowCharacter do not throw TypeError.
    assert.equal(await renderExpression(template, {
        SillyTavern: { characters },
        getCharData: upstreamLookup(characters),
    }), '完整');
});

test('variableTemplate generates getvar, setvar, incvar, and if blocks across scopes', () => {
    assert.equal(
        variableTemplate({ path: ['stat', 'hp'], value: 80, action: 'getvar', scope: 'default' }),
        "<%- getvar('stat.hp') ?? '' -%>",
    );
    assert.equal(
        variableTemplate({ path: ['stat', 'hp'], value: 80, action: 'getvar', scope: 'local', trimNewline: false }),
        "<%- getvar('stat.hp', 'local') ?? '' %>",
    );
    assert.equal(
        variableTemplate({ path: ['stat', 'hp'], value: 80, action: 'setvar', scope: 'global' }),
        "<% setvar('stat.hp', 80, 'global') -%>",
    );
    assert.equal(
        variableTemplate({ customPath: 'flags.met_lin', value: undefined, action: 'incvar', scope: 'message' }),
        "<% incvar('flags.met_lin', 1, 'message') -%>",
    );
    assert.equal(
        variableTemplate({ customPath: 'flags.met_lin', action: 'if', scope: 'default' }),
        "<% if (getvar('flags.met_lin')) { -%>\n\n<% } -%>",
    );
    assert.equal(
        variableTemplate({ path: [], value: { a: 1 }, action: 'getvar' }),
        '<%- getvar(null) ?? \'\' -%>',
    );
    assert.throws(() => variableTemplate({ path: [], action: 'incvar' }), /变量路径/);
});

test('parseInitialVariables parses JSON, @@decorators, and nested YAML/key-value blocks safely', () => {
    const fromJson = parseInitialVariables('@@initial_variables\n{"stat":{"hp":100,"tags":["a","b"]}}');
    assert.deepEqual(fromJson, { stat: { hp: 100, tags: ['a', 'b'] } });

    const fromYaml = parseInitialVariables(`@@initial_variables
# 角色初始状态
stat:
  hp: 120 # 生命值
  mp: 45.5
  alive: true
  title: '月光店主'
inventory:
  - 旧地图
  - 煤油灯
__proto__:
  polluted: true
`);
    assert.deepEqual(fromYaml, {
        stat: { hp: 120, mp: 45.5, alive: true, title: '月光店主' },
        inventory: ['旧地图', '煤油灯'],
    });
    assert.equal(({}).polluted, undefined);
});

test('presetTemplate uses single-arg getpreset by default and supports static cross-preset lookup', () => {
    assert.equal(
        presetTemplate({ presetName: 'Reborn', promptName: '文风准则', promptNames: ['文风准则', '思维链'] }),
        "<%- await getpreset('文风准则') -%>",
    );
    assert.ok(
        presetTemplate({ presetName: 'Reborn', promptName: '文风', promptNames: ['文风', '文风扩展'] }).includes('new RegExp('),
    );
    const staticTpl = presetTemplate({ presetName: "O'Brien 预设", promptName: '特殊[1]', mode: 'static' });
    assert.ok(staticTpl.includes('SillyTavern.getPresetManager'));
    assert.throws(() => presetTemplate({ presetName: 'Reborn', promptName: '   ' }), /没有名称/);
});

test('quickReplyTemplate quotes set and label names and guards against overlap', () => {
    assert.equal(
        quickReplyTemplate({ setName: '全局工具', setNames: ['全局工具'], label: '状态栏', labels: ['状态栏'] }),
        "<%- await getqr('全局工具', '状态栏') -%>",
    );
    assert.ok(
        quickReplyTemplate({ setName: '工具', setNames: ['工具', '工具箱'], label: '状态', labels: ['状态'] }).includes('new RegExp('),
    );
    assert.throws(() => quickReplyTemplate({ setName: '工具', label: '' }), /没有标签/);
});

test('toStringList, safeJsonStringify, and snippetText handle malformed, circular, BigInt, and huge inputs', () => {
    assert.deepEqual(toStringList('月光, 街区，旧城 , '), ['月光', '街区', '旧城']);
    assert.deepEqual(toStringList([' a ', '', null, 'b']), ['a', 'b']);
    assert.deepEqual(toStringList(null), []);

    const circular = { count: 10n };
    circular.self = circular;
    const json = safeJsonStringify(circular);
    assert.ok(json.includes('"10"'));
    assert.ok(json.includes('[Circular]'));

    const huge = '甲乙丙丁\n\n   '.repeat(20000);
    const start = performance.now();
    const snip = snippetText(huge, 80);
    assert.ok(performance.now() - start < 50);
    assert.equal(snip.length, 80);
});

test('blank titles are rejected, duplicates are reported without substituting UID', () => {
    assert.throws(() => worldTemplate('书', '   '), /标题/);
    assert.ok(duplicateWarning('条目', ['条目', '条目'], '条目').includes('第一个'));
    assert.equal(duplicateWarning('   ', ['   ', '   '], '条目'), '');
    assert.equal(worldTemplate('书', '条目', ['条目', '条目']), "<%- await getwi('书', '条目') -%>");
});

test('field search finds collapsed descendants, ignores whitespace-only queries, and handles circular data', () => {
    const data = { data: { alternate_greetings: ['第一条', '第二条'] }, description: '你好' };
    const collapsed = fieldRows(data);
    assert.ok(!collapsed.some(row => row.path.length === 3));
    const whitespaceOnly = fieldRows(data, { query: '   ' });
    assert.deepEqual(whitespaceOnly.map(r => r.path), collapsed.map(r => r.path));
    assert.equal(prepareSearchWords('   '), null);
    assert.equal(matchesPrecomputed(null, 'anything'), true);

    const searched = fieldRows(data, { query: '第二条' });
    assert.deepEqual(searched.map(row => row.path), [['data', 'alternate_greetings', 1]]);
    const expanded = fieldRows(data, { expanded: new Set(['["data"]', '["data","alternate_greetings"]']) });
    assert.ok(expanded.some(row => row.path.at(-1) === 1));
    assert.ok(matchesSearch('Ａlice 森林', 'Alice', '森林角色'));

    const cyclic = { a: 1 };
    cyclic.loop = cyclic;
    const cyclicRows = fieldRows(cyclic, { expanded: new Set(['["loop"]']) });
    assert.ok(cyclicRows.length >= 2);
});

test('name selectors never use world entry indices', () => {
    assert.equal(nameReference('普通条目', ['普通条目']), "'普通条目'");
    const selector = new Function(`return ${nameReference('条目', ['条目', '条目附录'])}`)();
    assert.ok(selector.test('条目'));
    assert.ok(!selector.test('条目附录'));
    const trailingNewline = new Function(`return ${nameReference('条目', ['条目', '条目\n'])}`)();
    assert.ok(!trailingNewline.test('条目\n'));
});
