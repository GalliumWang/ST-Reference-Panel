import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
    characterTemplate, worldTemplate, variableTemplate, presetTemplate, quickReplyTemplate,
} from '../core.js';

const enginePath = process.env.ST_REFERENCE_EJS_PATH;
if (!enginePath) throw new Error('Set ST_REFERENCE_EJS_PATH to ST-Prompt-Template/src/3rdparty/ejs.js');
const sandbox = { module: { exports: {} }, exports: {}, console };
vm.runInNewContext(await readFile(enginePath, 'utf8'), sandbox);
const ejs = sandbox.module.exports;
let count = 0;

for (const name of ['角色', "O'Brien", '名字\\旧', 'A[1]', 'a.b', '<%bad%>', '{{char}}', '换\n行', '1', 'map', 'toString']) {
    const characters = [{ name: name + '附录', description: 'wrong' }, { name, description: 'correct', data: { array: [false, 0, '你好'] } }];
    const names = characters.map(c => c.name);
    const getCharData = selector => selector === undefined
        ? characters[1]
        : (characters[selector] || characters.find(c => c.name === selector || c.name.match(selector)));
    const scalar = characterTemplate({ name, path: ['description'], value: 'correct', names });
    assert.equal(await ejs.compile(scalar, { async: true, client: true })({ getCharData }), 'correct');
    const array = characterTemplate({ name, path: ['data', 'array'], value: characters[1].data.array, names });
    assert.equal(await ejs.compile(array, { async: true, client: true })({ getCharData }), JSON.stringify(characters[1].data.array, null, 2));
    const book = "书 O'Brien\\<%旧%>";
    const world = worldTemplate(book, name, names);
    const getwi = (actualBook, selector) => {
        assert.equal(actualBook, book);
        return characters.find(c => c.name === selector || c.name.match(selector))?.description ?? '';
    };
    assert.equal(await ejs.compile(world, { async: true, client: true })({ getwi }), 'correct');
    count += 3;
}

// Dynamic current character
const dynChar = characterTemplate({ name: 'ignored', path: ['description'], value: 'current', dynamicCurrent: true });
assert.equal(await ejs.compile(dynChar, { async: true, client: true })({ getCharData: async () => ({ description: 'current' }) }), 'current');
count++;

// Lazy loading + optional chaining when unshallowCharacter is present or missing
const lazyCharacters = [{ name: '角色', shallow: true }];
const lazyTemplate = characterTemplate({ name: '角色', path: ['data', 'alternate_greetings', 0], value: '你好', lazy: true });
const lazyResult = await ejs.compile(lazyTemplate, { async: true, client: true })({
    SillyTavern: { characters: lazyCharacters, unshallowCharacter: async index => {
        lazyCharacters[index].data = { alternate_greetings: ['你好'] };
    } }, getCharData: () => lazyCharacters[0],
});
assert.equal(lazyResult, '你好');
count++;

// Missing character / null container renders '' (not "null")
const missing = characterTemplate({ name: '已删除角色', path: ['data', 'field'], value: ['a'] });
assert.equal(await ejs.compile(missing, { async: true, client: true })({ getCharData: () => null }), '');
count++;

// World UID, primaryBook, and activewi
const wiUid = worldTemplate('主世界书', '月光', [], { lookup: 'uid', uid: 12 });
assert.equal(await ejs.compile(wiUid, { async: true, client: true })({
    getwi: async (book, uid) => `${book}#${typeof uid}:${uid}`,
}), '主世界书#number:12');
const wiPrimary = worldTemplate('主世界书', '月光', [], { primaryBook: true });
assert.equal(await ejs.compile(wiPrimary, { async: true, client: true })({
    getwi: async title => `primary:${title}`,
}), 'primary:月光');
const activated = [];
const wiActive = worldTemplate('主世界书', '月光', [], { action: 'activewi', lookup: 'uid', uid: 7 }) + 'OK';
assert.equal(await ejs.compile(wiActive, { async: true, client: true })({
    activewi: async (book, uid) => { activated.push([book, uid]); },
}), 'OK');
assert.deepEqual(activated, [['主世界书', 7]]);
count += 3;

// Variables: getvar, setvar, incvar, if (getvar(...))
const store = { 'stat.hp': 80, 'flags.met': true };
const varCtx = {
    getvar: (key) => store[key],
    setvar: (key, val) => { store[key] = val; },
    incvar: (key, delta) => { store[key] = (store[key] ?? 0) + delta; },
};
assert.equal(await ejs.compile(variableTemplate({ customPath: 'stat.hp', value: 80, action: 'getvar' }), { async: true, client: true })(varCtx), '80');
await ejs.compile(variableTemplate({ customPath: 'stat.hp', value: 95, action: 'setvar', scope: 'local' }), { async: true, client: true })(varCtx);
assert.equal(store['stat.hp'], 95);
await ejs.compile(variableTemplate({ customPath: 'stat.hp', action: 'incvar' }), { async: true, client: true })(varCtx);
assert.equal(store['stat.hp'], 96);
const ifTpl = variableTemplate({ customPath: 'flags.met', action: 'if' }).replace('\n\n', '\n命中分支\n');
assert.equal((await ejs.compile(ifTpl, { async: true, client: true })(varCtx)).trim(), '命中分支');
count += 4;

// Presets (1-arg getpreset & static lookup) and QuickReply (getqr)
const presetCurrent = presetTemplate({ presetName: 'Reborn', promptName: '文风准则', mode: 'current' });
assert.equal(await ejs.compile(presetCurrent, { async: true, client: true })({
    getpreset: async (name, data) => {
        assert.equal(name, '文风准则');
        assert.equal(data, undefined);
        return '自然克制';
    },
}), '自然克制');

const presetStatic = presetTemplate({ presetName: '备用预设', promptName: '思维链', mode: 'static' });
assert.equal(await ejs.compile(presetStatic, { async: true, client: true })({
    SillyTavern: {
        getPresetManager: () => ({
            getPresetList: () => ({
                preset_names: ['Reborn', '备用预设'],
                presets: [{ prompts: [] }, { prompts: [{ name: '思维链', content: '<thinking>' }] }],
            }),
        }),
    },
}), '<thinking>');

const qrTpl = quickReplyTemplate({ setName: '全局工具', label: '状态栏' });
assert.equal(await ejs.compile(qrTpl, { async: true, client: true })({
    getqr: async (set, label) => `${set}/${label}`,
}), '全局工具/状态栏');
count += 3;

console.log(`Upstream EJS integration: all ${count} v1.1.0 templates compiled and rendered cleanly.`);
