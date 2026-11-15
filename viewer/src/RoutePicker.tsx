import type { RouteCheck } from '@contracts';
import { ChevronDown, ChevronRight, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/** Routes the picker pre-selects: real pages that answered, or that need sign-in. */
export function isSuggested(route: RouteCheck): boolean {
    if (route.hidden || route.kind !== 'page') return false;
    return route.signIn || (route.status !== null && route.status < 400);
}

/** A route pattern as a crawl glob: /projects/:project → /projects/*. */
export function patternGlob(pattern: string): string {
    return pattern.replace(/\/:\w+\?/g, '/**').replace(/:\w+/g, '*');
}

interface Node {
    key: string;
    segment: string;
    route?: RouteCheck;
    children: Node[];
}

function buildTree(routes: RouteCheck[]): Node {
    const root: Node = { key: '', segment: '', children: [] };
    for (const route of routes) {
        const parts = route.pattern.split('/').filter(Boolean);
        if (parts.length === 0) {
            root.children.unshift({ key: '/', segment: '/', route, children: [] });
            continue;
        }
        let node = root;
        parts.forEach((part, i) => {
            const key = `/${parts.slice(0, i + 1).join('/')}`;
            let child = node.children.find((c) => c.key === key);
            if (!child) {
                child = { key, segment: part, children: [] };
                node.children.push(child);
            }
            if (i === parts.length - 1) child.route = route;
            node = child;
        });
    }
    // Single-child chains without their own route read better merged: /admin/settings → one row.
    const merge = (node: Node): Node => {
        node.children = node.children.map(merge);
        if (!node.route && node.children.length === 1 && node.key !== '') {
            const only = node.children[0];
            return { ...only, segment: `${node.segment}/${only.segment}` };
        }
        return node;
    };
    return merge(root);
}

function routesUnder(node: Node): RouteCheck[] {
    return [...(node.route ? [node.route] : []), ...node.children.flatMap(routesUnder)];
}

interface Props {
    routes: RouteCheck[];
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
    params: Record<string, string>;
    /** A parameter value was edited; the parent re-checks routes with it. Without it, values are shown read-only. */
    onParam?: (name: string, value: string) => void;
    height?: number;
}

export function RoutePicker({ routes, selected, onChange, params, onParam, height = 360 }: Props) {
    const [query, setQuery] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    // JSON endpoints and downloads aren't screens: tucked away with the config's hidden routes.
    const tucked = (r: RouteCheck) => r.hidden || r.kind === 'json' || r.kind === 'download';
    const visible = useMemo(
        () => routes.filter((r) => (showHidden || !tucked(r)) && (!query || r.pattern.toLowerCase().includes(query.toLowerCase()))),
        [routes, showHidden, query],
    );
    const tree = useMemo(() => buildTree(visible), [visible]);
    const hiddenCount = routes.filter(tucked).length;
    const selectable = (r: RouteCheck) => r.kind !== 'needs-param' && r.kind !== 'error';

    const set = (patterns: string[], on: boolean) => {
        const next = new Set(selected);
        for (const p of patterns) on ? next.add(p) : next.delete(p);
        onChange(next);
    };

    const row = (node: Node, depth: number): React.ReactNode => {
        const under = routesUnder(node).filter(selectable);
        const picked = under.filter((r) => selected.has(r.pattern)).length;
        const state = under.length === 0 ? 'none' : picked === 0 ? 'off' : picked === under.length ? 'on' : 'some';
        const hasKids = node.children.length > 0;
        const open = !collapsed.has(node.key) || Boolean(query);
        const r = node.route;
        return (
            <div key={node.key} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={state === 'on'}>
                <div className={`rp-row${r && !selectable(r) ? ' rp-dim' : ''}${r?.hidden ? ' rp-hidden' : ''}`} style={{ paddingInlineStart: 8 + depth * 18 }}>
                    <button
                        type="button"
                        className="rp-caret"
                        aria-label={open ? 'Collapse' : 'Expand'}
                        style={{ visibility: hasKids ? 'visible' : 'hidden' }}
                        onClick={() => {
                            const next = new Set(collapsed);
                            open ? next.add(node.key) : next.delete(node.key);
                            setCollapsed(next);
                        }}
                    >
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                    <button
                        type="button"
                        className={`rp-check rp-check-${state}`}
                        role="checkbox"
                        aria-checked={state === 'on' ? true : state === 'some' ? 'mixed' : false}
                        disabled={state === 'none'}
                        onClick={() => set(under.map((x) => x.pattern), state !== 'on')}
                        aria-label={`Select ${node.key}`}
                    >
                        {state === 'on' ? '✓' : state === 'some' ? '–' : ''}
                    </button>
                    <span className="rp-path mono">
                        {node.segment.split('/').map((part, i) => (
                            <span key={i}>
                                {i > 0 && '/'}
                                {part.startsWith(':') ? <span className="rp-param">{part}</span> : part}
                            </span>
                        ))}
                        {hasKids && routesUnder(node).length > 1 && <span className="muted"> · {routesUnder(node).length}</span>}
                    </span>
                    <span className="rp-meta">{r && <RouteMeta route={r} params={params} onParam={onParam} />}</span>
                </div>
                {hasKids && open && node.children.map((child) => row(child, depth + 1))}
            </div>
        );
    };

    const suggested = routes.filter(isSuggested).map((r) => r.pattern);
    return (
        <div className="rp">
            <div className="rp-bar">
                <label className="rp-search">
                    <Search size={13} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter routes…" aria-label="Filter routes" />
                </label>
                <div className="segmented">
                    <button type="button" onClick={() => onChange(new Set(suggested))} title="Pages that answered or need sign-in">
                        Suggested
                    </button>
                    <button type="button" onClick={() => onChange(new Set(routes.filter((r) => selectable(r) && (showHidden || !tucked(r))).map((r) => r.pattern)))}>
                        All
                    </button>
                    <button type="button" onClick={() => onChange(new Set())}>
                        None
                    </button>
                </div>
                {hiddenCount > 0 && (
                    <label className="toggle">
                        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                        {hiddenCount} hidden
                    </label>
                )}
            </div>
            <div className="rp-list" role="tree" aria-multiselectable style={{ height }}>
                {tree.children.length ? tree.children.map((n) => row(n, 0)) : <div className="empty small">No routes match.</div>}
            </div>
        </div>
    );
}

function RouteMeta({ route, params, onParam }: { route: RouteCheck; params: Record<string, string>; onParam?: (name: string, value: string) => void }) {
    const names = [...route.pattern.matchAll(/:(\w+)/g)].map((m) => m[1]);
    return (
        <>
            {names.map((name) => {
                const value = params[name] ?? route.params?.[name]?.[0] ?? '';
                return onParam ? (
                    <ParamInput key={name} name={name} value={value} options={route.params?.[name] ?? []} onCommit={(v) => onParam(name, v)} />
                ) : value ? (
                    <span key={name} className="rp-param-input">
                        <span className="rp-param">:{name}</span>= {value}
                    </span>
                ) : null;
            })}
            {route.kind === 'needs-param' ? (
                <span className="pill pill-bad">needs a value</span>
            ) : route.signIn ? (
                <span className="pill pill-warn">
                    <Lock size={10} /> sign-in
                </span>
            ) : route.kind === 'page' && route.status !== null && route.status < 400 ? (
                <span className="pill pill-ok">{route.status}</span>
            ) : (
                <span className="pill">
                    {route.kind === 'page' ? route.status : route.kind}
                    {route.error && !route.status ? ' · error' : ''}
                </span>
            )}
        </>
    );
}

function ParamInput({ name, value, options, onCommit }: { name: string; value: string; options: string[]; onCommit: (value: string) => void }) {
    const [draft, setDraft] = useState(value);
    const list = `rp-${name}-options`;
    return (
        <span className="rp-param-input">
            <span className="rp-param">:{name}</span>=
            <input
                value={draft}
                list={options.length > 1 ? list : undefined}
                placeholder="value"
                size={Math.max(6, Math.min(18, draft.length + 1))}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => draft !== value && onCommit(draft.trim())}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                aria-label={`Value for :${name}`}
            />
            {options.length > 1 && (
                <datalist id={list}>
                    {options.slice(0, 20).map((o) => (
                        <option key={o} value={o} />
                    ))}
                </datalist>
            )}
        </span>
    );
}
