export async function copyText(text, textarea) {
    if (!text) return false;
    const canUseAsyncClipboard = globalThis.isSecureContext !== false
        && typeof globalThis.navigator?.clipboard?.writeText === 'function';
    if (canUseAsyncClipboard) {
        try {
            await globalThis.navigator.clipboard.writeText(text);
            return true;
        } catch {
            /* Blocked permissions or browser policy: fall through to synchronous selection copy. */
        }
    }
    if (!textarea) return false;
    const previousFocus = globalThis.document?.activeElement;
    const wasReadOnly = Boolean(textarea.readOnly);
    let copied = false;
    try {
        // Older mobile WebViews / Safari under LAN HTTP may ignore execCommand('copy') on readOnly controls.
        if (wasReadOnly) textarea.readOnly = false;
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange?.(0, text.length);
        copied = Boolean(globalThis.document?.execCommand?.('copy'));
    } catch {
        copied = false;
    } finally {
        if (wasReadOnly) textarea.readOnly = true;
    }
    if (copied) {
        if (previousFocus && previousFocus !== textarea && typeof previousFocus.focus === 'function') {
            previousFocus.focus({ preventScroll: true });
        }
    } else {
        // Keep selection active and bring the template box into view for manual system-menu copying.
        try {
            textarea.focus({ preventScroll: true });
            textarea.select();
            textarea.setSelectionRange?.(0, text.length);
            textarea.scrollIntoView?.({ block: 'nearest' });
        } catch { /* Ignore detached or non-DOM test doubles. */ }
    }
    return copied;
}

export function isEditableElement(node) {
    if (!node || typeof node !== 'object' || !node.isConnected) return false;
    if (node.disabled || node.readOnly) return false;
    const tag = String(node.tagName ?? '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
        const type = String(node.type || 'text').toLowerCase();
        return ['text', 'search', 'url', 'tel', 'email', ''].includes(type);
    }
    return Boolean(node.isContentEditable);
}

export function insertAtEditable(target, text) {
    if (!text || !isEditableElement(target)) return false;
    try {
        target.focus?.({ preventScroll: true });
        if (typeof target.value === 'string') {
            const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
            const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
            if (typeof target.setRangeText === 'function') {
                target.setRangeText(text, start, end, 'end');
            } else {
                target.value = target.value.slice(0, start) + text + target.value.slice(end);
                const caret = start + text.length;
                target.setSelectionRange?.(caret, caret);
            }
            const EventCtor = target.ownerDocument?.defaultView?.Event ?? globalThis.Event;
            if (typeof EventCtor === 'function') {
                target.dispatchEvent(new EventCtor('input', { bubbles: true }));
                target.dispatchEvent(new EventCtor('change', { bubbles: true }));
            }
            return true;
        }
        if (target.isContentEditable) {
            const doc = target.ownerDocument ?? globalThis.document;
            if (doc?.execCommand?.('insertText', false, text)) return true;
            target.textContent = (target.textContent ?? '') + text;
            return true;
        }
    } catch {
        return false;
    }
    return false;
}
