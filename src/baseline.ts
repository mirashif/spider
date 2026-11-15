// The baseline is the accepted state of every screen. Reviews compare a new run against it, and accepting moves it
// forward: all of a run at once, or screen by screen. It lives in runs/baseline/ with the same layout as a run, so
// everything that reads runs (compare, the viewer) reads it too.

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Screen, ScreenMap } from './contracts.ts';
import { BASELINE, ensureDir, Store, writeJson } from './store.ts';

export interface AcceptResult {
    revision: number;
    /** Screens whose accepted state changed. */
    accepted: string[];
    /** Screens dropped from the baseline because the run no longer has them. */
    removed: string[];
    created: boolean;
}

/** Accepts `screenIds` from a run (all of them when omitted). Accepting all also drops screens the run no longer has. */
export function accept(store: Store, runId: string, screenIds?: string[]): AcceptResult {
    if (runId === BASELINE) throw new Error('Pick a run to accept, not the baseline itself.');
    const run = store.readMap(runId);
    const current = store.baseline();
    const baseDir = store.runDir(BASELINE);
    const runDir = store.runDir(runId);
    ensureDir(join(baseDir, 'shots'));

    const all = !screenIds || screenIds.length === 0;
    const runScreens = new Map(run.screens.map((s) => [s.id, s]));
    const unknown = (screenIds ?? []).filter((id) => !runScreens.has(id) && !current?.screens.some((s) => s.id === id));
    if (unknown.length) throw new Error(`Not in run ${runId} or the baseline: ${unknown.join(', ')}`);

    const screens = new Map((current?.screens ?? []).map((s) => [s.id, s]));
    const accepted: string[] = [];
    const removed: string[] = [];

    const targets = all ? [...new Set([...runScreens.keys(), ...screens.keys()])] : screenIds;
    for (const id of targets) {
        const next = runScreens.get(id);
        const prev = screens.get(id);
        if (prev) deleteFiles(baseDir, prev);
        if (next) {
            copyFiles(runDir, baseDir, next);
            screens.set(id, next);
            accepted.push(id);
        } else if (prev) {
            screens.delete(id);
            removed.push(id);
        }
    }

    // Keep crawl order from the run, then anything only the baseline has.
    const order = new Map(run.screens.map((s, i) => [s.id, i]));
    const ordered = [...screens.values()].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const ids = new Set(ordered.map((s) => s.id));
    const touched = new Set([...accepted, ...removed]);
    const transitions = [
        ...(current?.transitions ?? []).filter((t) => !touched.has(t.from) && !touched.has(t.to)),
        ...run.transitions.filter((t) => touched.has(t.from) || touched.has(t.to)),
    ].filter((t, i, list) => ids.has(t.from) && ids.has(t.to) && list.findIndex((u) => u.id === t.id) === i);

    const revision = (current?.run.revision ?? 0) + 1;
    const map: ScreenMap = {
        contract: run.contract,
        run: {
            ...run.run,
            id: BASELINE,
            kind: 'baseline',
            label: BASELINE,
            revision,
            acceptedFrom: [runId, ...(current?.run.acceptedFrom ?? []).filter((id) => id !== runId)].slice(0, 20),
        },
        screens: ordered,
        transitions,
        gaps: all ? run.gaps : (current?.gaps ?? run.gaps),
    };
    writeJson(join(baseDir, 'map.json'), map);
    return { revision, accepted, removed, created: !current };
}

function files(screen: Screen): string[] {
    return screen.shots.flatMap((shot) => [shot.path, ...(shot.elements ? [shot.elements] : [])]);
}

function copyFiles(fromDir: string, toDir: string, screen: Screen) {
    for (const file of files(screen)) {
        const from = join(fromDir, file);
        if (existsSync(from)) copyFileSync(from, join(toDir, file));
    }
}

function deleteFiles(dir: string, screen: Screen) {
    for (const file of files(screen)) rmSync(join(dir, file), { force: true });
}
