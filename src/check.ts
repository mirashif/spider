// The route check behind the first-launch picker: list the app's routes and request each one once, without a
// browser or cookies, so the picker can show status, sign-in walls and missing parameters before anything is crawled.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './config.ts';
import type { RouteCheck, RoutesResult } from './contracts.ts';
import { isExcludedRoute, loadRoutePatterns } from './presets/index.ts';
import { compilePatterns, inferPatterns, routeFor } from './routes.ts';
import { readJson, Store, writeJson } from './store.ts';

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|auth|session)(\/|$)/i;

export async function checkRoutes(project: Project, options: { concurrency?: number } = {}): Promise<RoutesResult> {
    const started = Date.now();
    const config = project.config;
    const store = new Store(project.dataDir);

    let loaded: Awaited<ReturnType<typeof loadRoutePatterns>>;
    try {
        loaded = await loadRoutePatterns(config);
    } catch (error) {
        loaded = { patterns: [], source: 'none', detail: `route list failed: ${(error as Error).message.split('\n')[0]}` };
    }

    // Concrete paths we've seen: from the latest run (and baseline), and from the sitemap. They fill in parameters.
    const seen = new Set<string>(loaded.samples ?? []);
    for (const id of [...store.listRuns().slice(0, 1).map((r) => r.id), ...(store.baseline() ? ['baseline'] : [])]) {
        for (const screen of store.readMap(id).screens) {
            seen.add(screen.url.split('?')[0]);
            for (const link of screen.links) if (link.href.startsWith(config.baseURL)) seen.add(new URL(link.href).pathname);
        }
    }

    let source: RoutesResult['source'] = loaded.source;
    let patterns = loaded.patterns;
    const seeds = [...new Set(Object.values(config.personas).flatMap((p) => p.seeds))];
    const linked = await scanLinks(config.baseURL, seeds);
    // Linked pages are real paths too: they give parameter values on a project's very first check.
    for (const path of linked) seen.add(path.length > 1 ? path.replace(/\/+$/, '') : path);
    if (patterns.length === 0) {
        // No route list: fall back to what the sitemap or the last run saw, then to the links on the seed pages.
        // Concrete paths only: guess the patterns behind them, so 40 tag pages read as one /tag/:tag.
        patterns = inferPatterns([...seen, ...linked]);
        source = loaded.source === 'sitemap' ? 'sitemap' : seen.size ? 'run' : linked.length ? 'links' : 'none';
    } else {
        // A route list can be partial (hand-written patterns, a sitemap that skips pages): add linked pages it misses.
        const compiled = compilePatterns(patterns);
        for (const path of linked) {
            const route = routeFor(path, compiled);
            if (!patterns.includes(route)) patterns.push(route);
        }
    }

    // A path belongs to its most specific pattern: /projects/create is not a sample for /projects/:project.
    const params = (p: string) => (p.match(/:/g) ?? []).length;
    const owners = compilePatterns([...new Set(patterns)].sort((a, b) => params(a) - params(b) || b.length - a.length));
    const owned = new Map<string, string[]>();
    for (const path of seen) {
        const owner = routeFor(path, owners);
        if (owner.includes(':')) (owned.get(owner) ?? owned.set(owner, []).get(owner)!).push(path);
    }

    const loginPaths = Object.values(config.personas).flatMap((p) => (p.login ?? []).flatMap((s) => ('goto' in s ? [s.goto] : [])));
    const routes = await mapLimit([...new Set(patterns)].sort(), options.concurrency ?? 6, (pattern) =>
        checkOne(config.baseURL, pattern, {
            params: config.params,
            seen: owned.get(pattern) ?? [],
            hidden: isExcludedRoute(config, pattern),
            loginPaths,
        }),
    );

    const result: RoutesResult = { source, detail: loaded.detail, checkedAt: new Date().toISOString(), durationMs: Date.now() - started, routes };
    writeJson(join(project.dataDir, 'routes.json'), result);
    return result;
}

export function lastRouteCheck(project: Project): RoutesResult | undefined {
    const path = join(project.dataDir, 'routes.json');
    return existsSync(path) ? readJson<RoutesResult>(path) : undefined;
}

async function checkOne(
    baseURL: string,
    pattern: string,
    ctx: { params: Record<string, string>; seen: string[]; hidden: boolean; loginPaths: string[] },
): Promise<RouteCheck> {
    const names = [...pattern.matchAll(/:(\w+)\??/g)].map((m) => m[1]);
    const params: Record<string, string[]> = {};
    if (names.length) {
        const segments = pattern.split('/');
        for (const path of ctx.seen) {
            const parts = path.split('/');
            segments.forEach((seg, i) => {
                const name = seg.match(/^:(\w+)/)?.[1];
                if (name && parts[i]) (params[name] ??= []).includes(parts[i]) || params[name].push(parts[i]);
            });
        }
        for (const name of names) {
            if (ctx.params[name]) params[name] = [ctx.params[name], ...(params[name] ?? []).filter((v) => v !== ctx.params[name])];
        }
    }
    const missing = names.filter((name) => !params[name]?.length && !pattern.includes(`:${name}?`));
    const base = { pattern, hidden: ctx.hidden, params: names.length ? params : undefined };
    if (missing.length) return { ...base, status: null, kind: 'needs-param', signIn: false, error: `No value for ${missing.map((n) => `:${n}`).join(', ')}` };

    const path = pattern.replace(/\/:(\w+)(\?)?/g, (_, name: string) => (params[name]?.[0] ? `/${params[name][0]}` : '')) || '/';
    try {
        const res = await fetch(new URL(path, baseURL), { redirect: 'manual', headers: { accept: 'text/html,*/*;q=0.5' }, signal: AbortSignal.timeout(10_000) });
        await res.body?.cancel();
        const type = res.headers.get('content-type') ?? '';
        const disposition = res.headers.get('content-disposition') ?? '';
        const location = res.headers.get('location');
        const redirect = location ? new URL(location, baseURL).pathname : undefined;
        const signIn = res.status >= 300 && res.status < 400 && Boolean(redirect && (LOGIN_PATH.test(redirect) || ctx.loginPaths.includes(redirect)));
        const kind = /attachment/.test(disposition) ? 'download' : /json/.test(type) ? 'json' : res.status >= 500 ? 'error' : 'page';
        return { ...base, path, status: res.status, kind, signIn, redirect };
    } catch (error) {
        return { ...base, path, status: null, kind: 'error', signIn: false, error: (error as Error).message };
    }
}

async function scanLinks(baseURL: string, seeds: string[]): Promise<string[]> {
    const origin = new URL(baseURL).origin;
    const found = new Set<string>(seeds);
    for (const seed of seeds) {
        try {
            const res = await fetch(new URL(seed, baseURL), { signal: AbortSignal.timeout(8000) });
            const html = await res.text();
            for (const m of html.matchAll(/href=["']([^"'#]+)["']/g)) {
                const url = new URL(m[1], new URL(seed, baseURL));
                if (url.origin === origin && !/\.(css|js|png|jpe?g|svg|ico|woff2?|webmanifest)$/.test(url.pathname)) found.add(url.pathname);
            }
        } catch {
            /* unreachable seed; the check itself will report it */
        }
    }
    return [...found];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i]);
            }
        }),
    );
    return out;
}
