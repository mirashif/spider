// Framework-specific knowledge lives here, not in the crawler: where route lists come from and how pages map to files.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { matchesAny } from '../patterns.ts';

export interface RoutePatterns {
    patterns: string[];
    source: 'preset' | 'hook' | 'sitemap' | 'none';
    detail?: string;
    /** Concrete paths found along the way (sitemaps list real URLs), usable as parameter samples. */
    samples?: string[];
}

/** The app's route patterns, from a hook, a preset, or the sitemap. Excluded routes are kept; callers decide. */
export async function loadRoutePatterns(config: ProjectConfig): Promise<RoutePatterns> {
    const extra = config.routes?.extra ?? [];
    if (config.hooks.routes) {
        const patterns = await config.hooks.routes({ appDir: config.appDir });
        return { patterns: [...extra, ...patterns], source: 'hook', detail: 'spider.config.ts routes()' };
    }
    if (config.routes?.preset === 'laravel') {
        const command = config.routes.command ?? ['php', 'artisan', 'route:list', '--json', '--method=GET'];
        const output = execFileSync(command[0], command.slice(1), { cwd: config.appDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        return { patterns: [...extra, ...parseLaravelRoutes(output, config.routes.domain)], source: 'preset', detail: `laravel: ${command.join(' ')}` };
    }
    const sitemap = await readSitemap(config.baseURL);
    if (sitemap.length) return { patterns: [...extra], source: 'sitemap', detail: `${config.baseURL}/sitemap.xml`, samples: sitemap };
    return { patterns: extra, source: extra.length ? 'preset' : 'none' };
}

/**
 * Laravel `route:list --json` → GET route patterns. With `domain`, only routes registered for that domain, when the
 * app registers any (multi-domain apps); most apps register none, and then every route counts.
 */
export function parseLaravelRoutes(output: string, domain?: string): string[] {
    const rows = JSON.parse(output) as { domain: string | null; method: string; uri: string }[];
    const strict = domain !== undefined && rows.some((row) => row.domain === domain);
    const patterns = new Set<string>();
    for (const row of rows) {
        if (!row.method.split('|').includes('GET')) continue;
        if (strict && row.domain !== domain) continue;
        const path = `/${row.uri}`.replace(/^\/+/, '/').replace(/\{(\w+)(\?)?\}/g, (_, name: string, optional?: string) => `:${name}${optional ?? ''}`);
        patterns.add(path);
    }
    return [...patterns].sort();
}

async function readSitemap(baseURL: string): Promise<string[]> {
    try {
        const res = await fetch(new URL('/sitemap.xml', baseURL), { signal: AbortSignal.timeout(5000), redirect: 'follow' });
        if (!res.ok || !/xml/.test(res.headers.get('content-type') ?? '')) return [];
        const xml = await res.text();
        const origin = new URL(baseURL).origin;
        return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
            .map((m) => new URL(m[1]))
            .filter((u) => u.origin === origin)
            .map((u) => u.pathname)
            .slice(0, 2000);
    } catch {
        return [];
    }
}

/** Source file for a page, relative to the app folder, when it exists. */
export function sourceFileFor(config: ProjectConfig, page: { component?: string; route: string }): string | undefined {
    let file = config.hooks.sourceFile?.(page);
    if (!file && config.source?.preset === 'inertia' && page.component) {
        file = `${config.source.pages ?? 'resources/js/pages'}/${page.component}${config.source.ext ?? '.tsx'}`;
    }
    if (file && !existsSync(join(config.appDir, file))) return undefined;
    return file;
}

export function isExcludedRoute(config: ProjectConfig, pattern: string): boolean {
    return matchesAny(pattern, config.routeExclude);
}
