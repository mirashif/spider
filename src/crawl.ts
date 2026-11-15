import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { PersonaConfig, Project, ProjectConfig } from './config.ts';
import {
    MAP_CONTRACT,
    variantId,
    type CrawlEvent,
    type ElementInfo,
    type Gap,
    type LinkOut,
    type Screen,
    type ScreenMap,
    type Shot,
    type Transition,
    type VariantKey,
    type ViewportSpec,
} from './contracts.ts';
import { matchesAny, toRegExp } from './patterns.ts';
import { isExcludedRoute, loadRoutePatterns, sourceFileFor } from './presets/index.ts';
import { compilePatterns, patternCovered, routeFor } from './routes.ts';
import { describeStep, runSteps } from './steps.ts';
import { BASELINE, ensureDir, gitInfo, Store, writeJson } from './store.ts';

export interface CrawlOptions {
    label?: string;
    skipPrepare?: boolean;
    headed?: boolean;
    /** Only these personas. */
    personas?: string[];
    /** Only follow and capture paths matching these globs (on top of each persona's own rules). */
    only?: string[];
    onEvent?: (event: CrawlEvent) => void;
    signal?: AbortSignal;
}

/** A persona needs a person to sign in (manual sign-in with no valid saved session). */
export class NeedsSignInError extends Error {
    constructor(readonly personas: string[]) {
        super(`Sign-in needed for ${personas.join(', ')}. Run: ${personas.map((p) => `spider-web login ${p}`).join(' && ')}`);
    }
}

interface QueueItem {
    path: string;
    depth: number;
    from?: string;
    label?: string;
}

interface Variant {
    key: VariantKey;
    viewport: ViewportSpec;
    context: BrowserContext;
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

const BASE_CSS = `
*, *::before, *::after { caret-color: transparent !important; scroll-behavior: auto !important; }
#nprogress, .nprogress-custom-parent { display: none !important; }
`;

const ELEMENTS_SCRIPT = readFileSync(new URL('./capture/elements.js', import.meta.url), 'utf8');
const ELEMENT_LIMIT = 500;

export async function crawl(project: Project, options: CrawlOptions = {}): Promise<{ runId: string; map: ScreenMap }> {
    const config = project.config;
    const store = new Store(project.dataDir);
    const emit = options.onEvent ?? (() => undefined);
    const log = (message: string) => emit({ type: 'log', message });
    const startedAt = new Date().toISOString();

    const personaNames = Object.keys(config.personas).filter((name) => !options.personas?.length || options.personas.includes(name));
    const unknown = (options.personas ?? []).filter((name) => !config.personas[name]);
    if (unknown.length) throw new Error(`Unknown persona ${unknown.join(', ')}. Personas: ${Object.keys(config.personas).join(', ')}`);
    const only = options.only?.map(toRegExp);

    if (options.label === BASELINE) throw new Error('"baseline" is reserved for the accepted state; pick another label.');
    const runId = store.newRunId(options.label);
    emit({ type: 'start', run: runId, personas: personaNames });

    if (config.prepare && !options.skipPrepare) {
        emit({ type: 'phase', phase: 'prepare' });
        log(`prepare: ${config.prepare}`);
        execSync(config.prepare, { cwd: config.appDir, stdio: ['ignore', 'ignore', 'inherit'] });
    }

    emit({ type: 'phase', phase: 'routes' });
    let routeSourcePatterns: string[] = [];
    try {
        const loaded = await loadRoutePatterns(config);
        routeSourcePatterns = loaded.patterns.filter((p) => !isExcludedRoute(config, p));
        if (loaded.source !== 'none') log(`routes: ${routeSourcePatterns.length} from ${loaded.detail ?? loaded.source}`);
    } catch (error) {
        log(`routes: could not read (${firstLine(error)}); continuing without them`);
    }
    // The app's patterns, static segments before params, decide which URLs are the same screen.
    const patterns = compilePatterns(sortBySpecificity(routeSourcePatterns));

    const screens = new Map<string, Screen>();
    const transitions = new Map<string, Transition>();
    const gaps: Gap[] = [];
    const origin = new URL(config.baseURL).origin;
    const addGap = (gap: Gap) => {
        gaps.push(gap);
        emit({ type: 'gap', gap });
    };

    const browser = await chromium.launch({ headless: !options.headed });
    let runDir: string | undefined;
    try {
        // Check every session first, so a missing sign-in stops the crawl before any work, not halfway.
        emit({ type: 'phase', phase: 'sign-in' });
        const sessions = new Map<string, StorageState | undefined>();
        const missing: string[] = [];
        for (const name of personaNames) {
            const state = await signIn(browser, store, config, name, config.personas[name], addGap, log);
            if (state === 'needs-person') missing.push(name);
            else if (state !== null) sessions.set(name, state);
        }
        if (missing.length) throw new NeedsSignInError(missing);

        runDir = ensureDir(store.runDir(runId));
        ensureDir(join(runDir, 'shots'));

        for (const personaName of personaNames) {
            if (!sessions.has(personaName)) continue;
            const persona = config.personas[personaName];
            emit({ type: 'phase', phase: 'crawl', persona: personaName });
            const variants = await openVariants(browser, config, sessions.get(personaName));
            const primaryPage = await variants[0].context.newPage();
            const consoleErrors: string[] = [];
            primaryPage.on('console', (msg) => {
                if (msg.type() === 'error') consoleErrors.push(msg.text());
            });
            primaryPage.on('pageerror', (error) => consoleErrors.push(error.message));

            const routeToScreen = new Map<string, string>();
            const inRun = (path: string) => inScope(path, persona) && (!only || matchesAny(path, only));
            const queue: QueueItem[] = persona.seeds.filter(inRun).map((path) => ({ path, depth: 0 }));
            if (queue.length === 0 && only) {
                // A narrowed crawl (--only) may not include the seeds; start from the narrowed routes themselves.
                for (const pattern of routeSourcePatterns) if (!pattern.includes(':') && inRun(pattern)) queue.push({ path: pattern, depth: 0 });
            }
            const failed = new Set<string>();
            let done = 0;

            while (queue.length > 0) {
                if (options.signal?.aborted) throw new Error('Cancelled');
                const item = queue.shift()!;
                const requestedRoute = routeFor(item.path, patterns);
                if (routeToScreen.has(requestedRoute)) {
                    addTransition(transitions, item.from, routeToScreen.get(requestedRoute), item.label, 'link');
                    continue;
                }
                if (failed.has(requestedRoute)) continue;
                if (routeToScreen.size >= config.maxScreens) {
                    failed.add(requestedRoute);
                    addGap({ kind: 'capture-error', message: `Stopped at ${config.maxScreens} screens; ${item.path} not captured`, route: requestedRoute });
                    continue;
                }

                consoleErrors.length = 0;
                let response;
                try {
                    response = await primaryPage.goto(item.path, { waitUntil: 'networkidle', timeout: 20_000 });
                    await settle(primaryPage);
                } catch (error) {
                    failed.add(requestedRoute);
                    addGap({ kind: 'capture-error', message: `${item.path}: ${firstLine(error)}`, route: requestedRoute });
                    continue;
                }

                const finalUrl = new URL(primaryPage.url());
                const finalPath = finalUrl.pathname;
                const route = finalUrl.origin === origin ? routeFor(finalPath, patterns) : requestedRoute;
                if (route !== requestedRoute) routeToScreen.set(requestedRoute, `${personaName}:${route}`);
                const screenId = `${personaName}:${route}`;

                if (screens.has(screenId)) {
                    // A redirect onto a screen we already have (e.g. a guarded page bouncing to login).
                    addTransition(transitions, item.from, screenId, item.label, route !== requestedRoute ? 'redirect' : 'link');
                    continue;
                }
                routeToScreen.set(route, screenId);

                const page = await describePage(primaryPage, config, route);
                const links = await collectLinks(primaryPage, origin);
                const screen: Screen = {
                    id: screenId,
                    persona: personaName,
                    route,
                    url: item.path,
                    title: page.title,
                    httpStatus: response?.status() ?? null,
                    redirectedTo: finalPath !== new URL(item.path, config.baseURL).pathname ? finalPath : undefined,
                    depth: item.depth,
                    component: page.component,
                    sourceFile: page.sourceFile,
                    shots: [],
                    links: [],
                    consoleErrors: [...consoleErrors],
                    capturedAt: new Date().toISOString(),
                };
                screens.set(screenId, screen);
                addTransition(transitions, item.from, screenId, item.label, route !== requestedRoute ? 'redirect' : 'link');

                screen.shots = await shootVariants(variants, item.path, runDir, screenId, config);

                for (const link of links) {
                    const out: LinkOut = { label: link.label, href: link.href, bounds: link.bounds };
                    const url = new URL(link.href);
                    if (link.download) out.skipped = 'download';
                    else if (url.origin !== origin) out.skipped = 'external';
                    else if (!inRun(url.pathname)) out.skipped = 'excluded';
                    else {
                        out.targetScreenId = `${personaName}:${routeFor(url.pathname, patterns)}`;
                        // Repeats are cheap: once a route is captured, a queued repeat only adds a transition.
                        queue.push({ path: url.pathname + url.search, depth: item.depth + 1, from: screenId, label: link.label });
                    }
                    screen.links.push(out);
                }
                done++;
                emit({ type: 'screen', persona: personaName, screenId, route, title: page.title, done, queued: countNew(queue, routeToScreen, failed, patterns) });
            }

            // Fix link targets that redirected (e.g. /admin → /admin/projects).
            for (const screen of screens.values()) {
                if (screen.persona !== personaName) continue;
                for (const link of screen.links) {
                    if (!link.targetScreenId) continue;
                    const route = link.targetScreenId.slice(personaName.length + 1);
                    link.targetScreenId = routeToScreen.get(route) ?? link.targetScreenId;
                }
            }

            emit({ type: 'phase', phase: 'states', persona: personaName });
            await captureStates(config, personaName, variants, screens, transitions, addGap, runDir, log, Boolean(only));
            await Promise.all(variants.map((variant) => variant.context.close()));
        }
    } finally {
        await browser.close();
    }

    if (routeSourcePatterns.length > 0 && !only) {
        const captured = new Set([...screens.values()].filter((s) => !s.state).map((s) => s.route));
        for (const pattern of routeSourcePatterns) {
            if (!patternCovered(pattern, captured)) addGap({ kind: 'unreached-route', message: `No link led to ${pattern}`, route: pattern });
        }
    }

    emit({ type: 'phase', phase: 'write' });
    const map: ScreenMap = {
        contract: MAP_CONTRACT,
        run: {
            id: runId,
            kind: 'run',
            target: project.root,
            targetLabel: config.name,
            label: options.label,
            ...(options.personas?.length || only ? { scope: { personas: options.personas?.length ? personaNames : undefined, only: options.only } } : {}),
            baseURL: config.baseURL,
            repoPath: config.appDir,
            startedAt,
            completedAt: new Date().toISOString(),
            ...gitInfo(config.appDir),
            viewports: config.viewports,
            colorSchemes: config.colorSchemes,
            personas: personaNames,
        },
        screens: [...screens.values()],
        transitions: [...transitions.values()].filter((t) => screens.has(t.from) && screens.has(t.to)),
        gaps,
    };
    writeJson(join(runDir!, 'map.json'), map);
    return { runId, map };
}

/** Queued paths that would become new screens: the honest "left to do" number for progress. */
function countNew(queue: QueueItem[], known: Map<string, string>, failed: Set<string>, patterns: ReturnType<typeof compilePatterns>): number {
    const routes = new Set<string>();
    for (const item of queue) {
        const route = routeFor(item.path, patterns);
        if (!known.has(route) && !failed.has(route)) routes.add(route);
    }
    return routes.size;
}

function firstLine(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

function sortBySpecificity(patterns: string[]): string[] {
    const params = (p: string) => (p.match(/:/g) ?? []).length;
    return [...new Set(patterns)].sort((a, b) => params(a) - params(b) || b.length - a.length);
}

export function inScope(path: string, persona: PersonaConfig): boolean {
    if (matchesAny(path, persona.exclude)) return false;
    if (persona.include && !matchesAny(path, persona.include)) return false;
    return true;
}

function addTransition(transitions: Map<string, Transition>, from: string | undefined, to: string | undefined, label: string | undefined, kind: Transition['kind']) {
    if (!from || !to || from === to) return;
    const id = `${from}->${to}`;
    if (!transitions.has(id)) transitions.set(id, { id, from, to, label: label ?? '', kind });
}

/**
 * A session for the persona: undefined when it needs none, null when scripted sign-in failed (a gap is recorded),
 * or 'needs-person' when it signs in by hand and has no saved session that still works.
 */
async function signIn(
    browser: Browser,
    store: Store,
    config: ProjectConfig,
    personaName: string,
    persona: PersonaConfig,
    addGap: (gap: Gap) => void,
    log: (line: string) => void,
): Promise<StorageState | undefined | null | 'needs-person'> {
    if (persona.signIn === 'none') return undefined;

    // Reuse the last session while it still lands in scope: sign-in endpoints are often rate limited.
    const saved = store.sessionPath(personaName);
    const reused = existsSync(saved) ? await validSession(browser, config, persona, JSON.parse(readFileSync(saved, 'utf8')) as StorageState) : undefined;
    if (reused) {
        log(`${personaName}: reusing saved session`);
        return reused;
    }
    if (persona.signIn === 'manual') return 'needs-person';

    const context = await browser.newContext({ baseURL: config.baseURL });
    const page = await context.newPage();
    try {
        await runSteps(page, persona.login!);
        log(`${personaName}: signed in (${new URL(page.url()).pathname})`);
        const state = await context.storageState();
        ensureDir(store.authDir);
        writeFileSync(saved, JSON.stringify(state));
        return state;
    } catch (error) {
        const message = `Sign-in for ${personaName} failed: ${firstLine(error)}`;
        const shot = join(ensureDir(store.authDir), `${personaName}-failed.png`);
        await page.screenshot({ path: shot }).catch(() => undefined);
        log(`${message} (page: ${shot})`);
        addGap({ kind: 'login-failed', message: `${message}. Ended on ${page.url()}. Steps: ${persona.login!.map(describeStep).join(' → ')}` });
        return null;
    } finally {
        await context.close();
    }
}

/**
 * The session if it still works: its first seed lands in scope (not bounced to a login page), and, for personas
 * that sign in, the page differs from what a signed-out visitor sees there (sites that show the same page to both
 * would otherwise keep an expired session forever).
 */
export async function validSession(browser: Browser, config: ProjectConfig, persona: PersonaConfig, state: StorageState): Promise<StorageState | undefined> {
    const look = async (storageState?: StorageState) => {
        const context = await browser.newContext({ baseURL: config.baseURL, storageState });
        try {
            const page = await context.newPage();
            await page.goto(persona.seeds[0], { waitUntil: 'networkidle', timeout: 20_000 });
            const text = await page.evaluate(() => document.body?.innerText ?? '');
            return { path: new URL(page.url()).pathname, text, state: await context.storageState() };
        } finally {
            await context.close();
        }
    };
    try {
        const signedIn = await look(state);
        if (!inScope(signedIn.path, persona)) return undefined;
        if (persona.signIn !== 'none') {
            const signedOut = await look();
            if (signedOut.path === signedIn.path && signedOut.text === signedIn.text) return undefined;
        }
        return signedIn.state;
    } catch {
        return undefined;
    }
}

async function openVariants(browser: Browser, config: ProjectConfig, storageState: StorageState | undefined): Promise<Variant[]> {
    const variants: Variant[] = [];
    for (const viewport of config.viewports) {
        for (const colorScheme of config.colorSchemes) {
            const context = await browser.newContext({
                baseURL: config.baseURL,
                viewport: { width: viewport.width, height: viewport.height },
                colorScheme,
                storageState,
                deviceScaleFactor: 1,
                reducedMotion: 'reduce',
                timezoneId: 'UTC',
                locale: 'en-US',
            });
            if (config.clock) await context.clock.setFixedTime(new Date(config.clock));
            // A string, not a function: tsx rewrites named functions with a __name helper the page doesn't have.
            await context.addInitScript(`(() => {
                const css = ${JSON.stringify(BASE_CSS + (config.css ?? ''))};
                function apply() {
                    const style = document.createElement('style');
                    style.setAttribute('data-spider', '');
                    style.textContent = css;
                    document.head.appendChild(style);
                }
                if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply);
            })();`);
            variants.push({ key: { viewport: viewport.id, colorScheme }, viewport, context });
        }
    }
    return variants;
}

async function settle(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
            [...document.images].filter((img) => !img.complete).map((img) => new Promise((resolve) => img.addEventListener('load', resolve, { once: true }))),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function describePage(page: Page, config: ProjectConfig, route: string): Promise<{ title: string; component?: string; sourceFile?: string }> {
    const { title, component } = await page.evaluate(() => {
        let component: string | undefined;
        const el = document.querySelector('[data-page]');
        try {
            const raw = el?.tagName === 'SCRIPT' ? el.textContent : el?.getAttribute('data-page');
            if (raw) component = (JSON.parse(raw) as { component?: string }).component;
        } catch {
            /* not an Inertia page */
        }
        component ??= (history.state as { page?: { component?: string } } | null)?.page?.component;
        return { title: document.title, component };
    });
    return { title, component, sourceFile: sourceFileFor(config, { component, route }) };
}

async function collectLinks(page: Page, origin: string) {
    return page.evaluate((origin) => {
        const seen = new Set<string>();
        const out: { label: string; href: string; download: boolean; bounds?: { x: number; y: number; width: number; height: number } }[] = [];
        for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
            const href = a.href;
            if (!/^https?:/.test(href)) continue;
            const rect = a.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(a).visibility !== 'hidden';
            const label = (a.getAttribute('aria-label') || a.textContent || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const key = `${href}|${label}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const url = new URL(href);
            url.hash = '';
            out.push({
                label: label || url.pathname,
                href: url.toString(),
                download: a.hasAttribute('download') && url.origin === origin,
                bounds: visible ? { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height } : undefined,
            });
        }
        return out;
    }, origin);
}

async function shootVariants(variants: Variant[], path: string, runDir: string, screenId: string, config: ProjectConfig, before?: (page: Page) => Promise<void>): Promise<Shot[]> {
    const shots = await Promise.all(
        variants.map(async (variant): Promise<Shot | null> => {
            const page = await variant.context.newPage();
            try {
                await page.goto(path, { waitUntil: 'networkidle', timeout: 20_000 });
                if (before) await before(page);
                await settle(page);
                return await shoot(page, variant, runDir, screenId, config);
            } catch {
                return null;
            } finally {
                await page.close();
            }
        }),
    );
    return shots.filter((shot): shot is Shot => shot !== null);
}

async function shoot(page: Page, variant: Variant, runDir: string, screenId: string, config: ProjectConfig): Promise<Shot> {
    const cap = config.maxShotHeight;
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    const fullHeight = Math.max(height, variant.viewport.height);
    const shotHeight = Math.min(fullHeight, cap);
    const name = `shots/${slug(screenId)}__${variantId(variant.key)}`;
    // Elements are measured in the same layout the shot shows, before masks paint over anything.
    const elements = (await page.evaluate(`(${ELEMENTS_SCRIPT})(${JSON.stringify({ maxHeight: shotHeight, limit: ELEMENT_LIMIT })})`)) as ElementInfo[];
    writeFileSync(join(runDir, `${name}.elements.json`), JSON.stringify(elements));
    // Where the masks land, so compare can ignore those areas even when an overlay tints the mask colour.
    const masked = config.mask.length
        ? await page.evaluate((selectors) => {
              const out: { x: number; y: number; width: number; height: number }[] = [];
              for (const selector of selectors) {
                  let found: Element[] = [];
                  try {
                      found = [...document.querySelectorAll(selector)];
                  } catch {
                      /* invalid selector: Playwright reports it */
                  }
                  for (const el of found) {
                      const r = el.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) out.push({ x: Math.floor(r.left + scrollX), y: Math.floor(r.top + scrollY), width: Math.ceil(r.width), height: Math.ceil(r.height) });
                  }
              }
              return out;
          }, config.mask)
        : [];
    await page.screenshot({
        path: join(runDir, `${name}.png`),
        fullPage: true,
        clip: { x: 0, y: 0, width: variant.viewport.width, height: shotHeight },
        animations: 'disabled',
        caret: 'hide',
        mask: config.mask.map((selector) => page.locator(selector)),
        maskColor: '#FF00FF',
    });
    return {
        variant: variant.key,
        path: `${name}.png`,
        width: variant.viewport.width,
        height: shotHeight,
        truncated: fullHeight > cap,
        elements: `${name}.elements.json`,
        ...(masked.length ? { masked } : {}),
    };
}

async function captureStates(
    config: ProjectConfig,
    personaName: string,
    variants: Variant[],
    screens: Map<string, Screen>,
    transitions: Map<string, Transition>,
    addGap: (gap: Gap) => void,
    runDir: string,
    log: (line: string) => void,
    narrowed: boolean,
): Promise<void> {
    for (const state of config.states) {
        if (state.persona !== personaName) continue;
        const base = screens.get(`${personaName}:${state.route}`);
        if (!base) {
            // Not an error in a narrowed crawl (--only): the route just wasn't part of it.
            if (narrowed) continue;
            addGap({ kind: 'state-failed', message: `State "${state.name}" needs ${state.route}, which was not captured`, route: state.route });
            continue;
        }
        const screenId = `${base.id}#${slug(state.name)}`;
        const shots = await shootVariants(variants, base.url, runDir, screenId, config, (page) => runSteps(page, state.steps));
        if (shots.length === 0) {
            addGap({ kind: 'state-failed', message: `State "${state.name}" on ${state.route}: steps failed (${state.steps.map(describeStep).join(' → ')})`, screenId: base.id });
            continue;
        }
        screens.set(screenId, {
            ...base,
            id: screenId,
            state: state.name,
            depth: base.depth + 1,
            shots,
            links: [],
            consoleErrors: [],
            capturedAt: new Date().toISOString(),
        });
        addTransition(transitions, base.id, screenId, state.name, 'state');
        log(`state ${state.route} › ${state.name}`);
    }
}

export function slug(value: string): string {
    return (
        value
            .replace(/^[^:]+:/, (m) => m.replace(':', '__'))
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase() || 'root'
    );
}
