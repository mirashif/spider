// First launch: find the app, read what its folder says about its framework, check its routes before anything is
// saved, and turn the picker's selection into a spider.json.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR_NAME, resolveConfig, type PersonaJson, type Project, type SpiderJson } from './config.ts';
import type { ColorScheme, RouteCheck, ViewportSpec } from './contracts.ts';

export interface FoundServer {
    url: string;
    port: number;
    status: number;
    title?: string;
    poweredBy?: string;
}

export interface Detected {
    appDir: string;
    framework?: 'laravel' | 'next' | 'nuxt' | 'sveltekit' | 'remix' | 'astro' | 'rails' | 'django' | 'vite';
    /** A human line for the UI, e.g. "Laravel · routes via Sail · Inertia pages". */
    summary?: string;
    name?: string;
    /** Where the app says it runs (Laravel's APP_URL, a dev script's --port). */
    url?: string;
    routes?: SpiderJson['routes'];
    source?: SpiderJson['source'];
}

/** Everything the setup screens collect. */
export interface SetupDraft {
    name: string;
    baseURL: string;
    /** Absolute, or relative to the project folder. */
    appDir?: string;
    /** Routes picked in the picker, with the concrete path used for each. */
    selection: { pattern: string; path?: string; signIn: boolean }[];
    params?: Record<string, string>;
    /** Only crawl the picked routes (true), or follow links anywhere on the site (false). */
    onlySelected: boolean;
    /** Name of the persona that signs in, when any picked route needs it. */
    signInPersona?: string;
    viewports?: ViewportSpec[];
    colorSchemes?: ColorScheme[];
    hidden?: string[];
    /** Patterns guessed from links (no route list): saved so crawls fold URLs the same way, e.g. /author/:author. */
    patterns?: string[];
}

const SCHEMA = fileURLToPath(new URL('./spider.schema.json', import.meta.url));

// Common dev-server ports, most likely first.
const PORTS = [3000, 5173, 8000, 8080, 80, 3001, 4200, 4173, 5174, 5000, 4000, 8888, 3002, 5175, 8081, 9000, 4321];

/** Dev servers answering on localhost right now, excluding spider-web itself. */
export async function discoverServers(ownPort?: number): Promise<FoundServer[]> {
    const found = await Promise.all(
        PORTS.filter((p) => p !== ownPort).map(async (port): Promise<FoundServer | undefined> => {
            const url = port === 80 ? 'http://localhost' : `http://localhost:${port}`;
            try {
                const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(1200), headers: { accept: 'text/html' } });
                const type = res.headers.get('content-type') ?? '';
                const body = /html/.test(type) ? (await res.text()).slice(0, 20_000) : (await res.body?.cancel(), '');
                const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
                // Not dev servers: spider-web itself, and macOS's AirPlay receiver on :5000/:7000.
                if (title === 'spider-web' || /AirTunes/i.test(res.headers.get('server') ?? '')) return undefined;
                return { url, port, status: res.status, title: title || undefined, poweredBy: res.headers.get('x-powered-by') ?? res.headers.get('server') ?? undefined };
            } catch {
                return undefined;
            }
        }),
    );
    return found.filter((s): s is FoundServer => Boolean(s));
}

/** What an app folder says about itself. Nothing here is required; it only fills in better defaults. */
export function detectApp(appDir: string): Detected {
    const dir = resolve(appDir);
    const has = (file: string) => existsSync(join(dir, file));
    const read = (file: string) => (has(file) ? readFileSync(join(dir, file), 'utf8') : '');
    const pkg = safeJson<{ name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(read('package.json'));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const out: Detected = { appDir: dir };

    if (has('artisan')) {
        const sail = has('vendor/bin/sail');
        out.framework = 'laravel';
        out.routes = { preset: 'laravel', command: [sail ? './vendor/bin/sail' : 'php', 'artisan', 'route:list', '--json', '--method=GET'] };
        const parts = ['Laravel', `routes via ${sail ? 'Sail' : 'php artisan'}`];
        for (const pages of ['resources/js/pages', 'resources/js/Pages']) {
            if (has(pages)) {
                const ext = has(`${pages}/Welcome.vue`) || deps.vue ? '.vue' : deps.svelte ? '.svelte' : '.tsx';
                out.source = { preset: 'inertia', pages, ext };
                parts.push('Inertia pages');
                break;
            }
        }
        out.summary = parts.join(' · ');
        const env = read('.env');
        const envValue = (key: string) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
        out.url = envValue('APP_URL');
        const appName = envValue('APP_NAME');
        if (appName && appName !== 'Laravel') out.name = appName;
        out.name ??= safeJson<{ name?: string }>(read('composer.json'))?.name?.split('/').pop();
    } else if (deps.next) {
        out.framework = 'next';
        out.summary = 'Next.js';
    } else if (deps.nuxt) {
        out.framework = 'nuxt';
        out.summary = 'Nuxt';
    } else if (deps['@sveltejs/kit']) {
        out.framework = 'sveltekit';
        out.summary = 'SvelteKit';
    } else if (deps['@remix-run/react'] || deps['react-router']) {
        out.framework = 'remix';
        out.summary = deps['@remix-run/react'] ? 'Remix' : 'React Router';
    } else if (deps.astro) {
        out.framework = 'astro';
        out.summary = 'Astro';
    } else if (has('config/routes.rb')) {
        out.framework = 'rails';
        out.summary = 'Rails';
    } else if (has('manage.py')) {
        out.framework = 'django';
        out.summary = 'Django';
    } else if (deps.vite) {
        out.framework = 'vite';
        out.summary = 'Vite app';
    }
    // A dev script that names its port is a decent guess at the URL.
    if (!out.url && pkg?.scripts) {
        const port = Object.values(pkg.scripts).join(' ').match(/(?:--port[= ]|-p )(\d{2,5})/)?.[1];
        if (port) out.url = `http://localhost:${port}`;
    }
    out.name ??= pkg?.name ?? basename(dir);
    return out;
}

/** A Project held in memory, so routes can be checked before anything is written. */
export function draftProject(root: string, json: SpiderJson): Project {
    return { root, configPath: join(root, 'spider.json'), dataDir: join(root, DATA_DIR_NAME), json, config: resolveConfig(root, json, {}) };
}

/** The draft config used for the route check: app, presets and a catch-all visitor. */
export function draftJson(root: string, baseURL: string, appDir: string | undefined, params?: Record<string, string>): SpiderJson {
    const detected = appDir ? detectApp(resolve(root, appDir)) : undefined;
    return {
        name: detected?.name ?? new URL(baseURL).host,
        baseURL: baseURL.replace(/\/$/, ''),
        ...(appDir && appPath(root, appDir) !== '.' ? { app: appPath(root, appDir) } : {}),
        personas: { visitor: { seeds: ['/'] } },
        ...(detected?.routes ? { routes: { ...detected.routes, ...routeDefaults(detected) } } : {}),
        ...(detected?.source ? { source: detected.source } : {}),
        ...(params && Object.keys(params).length ? { params } : {}),
    };
}

function routeDefaults(detected: Detected): Partial<NonNullable<SpiderJson['routes']>> {
    // Laravel lists API and health routes alongside pages; start with the usual suspects hidden.
    if (detected.framework === 'laravel') {
        let domain: string | undefined;
        try {
            domain = detected.url ? new URL(detected.url).hostname : undefined;
        } catch {
            /* not a URL */
        }
        return { exclude: ['/api/**', '/up', '/sanctum/**', '/_ignition/**', '/telescope/**', '/horizon/**', '/storage/**'], ...(domain ? { domain } : {}) };
    }
    return {};
}

/** The picker's selection → spider.json: a visitor for open routes, a signing-in persona for walled ones. */
export function buildConfig(root: string, draft: SetupDraft): SpiderJson {
    const base = draftJson(root, draft.baseURL, draft.appDir, draft.params);
    const open = draft.selection.filter((r) => !r.signIn);
    const walled = draft.selection.filter((r) => r.signIn);
    const glob = (pattern: string) => pattern.replace(/\/:\w+\?/g, '/**').replace(/:\w+/g, '*');
    const seedsOf = (routes: SetupDraft['selection']) => [...new Set(routes.map((r) => r.path ?? r.pattern).filter((p) => !p.includes(':')))];

    const persona = (routes: SetupDraft['selection'], extra: Partial<PersonaJson> = {}): PersonaJson => ({
        seeds: seedsOf(routes).length ? seedsOf(routes) : ['/'],
        ...(draft.onlySelected ? { include: [...new Set(routes.map((r) => glob(r.pattern)))] } : {}),
        ...extra,
    });

    const personas: Record<string, PersonaJson> = {};
    if (open.length || !walled.length) personas.visitor = persona(open);
    if (walled.length) {
        const name = draft.signInPersona?.trim() || 'user';
        // Sign-in and sign-out pages bounce a signed-in user around; keep them out of that persona's crawl.
        personas[name] = persona(walled, { login: 'manual', exclude: ['**/login', '**/logout', '**/sign-in', '**/sign-out'] });
    }

    const guessed = (draft.patterns ?? []).filter((p) => p.includes(':'));
    const routes = base.routes
        ? { ...base.routes, exclude: [...new Set([...(base.routes.exclude ?? []), ...(draft.hidden ?? [])])] }
        : guessed.length
          ? { preset: 'sitemap' as const, extra: guessed }
          : undefined;
    return {
        $schema: relative(root, SCHEMA).startsWith('../../..') ? SCHEMA : relative(root, SCHEMA),
        name: draft.name || base.name,
        baseURL: base.baseURL,
        ...(base.app ? { app: base.app } : {}),
        viewports: draft.viewports?.length ? draft.viewports : [{ id: 'desktop', width: 1440, height: 900 }],
        colorSchemes: draft.colorSchemes?.length ? draft.colorSchemes : ['light'],
        personas,
        ...(routes ? { routes } : {}),
        ...(base.source ? { source: base.source } : {}),
        ...(draft.params && Object.keys(draft.params).length ? { params: draft.params } : {}),
    };
}

/** Routes the picker should pre-select: real pages that answered, or need sign-in. */
export function suggested(route: RouteCheck): boolean {
    if (route.hidden || route.kind !== 'page') return false;
    return route.signIn || (route.status !== null && route.status < 400);
}

function appPath(root: string, appDir: string): string {
    const abs = resolve(root, appDir);
    const rel = relative(root, abs);
    return rel === '' ? '.' : rel.startsWith('../../..') ? abs : rel;
}

function safeJson<T>(text: string): T | undefined {
    try {
        return text ? (JSON.parse(text) as T) : undefined;
    } catch {
        return undefined;
    }
}
