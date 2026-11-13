import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyText, isEditableElement, insertAtEditable } from '../clipboard.js';

test('LAN HTTP (!isSecureContext) skips async clipboard, temporarily unlocks readOnly, and restores focus', async () => {
    const prevSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const prevDoc = globalThis.document;

    let asyncCalled = false;
    let readOnlyDuringExec = null;
    let restoredFocus = false;

    const triggerBtn = {
        focus() { restoredFocus = true; },
    };
    const textarea = {
        readOnly: true,
        focused: false,
        range: null,
        focus() { this.focused = true; },
        select() {},
        setSelectionRange(s, e) { this.range = [s, e]; },
    };

    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async () => { asyncCalled = true; } } },
    });
    globalThis.document = {
        activeElement: triggerBtn,
        execCommand(cmd) {
            assert.equal(cmd, 'copy');
            readOnlyDuringExec = textarea.readOnly;
            return true;
        },
    };

    try {
        const ok = await copyText('hello', textarea);
        assert.equal(ok, true);
        assert.equal(asyncCalled, false);
        assert.equal(readOnlyDuringExec, false);
        assert.equal(textarea.readOnly, true);
        assert.equal(restoredFocus, true);
    } finally {
        if (prevSecure) Object.defineProperty(globalThis, 'isSecureContext', prevSecure);
        else delete globalThis.isSecureContext;
        if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav);
        else delete globalThis.navigator;
        globalThis.document = prevDoc;
    }
});

test('failed copy keeps template selected and scrolls textarea into view for manual system copy', async () => {
    const prevSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    const prevDoc = globalThis.document;
    let scrolled = false;
    const textarea = {
        readOnly: true,
        range: null,
        focus() {},
        select() {},
        setSelectionRange(s, e) { this.range = [s, e]; },
        scrollIntoView() { scrolled = true; },
    };
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    globalThis.document = { execCommand: () => false };

    try {
        const ok = await copyText('abcdef', textarea);
        assert.equal(ok, false);
        assert.deepEqual(textarea.range, [0, 6]);
        assert.equal(textarea.readOnly, true);
        assert.equal(scrolled, true);
    } finally {
        if (prevSecure) Object.defineProperty(globalThis, 'isSecureContext', prevSecure);
        else delete globalThis.isSecureContext;
        globalThis.document = prevDoc;
    }
});

test('insertAtEditable inserts at selection range and emits input + change events', () => {
    const events = [];
    const editor = {
        isConnected: true,
        disabled: false,
        readOnly: false,
        tagName: 'TEXTAREA',
        value: '前缀 [替换区] 后缀',
        selectionStart: 3,
        selectionEnd: 8,
        focused: false,
        focus() { this.focused = true; },
        setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
        dispatchEvent(ev) { events.push(ev.type); },
    };
    assert.equal(isEditableElement(editor), true);
    assert.equal(isEditableElement({ ...editor, readOnly: true }), false);
    assert.equal(isEditableElement({ ...editor, isConnected: false }), false);

    const ok = insertAtEditable(editor, '<%- getvar("hp") -%>');
    assert.equal(ok, true);
    assert.equal(editor.value, '前缀 <%- getvar("hp") -%> 后缀');
    assert.deepEqual(events, ['input', 'change']);
});
