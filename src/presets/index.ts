// Framework knowledge lives here, not in the crawler: where route lists come from and how pages map to files.
// The framework presets themselves are in ./frameworks.ts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { matchesAny } from '../patterns.ts';
import { presetById } from './frameworks.ts';

export { detectPreset, parseDjangoUrls, parseLaravelRoutes, parseRailsRoutes, PRESETS, presetById, type PresetId } from './frameworks.ts';

export interface RoutePatterns {
    patterns: string[];
    source: 'preset' | 'hook' | 'sitemap' | 'none';
    detail?: string;
    /** Concrete paths found along the way (sitemaps list real URLs), usable as parameter samples. */
    samples?: string[];
}

// The file behind each route, per app folder, from the last route list read (file-based presets know it).
const routeFiles = new Map<string, Map<string, string>>();

/** The app's route patterns, from a hook, a preset, or the sitemap. Excluded routes are kept; callers decide. */
export async function loadRoutePatterns(config: ProjectConfig): Promise<RoutePatterns> {
    const extra = config.routes?.extra ?? [];
    if (config.hooks.routes) {
        const patterns = await config.hooks.routes({ appDir: config.appDir });
        return { patterns: [...extra, ...patterns], source: 'hook', detail: 'spider.config.ts routes()' };
    }
    const preset = config.routes?.preset && config.routes.preset !== 'sitemap' ? presetById(config.routes.preset) : undefined;
    if (preset) {
        const options = { dir: config.routes?.dir, command: config.routes?.command, domain: config.routes?.domain };
        const entries = preset.routes(config.appDir, options);
        routeFiles.set(config.appDir, new Map(entries.flatMap((e) => (e.file ? [[e.pattern, e.file] as const] : []))));
        const how = preset.describe?.(config.appDir, options);
        return { patterns: [...extra, ...entries.map((e) => e.pattern)], source: 'preset', detail: `${preset.label}${how ? ` · ${how}` : ''}` };
    }
    const sitemap = await readSitemap(config.baseURL);
    if (sitemap.length) return { patterns: [...extra], source: 'sitemap', detail: `${config.baseURL}/sitemap.xml`, samples: sitemap };
    return { patterns: extra, source: extra.length ? 'preset' : 'none', detail: extra.length ? 'routes.extra in spider.json' : undefined };
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
    // File-based routers: the route's own file.
    if (!file) file = routeFiles.get(config.appDir)?.get(page.route.replace(/#.*$/, ''));
    if (file && !existsSync(join(config.appDir, file))) return undefined;
    return file;
}

export function isExcludedRoute(config: ProjectConfig, pattern: string): boolean {
    return matchesAny(pattern, config.routeExclude);
}
