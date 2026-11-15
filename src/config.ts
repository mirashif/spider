// A project is a folder with spider.json (what the UI edits) and, optionally, spider.config.ts (code-only hooks).
// Data lives next to them in .spider/.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ColorScheme, ViewportSpec } from './contracts.ts';
import { maybeRegExp, toRegExp } from './patterns.ts';

export const CONFIG_FILE = 'spider.json';
export const HOOKS_FILE = 'spider.config.ts';
export const DATA_DIR_NAME = '.spider';

/** A locator described in config. Resolved with Playwright's role/test-id/text locators. */
export type LocatorSpec =
    | { role: string; name?: string | RegExp; exact?: boolean }
    | { testId: string }
    | { text: string | RegExp }
    | { css: string };

export type Step =
    | { goto: string }
    | { fill: LocatorSpec; value: string }
    | { click: LocatorSpec }
    | { press: string }
    | { waitForURL: string | RegExp }
    | { waitFor: LocatorSpec };

// ---- spider.json, as written on disk ----

export interface PersonaJson {
    /** Pages the crawl starts from. */
    seeds: string[];
    /** Only follow paths matching one of these globs ("re:" for a regex). Default: the whole origin. */
    include?: string[];
    exclude?: string[];
    /** "manual": sign in by hand with `spider-web login <persona>`. Or steps that sign in. Absent: no sign-in. */
    login?: 'manual' | Step[];
}

export interface StateJson {
    persona: string;
    route: string;
    name: string;
    steps: Step[];
}

export interface RoutesJson {
    /** Where the app's route list comes from. */
    preset: 'laravel' | 'sitemap';
    /** laravel: the command that prints `route:list --json`, run in the app folder. */
    command?: string[];
    /** laravel: only routes registered for this domain. */
    domain?: string;
    /** Routes to leave out (API, downloads…): globs. Hidden in the route picker. */
    exclude?: string[];
    /** Route patterns to use as-is, most specific first, on top of the preset's. */
    extra?: string[];
}

export interface SpiderJson {
    $schema?: string;
    name: string;
    baseURL: string;
    /** The app's own folder, relative to this file: git info, route lists, source links. Default ".". */
    app?: string;
    /** Shell command run in the app folder before each crawl (e.g. rebuild assets). */
    prepare?: string;
    viewports?: ViewportSpec[];
    colorSchemes?: ColorScheme[];
    /** Frozen browser clock, so relative times don't change between runs. */
    clock?: string;
    maxScreens?: number;
    maxShotHeight?: number;
    personas: Record<string, PersonaJson>;
    routes?: RoutesJson;
    /** Sample values for route parameters, e.g. { "tenant": "alpha" }. */
    params?: Record<string, string>;
    /** How screens map to source files. */
    source?: { preset: 'inertia'; pages?: string; ext?: string };
    states?: StateJson[];
    /** CSS selectors painted over before each shot. */
    mask?: string[];
    /** Extra CSS injected before shots. */
    css?: string;
}

// ---- spider.config.ts hooks ----

export interface Hooks {
    /** Route patterns from code, when no preset fits. */
    routes?: (ctx: { appDir: string }) => string[] | Promise<string[]>;
    /** Maps a page to its source file, relative to the app folder. */
    sourceFile?: (page: { component?: string; route: string }) => string | undefined;
    /** Sign-in steps that need code (regexes, env lookups), per persona. */
    login?: Record<string, Step[]>;
}

export function defineHooks(hooks: Hooks): Hooks {
    return hooks;
}

// ---- Resolved config, what the rest of the code uses ----

export interface PersonaConfig {
    seeds: string[];
    include?: RegExp[];
    exclude?: RegExp[];
    signIn: 'none' | 'steps' | 'manual';
    login?: Step[];
}

export interface StateConfig {
    persona: string;
    route: string;
    name: string;
    steps: Step[];
}

export interface ProjectConfig {
    name: string;
    baseURL: string;
    appDir: string;
    prepare?: string;
    viewports: ViewportSpec[];
    colorSchemes: ColorScheme[];
    clock?: string;
    maxScreens: number;
    maxShotHeight: number;
    personas: Record<string, PersonaConfig>;
    routes?: RoutesJson;
    routeExclude: RegExp[];
    params: Record<string, string>;
    source?: SpiderJson['source'];
    states: StateConfig[];
    mask: string[];
    css?: string;
    hooks: Hooks;
}

export interface Project {
    root: string;
    configPath: string;
    dataDir: string;
    json: SpiderJson;
    config: ProjectConfig;
}

export const DEFAULT_VIEWPORTS: ViewportSpec[] = [
    { id: 'desktop', width: 1440, height: 900 },
    { id: 'mobile', width: 390, height: 844 },
];

export class ConfigError extends Error {}

/** Finds the project folder: the first folder from `start` upwards with a spider.json. */
export function findProjectRoot(start: string): string | undefined {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, CONFIG_FILE))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

export async function loadProject(start = process.cwd()): Promise<Project> {
    const root = findProjectRoot(start);
    if (!root) throw new ConfigError(`No ${CONFIG_FILE} in ${resolve(start)} or above. Run: spider-web init --url <app url>`);
    const configPath = join(root, CONFIG_FILE);
    let json: SpiderJson;
    try {
        json = JSON.parse(readFileSync(configPath, 'utf8')) as SpiderJson;
    } catch (error) {
        throw new ConfigError(`${configPath}: ${(error as Error).message}`);
    }
    const hooksPath = join(root, HOOKS_FILE);
    let hooks: Hooks = {};
    if (existsSync(hooksPath)) {
        const mod = (await import(pathToFileURL(hooksPath).href)) as { default?: Hooks };
        hooks = mod.default ?? {};
    }
    return { root, configPath, dataDir: join(root, DATA_DIR_NAME), json, config: resolveConfig(root, json, hooks) };
}

export function resolveConfig(root: string, raw: SpiderJson, hooks: Hooks): ProjectConfig {
    const json = interpolate(raw) as SpiderJson;
    if (!json.baseURL) throw new ConfigError(`${CONFIG_FILE}: baseURL is required`);
    if (!json.personas || Object.keys(json.personas).length === 0) throw new ConfigError(`${CONFIG_FILE}: add at least one persona`);
    const personas: Record<string, PersonaConfig> = {};
    for (const [name, p] of Object.entries(json.personas)) {
        const steps = hooks.login?.[name] ?? (Array.isArray(p.login) ? p.login.map(reviveStep) : undefined);
        personas[name] = {
            seeds: p.seeds?.length ? p.seeds : ['/'],
            include: p.include?.map(toRegExp),
            exclude: p.exclude?.map(toRegExp),
            signIn: steps ? 'steps' : p.login === 'manual' ? 'manual' : 'none',
            login: steps,
        };
    }
    return {
        name: json.name || new URL(json.baseURL).host,
        baseURL: json.baseURL,
        appDir: resolve(root, json.app ?? '.'),
        prepare: json.prepare,
        viewports: json.viewports?.length ? json.viewports : DEFAULT_VIEWPORTS.slice(0, 1),
        colorSchemes: json.colorSchemes?.length ? json.colorSchemes : ['light'],
        clock: json.clock,
        maxScreens: json.maxScreens ?? 60,
        maxShotHeight: json.maxShotHeight ?? 4000,
        personas,
        routes: json.routes,
        routeExclude: (json.routes?.exclude ?? []).map(toRegExp),
        params: json.params ?? {},
        source: json.source,
        states: (json.states ?? []).map((s) => ({ ...s, steps: s.steps.map(reviveStep) })),
        mask: json.mask ?? [],
        css: json.css,
        hooks,
    };
}

/** "re:…" strings in steps become regexes (URL waits, role names, text). */
function reviveStep(step: Step): Step {
    const loc = (spec: LocatorSpec): LocatorSpec => {
        if ('role' in spec && typeof spec.name === 'string') return { ...spec, name: maybeRegExp(spec.name) };
        if ('text' in spec && typeof spec.text === 'string') return { text: maybeRegExp(spec.text) };
        return spec;
    };
    if ('waitForURL' in step && typeof step.waitForURL === 'string') return { waitForURL: maybeRegExp(step.waitForURL) };
    if ('fill' in step) return { ...step, fill: loc(step.fill) };
    if ('click' in step) return { click: loc(step.click) };
    if ('waitFor' in step) return { waitFor: loc(step.waitFor) };
    return step;
}

/** ${NAME} and ${NAME:-default} in any string value read the environment, so secrets stay out of spider.json. */
function interpolate(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
    }
    if (Array.isArray(value)) return value.map(interpolate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
    return value;
}

export function writeConfig(root: string, json: SpiderJson): string {
    const path = join(root, CONFIG_FILE);
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    return path;
}
