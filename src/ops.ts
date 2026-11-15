// What both the CLI and the server do: crawl (one at a time per project), review against the baseline, accept.
// The CLI and the UI call these same functions, so they can't drift apart.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { accept, type AcceptResult } from './baseline.ts';
import { compareRuns, type CompareOptions } from './compare.ts';
import type { Project } from './config.ts';
import { variantId, type ChangeStatus, type Comparison, type CrawlEvent, type JobInfo, type ProjectInfo, type ScreenMap } from './contracts.ts';
import { crawl, NeedsSignInError, type CrawlOptions } from './crawl.ts';
import { matchesAny, toRegExp } from './patterns.ts';
import { BASELINE, Store } from './store.ts';

export interface CrawlRunResult {
    run: string;
    screens: number;
    transitions: number;
    shots: number;
    gaps: ScreenMap['gaps'];
    map: ScreenMap;
}

export interface ChangeSummary {
    screen: string;
    status: ChangeStatus;
    variants: { variant: string; status: ChangeStatus; diffRatio: number; regions: [number, number, number, number][]; before?: string; after?: string; diff?: string }[];
    linksAdded: string[];
    linksRemoved: string[];
}

export interface ReviewResult {
    run: string;
    /** "created" when there was no baseline yet and this run became it. */
    baseline: 'created' | 'compared';
    comparison?: string;
    summary?: Record<ChangeStatus, number>;
    changes: ChangeSummary[];
}

/** Crawls under the project lock, relaying progress to a running server so the UI shows it live. */
export async function runCrawl(project: Project, options: CrawlOptions & { by: 'ui' | 'cli'; relay?: Relay }): Promise<CrawlRunResult> {
    const store = new Store(project.dataDir);
    const release = store.acquireLock(options.by);
    const ownRelay = !options.relay;
    const relay = options.relay ?? (options.by === 'cli' ? relayTo(store, 'crawl', options.label) : undefined);
    try {
        const { runId, map } = await crawl(project, {
            ...options,
            onEvent: (event) => {
                options.onEvent?.(event);
                relay?.event(event);
            },
        });
        const result = { run: runId, screens: map.screens.length, transitions: map.transitions.length, shots: map.screens.reduce((n, s) => n + s.shots.length, 0), gaps: map.gaps, map };
        if (ownRelay) relay?.end({ status: 'done', result: { run: runId, screens: result.screens } });
        return result;
    } catch (error) {
        relay?.end(error instanceof NeedsSignInError ? { status: 'needs-sign-in', needsSignIn: error.personas, error: error.message } : { status: 'failed', error: (error as Error).message });
        throw error;
    } finally {
        release();
    }
}

/** Crawl, then compare against the baseline. With no baseline yet, the run becomes it. */
export async function runReview(project: Project, options: CrawlOptions & { by: 'ui' | 'cli'; base?: string; compare?: CompareOptions }): Promise<ReviewResult & { crawl: CrawlRunResult }> {
    const store = new Store(project.dataDir);
    const relay = options.by === 'cli' ? relayTo(store, 'review', options.label) : undefined;
    const crawled = await runCrawl(project, { ...options, relay });
    try {
        const baseRef = options.base ?? BASELINE;
        if (baseRef === BASELINE && !store.baseline()) {
            accept(store, crawled.run);
            relay?.end({ status: 'done', result: { run: crawled.run, screens: crawled.screens } });
            return { crawl: crawled, run: crawled.run, baseline: 'created', changes: [] };
        }
        const base = store.readMap(store.resolveRun(baseRef));
        const { id, comparison } = compareRuns(store, scopeTo(base, crawled.map), crawled.map, options.compare);
        relay?.end({ status: 'done', result: { run: crawled.run, comparison: id, summary: comparison.summary, screens: crawled.screens } });
        return { crawl: crawled, run: crawled.run, baseline: 'compared', comparison: id, summary: comparison.summary, changes: summarize(store, comparison) };
    } catch (error) {
        relay?.end({ status: 'failed', error: (error as Error).message });
        throw error;
    }
}

export function compareRefs(project: Project, baseRef: string, headRef: string, options?: CompareOptions): ReviewResult {
    const store = new Store(project.dataDir);
    const baseId = store.resolveRun(baseRef);
    const headId = store.resolveRun(headRef);
    if (baseId === headId) throw new Error(`Base and head are the same run (${baseId}).`);
    const head = store.readMap(headId);
    const { id, comparison } = compareRuns(store, scopeTo(store.readMap(baseId), head), head, options);
    return { run: headId, baseline: 'compared', comparison: id, summary: comparison.summary, changes: summarize(store, comparison) };
}

/** Accept screens from a run, then re-compare that run so the UI shows what's still different. */
export function acceptAndRecompare(project: Project, runRef: string, screens?: string[]): AcceptResult & { run: string; comparison?: string; summary?: Record<ChangeStatus, number> } {
    const store = new Store(project.dataDir);
    const run = store.resolveRun(runRef);
    const result = accept(store, run, screens);
    if (result.created || !screens?.length) return { ...result, run };
    const head = store.readMap(run);
    const { id, comparison } = compareRuns(store, scopeTo(store.readMap(BASELINE), head), head);
    return { ...result, run, comparison: id, summary: comparison.summary };
}

/**
 * A narrowed run (--as, --only, a recrawl) covers part of the app: compare only that part of the base, or every
 * screen it didn't visit would show up as removed.
 */
export function scopeTo(base: ScreenMap, head: ScreenMap): ScreenMap {
    const scope = head.run.scope;
    if (!scope) return base;
    const only = scope.only?.map(toRegExp);
    const inScope = (screen: ScreenMap['screens'][number]) =>
        (!scope.personas?.length || scope.personas.includes(screen.persona)) && (!only || matchesAny(screen.url.split('?')[0], only));
    return { ...base, screens: base.screens.filter(inScope) };
}

/** The agent-facing view of a comparison: only what changed, with absolute image paths. */
export function summarize(store: Store, comparison: Comparison): ChangeSummary[] {
    const baseDir = store.runDir(comparison.base.id);
    const headDir = store.runDir(comparison.head.id);
    const cmpDir = join(store.comparisonsDir, comparison.id);
    const base = store.hasRun(comparison.base.id) ? store.readMap(comparison.base.id) : undefined;
    const head = store.readMap(comparison.head.id);
    const shot = (map: ScreenMap | undefined, dir: string, screenId: string, key: string) => {
        const s = map?.screens.find((x) => x.id === screenId)?.shots.find((x) => variantId(x.variant) === key);
        const path = s ? join(dir, s.path) : undefined;
        return path && existsSync(path) ? path : undefined;
    };
    return comparison.changes
        .filter((c) => c.status !== 'unchanged')
        .map((c) => ({
            screen: c.screenId,
            status: c.status,
            variants: c.variants
                .filter((v) => v.status !== 'unchanged')
                .map((v) => {
                    const key = variantId(v.variant);
                    return {
                        variant: key,
                        status: v.status,
                        diffRatio: Number(v.diffRatio.toFixed(5)),
                        regions: v.regions.slice(0, 10).map((r) => [r.x, r.y, r.width, r.height] as [number, number, number, number]),
                        before: shot(base, baseDir, c.screenId, key),
                        after: shot(head, headDir, c.screenId, key),
                        diff: v.diffPath ? join(cmpDir, v.diffPath) : undefined,
                    };
                }),
            linksAdded: c.linksAdded,
            linksRemoved: c.linksRemoved,
        }));
}

export function projectInfo(project: Project): ProjectInfo {
    const store = new Store(project.dataDir);
    const c = project.config;
    return {
        name: c.name,
        root: project.root,
        configPath: project.configPath,
        baseURL: c.baseURL,
        appDir: c.appDir,
        personas: Object.entries(c.personas).map(([name, p]) => ({ name, signIn: p.signIn, hasSession: existsSync(store.sessionPath(name)) })),
        viewports: c.viewports,
        colorSchemes: c.colorSchemes,
    };
}

// ---- Relaying CLI progress to a running server ----

type RelayEnd = Pick<JobInfo, 'status' | 'result' | 'error' | 'needsSignIn'>;
export type Relay = NonNullable<ReturnType<typeof relayTo>>;

function relayTo(store: Store, kind: JobInfo['kind'], label?: string) {
    const server = store.serverInfo();
    if (!server) return undefined;
    const id = `cli-${process.pid}-${Date.now()}`;
    let chain = Promise.resolve();
    const post = (body: unknown) => {
        // In order, and never failing the crawl: the UI is a nice-to-have here.
        chain = chain.then(() =>
            fetch(`${server.url}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
                .then(() => undefined)
                .catch(() => undefined),
        );
    };
    post({ id, kind, label, start: true });
    return {
        event: (event: CrawlEvent) => post({ id, event }),
        end: (end: RelayEnd) => post({ id, end }),
    };
}
