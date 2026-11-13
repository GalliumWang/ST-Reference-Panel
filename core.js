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

export function toStringList(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item ?? '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(/[,，]\s*/).map(item => item.trim()).filter(Boolean);
    }
    if (value === null || value === undefined) return [];
    const text = String(value).trim();
    return text ? [text] : [];
}

export function safeJsonStringify(value, space = 2) {
    const seen = new WeakSet();
    try {
        const result = JSON.stringify(value, (_key, current) => {
            if (typeof current === 'bigint') return current.toString();
            if (current !== null && typeof current === 'object') {
                if (seen.has(current)) return '[Circular]';
                seen.add(current);
            }
            return current;
        }, space);
        return result ?? String(value);
    } catch {
        return '[无法序列化的对象]';
    }
}

export function nameReference(name, candidates = [], { character = false, forceRegex = false } = {}) {
    // Upstream lookups evaluate `characters[name] || characters.find(c => c.name === name || c.name.match(name))`
    // and `comment === title || comment.match(title)`. Array/Object prototype keys (e.g. 'map', 'at', 'length',
    // 'toString'), numeric strings, regex metacharacters, or substring overlaps require an anchored RegExp.
    const str = String(name);
    const special = /[.*+?^${}()|[\]\\]/.test(str)
        || (character && (/^\d+$/.test(str) || str in []));
    const overlap = candidates.some(other => other !== str && String(other).includes(str));
    const end = candidates.some(other => other !== str && /[\r\n\u2028\u2029]$/.test(String(other)))
        ? '$(?![\\s\\S])' : '$';
    return forceRegex || special || overlap
        ? `new RegExp(${quoteString('^' + escapeRegex(str) + end)})`
        : quoteString(str);
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

export function lodashPath(path) {
    if (!Array.isArray(path) || !path.length) return '';
    return path.map((key, index) => {
        if (typeof key === 'number') return `[${key}]`;
        const str = String(key);
        if (/^[A-Za-z_$][\w$]*$/.test(str) && !str.includes('.')) {
            return index === 0 ? str : `.${str}`;
        }
        const escaped = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `['${escaped}']`;
    }).join('');
}

export function displayPath(path, rootLabel = '整个角色数据') {
    return path.length ? accessPath(path).replace(/^\./, '') : rootLabel;
}

export function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `数组 · ${value.length} 项`;
    if (typeof value === 'object') {
        try { return `对象 · ${Object.keys(value).length} 项`; } catch { return '对象'; }
    }
    return { string: '文本', number: '数字', boolean: '布尔值', undefined: '未设置' }[typeof value] ?? typeof value;
}

export function previewText(value) {
    if (value === undefined) return '（未设置）';
    if (value === '') return '（空文本）';
    if (value !== null && typeof value === 'object') return safeJsonStringify(value, 2);
    return String(value);
}

export function snippetText(value, maxLen = 100) {
    if (value === undefined) return '（未设置）';
    if (value === '') return '（空文本）';
    if (value === null) return 'null';
    if (typeof value === 'string') {
        // Slice before regex whitespace collapse to avoid scanning 100k+ character entries.
        return value.slice(0, Math.max(maxLen * 4, 240)).replace(/\s+/g, ' ').trim().slice(0, maxLen);
    }
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const sample = value.slice(0, 4).map(item => {
            if (item === null) return 'null';
            if (typeof item === 'object') return Array.isArray(item) ? '[…]' : '{…}';
            const text = String(item).slice(0, 24).replace(/\s+/g, ' ');
            return typeof item === 'string' ? `"${text}"` : text;
        }).join(', ');
        return `[${sample}${value.length > 4 ? ', …' : ''}]`.slice(0, maxLen);
    }
    if (typeof value === 'object') {
        let keys = [];
        try { keys = Object.keys(value); } catch { return '{…}'; }
        if (!keys.length) return '{}';
        const sample = keys.slice(0, 5).join(', ');
        return `{ ${sample}${keys.length > 5 ? ', …' : ''} }`.slice(0, maxLen);
    }
    return String(value).slice(0, maxLen);
}

export function isContainer(value) {
    return value !== null && typeof value === 'object';
}

export function normalizeSearchText(...values) {
    return values.map(value => String(value ?? '')).join(' ').normalize('NFKC').toLocaleLowerCase();
}

export function prepareSearchWords(query) {
    const raw = String(query ?? '').trim();
    if (!raw) return null;
    const words = raw.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? words : null;
}

export function matchesPrecomputed(words, normalizedText) {
    if (!words || !words.length) return true;
    const haystack = String(normalizedText ?? '');
    return words.every(word => haystack.includes(word));
}

export function matchesSearch(query, ...values) {
    const words = Array.isArray(query) ? query : prepareSearchWords(query);
    if (!words || !words.length) return true;
    const text = normalizeSearchText(...values);
    return words.every(word => text.includes(word));
}

export function fieldRows(data, { expanded = new Set(), query = '', includeRoot = true, rootLabel = '整个角色数据' } = {}) {
    const rows = [];
    const words = prepareSearchWords(query);
    const hasQuery = Boolean(words);
    const seenObjects = new WeakSet();
    // Iterative traversal avoids overflowing the stack on deeply nested or circular cards.
    const stack = [{ path: [], value: data }];
    while (stack.length) {
        const row = stack.pop();
        row.id = JSON.stringify(row.path);
        row.label = displayPath(row.path, rootLabel);
        row.container = isContainer(row.value);
        const isRoot = row.path.length === 0;
        if (!isRoot || includeRoot) {
            if (!hasQuery || matchesSearch(words, row.label, row.container ? '' : row.value)) {
                rows.push(row);
            }
        }
        if (row.container && (isRoot || hasQuery || expanded.has(row.id))) {
            if (seenObjects.has(row.value)) continue;
            seenObjects.add(row.value);
            let keys = [];
            try { keys = Object.keys(row.value); } catch { keys = []; }
            for (let i = keys.length - 1; i >= 0; i--) {
                const key = Array.isArray(row.value) && /^(0|[1-9]\d*)$/.test(keys[i]) ? Number(keys[i]) : keys[i];
                stack.push({ path: [...row.path, key], value: row.value[key] });
            }
        }
    }
    return rows;
}

export function characterTemplate({ name, path = [], value, names = [], lazy = false, dynamicCurrent = false, forceRegex = false }) {
    let read;
    if (dynamicCurrent) {
        read = 'await getCharData()';
    } else {
        if (!String(name ?? '').trim()) throw new Error('角色名称为空，无法按名称引用。');
        const selector = nameReference(name, names, { character: true, forceRegex });
        read = `await getCharData(${selector})`;
        if (lazy) {
            // Compute the index at render time, so sorting/importing cards cannot
            // turn a saved reference into a reference to a different array index.
            const index = `String(SillyTavern.characters.findIndex(c => c.name === ${quoteString(name)}))`;
            read = `await SillyTavern.unshallowCharacter?.(${index}), ${read}`;
        }
    }
    const access = `(${read})${accessPath(path, true)}`;
    // Coerce null to undefined before JSON.stringify so missing characters/null containers render '' instead of "null".
    const expression = isContainer(value) ? `JSON.stringify(${access} ?? undefined, null, 2) ?? ''` : `${access} ?? ''`;
    return `<%- ${expression} %>`;
}

export function worldTemplate(book, title, titles = [], options = {}) {
    const {
        primaryBook = false,
        lookup = 'title',
        action = 'getwi',
        trimNewline = true,
        forceRegex = false,
        uid = undefined,
    } = options ?? {};

    if (!primaryBook && !String(book ?? '').trim()) {
        throw new Error('世界书名称为空。');
    }

    const cleanTitle = String(title ?? '');
    const useUid = lookup === 'uid' || (action === 'activewi' && !cleanTitle.trim() && uid !== undefined && uid !== null && String(uid).trim() !== '');
    let selector;
    if (useUid) {
        const rawUid = String(uid ?? '').trim();
        const numericUid = Number(rawUid);
        if (!rawUid || !Number.isFinite(numericUid)) {
            throw new Error('此条目的 UID 不是有效数字，ST-Prompt-Template 无法按数字 UID 定位。');
        }
        selector = String(numericUid);
    } else {
        if (!cleanTitle.trim()) {
            throw new Error('此条目没有标题／备注，请先在世界书编辑器里填写名称，或切换为“按 UID”模式。');
        }
        selector = nameReference(cleanTitle, titles, { forceRegex });
    }

    const args = primaryBook ? selector : `${quoteString(book)}, ${selector}`;
    const close = trimNewline ? '-%>' : '%>';
    if (action === 'activewi') {
        return `<% await activewi(${args}) ${close}`;
    }
    return `<%- await getwi(${args}) ${close}`;
}

export function sampleValueLiteral(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return quoteString(value.length <= 48 ? value : '');
    if (Array.isArray(value)) return '[]';
    if (value !== null && typeof value === 'object') return '{}';
    return quoteString('');
}

export function variableTemplate({ path = [], customPath = '', value = undefined, action = 'getvar', scope = 'default', trimNewline = true }) {
    const keyPath = String(customPath ?? '').trim() || lodashPath(path);
    if (!keyPath && (action === 'incvar' || action === 'if')) {
        throw new Error('请先选择或输入具体变量路径。');
    }
    const keyExpr = keyPath ? quoteString(keyPath) : 'null';
    const validScope = ['local', 'global', 'message', 'cache', 'initial'].includes(scope) ? scope : '';
    const scopeArg = validScope ? `, ${quoteString(validScope)}` : '';
    const close = trimNewline ? '-%>' : '%>';

    if (action === 'setvar') {
        return `<% setvar(${keyExpr}, ${sampleValueLiteral(value)}${scopeArg}) ${close}`;
    }
    if (action === 'incvar') {
        return `<% incvar(${keyExpr}, 1${scopeArg}) ${close}`;
    }
    if (action === 'if') {
        return `<% if (getvar(${keyExpr}${scopeArg})) { ${close}\n\n<% } ${close}`;
    }
    const readCall = `getvar(${keyExpr}${scopeArg})`;
    const expression = isContainer(value) && keyPath
        ? `JSON.stringify(${readCall} ?? undefined, null, 2) ?? ''`
        : `${readCall} ?? ''`;
    return `<%- ${expression} ${close}`;
}

export function presetTemplate({ presetName = '', promptName = '', promptNames = [], mode = 'current', trimNewline = true, forceRegex = false }) {
    if (!String(promptName ?? '').trim()) {
        throw new Error('此预设条目没有名称，无法生成引用。');
    }
    const close = trimNewline ? '-%>' : '%>';
    if (mode === 'static') {
        if (!String(presetName ?? '').trim()) throw new Error('预设名称为空，无法生成指定预设读取模板。');
        const pName = quoteString(presetName);
        const itemName = quoteString(promptName);
        return `<%- ((() => { const pm = SillyTavern.getPresetManager?.('openai') ?? SillyTavern.getPresetManager?.(); const list = pm?.getPresetList?.(); const idx = Array.isArray(list?.preset_names) ? list.preset_names.indexOf(${pName}) : list?.preset_names?.[${pName}]; return list?.presets?.[idx]?.prompts?.find(p => p?.name === ${itemName})?.content ?? ''; })()) ${close}`;
    }
    // Upstream ST-Prompt-Template `getpreset(name, data = {})` accepts a single prompt name (string | RegExp)
    // and reads from the currently active Chat Completion preset (`oai_settings.prompts`).
    const selector = nameReference(promptName, promptNames, { forceRegex });
    return `<%- await getpreset(${selector}) ${close}`;
}

export function quickReplyTemplate({ setName = '', setNames = [], label = '', labels = [], trimNewline = true, forceRegex = false }) {
    if (!String(setName ?? '').trim()) throw new Error('快速回复集合名称为空。');
    if (!String(label ?? '').trim()) throw new Error('此快速回复条目没有标签（label），无法按标签引用。');
    const setSelector = nameReference(setName, setNames, { forceRegex });
    const labelSelector = nameReference(label, labels, { forceRegex });
    const close = trimNewline ? '-%>' : '%>';
    return `<%- await getqr(${setSelector}, ${labelSelector}) ${close}`;
}

function parseScalarValue(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null' || trimmed === '~') return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { return JSON.parse(trimmed); } catch { /* Fall through to unquoted handling. */ }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
}

export function parseInitialVariables(rawText) {
    if (typeof rawText !== 'string') return {};
    let text = rawText.replace(/^\uFEFF/, '');
    // Strip leading @@decorators used by ST-Prompt-Template (e.g. @@initial_variables).
    const lines = text.split(/\r?\n/);
    let startIdx = 0;
    while (startIdx < lines.length && lines[startIdx].trim().startsWith('@@')) {
        startIdx++;
    }
    text = lines.slice(startIdx).join('\n').trim();
    if (!text) return {};

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* Fall back to lightweight YAML / key-value parser. */ }

    const root = {};
    const stack = [{ indent: -1, target: root, lastKey: null, parent: null, parentKey: null }];
    for (const rawLine of lines.slice(startIdx)) {
        if (!rawLine.trim() || /^\s*#/.test(rawLine) || /^\s*<%/.test(rawLine)) continue;
        const indent = rawLine.match(/^ */)?.[0].length ?? 0;
        const trimmed = rawLine.trim();
        // Strip trailing inline comments outside quotes.
        const uncommented = trimmed.replace(/\s+#[^"'`]*$/, '').trim();

        while (stack.length > 1 && indent <= stack.at(-1).indent) {
            stack.pop();
        }
        const current = stack.at(-1);
        if (!current || !current.target) continue;

        if (uncommented.startsWith('- ')) {
            const itemVal = parseScalarValue(uncommented.slice(2));
            if (Array.isArray(current.target)) {
                current.target.push(itemVal);
            } else if (current.lastKey !== null) {
                if (!Array.isArray(current.target[current.lastKey])) {
                    current.target[current.lastKey] = [];
                }
                current.target[current.lastKey].push(itemVal);
            } else if (current.parent && current.parentKey) {
                const list = [itemVal];
                current.parent[current.parentKey] = list;
                current.target = list;
            }
            continue;
        }

        if (Array.isArray(current.target)) continue;
        const colonIndex = uncommented.indexOf(':');
        if (colonIndex <= 0) continue;
        const rawKey = uncommented.slice(0, colonIndex).trim().replace(/^['"]|['"]$/g, '');
        const rest = uncommented.slice(colonIndex + 1).trim();
        if (!rawKey || rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') {
            if (!rest) stack.push({ indent, target: null, lastKey: null, parent: null, parentKey: null });
            continue;
        }
        if (!rest) {
            const child = {};
            current.target[rawKey] = child;
            current.lastKey = rawKey;
            stack.push({ indent, target: child, lastKey: null, parent: current.target, parentKey: rawKey });
        } else {
            current.target[rawKey] = parseScalarValue(rest);
            current.lastKey = rawKey;
        }
    }
    return root;
}

export function duplicateWarning(name, names, kind) {
    if (!String(name ?? '').trim()) return '';
    return names.filter(other => other === name).length > 1
        ? `存在同名${kind}。名称引用会读取原插件找到的第一个同名目标，可能与当前预览不同；请先区分名称。`
        : '';
}

export function uidOverlapWarning(uid, entries = [], currentEntry = null) {
    const rawUid = String(uid ?? '').trim();
    const numericUid = Number(rawUid);
    if (!rawUid || !Number.isFinite(numericUid)) return '';
    const needle = String(numericUid);
    const sameUid = entries.filter(item => item && item !== currentEntry && Number(item.uid) === numericUid);
    if (sameUid.length) {
        return `存在相同 UID（${needle}）的条目，运行时将命中排序靠前的第一条。`;
    }
    const commentHit = entries.find(item => item && item !== currentEntry && String(item.comment ?? '').includes(needle));
    if (commentHit) {
        return `注意：同世界书条目“${commentHit.comment}”标题含数字“${needle}”。原插件同时执行 comment.match(uid)，若该条目排序更靠前可能被优先命中。`;
    }
    return '';
}
