// Pure template generation; browsing the panel never evaluates character/lorebook code.
export const COMMON_FIELDS = [
    ['描述', ['description']],
    ['性格', ['personality']],
    ['场景', ['scenario']],
    ['开场白', ['first_mes']],
    ['示例对话', ['mes_example']],
    ['系统提示词', ['data', 'system_prompt']],
    ['历史后指令', ['data', 'post_history_instructions']],
    ['作者备注', ['data', 'creator_notes']],
    ['备用开场白', ['data', 'alternate_greetings']],
    ['深度提示词', ['data', 'extensions', 'depth_prompt', 'prompt']],
];

export function quoteString(value) {
    // Escape EJS delimiters and ST macro braces as well as JavaScript characters.
    const escapes = { "'": "\\'", '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t',
        '<': '\\x3C', '>': '\\x3E', '{': '\\x7B', '}': '\\x7D' };
    return "'" + String(value).replace(/[\x00-\x1f\x7f'\\<>{}\u2028\u2029]/g, c =>
        escapes[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + "'";
}

export function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nameReference(name, candidates = [], { character = false } = {}) {
    // The upstream lookup also applies String.match(name). A literal name can
    // therefore select a longer name, interpret punctuation, or index an array.
    const special = /[.*+?^${}()|[\]\\]/.test(name) || (character && /^\d+$/.test(name));
    const overlap = candidates.some(other => other !== name && String(other).includes(name));
    const end = candidates.some(other => other !== name && /[\r\n\u2028\u2029]$/.test(other))
        ? '$(?![\\s\\S])' : '$';
    return special || overlap
        ? `new RegExp(${quoteString('^' + escapeRegex(name) + end)})`
        : quoteString(name);
}

export function getAtPath(data, path) {
    let value = data;
    for (const key of path) {
        if (value == null || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
    }
    return value;
}

export function accessPath(path, optional = false) {
    return path.map(key => {
        if (typeof key === 'number') return `${optional ? '?.' : ''}[${key}]`;
        if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${optional ? '?.' : '.'}${key}`;
        return `${optional ? '?.' : ''}[${quoteString(key)}]`;
    }).join('');
}

export function displayPath(path) {
    return path.length ? accessPath(path).replace(/^\./, '') : '整个角色数据';
}

export function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `数组 · ${value.length} 项`;
    if (typeof value === 'object') return `对象 · ${Object.keys(value).length} 项`;
    return { string: '文本', number: '数字', boolean: '布尔值', undefined: '未设置' }[typeof value] ?? typeof value;
}

export function previewText(value) {
    if (value === undefined) return '（未设置）';
    if (value === '') return '（空文本）';
    if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

export function isContainer(value) {
    return value !== null && typeof value === 'object';
}

export function matchesSearch(query, ...values) {
    const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
    const text = normalize(values.join(' '));
    return normalize(query).trim().split(/\s+/).every(word => text.includes(word));
}

export function fieldRows(data, { expanded = new Set(), query = '' } = {}) {
    const rows = [];
    // Iterative traversal avoids overflowing the stack on deeply nested cards.
    const stack = [{ path: [], value: data }];
    while (stack.length) {
        const row = stack.pop();
        row.id = JSON.stringify(row.path);
        row.label = displayPath(row.path);
        row.container = isContainer(row.value);
        if (!query || matchesSearch(query, row.label, row.container ? '' : row.value)) rows.push(row);
        if (row.container && (row.path.length === 0 || query || expanded.has(row.id))) {
            const keys = Object.keys(row.value);
            for (let i = keys.length - 1; i >= 0; i--) {
                const key = Array.isArray(row.value) && /^(0|[1-9]\d*)$/.test(keys[i]) ? Number(keys[i]) : keys[i];
                stack.push({ path: [...row.path, key], value: row.value[key] });
            }
        }
    }
    return rows;
}

export function characterTemplate({ name, path, value, names = [], lazy = false }) {
    if (!String(name).trim()) throw new Error('角色名称为空，无法按名称引用。');
    const selector = nameReference(name, names, { character: true });
    let read = `await getCharData(${selector})`;
    if (lazy) {
        // Compute the index at render time, so sorting/importing cards cannot
        // turn a saved reference into a reference to a different array index.
        const index = `String(SillyTavern.characters.findIndex(c => c.name === ${quoteString(name)}))`;
        read = `await SillyTavern.unshallowCharacter(${index}), ${read}`;
    }
    const access = `(${read})${accessPath(path, true)}`;
    const expression = isContainer(value) ? `JSON.stringify(${access}, null, 2) ?? ''` : `${access} ?? ''`;
    return `<%- ${expression} %>`;
}

export function worldTemplate(book, title, titles = []) {
    if (!String(book).trim()) throw new Error('世界书名称为空。');
    if (!String(title).trim()) throw new Error('此条目没有标题／备注，请先在世界书编辑器里填写名称。');
    return `<%- await getwi(${quoteString(book)}, ${nameReference(title, titles)}) -%>`;
}

export function duplicateWarning(name, names, kind) {
    return names.filter(other => other === name).length > 1
        ? `存在同名${kind}。名称引用会读取原插件找到的第一个同名目标，可能与当前预览不同；请先区分名称。`
        : '';
}
