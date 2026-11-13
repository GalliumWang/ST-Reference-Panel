import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ST_REFERENCE_TEST_MODULES
    ? join(process.env.ST_REFERENCE_TEST_MODULES, 'playwright') : 'playwright');
const base = '/scripts/extensions/third-party/ST-Reference-Panel/';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.ST_REFERENCE_OUTPUT || join(dirname(root), 'reference-panel-verification');
await mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/avatar.svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="88"><rect width="72" height="88" rx="8" fill="#48635d"/><circle cx="36" cy="30" r="14" fill="#b8d0bd"/><path d="M12 82C12 46 60 46 60 82" fill="#b8d0bd"/></svg>');
        return;
    }
    if (route === '/scripts/world-info.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end('export const world_names = window.fixtureWorldNames(); export const loadWorldInfo = window.fixtureLoadWorld;');
        return;
    }
    let file;
    if (route === '/') file = join(root, 'tests', 'fixtures.html');
    else if (route.startsWith(base)) {
        const name = route.slice(base.length);
        if (['index.js', 'panel.js', 'core.js', 'adapter.js', 'clipboard.js', 'style.css'].includes(name)) file = join(root, name);
    }
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript');
        res.end(await readFile(file));
    } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
const passed = label => { ++checks; console.log(`PASS ${label}`); };

function target(page, name) {
    return page.locator('.srp-target').filter({ has: page.getByText(name, { exact: true }) }).first();
}
async function open(page) { await page.locator('#st-reference-panel-menu').click(); }
async function chooseCharacter(page, name) {
    await page.getByRole('tab', { name: '角色卡', exact: true }).click();
    const details = page.locator('.srp-sources');
    if (!await details.evaluate(node => node.open)) await details.locator('summary').first().click();
    await page.getByRole('searchbox', { name: '搜索角色', exact: true }).fill(name);
    await page.locator('.srp-source').filter({ has: page.getByText(name, { exact: true }) }).click();
    await target(page, '描述').waitFor();
}
async function chooseBook(page, name) {
    await page.getByRole('tab', { name: '世界书', exact: true }).click();
    const details = page.locator('.srp-sources');
    if (!await details.evaluate(node => node.open)) await details.locator('summary').first().click();
    await page.getByRole('searchbox', { name: '搜索世界书', exact: true }).fill(name);
    await page.locator('.srp-source').filter({ has: page.getByText(name, { exact: true }) }).click();
}
async function fit(page, label) {
    const dimensions = await page.locator('.srp-dialog').evaluate(dialog => {
        const footer = dialog.querySelector('.srp-footer').getBoundingClientRect();
        const rect = dialog.getBoundingClientRect();
        return { overflows: dialog.scrollWidth > dialog.clientWidth + 1, left: rect.left, right: rect.right,
            top: footer.top, bottom: footer.bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(dimensions.overflows, false, `${label}: horizontal overflow`);
    assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width + 1, `${label}: dialog bounds`);
    assert.ok(dimensions.top >= 0 && dimensions.bottom <= dimensions.height + 1, `${label}: copy footer bounds`);
}

let lastPage;
try {
    browser = await chromium.launch({ channel: process.env.ST_REFERENCE_BROWSER || 'chrome', headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1365, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await desktop.newPage();
    lastPage = page;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await open(page);

    // Context-aware group pins active character at top without duplicating .srp-source nodes
    assert.equal(await page.locator('.srp-context-group .srp-badge').first().textContent(), '当前角色');
    assert.equal(await page.locator('.srp-source').count(), 60);
    await page.getByRole('button', { name: /显示更多（还有/ }).click();
    assert.equal(await page.locator('.srp-source').count(), 76);
    // Searching by SillyTavern UI tagMap finds 林晚
    await page.getByRole('searchbox', { name: '搜索角色', exact: true }).fill('书店系');
    await page.waitForFunction(() => document.querySelectorAll('.srp-source').length === 1);
    await page.getByRole('searchbox', { name: '搜索角色', exact: true }).fill('');
    passed('large character list pages, context-aware pinning, and UI tagMap search without eager-loading cards');

    await chooseCharacter(page, '林晚');
    assert.deepEqual(await page.evaluate(() => window.fixtureLoads), ['lin.png']);
    await target(page, '描述').click();
    const template = await page.locator('.srp-template').inputValue();
    assert.ok(template.includes("getCharData('林晚')"));
    assert.ok(template.includes('?.description'));
    // Test character dynamicCurrent capsule
    await page.getByRole('button', { name: '动态当前角色', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- (await getCharData())?.description ?? '' %>");
    await page.getByRole('button', { name: '指定角色', exact: true }).click();

    await page.getByRole('button', { name: '复制引用', exact: true }).click();
    await page.getByText('已复制，可继续选择其他引用', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), template);
    assert.equal(await page.locator('.srp-dialog[open]').count(), 1);
    await fit(page, 'desktop');
    await page.screenshot({ path: join(output, 'desktop-character.png') });
    passed('character field copying, capsules, and real clipboard keep the dialog open');

    await target(page, '备用开场白').click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('JSON.stringify('));
    await page.getByRole('searchbox', { name: '搜索字段', exact: true }).fill('第二段问候');
    await target(page, 'data.alternate_greetings[1]').click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('?.alternate_greetings?.[1]'));
    await page.getByRole('searchbox', { name: '搜索字段', exact: true }).fill('力量');
    await target(page, "data.extensions['自定义']['力量']").click();
    assert.equal(await page.locator('.srp-source-preview').textContent(), '0');
    passed('nested fields, array items, JSON output, and zero-valued fields');

    await chooseCharacter(page, "O'Brien[旧]");
    await target(page, '描述').click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('new RegExp('));
    assert.equal(await page.evaluate(() => window.fixtureInjected), false);
    assert.equal(await page.locator('.srp-source-preview img, .srp-source-preview script').count(), 0);
    passed('special names and unexecuted raw source content');

    await chooseBook(page, '城市设定');
    await target(page, '月光街区').click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- await getwi('城市设定', '月光街区') -%>");
    await page.getByRole('button', { name: '复制引用', exact: true }).click();
    await page.getByText('已复制，可继续选择其他引用', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "<%- await getwi('城市设定', '月光街区') -%>");
    await page.screenshot({ path: join(output, 'desktop-world.png') });

    // World multi-template capsules: primaryBook, UID, activewi, preserve newline
    await page.getByRole('button', { name: '当前角色主书', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- await getwi('月光街区') -%>");
    await page.getByRole('button', { name: '按 UID', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), '<%- await getwi(0) -%>');
    await page.getByRole('button', { name: 'activewi 激活', exact: true }).click();
    await page.getByRole('button', { name: '指定书名', exact: true }).click();
    await page.getByRole('button', { name: '保留换行 %>', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<% await activewi('城市设定', 0) %>");
    // Reset world capsules
    await page.getByRole('button', { name: '按标题', exact: true }).click();
    await page.getByRole('button', { name: 'getwi 读取', exact: true }).click();
    await page.getByRole('button', { name: '吞换行 -%>', exact: true }).click();

    await page.getByRole('searchbox', { name: '搜索条目', exact: true }).fill('关系');
    await target(page, '[设定]人物关系').click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('new RegExp('));
    await page.getByRole('searchbox', { name: '搜索条目', exact: true }).fill('');
    await target(page, '月').click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('new RegExp('));
    await target(page, '（无标题）').click();
    assert.equal(await page.getByRole('button', { name: '复制引用', exact: true }).isDisabled(), true);
    assert.ok((await page.locator('.srp-warning').textContent()).includes('标题'));
    await target(page, '重复标题').click();
    assert.ok((await page.locator('.srp-warning').textContent()).includes('同名'));
    assert.ok((await page.locator('.srp-template').inputValue()).includes("'重复标题'"));
    passed('world names, capsules (primary/UID/activewi), entry search, disabled entries, blank and duplicate titles');

    // Tab 3: Variables (merged local + global + message + [InitialVariables], custom path, getvar/setvar/incvar/if)
    await page.getByRole('tab', { name: '变量 Variables', exact: true }).click();
    await target(page, 'stat').waitFor();
    await page.getByRole('button', { name: '展开 stat', exact: true }).click();
    await target(page, 'stat.maxHp').waitFor();
    await target(page, 'stat.hp').click();
    assert.equal(await page.locator('.srp-source-preview').textContent(), '85');
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- getvar('stat.hp') ?? '' -%>");
    await page.getByRole('button', { name: 'setvar', exact: true }).click();
    await page.getByRole('button', { name: 'local', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<% setvar('stat.hp', 85, 'local') -%>");
    await page.getByRole('button', { name: 'incvar', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<% incvar('stat.hp', 1, 'local') -%>");
    await page.getByRole('button', { name: 'if (getvar)', exact: true }).click();
    assert.ok((await page.locator('.srp-template').inputValue()).startsWith("<% if (getvar('stat.hp', 'local')) { -%>"));
    await page.getByLabel('自定义变量路径').fill('flags.visited_shop');
    await page.getByRole('button', { name: 'getvar', exact: true }).click();
    await page.getByRole('button', { name: '默认作用域', exact: true }).click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- getvar('flags.visited_shop') ?? '' -%>");
    await page.screenshot({ path: join(output, 'desktop-variables.png') });
    passed('variables tab aggregates all scopes + [InitialVariables] and generates getvar/setvar/incvar/if');

    // Tab 4: Presets & QuickReply v2
    await page.getByRole('tab', { name: '预设 / QR', exact: true }).click();
    await page.locator('.srp-source').filter({ has: page.getByText('Reborn 默认预设', { exact: true }) }).click();
    await target(page, '主系统提示').click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- await getpreset('主系统提示') -%>");
    await page.locator('.srp-source').filter({ has: page.getByText('备用文风预设', { exact: true }) }).click();
    await target(page, '古典文风').click();
    assert.ok((await page.locator('.srp-warning').textContent()).includes('当前已激活预设'));
    await page.getByRole('button', { name: '指定预设静态读取', exact: true }).click();
    assert.ok((await page.locator('.srp-template').inputValue()).includes('SillyTavern.getPresetManager'));
    await page.getByRole('button', { name: '当前预设 getpreset', exact: true }).click();

    await page.locator('.srp-source').filter({ has: page.getByText('全局快捷栏', { exact: true }) }).click();
    await target(page, '查看状态').click();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- await getqr('全局快捷栏', '查看状态') -%>");
    await page.screenshot({ path: join(output, 'desktop-presets.png') });
    passed('presets and QuickReply v2 tab generates single-arg getpreset, static cross-preset, and getqr');

    // Favorites, Staging Basket batch copy, and WORLDINFO_UPDATED hot sync
    await page.getByRole('button', { name: '☆ 收藏', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '★ 已收藏', exact: true }).count(), 1);
    await page.locator('.srp-preview-tools').getByRole('button', { name: '+ 暂存', exact: true }).click();
    await chooseBook(page, '城市设定');
    await page.getByRole('searchbox', { name: '搜索条目', exact: true }).fill('');
    await page.locator('.srp-target-item').first().getByRole('button', { name: '+ 暂存', exact: true }).click();
    assert.ok((await page.locator('.srp-basket').textContent()).includes('2 项'));
    await page.getByRole('button', { name: '批量复制', exact: true }).click();
    const batchClip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    assert.equal(batchClip, "<%- await getqr('全局快捷栏', '查看状态') -%>\n<%- await getwi('城市设定', '月光街区') -%>");

    // Hot sync on WORLDINFO_UPDATED while open preserves selection & search
    await target(page, '月光街区').click();
    await page.evaluate(() => {
        window.fixtureBooks['城市设定'].entries[99] = {
            uid: 99, comment: '热更新条目', key: ['热更'], content: '动态同步内容', displayIndex: 7,
        };
        window.fixtureContext.eventSource.emit('worldinfo_updated', '城市设定', window.fixtureBooks['城市设定']);
    });
    await target(page, '热更新条目').waitFor();
    assert.equal(await page.locator('.srp-template').inputValue(), "<%- await getwi('城市设定', '月光街区') -%>");
    passed('favorites, staging basket batch copy, and WORLDINFO_UPDATED hot sync');

    await chooseBook(page, '慢速世界书');
    await page.getByRole('tab', { name: '角色卡', exact: true }).click();
    await page.getByRole('tab', { name: '世界书', exact: true }).click();
    await target(page, '慢速条目').waitFor();
    await chooseBook(page, '慢速世界书');
    await chooseBook(page, '城市设定');
    await target(page, '月光街区').waitFor();
    await page.waitForFunction(() => !document.querySelector('.srp-workspace').hasAttribute('aria-busy'));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await target(page, '慢速条目').count(), 0);
    passed('rapid source/tab switching rejects stale reads and reloads interrupted selections');

    await chooseBook(page, '读取失败');
    await page.getByText('模拟读取失败', { exact: true }).waitFor();
    await page.evaluate(() => window.fixtureFailures.clear());
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await target(page, '恢复后的条目').waitFor();
    passed('failed reads recover through refresh');

    // Force both clipboard mechanisms to fail, then check selection fallback.
    await target(page, '恢复后的条目').click();
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
        document.execCommand = () => false;
    });
    await page.getByRole('button', { name: '复制引用', exact: true }).click();
    await page.getByText('自动复制失败，模板已选中，请使用系统复制菜单', { exact: true }).waitFor();
    const range = await page.locator('.srp-template').evaluate(node => [node.selectionStart, node.selectionEnd, node.value.length]);
    assert.deepEqual(range, [0, range[2], range[2]]);
    passed('clipboard denial leaves the exact template selected for manual copying');

    // Backdrop drag-select guard & #toast-container rescue before modal close
    await page.evaluate(() => {
        const dialog = document.querySelector('.srp-dialog');
        const toast = document.getElementById('toast-container');
        dialog.append(toast);
        // Simulate pointerdown inside dialog + click outside (drag-selection release on backdrop)
        dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 680, clientY: 480 }));
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 2, clientY: 2 }));
    });
    assert.equal(await page.locator('.srp-dialog[open]').count(), 1);

    await page.keyboard.press('Escape');
    await page.locator('.srp-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.srp-dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('toast-container')?.parentElement === document.body), true);
    passed('backdrop drag-selection guard and #toast-container rescue on dialog close');

    // Cursor insertion into focused host textarea + global STReferencePanel API + floating window (z-index 3200)
    await page.evaluate(() => {
        const editor = document.getElementById('send_textarea');
        editor.value = '前缀 后缀';
        editor.focus();
        editor.setSelectionRange(3, 3);
    });
    await open(page);
    assert.equal(await page.getByRole('tab', { name: '世界书', exact: true }).getAttribute('aria-selected'), 'true');
    await chooseBook(page, '城市设定');
    await target(page, '月光街区').click();
    await page.getByRole('button', { name: '插入光标处', exact: true }).click();
    assert.equal(await page.locator('#send_textarea').inputValue(), "前缀 <%- await getwi('城市设定', '月光街区') -%>后缀");

    // Cross-plugin global API: window.STReferencePanel.open({ tab, floating: true, onInsert })
    const apiCheck = await page.evaluate(async () => {
        window.insertedPayloads = [];
        await window.STReferencePanel.open({
            tab: 'worlds',
            floating: true,
            onInsert(tpl, meta) { window.insertedPayloads.push({ tpl, mode: meta?.mode }); },
        });
        const dialog = document.querySelector('.srp-dialog');
        return {
            version: window.STReferencePanel.version,
            floatingClass: dialog.classList.contains('srp-floating'),
            zIndex: getComputedStyle(dialog).zIndex,
        };
    });
    assert.equal(apiCheck.version, '1.1.0');
    assert.equal(apiCheck.floatingClass, true);
    assert.equal(apiCheck.zIndex, '3200');
    await page.getByRole('button', { name: '插入引用', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.insertedPayloads), [
        { tpl: "<%- await getwi('城市设定', '月光街区') -%>", mode: 'single' },
    ]);

    // Drag floating header far out-of-bounds and verify viewport clamping + minimize pill
    await page.evaluate(() => {
        const header = document.querySelector('.srp-header');
        header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 500, clientY: 120 }));
        header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 5000, clientY: -900 }));
        header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 5000, clientY: -900 }));
    });
    await fit(page, 'floating clamped');
    await page.getByRole('button', { name: '最小化悬浮小窗', exact: true }).click();
    assert.equal(await page.locator('.srp-mini-pill').isVisible(), true);
    await page.locator('.srp-mini-pill').click();
    assert.equal(await page.locator('.srp-mini-pill').isVisible(), false);
    await page.getByRole('button', { name: '🗖 模态窗口', exact: true }).click();
    passed('cursor insertion, window.STReferencePanel API, floating mode z-index 3200, drag clamping, and minimize pill');

    await page.getByRole('tab', { name: '世界书', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('tab', { name: '角色卡', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '关闭引用面板', exact: true }).click();
    await page.locator('.srp-dialog').waitFor({ state: 'detached' });
    await page.evaluate(() => { delete window.fixtureContext.getWorldInfoNames; delete window.fixtureContext.loadWorldInfo; });
    await open(page);
    await chooseBook(page, '城市设定');
    await target(page, '月光街区').waitFor();
    passed('keyboard tab navigation, close, and older world-info API fallback');

    await page.evaluate(async base => (await import(base + 'index.js')).onDisable(), base);
    assert.equal(await page.locator('.srp-dialog, #st-reference-panel-menu').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.STReferencePanel), 'undefined');
    assert.equal(await page.evaluate(() => window.fixtureListeners.get('worldinfo_updated')?.size ?? 0), 0);
    await page.evaluate(async base => { const module = await import(base + 'index.js'); module.onEnable(); module.onEnable(); }, base);
    assert.equal(await page.locator('#st-reference-panel-menu').count(), 1);
    assert.equal(await page.evaluate(() => window.STReferencePanel?.version), '1.1.0');
    assert.deepEqual(errors, []);
    passed('enable/disable cleanup (DOM, host event listeners, STReferencePanel global) and single menu entry');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await mobile.newPage();
    lastPage = phone;
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(url);
    await open(phone);
    assert.ok(!await phone.evaluate(() => document.activeElement instanceof HTMLInputElement));
    await chooseCharacter(phone, '林晚');
    assert.equal(await phone.locator('.srp-sources').evaluate(node => node.open), false);
    await target(phone, '描述').tap();
    await fit(phone, 'phone portrait');
    await phone.screenshot({ path: join(output, 'mobile-character.png') });
    await chooseBook(phone, '城市设定');
    await target(phone, '月光街区').tap();
    await fit(phone, 'phone world');
    await phone.screenshot({ path: join(output, 'mobile-world.png') });
    for (const [width, height] of [[320, 568], [844, 390], [768, 1024]]) {
        await phone.setViewportSize({ width, height });
        await fit(phone, `${width}×${height}`);
    }
    assert.deepEqual(errors, []);
    passed('touch selection, mobile collapse, fixed copy footer, portrait/landscape/tablet fit');
    console.log(`Browser verification: ${checks} scenarios passed. Screenshots: ${output}`);
} catch (error) {
    if (lastPage) {
        await lastPage.screenshot({ path: join(output, 'failure.png') });
        console.log(await lastPage.locator('body').innerText());
    }
    throw error;
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
