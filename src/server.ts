// The local server: the viewer, a small JSON API, live job progress over SSE, and the .spider/ files.
// The UI does everything through this; the CLI relays its own crawls here when the server is running.

import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRoutes, lastRouteCheck } from './check.ts';
import { CONFIG_FILE, DATA_DIR_NAME, loadProject, writeConfig, type Project } from './config.ts';
import type { Bounds, CrawlEvent, JobInfo } from './contracts.ts';
import { NeedsSignInError } from './crawl.ts';
import { manualLogin } from './login.ts';
import { suggestMask, updateMasks } from './mask.ts';
import { acceptAndRecompare, projectInfo, runCrawl, runReview } from './ops.ts';
import { buildConfig, detectApp, discoverServers, draftJson, draftProject, type SetupDraft } from './setup.ts';
import { ensureDataDir, Store, writeJson } from './store.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
};

export interface ServerHandle {
    url: string;
    close: () => Promise<void>;
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Serves one project folder. Without a spider.json yet (`initial` undefined) it starts in setup mode: the UI shows
 * first launch, and the project endpoints answer 409 until setup saves a config.
 */
export async function startServer(root: string, initial: Project | undefined, options: { port?: number; host?: string } = {}): Promise<ServerHandle> {
    let current = initial;
    const store = new Store(join(root, DATA_DIR_NAME));
    const jobs = new Jobs();
    let crawlAbort: AbortController | undefined;
    let ownPort: number | undefined;
    const need = (): Project => {
        if (!current) throw new HttpError(409, 'Not set up yet: finish first launch, or run spider-web init.');
        return current;
    };
    const reload = async () => {
        current = await loadProject(root);
        return current;
    };

    const api: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void> = {
        'GET /api/project': (_req, res) => json(res, projectInfo(need())),
        'GET /api/index': (_req, res) => json(res, store.index()),
        'GET /api/jobs/current': (_req, res) => json(res, jobs.current ?? null),

        'GET /api/routes': async (_req, res, url) => {
            const project = need();
            const cached = url.searchParams.get('refresh') === '1' ? undefined : lastRouteCheck(project);
            json(res, cached ?? (await checkRoutes(project)));
        },

        // ---- First launch ----

        'GET /api/setup': async (_req, res) => {
            json(res, { configured: Boolean(current), root, detected: detectApp(root), servers: current ? [] : await discoverServers(ownPort) });
        },
        'POST /api/setup/detect': async (req, res) => {
            const { appDir } = await readBody<{ appDir: string }>(req);
            const dir = resolve(root, appDir || '.');
            if (!existsSync(dir)) throw new HttpError(400, `No folder at ${dir}`);
            json(res, detectApp(dir));
        },
        'POST /api/setup/servers': async (_req, res) => json(res, await discoverServers(ownPort)),
        'POST /api/setup/routes': async (req, res) => {
            const { baseURL, appDir, params } = await readBody<{ baseURL: string; appDir?: string; params?: Record<string, string> }>(req);
            try {
                new URL(baseURL);
            } catch {
                throw new HttpError(400, `Not a URL: ${baseURL}`);
            }
            const draft = draftProject(root, draftJson(root, baseURL, appDir, params));
            ensureDataDir(draft.dataDir);
            json(res, await checkRoutes(draft));
        },
        'POST /api/setup/save': async (req, res) => {
            const draft = await readBody<SetupDraft>(req);
            if (current && existsSync(join(root, CONFIG_FILE)) && !(draft as { replace?: boolean }).replace) throw new HttpError(409, 'Already set up.');
            writeConfig(root, buildConfig(root, draft));
            json(res, projectInfo(await reload()));
        },

        // ---- Config edits from the app ----

        'POST /api/mask/suggest': async (req, res) => {
            const body = await readBody<{ run: string; screen: string; variant: string; region: Bounds }>(req);
            json(res, suggestMask(need(), body.run, body.screen, body.variant, body.region) ?? null);
        },
        'POST /api/mask': async (req, res) => {
            const { add = [], remove = [] } = await readBody<{ add?: string[]; remove?: string[] }>(req);
            const mask = updateMasks(need(), add, remove);
            await reload();
            json(res, { mask });
        },

        'POST /api/crawl': async (req, res) => {
            const body = await readBody<{ review?: boolean; label?: string; personas?: string[]; only?: string[]; skipPrepare?: boolean }>(req);
            const project = need();
            if (jobs.running || store.readLock()) return json(res, { error: 'A crawl is already running.' }, 409);
            const job = jobs.start(body.review === false ? 'crawl' : 'review', 'ui', body.label);
            crawlAbort = new AbortController();
            const options = { ...body, by: 'ui' as const, signal: crawlAbort.signal, onEvent: (event: CrawlEvent) => jobs.event(job.id, event) };
            // Respond now; progress arrives over /api/events.
            json(res, job, 202);
            try {
                if (body.review === false) {
                    const result = await runCrawl(project, options);
                    jobs.end(job.id, { status: 'done', result: { run: result.run, screens: result.screens } });
                } else {
                    const result = await runReview(project, options);
                    jobs.end(job.id, { status: 'done', result: { run: result.run, comparison: result.comparison, summary: result.summary, screens: result.crawl.screens } });
                }
            } catch (error) {
                if (error instanceof NeedsSignInError) jobs.end(job.id, { status: 'needs-sign-in', needsSignIn: error.personas, error: error.message });
                else jobs.end(job.id, { status: crawlAbort.signal.aborted ? 'cancelled' : 'failed', error: (error as Error).message });
            }
        },

        'POST /api/crawl/cancel': (_req, res) => {
            crawlAbort?.abort();
            json(res, { ok: true });
        },

        'POST /api/login': async (req, res) => {
            const { persona } = await readBody<{ persona: string }>(req);
            const project = need();
            const job = jobs.start('login', 'ui', persona);
            json(res, job, 202);
            try {
                const result = await manualLogin(project, persona, { onStatus: (message) => jobs.event(job.id, { type: 'log', message }) });
                jobs.end(job.id, result.saved ? { status: 'done' } : { status: 'failed', error: `No working session for ${persona}: the window closed on ${result.endedOn ?? 'a page outside its routes'}.` });
            } catch (error) {
                jobs.end(job.id, { status: 'failed', error: (error as Error).message });
            }
        },

        'POST /api/accept': async (req, res) => {
            const { run, screens } = await readBody<{ run: string; screens?: string[] }>(req);
            json(res, acceptAndRecompare(need(), run, screens));
        },

        // A CLI crawl reporting in, so the UI can show it.
        'POST /api/relay': async (req, res) => {
            const body = await readBody<{ id: string; kind?: JobInfo['kind']; label?: string; start?: boolean; event?: CrawlEvent; end?: Partial<JobInfo> }>(req);
            if (body.start) jobs.start(body.kind ?? 'crawl', 'cli', body.label, body.id);
            if (body.event) jobs.event(body.id, body.event);
            if (body.end) jobs.end(body.id, body.end);
            json(res, { ok: true });
        },

        'GET /api/events': (req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            res.write(`event: job\ndata: ${JSON.stringify({ job: jobs.current ?? null })}\n\n`);
            const off = jobs.subscribe((payload) => res.write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`));
            const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
            req.on('close', () => {
                clearInterval(ping);
                off();
            });
        },
    };

    let viewer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://local');
        try {
            const handler = api[`${req.method} ${url.pathname}`];
            if (handler) return await handler(req, res, url);
            if (url.pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
            if (url.pathname.startsWith('/data/')) return serveData(store.dataDir, url, res);
            viewer(req, res);
        } catch (error) {
            if (!res.headersSent) json(res, { error: (error as Error).message }, error instanceof HttpError ? error.status : 500);
        }
    };
    const server = createServer(handle);
    // Vite's hot reload rides on this server's port, so two projects' servers never fight over a fixed one.
    viewer = await viewerMiddleware(server);

    const host = options.host ?? '127.0.0.1';
    const port = await listen(server, options.port ?? 4320, host);
    ownPort = port;
    // `localhost` resolves to ::1 first on many machines (macOS does), and some browsers don't fall back to
    // 127.0.0.1. Listen on the IPv6 loopback too, on the same port, so http://localhost works everywhere.
    let server6: ReturnType<typeof createServer> | undefined;
    if (host === '127.0.0.1') {
        server6 = createServer(handle);
        await new Promise<void>((done) => {
            server6!.once('error', () => {
                server6 = undefined;
                done();
            });
            server6!.listen(port, '::1', () => done());
        });
        // Hot-reload sockets opened via ::1 go to the same Vite instance.
        server6?.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    }
    const url = `http://${host === '127.0.0.1' || host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    const infoPath = join(store.dataDir, 'server.json');
    ensureDataDir(store.dataDir);
    writeJson(infoPath, { url, pid: process.pid, startedAt: new Date().toISOString() });
    // Only remove the file if it's still ours (another server may have started since).
    const cleanup = () => {
        try {
            if (JSON.parse(readFileSync(infoPath, 'utf8')).pid === process.pid) rmSync(infoPath, { force: true });
        } catch {
            /* already gone */
        }
    };
    process.once('exit', cleanup);

    return {
        url,
        close: async () => {
            cleanup();
            await Promise.all([server, server6].map((srv) => srv && new Promise<void>((done) => {
                        srv.closeAllConnections(); // open SSE streams would otherwise keep it alive
                        srv.close(() => done());
                    })));
        },
    };
}

class Jobs {
    current?: JobInfo;
    private listeners = new Set<(payload: { job: JobInfo; event?: CrawlEvent }) => void>();

    get running(): boolean {
        return this.current?.status === 'running';
    }

    start(kind: JobInfo['kind'], by: JobInfo['by'], label?: string, id = `${kind}-${Date.now()}`): JobInfo {
        this.current = { id, kind, by, label, status: 'running', startedAt: new Date().toISOString(), progress: { done: 0, queued: 0 } };
        this.emit();
        return this.current;
    }

    event(id: string, event: CrawlEvent) {
        const job = this.current;
        if (!job || job.id !== id) return;
        const p = (job.progress ??= { done: 0, queued: 0 });
        if (event.type === 'phase') {
            p.phase = event.phase;
            if (event.persona && event.persona !== p.persona) Object.assign(p, { persona: event.persona, done: 0, queued: 0, route: undefined });
        }
        if (event.type === 'screen') Object.assign(p, { persona: event.persona, done: event.done, queued: event.queued, route: event.route });
        this.emit(event);
    }

    end(id: string, end: Partial<JobInfo>) {
        if (!this.current || this.current.id !== id) return;
        this.current = { ...this.current, ...end, endedAt: new Date().toISOString() };
        this.emit();
    }

    subscribe(fn: (payload: { job: JobInfo; event?: CrawlEvent }) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private emit(event?: CrawlEvent) {
        if (!this.current) return;
        for (const fn of this.listeners) fn({ job: this.current, event });
    }
}

/** The built viewer when there is one (published package), else Vite in middleware mode (working on spider-web). */
async function viewerMiddleware(httpServer: ReturnType<typeof createServer>): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
    const dist = join(PACKAGE_ROOT, 'dist', 'viewer');
    if (existsSync(join(dist, 'index.html')) && !process.env.SPIDER_DEV) {
        return (req, res) => {
            const url = new URL(req.url ?? '/', 'http://local');
            const file = resolve(dist, `.${normalize(decodeURIComponent(url.pathname))}`);
            const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html');
            res.setHeader('content-type', MIME[extname(target)] ?? 'application/octet-stream');
            createReadStream(target).pipe(res);
        };
    }
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
        configFile: join(PACKAGE_ROOT, 'viewer', 'vite.config.ts'),
        server: { middlewareMode: true, hmr: { server: httpServer } },
        appType: 'spa',
        logLevel: 'warn',
    });
    return (req, res) => vite.middlewares(req, res);
}

function serveData(dataDir: string, url: URL, res: ServerResponse) {
    const relative = normalize(decodeURIComponent(url.pathname.slice('/data/'.length)));
    const file = resolve(dataDir, relative);
    // Sessions and server files are never served.
    const allowed = file.startsWith(join(dataDir, 'runs') + '/') || file.startsWith(join(dataDir, 'comparisons') + '/');
    if (!allowed || !existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    // Run files never change once written; the baseline does, so it isn't cached.
    const immutable = extname(file) === '.png' && !relative.startsWith('runs/baseline/');
    res.setHeader('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-store');
    createReadStream(file).pipe(res);
}

function json(res: ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return (raw ? JSON.parse(raw) : {}) as T;
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string, tries = 10): Promise<number> {
    return new Promise((done, fail) => {
        const attempt = (p: number, left: number) => {
            server.once('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
                else fail(error);
            });
            server.listen(p, host, () => done(p));
        };
        attempt(port, tries);
    });
}
