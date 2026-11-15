// spider-web's command line. Built for two readers:
//  - people in a terminal: short, readable progress and results
//  - agents: --json prints one result object on stdout, progress goes to stderr as NDJSON, nothing ever prompts,
//    and exit codes carry the outcome (0 nothing changed, 1 changes, 2 error, 3 needs a person).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkRoutes, lastRouteCheck } from './check.ts';
import { ConfigError, CONFIG_FILE, findProjectRoot, loadProject, writeConfig, type Project, type SpiderJson } from './config.ts';
import { variantId, type CrawlEvent, type ElementInfo, type RouteCheck } from './contracts.ts';
import { NeedsSignInError } from './crawl.ts';
import { manualLogin } from './login.ts';
import { updateMasks } from './mask.ts';
import { acceptAndRecompare, compareRefs, projectInfo, runCrawl, runReview, type ChangeSummary, type ReviewResult } from './ops.ts';
import { BASELINE, ensureDataDir, readJson, Store } from './store.ts';

const EXIT = { ok: 0, changes: 1, error: 2, person: 3 } as const;

const HELP = `spider-web: map a web app's screens, review visual changes, hand them to agents.

Run with no command to open the app (http://localhost:4320). Without a spider.json, the app starts with setup.

Set up
  init     --url URL [--name N] [--app DIR] [--persona P] [--login manual] [--route GLOB]… [--exclude GLOB]… [--param K=V]…
  routes   [--refresh]            The app's routes, each checked once: status, sign-in, missing params.
  login    PERSONA                Opens a browser; sign in by hand, close the window, the session is saved.

Capture and review
  crawl    [--as P]… [--only GLOB]… [--label L] [--skip-prepare] [--headed]
  review   (crawl flags) [--base REF]   Crawl, then compare with the baseline. The first review creates it.
  compare  [BASE] [HEAD]          Compare two runs (ids, labels, latest, previous, baseline).
  accept   [SCREEN…] [--run REF]  Make a run (or some of its screens) the new baseline.
  mask     [--css SEL]… [--unmask SEL]…   Hide parts that change on their own (times, avatars).

Look
  runs                            Runs, the baseline, comparisons.
  screens  [--run REF]            Screens in a run, with absolute shot paths.
  show     SCREEN [--run REF] [--variant V] [--elements]
  serve    [--port N] [--no-open] The app (also: spider-web with no command).
  explain                         What spider.json can hold.

Every command: --json (one result on stdout, NDJSON progress on stderr), -C DIR (project folder).
Exit codes: 0 done, nothing changed · 1 visual changes · 2 error · 3 needs a person (e.g. sign-in).`;

const OPTIONS = {
    json: { type: 'boolean' },
    project: { type: 'string', short: 'C' },
    help: { type: 'boolean', short: 'h' },
    // init
    url: { type: 'string' },
    name: { type: 'string' },
    app: { type: 'string' },
    persona: { type: 'string' },
    login: { type: 'string' },
    route: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    param: { type: 'string', multiple: true },
    seed: { type: 'string', multiple: true },
    force: { type: 'boolean' },
    // crawl / review
    as: { type: 'string', multiple: true },
    only: { type: 'string', multiple: true },
    label: { type: 'string' },
    'skip-prepare': { type: 'boolean' },
    headed: { type: 'boolean' },
    base: { type: 'string' },
    'min-pixels': { type: 'string' },
    threshold: { type: 'string' },
    // look
    run: { type: 'string' },
    variant: { type: 'string' },
    elements: { type: 'boolean' },
    refresh: { type: 'boolean' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    // mask
    css: { type: 'string', multiple: true },
    unmask: { type: 'string', multiple: true },
} as const;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: string[]) {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
}

class Output {
    readonly tty = Boolean(process.stdout.isTTY);
    private live = false;

    constructor(readonly json: boolean) {}

    /** The final result: JSON on stdout for agents, or the human rendering. */
    result(value: unknown, human: () => void) {
        this.endLive();
        if (this.json) process.stdout.write(`${JSON.stringify(value)}\n`);
        else human();
    }

    line(text = '') {
        if (this.json) return;
        this.endLive();
        console.log(text);
    }

    /** Progress: NDJSON on stderr for agents; a single updating line in a terminal; plain lines otherwise. */
    event(event: CrawlEvent) {
        if (this.json) {
            process.stderr.write(`${JSON.stringify(event)}\n`);
            return;
        }
        if (event.type === 'screen') {
            const text = `  ${event.persona.padEnd(10)} ${String(event.done).padStart(3)} captured · ${String(event.queued).padStart(2)} queued   ${event.route}`;
            if (this.tty) {
                process.stdout.write(`\r\x1b[2K${dim(text.slice(0, (process.stdout.columns || 100) - 1))}`);
                this.live = true;
            } else console.log(text);
        } else if (event.type === 'phase' && event.phase === 'crawl') this.line(`${event.persona}`);
        else if (event.type === 'log') this.line(dim(`  ${event.message}`));
        else if (event.type === 'gap' && event.gap.kind !== 'unreached-route') this.line(yellow(`  ! ${event.gap.message}`));
    }

    private endLive() {
        if (this.live) {
            process.stdout.write('\n');
            this.live = false;
        }
    }
}

const color = (code: number) => (text: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = color(2);
const green = color(32);
const yellow = color(33);
const red = color(31);
const bold = color(1);

async function main(): Promise<number> {
    let parsed;
    try {
        parsed = parse(process.argv.slice(2));
    } catch (error) {
        return fail(new Output(process.argv.includes('--json')), 'usage', (error as Error).message, 'spider-web --help');
    }
    const { values, positionals } = parsed;
    const [command, ...args] = positionals;
    const out = new Output(Boolean(values.json));
    const cwd = resolve(values.project ?? process.cwd());

    if (values.help || command === 'help') {
        console.log(HELP);
        return EXIT.ok;
    }

    try {
        switch (command) {
            case undefined:
                if (!process.stdout.isTTY || values.json) {
                    console.log(HELP);
                    return EXIT.ok;
                }
                return await serve(out, cwd, values);
            case 'serve':
            case 'view':
                return await serve(out, cwd, values);
            case 'init':
                return await init(out, cwd, values);
            case 'explain':
                return explain(out);
        }

        const project = await loadProject(cwd);
        ensureDataDir(project.dataDir);
        switch (command) {
            case 'routes':
                return await routes(out, project, values);
            case 'login':
                return await login(out, project, args[0]);
            case 'crawl':
                return await crawlCmd(out, project, values);
            case 'review':
                return await reviewCmd(out, project, values);
            case 'compare':
                return compareCmd(out, project, args, values);
            case 'accept':
                return acceptCmd(out, project, args, values);
            case 'runs':
                return runs(out, project);
            case 'screens':
                return screens(out, project, values);
            case 'show':
                return show(out, project, args[0], values);
            case 'mask':
                return mask(out, project, values);
            default:
                return fail(out, 'usage', `Unknown command "${command}".`, 'spider-web --help');
        }
    } catch (error) {
        if (error instanceof NeedsSignInError) {
            return fail(out, 'needs-sign-in', error.message, `ask the user to run: ${error.personas.map((p) => `spider-web login ${p}`).join(' && ')}`, EXIT.person, { personas: error.personas });
        }
        if (error instanceof ConfigError) return fail(out, 'config', error.message, existsSync(join(cwd, CONFIG_FILE)) ? 'spider-web explain' : 'spider-web init --url <app url>');
        return fail(out, 'error', (error as Error).message);
    }
}

function fail(out: Output, code: string, message: string, next?: string, exit: number = EXIT.error, extra: Record<string, unknown> = {}): number {
    if (out.json) process.stdout.write(`${JSON.stringify({ error: code, message, ...extra, ...(next ? { next } : {}) })}\n`);
    else {
        console.error(red(message));
        if (next) console.error(dim(`next: ${next}`));
    }
    return exit;
}

// ---- Set up ----

async function init(out: Output, cwd: string, values: Values): Promise<number> {
    const existing = findProjectRoot(cwd);
    if (existing === cwd && !values.force) return fail(out, 'exists', `${join(cwd, CONFIG_FILE)} already exists.`, 'edit it in the app (spider-web), or pass --force to replace it');
    if (!values.url) {
        // People get the setup screens; agents get told which flag they're missing.
        if (process.stdout.isTTY && !out.json) return serve(out, cwd, values);
        return fail(out, 'usage', 'init needs --url, e.g. spider-web init --url http://localhost:3000', 'or run spider-web to set up in the app');
    }

    const appDir = resolve(cwd, values.app ?? '.');
    const persona = values.persona ?? 'user';
    const params = Object.fromEntries((values.param ?? []).map((kv) => kv.split('=') as [string, string]));
    const json: SpiderJson = {
        name: values.name ?? new URL(values.url).host,
        baseURL: values.url.replace(/\/$/, ''),
        // Relative when it's nearby (so the project can move with the app), absolute when it's far away.
        ...(values.app ? { app: relative(cwd, appDir).startsWith('../../..') ? appDir : relative(cwd, appDir) || '.' } : {}),
        personas: {
            [persona]: {
                seeds: values.seed ?? ['/'],
                ...(values.route?.length ? { include: values.route } : {}),
                ...(values.exclude?.length ? { exclude: values.exclude } : {}),
                ...(values.login === 'manual' ? { login: 'manual' as const } : {}),
            },
        },
        ...(Object.keys(params).length ? { params } : {}),
    };
    // What the app folder says about its framework.
    const detected: string[] = [];
    if (existsSync(join(appDir, 'artisan'))) {
        const sail = existsSync(join(appDir, 'vendor/bin/sail'));
        json.routes = { preset: 'laravel', command: [sail ? './vendor/bin/sail' : 'php', 'artisan', 'route:list', '--json', '--method=GET'] };
        detected.push(`Laravel (routes via ${sail ? 'Sail' : 'php artisan'})`);
        for (const pages of ['resources/js/pages', 'resources/js/Pages']) {
            if (existsSync(join(appDir, pages))) {
                json.source = { preset: 'inertia', pages, ext: '.tsx' };
                detected.push('Inertia pages');
                break;
            }
        }
    }
    const path = writeConfig(cwd, json);
    ensureDataDir(join(cwd, '.spider'));
    const next = values.login === 'manual' ? `spider-web login ${persona}` : 'spider-web routes';
    out.result({ config: path, detected, personas: [persona], next }, () => {
        out.line(`${green('✓')} Wrote ${relative(process.cwd(), path) || path}${detected.length ? dim(`  detected: ${detected.join(', ')}`) : ''}`);
        out.line(dim(`next: ${next}`));
    });
    return EXIT.ok;
}

async function routes(out: Output, project: Project, values: Values): Promise<number> {
    const result = !values.refresh && lastRouteCheck(project) && isFresh(lastRouteCheck(project)!.checkedAt) ? lastRouteCheck(project)! : await checkRoutes(project);
    out.result(result, () => {
        const visible = result.routes.filter((r) => !r.hidden);
        const count = (f: (r: RouteCheck) => boolean) => visible.filter(f).length;
        out.line(`${green('✓')} ${result.routes.length} routes from ${result.detail ?? result.source}, checked in ${(result.durationMs / 1000).toFixed(1)}s`);
        out.line(dim(`  ${count((r) => r.kind === 'page' && !r.signIn)} open · ${count((r) => r.signIn)} sign-in · ${count((r) => r.kind === 'needs-param')} need a value · ${result.routes.length - visible.length} hidden`));
        for (const r of result.routes) {
            if (r.hidden) continue;
            const tag = r.signIn ? yellow('sign-in') : r.kind === 'needs-param' ? red(r.error ?? 'needs value') : r.kind === 'page' ? green(String(r.status)) : dim(`${r.kind} ${r.status ?? ''}`);
            const filled = r.path && r.path !== r.pattern ? dim(`  = ${r.path}`) : '';
            out.line(`  ${r.pattern.padEnd(42)} ${tag}${filled}`);
        }
    });
    return EXIT.ok;
}

function isFresh(iso: string): boolean {
    return Date.now() - new Date(iso).getTime() < 10 * 60_000;
}

async function login(out: Output, project: Project, persona: string | undefined): Promise<number> {
    if (!persona) return fail(out, 'usage', 'Which persona? spider-web login <persona>', `personas: ${Object.keys(project.config.personas).join(', ')}`);
    if (out.json || !process.stdout.isTTY) {
        // An agent can't sign in for the user; say what to ask for instead of opening a window nobody is watching.
        return fail(out, 'needs-person', `Signing in as ${persona} needs a person at a browser window.`, `ask the user to run: spider-web login ${persona}`, EXIT.person, { persona });
    }
    out.line('Opening a browser. Sign in, then close the window.');
    const result = await manualLogin(project, persona);
    if (!result.saved) return fail(out, 'not-signed-in', `No working session for ${persona}: the window closed on ${result.endedOn ?? 'a page outside its routes'}.`, `spider-web login ${persona}`, EXIT.person);
    out.line(`${green('✓')} Saved the ${persona} session  ${dim(relative(process.cwd(), result.path))}`);
    return EXIT.ok;
}

// ---- Capture and review ----

function crawlOptions(out: Output, values: Values) {
    return {
        by: 'cli' as const,
        label: values.label,
        skipPrepare: values['skip-prepare'],
        headed: values.headed,
        personas: values.as,
        only: values.only,
        onEvent: (event: CrawlEvent) => out.event(event),
        compare: {
            minPixels: values['min-pixels'] ? Number(values['min-pixels']) : undefined,
            threshold: values.threshold ? Number(values.threshold) : undefined,
        },
    };
}

async function crawlCmd(out: Output, project: Project, values: Values): Promise<number> {
    const started = Date.now();
    const result = await runCrawl(project, crawlOptions(out, values));
    const store = new Store(project.dataDir);
    const viewer = store.serverInfo()?.url;
    out.result(
        { run: result.run, dir: store.runDir(result.run), screens: result.screens, transitions: result.transitions, shots: result.shots, gaps: result.gaps, next: 'spider-web review, or spider-web accept to make this the baseline' },
        () => {
            out.line(`${green('✓')} ${result.screens} screens · ${result.transitions} links · ${result.shots} shots · ${Math.round((Date.now() - started) / 1000)}s  ${dim(`run ${result.run}`)}`);
            printGaps(out, result.gaps);
            if (viewer) out.line(dim(`  ${viewer}/?run=${encodeURIComponent(result.run)}`));
        },
    );
    return EXIT.ok;
}

async function reviewCmd(out: Output, project: Project, values: Values): Promise<number> {
    const result = await runReview(project, { ...crawlOptions(out, values), base: values.base });
    const changed = result.changes.length > 0;
    const { crawl: crawled, ...rest } = result;
    const store = new Store(project.dataDir);
    out.result({ ...rest, gaps: crawled.gaps, next: changed ? 'look at the diffs; spider-web accept <screen> to accept a change' : undefined }, () => {
        if (result.baseline === 'created') {
            out.line(`${green('✓')} ${crawled.screens} screens captured. No baseline yet, so this run is now the baseline.`);
            printGaps(out, crawled.gaps);
            return;
        }
        printReview(out, result);
        printGaps(out, crawled.gaps);
        const viewer = store.serverInfo()?.url;
        if (viewer && result.comparison) out.line(dim(`  ${viewer}/?compare=${encodeURIComponent(result.comparison)}`));
    });
    return changed ? EXIT.changes : EXIT.ok;
}

function compareCmd(out: Output, project: Project, args: string[], values: Values): number {
    const store = new Store(project.dataDir);
    const base = args[0] ?? (store.baseline() ? BASELINE : 'previous');
    const result = compareRefs(project, base, args[1] ?? 'latest', crawlOptions(out, values).compare);
    out.result(result, () => printReview(out, result));
    return result.changes.length ? EXIT.changes : EXIT.ok;
}

function acceptCmd(out: Output, project: Project, screenIds: string[], values: Values): number {
    const result = acceptAndRecompare(project, values.run ?? 'latest', screenIds);
    out.result(result, () => {
        const what = result.created ? 'Created the baseline' : `Baseline revision ${result.revision}`;
        out.line(`${green('✓')} ${what}: ${result.accepted.length} screen${result.accepted.length === 1 ? '' : 's'} accepted from ${result.run}${result.removed.length ? `, ${result.removed.length} removed` : ''}`);
        if (result.summary) out.line(dim(`  still different from that run: ${result.summary.modified + result.summary.added + result.summary.removed}`));
    });
    return EXIT.ok;
}

function printReview(out: Output, result: ReviewResult) {
    const s = result.summary!;
    for (const change of result.changes) {
        const label = change.status === 'modified' ? yellow('modified') : change.status === 'added' ? green('added   ') : red('removed ');
        const variants = change.variants.filter((v) => v.status === 'modified').map((v) => `${v.variant} ${pct(v.diffRatio)}`);
        out.line(`  ${label}  ${change.screen}  ${dim(variants.join(' · '))}`);
    }
    out.line(`  ${bold(String(s.modified))} modified · ${s.added} added · ${s.removed} removed · ${s.unchanged} unchanged`);
}

function pct(ratio: number): string {
    const p = ratio * 100;
    return p < 0.01 ? '<0.01%' : `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

function printGaps(out: Output, gaps: { kind: string; message: string }[]) {
    if (!gaps.length) return;
    out.line(yellow(`  ${gaps.length} gap${gaps.length === 1 ? '' : 's'}:`));
    for (const gap of gaps.slice(0, 8)) out.line(dim(`    ${gap.message}`));
    if (gaps.length > 8) out.line(dim(`    …and ${gaps.length - 8} more`));
}

// ---- Look ----

function runs(out: Output, project: Project): number {
    const store = new Store(project.dataDir);
    const index = store.index();
    out.result(index, () => {
        if (index.baseline) out.line(`${bold('baseline')}  revision ${index.baseline.revision} · from ${index.baseline.acceptedFrom?.[0]}`);
        if (!index.runs.length) out.line('No runs yet. Start with: spider-web review');
        for (const run of index.runs) {
            const git = run.gitCommit ? dim(` ${run.gitBranch}@${run.gitCommit.slice(0, 7)}${run.gitDirty ? '*' : ''}`) : '';
            out.line(`${run.id}${git}`);
        }
        if (index.comparisons.length) out.line(`\ncomparisons:`);
        for (const c of index.comparisons.slice(0, 10)) out.line(`  ${c.id}  ${dim(`${c.summary.modified} modified, ${c.summary.added} added, ${c.summary.removed} removed`)}`);
    });
    return EXIT.ok;
}

function defaultRun(store: Store, ref?: string): string {
    if (ref) return store.resolveRun(ref);
    return store.listRuns()[0]?.id ?? store.resolveRun(BASELINE);
}

function screens(out: Output, project: Project, values: Values): number {
    const store = new Store(project.dataDir);
    const runId = defaultRun(store, values.run);
    const map = store.readMap(runId);
    const dir = store.runDir(runId);
    const list = map.screens.map((s) => ({
        id: s.id,
        persona: s.persona,
        route: s.route,
        state: s.state,
        title: s.title,
        url: new URL(s.url, map.run.baseURL).toString(),
        source: s.sourceFile ? join(map.run.repoPath ?? '', s.sourceFile) : undefined,
        shots: s.shots.map((shot) => ({ variant: variantId(shot.variant), path: join(dir, shot.path), ...(shot.elements ? { elements: join(dir, shot.elements) } : {}) })),
    }));
    out.result({ run: runId, screens: list }, () => {
        out.line(dim(`run ${runId}`));
        for (const s of list) out.line(`  ${s.id.padEnd(48)} ${dim(s.title)}`);
    });
    return EXIT.ok;
}

function show(out: Output, project: Project, screenId: string | undefined, values: Values): number {
    if (!screenId) return fail(out, 'usage', 'Which screen? spider-web show <screen id>', 'spider-web screens');
    const store = new Store(project.dataDir);
    const runId = defaultRun(store, values.run);
    const map = store.readMap(runId);
    const dir = store.runDir(runId);
    const screen = map.screens.find((s) => s.id === screenId);
    if (!screen) return fail(out, 'not-found', `No screen "${screenId}" in ${runId}.`, 'spider-web screens');
    const shot = screen.shots.find((s) => variantId(s.variant) === values.variant) ?? screen.shots[0];
    const elements = shot?.elements && existsSync(join(dir, shot.elements)) ? readJson<ElementInfo[]>(join(dir, shot.elements)) : [];
    const result = {
        run: runId,
        id: screen.id,
        persona: screen.persona,
        route: screen.route,
        state: screen.state,
        title: screen.title,
        url: new URL(screen.url, map.run.baseURL).toString(),
        httpStatus: screen.httpStatus,
        component: screen.component,
        source: screen.sourceFile ? join(map.run.repoPath ?? '', screen.sourceFile) : undefined,
        shots: screen.shots.map((s) => ({ variant: variantId(s.variant), path: join(dir, s.path), width: s.width, height: s.height, truncated: s.truncated })),
        links: screen.links.filter((l) => l.targetScreenId).map((l) => ({ label: l.label, to: l.targetScreenId })),
        consoleErrors: screen.consoleErrors,
        elements: values.elements ? elements : { variant: shot ? variantId(shot.variant) : undefined, count: elements.length, byKind: countBy(elements, (e) => e.kind), hint: 'add --elements for the full list' },
    };
    out.result(result, () => {
        out.line(`${bold(screen.title)}  ${dim(screen.id)}`);
        out.line(`  ${result.url}`);
        if (result.source) out.line(`  ${dim('source')} ${result.source}`);
        for (const s of result.shots) out.line(`  ${dim(s.variant.padEnd(16))} ${s.path}`);
        out.line(`  ${dim('elements')} ${elements.length} on ${shot ? variantId(shot.variant) : '—'}  ${dim(Object.entries(countBy(elements, (e) => e.kind)).map(([k, n]) => `${n} ${k}`).join(' · '))}`);
        if (values.elements) for (const e of elements.filter((x) => x.kind === 'interactive').slice(0, 40)) out.line(`    ${(e.role ?? e.tag).padEnd(10)} ${(e.name ?? '').slice(0, 40).padEnd(40)} ${dim(e.selector)}`);
    });
    return EXIT.ok;
}

function mask(out: Output, project: Project, values: Values): number {
    const list = values.css?.length || values.unmask?.length ? updateMasks(project, values.css ?? [], values.unmask ?? []) : (project.json.mask ?? []);
    out.result({ mask: list, next: values.css?.length ? 'spider-web review' : undefined }, () => {
        if (!list.length) out.line('No masks. Add one: spider-web mask --css ".last-seen"');
        for (const selector of list) out.line(`  ${selector}`);
        if (values.css?.length) out.line(dim('next: spider-web review'));
    });
    return EXIT.ok;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
    return out;
}

async function serve(out: Output, cwd: string, values: Values): Promise<number> {
    // With a spider.json here or above, serve that project; without one, serve this folder in setup mode.
    const root = findProjectRoot(cwd) ?? cwd;
    const project = existsSync(join(root, CONFIG_FILE)) ? await loadProject(root) : undefined;
    const store = new Store(join(root, '.spider'));
    const name = project?.config.name ?? 'New project';
    // One server per project: running it again just reopens the app.
    const running = store.serverInfo();
    if (running) {
        out.result({ url: running.url, project: name, alreadyRunning: true }, () => out.line(`${green('●')} ${bold(name)} is already open at ${running.url}`));
        if (!values['no-open'] && !values.json && process.stdout.isTTY) openBrowser(running.url);
        return EXIT.ok;
    }
    const { startServer } = await import('./server.ts');
    const server = await startServer(root, project, { port: values.port ? Number(values.port) : undefined });
    out.result({ url: server.url, project: name, setup: !project }, () => {
        out.line(`${green('●')} ${bold(name)}  ${server.url}`);
        if (!project) out.line(dim(`  No spider.json in ${root} yet: set it up in the app.`));
        out.line(dim('  Ctrl-C to stop'));
    });
    if (!values['no-open'] && !values.json && process.stdout.isTTY) openBrowser(server.url);
    await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
    });
    await server.close();
    return EXIT.ok;
}

function openBrowser(url: string) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

function explain(out: Output): number {
    const doc = JSON.parse(readFileSync(new URL('./spider.schema.json', import.meta.url), 'utf8')) as unknown;
    out.result(doc, () => console.log(JSON.stringify(doc, null, 2)));
    return EXIT.ok;
}

// Kept for agents reading the source: the shape of one change in `review --json`.
export type { ChangeSummary };

main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        console.error(error instanceof Error ? error.stack : error);
        process.exitCode = EXIT.error;
    },
);
