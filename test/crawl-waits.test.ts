import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { settle } from '../src/capture/settle.ts';
import { loadProject } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import type { JobInfo } from '../src/contracts.ts';

test('settling skips offscreen lazy images and bounds stalled resources', { timeout: 15000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route('https://assets.test/**', () => {});
        await page.setContent('<div style="height:20000px"></div><img loading="lazy" src="https://assets.test/lazy.png">');
        assert.equal(await page.locator('img').evaluate((img: HTMLImageElement) => img.complete), false);
        let start = Date.now();
        await settle(page, 2000);
        assert.ok(Date.now() - start < 1500, 'lazy images should not consume the settling budget');
        await page.setContent('<img src="https://assets.test/stalled.png">', { waitUntil: 'domcontentloaded' });
        start = Date.now();
        await settle(page, 150);
        assert.ok(Date.now() - start < 1500, 'stalled resources must time out');
        await page.route('https://assets.test/broken.png', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await route.fulfill({ status: 404, body: '' });
        });
        await page.setContent('<img src="https://assets.test/broken.png">', { waitUntil: 'domcontentloaded' });
        start = Date.now();
        await settle(page, 2000);
        assert.ok(Date.now() - start < 1500, 'failed images should resolve on error');
    } finally {
        await browser.close();
    }
});

test('UI crawl finishes with lazy images and Stop interrupts an active page', { timeout: 20000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'spider-crawl-'));
    const target = createServer((req, res) => {
        if (req.url === '/stalled.png') return;
        if (req.url !== '/' && req.url !== '/pending') { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end(req.url === '/pending' ? '<img src="/stalled.png">' : '<h1>Lazy page</h1><div style="height:20000px"></div><img loading="lazy" src="/stalled.png">');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const port = (target.address() as { port: number }).port;
    writeFileSync(join(root, 'spider.json'), JSON.stringify({ name: 'Test', baseURL: `http://127.0.0.1:${port}`, viewports: [{ id: 'desktop', width: 800, height: 600 }], colorSchemes: ['light'], personas: { user: { seeds: ['/'] } } }));
    const project = await loadProject(root);
    const app = await startServer(root, project);
    const post = (path: string, body: unknown) => fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const waitJob = async (condition: (job: JobInfo) => boolean) => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            const job = await fetch(app.url + '/api/jobs/current').then((r) => r.json()) as JobInfo;
            if (condition(job)) return job;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Job did not reach expected state');
    };
    try {
        assert.equal((await post('/api/crawl', { review: false })).status, 202);
        const finished = await waitJob((job) => job.status !== 'running');
        assert.equal(finished.status, 'done', finished.error);
        assert.equal(finished.result?.screens, 1);
        project.config.personas.user.seeds = ['/pending'];
        assert.equal((await post('/api/crawl', { review: false })).status, 202);
        await waitJob((job) => job.progress?.route === '/pending');
        const start = Date.now();
        await post('/api/crawl/cancel', {});
        const cancelled = await waitJob((job) => job.status !== 'running');
        assert.equal(cancelled.status, 'cancelled', cancelled.error);
        assert.ok(Date.now() - start < 3000, 'Stop must interrupt the in-flight navigation');
    } finally {
        await app.close();
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});
