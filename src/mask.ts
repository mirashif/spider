// Masks hide parts of the page that change on their own (timestamps, avatars, live counters) so they stop showing
// up as visual changes. From a changed region, the element recorded under it gives a selector to mask.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeConfig, type Project } from './config.ts';
import { variantId, type Bounds, type ElementInfo } from './contracts.ts';
import { readJson, Store } from './store.ts';

export interface MaskSuggestion {
    /** The best selector to mask: the whole column when the element repeats in rows, else the element itself. */
    selector: string;
    /** Just this one element, when `selector` covers a whole column. */
    single?: string;
    element: Pick<ElementInfo, 'tag' | 'role' | 'name' | 'testId' | 'box'>;
}

/** The smallest recorded element covering most of the region, on the run's shot for that variant. */
export function suggestMask(project: Project, runId: string, screenId: string, variant: string, region: Bounds): MaskSuggestion | undefined {
    const store = new Store(project.dataDir);
    const map = store.readMap(store.resolveRun(runId));
    const shot = map.screens.find((s) => s.id === screenId)?.shots.find((s) => variantId(s.variant) === variant);
    if (!shot?.elements) return undefined;
    const path = join(store.runDir(map.run.id), shot.elements);
    if (!existsSync(path)) return undefined;
    const elements = readJson<ElementInfo[]>(path);

    const overlap = (a: Bounds, b: Bounds) => {
        const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return w > 0 && h > 0 ? w * h : 0;
    };
    const area = (b: Bounds) => b.width * b.height;
    const regionArea = Math.max(1, area(region));
    const candidates = elements
        // Masking a whole landmark (main, nav) would hide everything; skip those.
        .filter((e) => e.kind !== 'landmark' && overlap(e.box, region) / regionArea >= 0.6)
        .sort((a, b) => area(a.box) - area(b.box));
    const pick = candidates[0];
    if (!pick) return undefined;
    const element = { tag: pick.tag, role: pick.role, name: pick.name, testId: pick.testId, box: pick.box };
    // A changing value in a table row usually changes in every row (all the "last sign-in" times): mask the column.
    return pick.group ? { selector: pick.group, single: pick.selector, element } : { selector: pick.selector, element };
}

/** Adds (or with `remove`, drops) CSS selectors in spider.json's mask list. Returns the new list. */
export function updateMasks(project: Project, add: string[], remove: string[] = []): string[] {
    const json = { ...project.json };
    const next = [...new Set([...(json.mask ?? []).filter((s) => !remove.includes(s)), ...add])];
    json.mask = next;
    if (!next.length) delete json.mask;
    writeConfig(project.root, json);
    return next;
}
