// The .spider/ folder: runs, comparisons, the baseline, sign-in sessions, the crawl lock and the server file.
//
// .spider/
//   runs/<id>/map.json + shots/*.png + shots/*.elements.json
//   runs/baseline/              the accepted state; same layout as a run
//   comparisons/<base>__vs__<head>/comparison.json + diffs/*.png
//   auth/<persona>.json         saved sessions (never served)
//   routes.json                 the last route check
//   crawl.lock, server.json

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Comparison, DataIndex, RunInfo, ScreenMap } from './contracts.ts';

export const BASELINE = 'baseline';

export function ensureDir(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
}

/** .spider/ keeps its own .gitignore: runs, sessions and machine state stay out of git; config-like files can go in. */
export function ensureDataDir(dir: string): void {
    ensureDir(dir);
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, ['runs/', 'comparisons/', 'auth/', 'routes.json', 'crawl.lock', 'server.json', ''].join('\n'));
}

export function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export class Store {
    readonly runsDir: string;
    readonly comparisonsDir: string;
    readonly authDir: string;

    constructor(readonly dataDir: string) {
        this.runsDir = join(dataDir, 'runs');
        this.comparisonsDir = join(dataDir, 'comparisons');
        this.authDir = join(dataDir, 'auth');
    }

    runDir(id: string): string {
        return join(this.runsDir, id);
    }

    hasRun(id: string): boolean {
        return existsSync(join(this.runDir(id), 'map.json'));
    }

    readMap(id: string): ScreenMap {
        const path = join(this.runDir(id), 'map.json');
        if (!existsSync(path)) throw new Error(`No run "${id}" (looked for ${path})`);
        return readJson<ScreenMap>(path);
    }

    baseline(): ScreenMap | undefined {
        return this.hasRun(BASELINE) ? this.readMap(BASELINE) : undefined;
    }

    /** Runs newest first, without the baseline. */
    listRuns(): RunInfo[] {
        if (!existsSync(this.runsDir)) return [];
        return readdirSync(this.runsDir)
            .filter((id) => id !== BASELINE && this.hasRun(id))
            .map((id) => this.readMap(id).run)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }

    listComparisons(): DataIndex['comparisons'] {
        if (!existsSync(this.comparisonsDir)) return [];
        return readdirSync(this.comparisonsDir)
            .filter((id) => existsSync(join(this.comparisonsDir, id, 'comparison.json')))
            .map((id) => {
                const c = readJson<Comparison>(join(this.comparisonsDir, id, 'comparison.json'));
                return { id: c.id, target: c.target, createdAt: c.createdAt, base: c.base.id, head: c.head.id, summary: c.summary };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    index(): DataIndex {
        return { runs: this.listRuns(), comparisons: this.listComparisons(), baseline: this.baseline()?.run };
    }

    /** A run by id, by label (newest first), "latest", "previous", or "baseline". */
    resolveRun(ref: string): string {
        if (ref === BASELINE) {
            if (!this.hasRun(BASELINE)) throw new Error('No baseline yet. Accept a run first: spider-web accept');
            return BASELINE;
        }
        const runs = this.listRuns();
        const pick = ref === 'latest' ? runs[0] : ref === 'previous' ? runs[1] : (runs.find((r) => r.id === ref) ?? runs.find((r) => r.label === ref));
        if (!pick) throw new Error(`No run matches "${ref}". Runs: ${runs.map((r) => r.label ?? r.id).join(', ') || 'none yet'}`);
        return pick.id;
    }

    newRunId(label?: string): string {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
        return [stamp, label].filter(Boolean).join('_').replace(/[^A-Za-z0-9_.-]/g, '-');
    }

    sessionPath(persona: string): string {
        return join(this.authDir, `${persona.replace(/[^A-Za-z0-9_-]/g, '-')}.json`);
    }

    // ---- One crawl at a time per project, whether the UI or a CLI started it ----

    lockPath(): string {
        return join(this.dataDir, 'crawl.lock');
    }

    readLock(): { pid: number; startedAt: string; by: string } | undefined {
        const path = this.lockPath();
        if (!existsSync(path)) return undefined;
        try {
            const lock = readJson<{ pid: number; startedAt: string; by: string }>(path);
            process.kill(lock.pid, 0);
            return lock;
        } catch {
            rmSync(path, { force: true });
            return undefined;
        }
    }

    acquireLock(by: string): () => void {
        const held = this.readLock();
        if (held && held.pid !== process.pid) throw new Error(`A crawl is already running (pid ${held.pid}, started by ${held.by} at ${held.startedAt}).`);
        ensureDir(this.dataDir);
        writeJson(this.lockPath(), { pid: process.pid, startedAt: new Date().toISOString(), by });
        return () => rmSync(this.lockPath(), { force: true });
    }

    // ---- The running server, so the CLI can relay progress to the UI ----

    serverInfo(): { url: string; pid: number } | undefined {
        const path = join(this.dataDir, 'server.json');
        if (!existsSync(path)) return undefined;
        try {
            const info = readJson<{ url: string; pid: number }>(path);
            process.kill(info.pid, 0);
            return info;
        } catch {
            return undefined;
        }
    }
}

export function gitInfo(repo?: string): Pick<RunInfo, 'gitCommit' | 'gitBranch' | 'gitDirty'> {
    if (!repo) return {};
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return {
            gitCommit: git('rev-parse', 'HEAD'),
            gitBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
            gitDirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
        };
    } catch {
        return {};
    }
}
