import type { ChangeStatus, ColorScheme, Comparison, Screen, ScreenChange, ScreenMap, Shot, Transition, VariantChange, VariantKey } from '@contracts';
import { variantId } from '@contracts';

/** One screen as the viewer shows it: from a run, or from both sides of a comparison. */
export interface Entry {
    id: string;
    screen: Screen;
    /** The base run's screen, in a comparison, when it existed there. */
    before?: Screen;
    change?: ScreenChange;
    /** Run whose files `screen.shots` point into. */
    runId: string;
    beforeRunId?: string;
}

export interface Model {
    kind: 'run' | 'comparison';
    title: string;
    entries: Entry[];
    byId: Map<string, Entry>;
    transitions: Transition[];
    personas: string[];
    viewports: string[];
    colorSchemes: ColorScheme[];
    comparison?: Comparison;
    map: ScreenMap;
}

export function runModel(map: ScreenMap): Model {
    const entries = map.screens.map((screen) => ({ id: screen.id, screen, runId: map.run.id }));
    return finish({ kind: 'run', title: map.run.label ?? map.run.id, entries, transitions: map.transitions, map });
}

export function comparisonModel(comparison: Comparison, base: ScreenMap, head: ScreenMap): Model {
    const baseScreens = new Map(base.screens.map((s) => [s.id, s]));
    const headScreens = new Map(head.screens.map((s) => [s.id, s]));
    const entries: Entry[] = comparison.changes.map((change) => {
        const after = headScreens.get(change.screenId);
        const before = baseScreens.get(change.screenId);
        return {
            id: change.screenId,
            screen: (after ?? before)!,
            before,
            change,
            runId: after ? head.run.id : base.run.id,
            beforeRunId: before ? base.run.id : undefined,
        };
    });
    // Keep the head run's order (crawl order reads better than status order on the map).
    const order = new Map([...head.screens, ...base.screens].map((s, i) => [s.id, i]));
    entries.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const seen = new Set<string>();
    const transitions = [...head.transitions, ...base.transitions].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    return finish({
        kind: 'comparison',
        title: `${comparison.base.label ?? comparison.base.id} → ${comparison.head.label ?? comparison.head.id}`,
        entries,
        transitions,
        comparison,
        map: head,
    });
}

function finish(partial: Omit<Model, 'byId' | 'personas' | 'viewports' | 'colorSchemes'>): Model {
    const run = partial.map.run;
    return {
        ...partial,
        byId: new Map(partial.entries.map((e) => [e.id, e])),
        personas: run.personas,
        viewports: run.viewports.map((v) => v.id),
        colorSchemes: run.colorSchemes,
    };
}

export function shotFor(screen: Screen | undefined, key: VariantKey): Shot | undefined {
    if (!screen) return undefined;
    const id = variantId(key);
    return screen.shots.find((s) => variantId(s.variant) === id) ?? screen.shots[0];
}

export function variantChangeFor(change: ScreenChange | undefined, key: VariantKey): VariantChange | undefined {
    if (!change) return undefined;
    const id = variantId(key);
    return change.variants.find((v) => variantId(v.variant) === id);
}

export function runFileUrl(runId: string, path: string): string {
    return `/data/runs/${encodeURIComponent(runId)}/${path}`;
}

export function comparisonFileUrl(comparisonId: string, path: string): string {
    return `/data/comparisons/${encodeURIComponent(comparisonId)}/${path}`;
}

export async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
}

/** Status for an entry under the chosen variant: what the reviewer sees on that screen right now. */
export function entryStatus(entry: Entry, key: VariantKey): ChangeStatus | undefined {
    if (!entry.change) return undefined;
    return variantChangeFor(entry.change, key)?.status ?? entry.change.status;
}

export function screenLabel(screen: Screen): string {
    return screen.state ? `${screen.route} › ${screen.state}` : screen.route;
}

export const STATUS_LABEL: Record<ChangeStatus, string> = {
    added: 'Added',
    removed: 'Removed',
    modified: 'Modified',
    unchanged: 'Unchanged',
};
