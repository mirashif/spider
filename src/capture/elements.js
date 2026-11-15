// Runs in the page, as a string (so tsx never rewrites it). Called as (SCRIPT)({ maxHeight, limit }).
// Returns the elements a person would point at: controls, headings, landmarks, images, then text, up to `limit`.
({ maxHeight, limit }) => {
    const groups = [
        ['interactive', 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=option],[contenteditable="true"]'],
        ['heading', 'h1,h2,h3,h4,h5,h6,[role=heading]'],
        ['landmark', 'header,nav,main,aside,footer,form,dialog[open],[role=dialog],[role=alertdialog],[role=navigation],[role=main],[role=banner],[role=region][aria-label],[role=alert],[role=status],table'],
        ['image', 'img[alt]:not([alt=""]),svg[aria-label],[role=img][aria-label]'],
        // Text: whatever element actually holds the words (a span in a table cell, a time, a badge), plus test ids.
        ['text', '*'],
    ];
    const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'BODY', 'HEAD', 'TITLE', 'OPTION']);
    const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', IMG: 'img', TABLE: 'table', LI: 'listitem', SUMMARY: 'button', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };
    const SOURCE_ATTRS = ['data-source', 'data-source-file', 'data-insp-path', 'data-inspector-relative-path', 'data-locator', 'data-component-file'];
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

    const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.split(' ')[0];
        if (el.tagName === 'INPUT') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox' || t === 'radio') return t;
            if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
            if (t === 'range') return 'slider';
            return t === 'search' ? 'searchbox' : 'textbox';
        }
        if (el.tagName === 'A' && !el.hasAttribute('href')) return undefined;
        return IMPLICIT[el.tagName];
    };

    const nameOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return clean(aria);
        const by = el.getAttribute('aria-labelledby');
        if (by) {
            const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
            if (clean(text)) return clean(text);
        }
        if (el.matches('input,select,textarea')) {
            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label && clean(label.textContent)) return clean(label.textContent);
            }
            const wrap = el.closest('label');
            if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
            if (el.getAttribute('placeholder')) return clean(el.getAttribute('placeholder'));
            if (el.type === 'submit' || el.type === 'button') return clean(el.value);
        }
        if (el.tagName === 'IMG') return clean(el.getAttribute('alt'));
        const text = clean(el.innerText || el.textContent);
        if (text) return text;
        return clean(el.getAttribute('title')) || undefined;
    };

    const isGeneratedId = (id) => /\d{3,}|^[a-z]{0,3}[-_:]?[a-z0-9]{8,}$|^radix-|^headlessui-|^:r/i.test(id);
    const unique = (sel) => {
        try {
            return document.querySelectorAll(sel).length === 1;
        } catch {
            return false;
        }
    };
    const selectorOf = (el) => {
        const testId = el.getAttribute('data-testid');
        if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`)) return `[data-testid="${CSS.escape(testId)}"]`;
        if (el.id && !isGeneratedId(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
        const parts = [];
        let node = el;
        for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
            const tid = node.getAttribute('data-testid');
            if (node !== el && tid && unique(`[data-testid="${CSS.escape(tid)}"]`)) {
                parts.unshift(`[data-testid="${CSS.escape(tid)}"]`);
                break;
            }
            if (node !== el && node.id && !isGeneratedId(node.id) && unique(`#${CSS.escape(node.id)}`)) {
                parts.unshift(`#${CSS.escape(node.id)}`);
                break;
            }
            const tag = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (!parent || tag === 'body') {
                parts.unshift(tag);
                break;
            }
            const same = [...parent.children].filter((c) => c.tagName === node.tagName);
            parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
            const sel = parts.join(' > ');
            if (unique(sel)) return sel;
            node = parent;
        }
        return parts.join(' > ');
    };

    // The same element in every row of a table or list: anchored at the nearest test id or id, row index dropped.
    // "td:nth-of-type(4) time" in [data-testid=admins-table] covers the whole Last sign-in column.
    const groupOf = (el) => {
        if (!el.closest('tr,li')) return undefined;
        const parts = [];
        let node = el;
        for (let depth = 0; node && node.nodeType === 1 && depth < 10; depth++) {
            const tid = node.getAttribute('data-testid');
            if (node !== el && tid && unique(`[data-testid="${CSS.escape(tid)}"]`)) {
                parts.unshift(`[data-testid="${CSS.escape(tid)}"]`);
                break;
            }
            if (node !== el && node.id && !isGeneratedId(node.id) && unique(`#${CSS.escape(node.id)}`)) {
                parts.unshift(`#${CSS.escape(node.id)}`);
                break;
            }
            const tag = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (!parent || tag === 'body') break;
            const same = [...parent.children].filter((c) => c.tagName === node.tagName);
            parts.unshift(same.length > 1 && tag !== 'tr' && tag !== 'li' ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
            node = parent;
        }
        const sel = parts.join(' > ');
        try {
            const n = document.querySelectorAll(sel).length;
            return n > 1 && n < 500 ? sel : undefined;
        } catch {
            return undefined;
        }
    };

    const visible = (el, rect) => {
        if (rect.width < 1 || rect.height < 1) return false;
        if (rect.bottom + scrollY < 0 || rect.top + scrollY > maxHeight) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };

    const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && clean(n.textContent));

    const out = [];
    const taken = new Set();
    for (const [kind, query] of groups) {
        for (const el of document.querySelectorAll(query)) {
            if (out.length >= limit) break;
            if (taken.has(el) || el.closest('[data-spider]')) continue;
            if (kind === 'text' && (SKIP_TEXT.has(el.tagName) || (!ownText(el) && !el.hasAttribute('data-testid')))) continue;
            // Text inside a control is already described by the control.
            if (kind === 'text' && el.closest('a[href],button,[role=button],[role=link],label')?.matches(':not(label)')) continue;
            const rect = el.getBoundingClientRect();
            if (!visible(el, rect)) continue;
            taken.add(el);
            const name = nameOf(el);
            const info = {
                id: out.length,
                kind,
                tag: el.tagName.toLowerCase(),
                selector: selectorOf(el),
                box: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
            };
            const role = roleOf(el);
            if (role) info.role = role;
            if (name) info.name = cut(name, 120);
            const testId = el.getAttribute('data-testid');
            if (testId) info.testId = testId;
            const group = kind === 'text' || kind === 'image' ? groupOf(el) : undefined;
            if (group) info.group = group;
            if (el.tagName === 'A' && el.href) info.href = el.href;
            if (kind === 'interactive' || kind === 'heading') {
                const s = getComputedStyle(el);
                info.styles = { font: `${s.fontSize}/${s.fontWeight} ${s.fontFamily.split(',')[0].replace(/["']/g, '').trim()}`, color: s.color };
                if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') info.styles.background = s.backgroundColor;
                if (s.borderRadius && s.borderRadius !== '0px') info.styles.radius = s.borderRadius;
            }
            for (const attr of SOURCE_ATTRS) {
                const holder = el.closest(`[${attr}]`);
                if (holder) {
                    info.source = holder.getAttribute(attr);
                    break;
                }
            }
            out.push(info);
        }
    }
    return out;
}
