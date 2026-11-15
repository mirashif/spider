// Manual sign-in: open a real browser window, let the person sign in however the app wants (SSO, 2FA, magic links),
// and save the session when they close the window.

import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import type { Project } from './config.ts';
import { inScope, validSession } from './crawl.ts';
import { ensureDir, Store } from './store.ts';

export interface LoginResult {
    persona: string;
    saved: boolean;
    path: string;
    /** Where the window was when it closed. */
    endedOn?: string;
}

export async function manualLogin(project: Project, persona: string, options: { timeoutMs?: number; onStatus?: (message: string) => void } = {}): Promise<LoginResult> {
    const config = project.config;
    const p = config.personas[persona];
    if (!p) throw new Error(`Unknown persona "${persona}". Personas: ${Object.keys(config.personas).join(', ')}`);
    const store = new Store(project.dataDir);
    const path = store.sessionPath(persona);

    const browser = await chromium.launch({ headless: false });
    try {
        const context = await browser.newContext({ baseURL: config.baseURL, viewport: null });
        const page = await context.newPage();
        // Start where a signed-out visitor would be sent: the first seed (usually redirects to the login page).
        await page.goto(p.seeds[0]).catch(() => undefined);
        options.onStatus?.('Sign in in the browser window, then close it.');

        let lastState = await context.storageState();
        let lastUrl = page.url();
        // Keep the latest cookies while the window is open; closing it is the "done" signal.
        const poll = setInterval(async () => {
            try {
                lastState = await context.storageState();
                lastUrl = page.url();
            } catch {
                /* window closing */
            }
        }, 1000);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.timeoutMs ?? 15 * 60_000);
            page.on('close', () => {
                clearTimeout(timer);
                resolve();
            });
            browser.on('disconnected', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        clearInterval(poll);
        try {
            lastState = await context.storageState();
        } catch {
            /* closed: use the last poll */
        }

        // Check the session in a fresh headless browser before trusting it.
        const checker = await chromium.launch();
        try {
            const valid = await validSession(checker, config, p, lastState);
            const endedOn = new URL(lastUrl).pathname;
            if (!valid) return { persona, saved: false, path, endedOn };
            ensureDir(store.authDir);
            writeFileSync(path, JSON.stringify(valid));
            return { persona, saved: true, path, endedOn: inScope(endedOn, p) ? endedOn : undefined };
        } finally {
            await checker.close();
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
}
