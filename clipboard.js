export async function copyText(text, textarea) {
    if (!text) return false;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* LAN HTTP, blocked permissions, or unsupported browser: try selection. */ }
    const previousFocus = document.activeElement;
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Leave the text selected. */ }
    if (copied) previousFocus?.focus({ preventScroll: true });
    return copied;
}
