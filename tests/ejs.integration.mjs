import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { characterTemplate, worldTemplate } from '../core.js';

const enginePath = process.env.ST_REFERENCE_EJS_PATH;
if (!enginePath) throw new Error('Set ST_REFERENCE_EJS_PATH to ST-Prompt-Template/src/3rdparty/ejs.js');
const sandbox = { module: { exports: {} }, exports: {}, console };
vm.runInNewContext(await readFile(enginePath, 'utf8'), sandbox);
const ejs = sandbox.module.exports;
let count = 0;
for (const name of ['角色', "O'Brien", '名字\\旧', 'A[1]', 'a.b', '<%bad%>', '{{char}}', '换\n行', '1']) {
    const characters = [{ name: name + '附录', description: 'wrong' }, { name, description: 'correct', data: { array: [false, 0, '你好'] } }];
    const names = characters.map(c => c.name);
    const getCharData = selector => characters[selector] || characters.find(c => c.name === selector || c.name.match(selector));
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
console.log(`Upstream EJS integration: ${count} templates compiled and rendered correctly.`);

const lazyCharacters = [{ name: '角色', shallow: true }];
const lazyTemplate = characterTemplate({ name: '角色', path: ['data', 'alternate_greetings', 0], value: '你好', lazy: true });
const lazyResult = await ejs.compile(lazyTemplate, { async: true, client: true })({
    SillyTavern: { characters: lazyCharacters, unshallowCharacter: async index => {
        lazyCharacters[index].data = { alternate_greetings: ['你好'] };
    } }, getCharData: () => lazyCharacters[0],
});
assert.equal(lazyResult, '你好');
const missing = characterTemplate({ name: '已删除角色', path: ['data', 'field'], value: 'x' });
assert.equal(await ejs.compile(missing, { async: true, client: true })({ getCharData: () => null }), '');
console.log('Upstream EJS integration: lazy loading and missing nested fields also passed (29 templates total).');
