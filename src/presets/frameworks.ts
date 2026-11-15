// Framework presets: how each framework says which pages exist, and which file renders each one.
//
// File-based routers are read statically (no app code runs); server frameworks are asked through their own CLI.
// Every preset returns route patterns in spider-web's form (/users/:id, optional /:lang?), plus the source file for
// each pattern when the framework ties pages to files, so screens can link to their code.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface RouteEntry {
    pattern: string;
    /** Relative to the app folder. */
    file?: string;
}

export interface PresetOptions {
    /** Routes folder (file-based presets) relative to the app folder, when it isn't the framework's default. */
    dir?: string;
    /** Command printing the route list (laravel, rails, django), run in the app folder. */
    command?: string[];
    /** laravel: only routes registered for this domain, when the app registers any. */
    domain?: string;
}

export interface Preset {
    id: PresetId;
    label: string;
    /** True when the app folder looks like this framework. */
    detect: (app: AppFacts) => boolean;
    routes: (appDir: string, options: PresetOptions) => RouteEntry[];
    /** Shown in the UI: "routes via Sail", "app router", … */
    describe?: (appDir: string, options: PresetOptions) => string;
    /** Routes that are rarely screens, hidden in the picker by default. */
    exclude?: string[];
    /** The default command, for presets that ask a CLI. */
    command?: (appDir: string) => string[];
}

export type PresetId =
    | 'laravel'
    | 'rails'
    | 'django'
    | 'nextjs'
    | 'nuxt'
    | 'sveltekit'
    | 'remix'
    | 'tanstack-router'
    | 'astro'
    | 'solid-start'
    | 'qwik'
    | 'gatsby'
    | 'vue-router'
    | 'router-scan';

export interface AppFacts {
    dir: string;
    deps: Record<string, string>;
    has: (path: string) => boolean;
}

export function appFacts(dir: string): AppFacts {
    const read = (file: string) => {
        try {
            return JSON.parse(readFileSync(join(dir, file), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        } catch {
            return undefined;
        }
    };
    const pkg = read('package.json');
    return { dir, deps: { ...pkg?.dependencies, ...pkg?.devDependencies }, has: (path) => existsSync(join(dir, path)) };
}

// ---- Shared helpers ----

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.output', '.astro', 'coverage', '.turbo', '.vercel']);

/** Files under `root`, relative to it, skipping build output and dependencies. */
function walk(root: string, limit = 5000): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
        if (out.length >= limit) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
            const full = join(dir, name);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) visit(full);
            else out.push(relative(root, full));
        }
    };
    visit(root);
    return out.sort();
}

function firstDir(appDir: string, options: PresetOptions, candidates: string[]): string | undefined {
    if (options.dir) return existsSync(join(appDir, options.dir)) ? options.dir : undefined;
    return candidates.find((c) => existsSync(join(appDir, c)));
}

function join_(segments: (string | undefined)[]): string {
    const path = segments.filter((s) => s !== undefined && s !== '').join('/');
    return `/${path}`.replace(/\/+/g, '/') || '/';
}

function stripExt(file: string): string {
    return file.replace(/\.[^./]+$/, '');
}

function dedupe(entries: RouteEntry[]): RouteEntry[] {
    const seen = new Map<string, RouteEntry>();
    for (const e of entries) {
        // Prefer the entry with a file; the first file wins (layouts come before their index page in sort order).
        const prev = seen.get(e.pattern);
        if (!prev || (!prev.file && e.file)) seen.set(e.pattern, e);
    }
    return [...seen.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/**
 * Bracket-style dynamic segments, shared by Next, Nuxt, SvelteKit, Astro, Solid, Qwik:
 *   [id] → :id   [[id]] → :id?   [...slug] / [[...slug]] → :slug   [id=int] → :id   post-[id] → :id
 */
function bracketSegment(segment: string): string {
    const optional = segment.match(/^\[\[(?:\.\.\.)?(\w+)(?:=\w+)?\]\]$/);
    if (optional) return `:${optional[1]}?`;
    const param = segment.match(/\[(?:\.\.\.)?(\w+)(?:=\w+)?\]/);
    return param ? `:${param[1]}` : segment;
}

const isGroup = (segment: string) => /^\(.*\)$/.test(segment);

// ---- File-based routers ----

/** Next.js: app router (app/**\/page.tsx) and pages router (pages/**). */
function nextRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const entries: RouteEntry[] = [];
    const app = firstDir(appDir, options, ['app', 'src/app']);
    if (app) {
        for (const file of walk(join(appDir, app))) {
            if (!/(^|\/)page\.(tsx|ts|jsx|js|mdx|md)$/.test(file)) continue;
            const dirs = file.split('/').slice(0, -1);
            // Private folders (_x), parallel slots (@x) and intercepting routes ((.)x) don't add pages of their own.
            if (dirs.some((d) => d.startsWith('_') || d.startsWith('@') || /^\(\.{1,3}\)/.test(d))) continue;
            entries.push({ pattern: join_(dirs.filter((d) => !isGroup(d)).map(bracketSegment)), file: join(app, file) });
        }
    }
    const pages = options.dir && app ? undefined : firstDir(appDir, { dir: undefined }, ['pages', 'src/pages']);
    if (pages) entries.push(...pagesRouter(appDir, pages, /\.(tsx|ts|jsx|js|mdx|md)$/));
    return dedupe(entries);
}

/** Pages-style routers (Next pages/, Gatsby, Astro, Solid Start): file path = URL, index = folder. */
function pagesRouter(appDir: string, root: string, ext: RegExp, options: { skip?: RegExp } = {}): RouteEntry[] {
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root))) {
        if (!ext.test(file)) continue;
        if (/(^|\/)(_app|_document|_error|_middleware|404|500)\.[^/]+$/.test(file) || /^api\//.test(file) || options.skip?.test(file)) continue;
        const parts = stripExt(file).split('/');
        if (parts.some((p) => p.startsWith('_'))) continue;
        if (parts[parts.length - 1] === 'index') parts.pop();
        // Gatsby's file-system routes: {Product.slug} → :slug.
        const segments = parts.filter((p) => !isGroup(p)).map((p) => bracketSegment(p.replace(/^\{[\w.]*?(\w+)\}$/, '[$1]').replace(/^\((\w+)\)$/, '$1')));
        entries.push({ pattern: join_(segments), file: join(root, file) });
    }
    return entries;
}

/** Nuxt (pages/ or app/pages/) and unplugin-vue-router (src/pages/). */
function vuePagesRoutes(appDir: string, root: string): RouteEntry[] {
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root))) {
        if (!/\.vue$/.test(file)) continue;
        const parts = stripExt(file).split('/');
        if (parts[parts.length - 1] === 'index') parts.pop();
        entries.push({ pattern: join_(parts.filter((p) => !isGroup(p)).map(bracketSegment)), file: join(root, file) });
    }
    return dedupe(entries);
}

/** SvelteKit: src/routes/**\/+page.svelte. */
function svelteKitRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src/routes']);
    if (!root) return [];
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root))) {
        if (!/(^|\/)\+page\.(svelte|ts|js|server\.ts|server\.js)$/.test(file)) continue;
        const dirs = file.split('/').slice(0, -1);
        entries.push({ pattern: join_(dirs.filter((d) => !isGroup(d)).map(bracketSegment)), file: join(root, file) });
    }
    // Prefer the .svelte file as the page's source.
    return dedupe(entries.sort((a, b) => Number(!a.file?.endsWith('.svelte')) - Number(!b.file?.endsWith('.svelte'))));
}

/** Qwik City: src/routes/**\/index.tsx. */
function qwikRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src/routes']);
    if (!root) return [];
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root))) {
        if (!/(^|\/)index(@\w+)?\.(tsx|jsx|mdx|md)$/.test(file)) continue;
        const dirs = file.split('/').slice(0, -1);
        entries.push({ pattern: join_(dirs.filter((d) => !isGroup(d)).map(bracketSegment)), file: join(root, file) });
    }
    return dedupe(entries);
}

/**
 * Remix and React Router v7 framework mode: flat routes in app/routes (dots are slashes, $param, _index, _pathless,
 * trailing_ to break out of a layout, ($optional)), plus explicit route("path", "file") calls in app/routes.ts.
 */
function remixRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const entries: RouteEntry[] = [];
    const appFolder = options.dir ? options.dir.replace(/\/routes\/?$/, '') : 'app';
    const config = ['routes.ts', 'routes.js'].map((f) => join(appFolder, f)).find((f) => existsSync(join(appDir, f)));
    let useFlat = !config;
    if (config) {
        const source = readFileSync(join(appDir, config), 'utf8');
        useFlat = /flatRoutes\s*\(/.test(source);
        for (const m of source.matchAll(/\broute\(\s*["'`]([^"'`]*)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)) {
            entries.push({ pattern: join_(m[1].split('/').map((s) => s.replace(/^:(\w+)\?$/, ':$1?'))), file: join(appFolder, m[2]) });
        }
        for (const m of source.matchAll(/\bindex\(\s*["'`]([^"'`]+)["'`]/g)) entries.push({ pattern: '/', file: join(appFolder, m[1]) });
    }
    const root = join(appFolder, 'routes');
    if (useFlat && existsSync(join(appDir, root))) {
        for (const file of walk(join(appDir, root))) {
            if (!/\.(tsx|ts|jsx|js|mdx|md)$/.test(file)) continue;
            const parts = file.split('/');
            // A folder route is folder/route.tsx; other files in the folder are its helpers.
            let name: string;
            if (parts.length === 1) name = stripExt(parts[0]);
            else if (parts.length === 2 && /^route\.[^.]+$/.test(parts[1])) name = parts[0];
            else continue;
            // Split on dots outside [escapes].
            const segments = name.match(/(\[[^\]]*\]|[^.])+/g) ?? [];
            // A pathless layout (_auth.tsx) wraps pages but isn't one.
            const last = segments[segments.length - 1] ?? '';
            if (last.startsWith('_') && last !== '_index') continue;
            const out: string[] = [];
            for (const raw of segments) {
                if (raw === '_index' || raw === 'index') continue;
                if (raw.startsWith('_')) continue; // pathless layout
                const seg = raw.replace(/_$/, '').replace(/\[([^\]]*)\]/g, '$1');
                if (seg === '$') out.push(':splat');
                else if (/^\(\$(\w+)\)$/.test(seg)) out.push(`:${seg.slice(2, -1)}?`);
                else if (/^\((\w+)\)$/.test(seg)) out.push(seg.slice(1, -1));
                else if (seg.startsWith('$')) out.push(`:${seg.slice(1)}`);
                else out.push(seg);
            }
            entries.push({ pattern: join_(out), file: join(root, file) });
        }
    }
    return dedupe(entries);
}

/**
 * TanStack Router (React, Solid, Start). The generated route tree lists every full path and its file, so read that
 * first; fall back to file names (dots and folders are slashes, $param, _pathless, index, (group), -ignored).
 */
function tanstackRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const gen = ['src/routeTree.gen.ts', 'app/routeTree.gen.ts', 'routeTree.gen.ts'].find((f) => existsSync(join(appDir, f)));
    if (gen) {
        const source = readFileSync(join(appDir, gen), 'utf8');
        const files = new Map<string, string>();
        for (const m of source.matchAll(/import\s*\{\s*Route\s+as\s+(\w+?)(?:Import)?\s*\}\s*from\s*['"]([^'"]+)['"]/g)) {
            files.set(m[1], join(gen.replace(/[^/]*$/, ''), m[2]));
        }
        const block = source.match(/interface\s+FileRoutesByFullPath\s*\{([\s\S]*?)\n\}/)?.[1];
        if (block) {
            const entries: RouteEntry[] = [];
            for (const m of block.matchAll(/['"]([^'"]+)['"]\s*:\s*typeof\s+(\w+)/g)) {
                const base = m[2].replace(/WithChildren$/, '');
                const file = files.get(base);
                const ext = file && ['.tsx', '.ts', '.jsx', '.js'].find((e) => existsSync(join(appDir, file + e)));
                entries.push({ pattern: tanstackPath(m[1]), file: file && ext ? file + ext : undefined });
            }
            if (entries.length) return dedupe(entries);
        }
    }
    const root = firstDir(appDir, options, ['src/routes', 'app/routes']);
    if (!root) return [];
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root))) {
        if (!/\.(tsx|ts|jsx|js)$/.test(file) || /(^|\/)__root\.[^/]+$/.test(file) || /(^|[/.])-/.test(file)) continue;
        const name = stripExt(file).replace(/\.lazy$/, '');
        const all = name.split(/[/.]/);
        // A pathless layout (_layout.tsx, _auth.tsx) wraps pages but isn't one.
        if (all[all.length - 1].startsWith('_')) continue;
        const segments = all.filter((s) => s !== 'index' && s !== 'route' && !s.startsWith('_') && !isGroup(s));
        entries.push({ pattern: tanstackPath(`/${segments.map((s) => s.replace(/_$/, '')).join('/')}`), file: join(root, file) });
    }
    return dedupe(entries);
}

function tanstackPath(path: string): string {
    return (
        path
            .split('/')
            .map((s) => (s === '$' ? ':splat' : s.replace(/^\{-\$(\w+)\}$/, ':$1?').replace(/^\$(\w+)$/, ':$1')))
            .join('/')
            .replace(/\/$/, '') || '/'
    );
}

/** Astro: src/pages (.astro, .md, .mdx, .html); .ts/.js files there are endpoints, not pages. */
function astroRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src/pages']);
    return root ? dedupe(pagesRouter(appDir, root, /\.(astro|md|mdx|markdoc|html)$/)) : [];
}

/** Solid Start: src/routes, pages-style with (group) folders and (name).tsx renames. */
function solidStartRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src/routes']);
    return root ? dedupe(pagesRouter(appDir, root, /\.(tsx|jsx|mdx|md)$/)) : [];
}

function gatsbyRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src/pages']);
    return root ? dedupe(pagesRouter(appDir, root, /\.(tsx|ts|jsx|js|mdx|md)$/)) : [];
}

/** Vue Router: file routes (unplugin-vue-router) when present, else paths found in router config. */
function vueRouterRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const pages = firstDir(appDir, options, ['src/pages']);
    return pages && appFacts(appDir).deps['unplugin-vue-router'] ? vuePagesRoutes(appDir, pages) : scanRoutes(appDir, options);
}

/**
 * Config-based client routers (React Router library mode, Vue Router, Angular, Solid Router): no files to read, so
 * collect path strings from route definitions in the source. Best effort: nested child paths come out as top-level.
 */
function scanRoutes(appDir: string, options: PresetOptions): RouteEntry[] {
    const root = firstDir(appDir, options, ['src', 'app']) ?? '.';
    const entries: RouteEntry[] = [];
    for (const file of walk(join(appDir, root), 3000)) {
        if (!/\.(tsx|ts|jsx|js|vue)$/.test(file) || /\.(test|spec|stories)\./.test(file)) continue;
        let source: string;
        try {
            source = readFileSync(join(appDir, root, file), 'utf8');
        } catch {
            continue;
        }
        if (!/(Route|routes|createBrowserRouter|createRouter|RouterModule|path\s*:)/.test(source)) continue;
        const paths = [
            ...source.matchAll(/<Route\b[^>]*\bpath\s*=\s*["'`]([^"'`]*)["'`]/g),
            ...source.matchAll(/\bpath\s*:\s*["'`]([^"'`]*)["'`]/g),
        ].map((m) => m[1]);
        for (const path of paths) {
            if (path === '*' || path === '**' || /^https?:/.test(path) || path.includes('${')) continue;
            entries.push({ pattern: join_(path.split('/').map((s) => (s === '*' ? ':splat' : s))), file: join(root, file) });
        }
    }
    return dedupe(entries);
}

// ---- Server frameworks, asked through their CLI ----

function run(appDir: string, command: string[]): string {
    return execFileSync(command[0], command.slice(1), { cwd: appDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
}

/**
 * Laravel `route:list --json` → GET routes. With `domain`, only routes registered for that domain, when the app
 * registers any (multi-domain apps); most apps register none, and then every route counts.
 */
export function parseLaravelRoutes(output: string, domain?: string): string[] {
    const rows = JSON.parse(output) as { domain: string | null; method: string; uri: string }[];
    const strict = domain !== undefined && rows.some((row) => row.domain === domain);
    const patterns = new Set<string>();
    for (const row of rows) {
        if (!row.method.split('|').includes('GET')) continue;
        if (strict && row.domain !== domain) continue;
        patterns.add(`/${row.uri}`.replace(/^\/+/, '/').replace(/\{(\w+)(\?)?\}/g, (_, name: string, optional?: string) => `:${name}${optional ?? ''}`));
    }
    return [...patterns].sort();
}

/** `rails routes` → GET routes, without (.:format) and other optional groups. */
export function parseRailsRoutes(output: string): string[] {
    const patterns = new Set<string>();
    for (const line of output.split('\n')) {
        const m = line.match(/(?:^|\s)GET\s+(\/\S*)/);
        if (!m) continue;
        const path = m[1].replace(/\([^)]*\)/g, '').replace(/\*(\w+)/g, ':$1') || '/';
        patterns.add(path.length > 1 ? path.replace(/\/$/, '') : path);
    }
    return [...patterns].sort();
}

/** django-extensions `show_urls --format json` → URL patterns (<int:id> and (?P<id>…) become :id). */
export function parseDjangoUrls(output: string): string[] {
    const rows = JSON.parse(output) as { url: string }[];
    const patterns = new Set<string>();
    for (const row of rows) {
        const path = row.url
            .replace(/\(\?P<(\w+)>[^)]*\)/g, ':$1')
            .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
            .replace(/[\^$]/g, '');
        patterns.add(`/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'));
    }
    return [...patterns].sort();
}

// ---- The registry ----

const dep = (app: AppFacts, ...names: string[]) => names.some((n) => n in app.deps);

export const PRESETS: Preset[] = [
    {
        id: 'laravel',
        label: 'Laravel',
        detect: (a) => a.has('artisan'),
        command: (dir) => [existsSync(join(dir, 'vendor/bin/sail')) ? './vendor/bin/sail' : 'php', 'artisan', 'route:list', '--json', '--method=GET'],
        routes: (dir, o) => parseLaravelRoutes(run(dir, o.command ?? PRESETS[0].command!(dir)), o.domain).map((pattern) => ({ pattern })),
        describe: (dir, o) => `routes via ${(o.command ?? PRESETS[0].command!(dir))[0].includes('sail') ? 'Sail' : 'php artisan'}`,
        exclude: ['/api/**', '/up', '/sanctum/**', '/_ignition/**', '/telescope/**', '/horizon/**', '/storage/**', '/livewire/**'],
    },
    {
        id: 'rails',
        label: 'Rails',
        detect: (a) => a.has('config/routes.rb'),
        command: (dir) => (existsSync(join(dir, 'bin/rails')) ? ['bin/rails', 'routes'] : ['bundle', 'exec', 'rails', 'routes']),
        routes: (dir, o) => parseRailsRoutes(run(dir, o.command ?? ['bin/rails', 'routes'])).map((pattern) => ({ pattern })),
        exclude: ['/rails/**', '/cable', '/assets/**', '/up', '/recede_historical_location', '/resume_historical_location', '/refresh_historical_location'],
    },
    {
        id: 'django',
        label: 'Django',
        detect: (a) => a.has('manage.py'),
        command: () => ['python', 'manage.py', 'show_urls', '--format', 'json'],
        routes: (dir, o) => {
            try {
                return parseDjangoUrls(run(dir, o.command ?? ['python', 'manage.py', 'show_urls', '--format', 'json'])).map((pattern) => ({ pattern }));
            } catch (error) {
                throw new Error(`django: show_urls needs django-extensions (pip install django-extensions). ${(error as Error).message.split('\n')[0]}`);
            }
        },
        describe: () => 'routes via django-extensions show_urls',
        exclude: ['/static/**', '/media/**', '/__debug__/**', '/api/**'],
    },
    {
        id: 'nextjs',
        label: 'Next.js',
        detect: (a) => dep(a, 'next'),
        routes: nextRoutes,
        describe: (dir, o) => [firstDir(dir, o, ['app', 'src/app']) && 'app router', firstDir(dir, {}, ['pages', 'src/pages']) && 'pages router'].filter(Boolean).join(' + ') || 'no pages found',
        exclude: ['/api/**'],
    },
    { id: 'nuxt', label: 'Nuxt', detect: (a) => dep(a, 'nuxt'), routes: (dir, o) => {
        const root = firstDir(dir, o, ['app/pages', 'pages']);
        return root ? vuePagesRoutes(dir, root) : [];
    } },
    { id: 'sveltekit', label: 'SvelteKit', detect: (a) => dep(a, '@sveltejs/kit'), routes: svelteKitRoutes },
    {
        id: 'remix',
        label: 'Remix / React Router',
        detect: (a) => dep(a, '@remix-run/react', '@remix-run/node', '@react-router/dev'),
        routes: remixRoutes,
    },
    {
        id: 'tanstack-router',
        label: 'TanStack Router',
        detect: (a) => dep(a, '@tanstack/react-router', '@tanstack/solid-router', '@tanstack/react-start', '@tanstack/solid-start'),
        routes: tanstackRoutes,
        describe: (dir) => (['src/routeTree.gen.ts', 'app/routeTree.gen.ts'].some((f) => existsSync(join(dir, f))) ? 'from routeTree.gen.ts' : 'from route files'),
    },
    { id: 'astro', label: 'Astro', detect: (a) => dep(a, 'astro'), routes: astroRoutes },
    { id: 'solid-start', label: 'SolidStart', detect: (a) => dep(a, '@solidjs/start'), routes: solidStartRoutes },
    { id: 'qwik', label: 'Qwik City', detect: (a) => dep(a, '@builder.io/qwik-city', '@qwik.dev/router'), routes: qwikRoutes },
    { id: 'gatsby', label: 'Gatsby', detect: (a) => dep(a, 'gatsby'), routes: gatsbyRoutes },
    { id: 'vue-router', label: 'Vue Router', detect: (a) => dep(a, 'vue-router', 'unplugin-vue-router'), routes: vueRouterRoutes, describe: (dir) => (appFacts(dir).deps['unplugin-vue-router'] ? 'file routes' : 'paths from router config (best effort)') },
    {
        id: 'router-scan',
        label: 'Client router',
        detect: (a) => dep(a, 'react-router', 'react-router-dom', '@angular/router', '@solidjs/router', 'wouter'),
        routes: scanRoutes,
        describe: () => 'paths found in route definitions (best effort)',
    },
];

export function presetById(id: string): Preset | undefined {
    return PRESETS.find((p) => p.id === id);
}

/** The most specific preset for an app folder (meta-frameworks before the routers they're built on). */
export function detectPreset(dir: string): Preset | undefined {
    const facts = appFacts(dir);
    return PRESETS.find((p) => p.detect(facts));
}
