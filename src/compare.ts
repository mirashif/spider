import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
    COMPARISON_CONTRACT,
    variantId,
    type Bounds,
    type ChangeStatus,
    type Comparison,
    type Screen,
    type ScreenChange,
    type ScreenMap,
    type Shot,
    type VariantChange,
} from './contracts.ts';
import { slug } from './crawl.ts';
import { ensureDir, Store, writeJson } from './store.ts';

export interface CompareOptions {
    /** pixelmatch's per-pixel color threshold, 0..1. */
    threshold?: number;
    /** Fewer differing pixels than this counts as unchanged (anti-aliasing noise). */
    minPixels?: number;
}

export function compareRuns(store: Store, base: ScreenMap, head: ScreenMap, options: CompareOptions = {}): { id: string; comparison: Comparison } {
    const threshold = options.threshold ?? 0.1;
    const minPixels = options.minPixels ?? 24;
    // The baseline moves on every accept, so its revision is part of the id.
    const baseKey = base.run.kind === 'baseline' ? `baseline-r${base.run.revision ?? 1}` : base.run.id;
    const id = `${baseKey}__vs__${head.run.id}`;
    const dir = ensureDir(join(store.comparisonsDir, id));
    ensureDir(join(dir, 'diffs'));

    const baseScreens = new Map(base.screens.map((s) => [s.id, s]));
    const headScreens = new Map(head.screens.map((s) => [s.id, s]));
    const ids = [...new Set([...head.screens.map((s) => s.id), ...base.screens.map((s) => s.id)])];

    const changes: ScreenChange[] = ids.map((screenId) => {
        const before = baseScreens.get(screenId);
        const after = headScreens.get(screenId);
        const screen = (after ?? before)!;
        const common = { screenId, route: screen.route, persona: screen.persona, state: screen.state };

        if (!before || !after) {
            const status: ChangeStatus = after ? 'added' : 'removed';
            return {
                ...common,
                status,
                variants: screen.shots.map((shot) => ({ variant: shot.variant, status, diffRatio: 1, diffPixels: 0, regions: [], sizeChanged: false })),
                linksAdded: after ? linkLabels(after) : [],
                linksRemoved: before ? linkLabels(before) : [],
            };
        }

        const variants = diffVariants(store.runDir(base.run.id), store.runDir(head.run.id), before, after, dir, { threshold, minPixels });
        const status: ChangeStatus = variants.some((v) => v.status !== 'unchanged') ? 'modified' : 'unchanged';
        const beforeLinks = new Set(linkLabels(before));
        const afterLinks = new Set(linkLabels(after));
        return {
            ...common,
            status,
            variants,
            linksAdded: [...afterLinks].filter((label) => !beforeLinks.has(label)),
            linksRemoved: [...beforeLinks].filter((label) => !afterLinks.has(label)),
        };
    });

    const order: Record<ChangeStatus, number> = { removed: 0, modified: 1, added: 2, unchanged: 3 };
    changes.sort((a, b) => order[a.status] - order[b.status] || a.screenId.localeCompare(b.screenId));

    const summary: Record<ChangeStatus, number> = { added: 0, removed: 0, modified: 0, unchanged: 0 };
    for (const change of changes) summary[change.status] += 1;

    const comparison: Comparison = {
        contract: COMPARISON_CONTRACT,
        id,
        target: head.run.target,
        createdAt: new Date().toISOString(),
        base: base.run,
        head: head.run,
        threshold,
        changes,
        summary,
    };
    writeJson(join(dir, 'comparison.json'), comparison);
    return { id, comparison };
}

function linkLabels(screen: Screen): string[] {
    return [...new Set(screen.links.map((link) => link.label))];
}

function diffVariants(
    baseDir: string,
    headDir: string,
    before: Screen,
    after: Screen,
    dir: string,
    options: { threshold: number; minPixels: number },
): VariantChange[] {
    const beforeShots = new Map(before.shots.map((shot) => [variantId(shot.variant), shot]));
    const afterShots = new Map(after.shots.map((shot) => [variantId(shot.variant), shot]));
    const keys = [...new Set([...afterShots.keys(), ...beforeShots.keys()])];

    return keys.map((key): VariantChange => {
        const a = beforeShots.get(key);
        const b = afterShots.get(key);
        if (!a || !b) {
            const status: ChangeStatus = b ? 'added' : 'removed';
            return { variant: (b ?? a)!.variant, status, diffRatio: 1, diffPixels: 0, regions: [], sizeChanged: false };
        }
        return diffShot(baseDir, a, headDir, b, join(dir, 'diffs'), `${slug(after.id)}__${key}.png`, options);
    });
}

function diffShot(
    baseDir: string,
    a: Shot,
    headDir: string,
    b: Shot,
    diffDir: string,
    diffName: string,
    options: { threshold: number; minPixels: number },
): VariantChange {
    const imgA = PNG.sync.read(readFileSync(join(baseDir, a.path)));
    const imgB = PNG.sync.read(readFileSync(join(headDir, b.path)));
    const width = Math.max(imgA.width, imgB.width);
    const height = Math.max(imgA.height, imgB.height);
    const padA = pad(imgA, width, height);
    const padB = pad(imgB, width, height);
    ignoreMasked(padA, padB, [...(a.masked ?? []), ...(b.masked ?? [])]);
    const out = new PNG({ width, height });
    const diffPixels = pixelmatch(padA.data, padB.data, out.data, width, height, {
        threshold: options.threshold,
        includeAA: false,
        alpha: 0.15,
        diffColor: [255, 40, 90],
        diffColorAlt: [40, 160, 255],
    });
    const sizeChanged = imgA.width !== imgB.width || imgA.height !== imgB.height;
    const changed = diffPixels >= options.minPixels || sizeChanged;
    let diffPath: string | undefined;
    if (changed) {
        writeFileSync(join(diffDir, diffName), PNG.sync.write(out));
        diffPath = `diffs/${diffName}`;
    }
    return {
        variant: b.variant,
        status: changed ? 'modified' : 'unchanged',
        diffRatio: diffPixels / (width * height),
        diffPixels,
        regions: changed ? findRegions(out, width, height) : [],
        diffPath,
        sizeChanged,
    };
}

/**
 * Masked areas are painted #FF00FF at capture. Where either side has that colour, copy one side onto the other so
 * the pixel can't differ: a mask added after the baseline was shot hides its area right away, not after an accept.
 */
function ignoreMasked(a: PNG, b: PNG, boxes: Bounds[]) {
    const da = a.data;
    const db = b.data;
    // Recorded mask areas: make both sides identical there, whatever colour they ended up.
    for (const box of boxes) {
        const x0 = Math.max(0, box.x);
        const x1 = Math.min(a.width, box.x + box.width);
        for (let y = Math.max(0, box.y); y < Math.min(a.height, box.y + box.height); y++) {
            const start = (y * a.width + x0) * 4;
            const end = (y * a.width + x1) * 4;
            if (end > start) db.set(da.subarray(start, end), start);
        }
    }
    for (let i = 0; i < da.length; i += 4) {
        const maskedA = da[i] === 255 && da[i + 1] === 0 && da[i + 2] === 255;
        const maskedB = db[i] === 255 && db[i + 1] === 0 && db[i + 2] === 255;
        if (maskedA || maskedB) {
            db[i] = da[i] = 255;
            db[i + 1] = da[i + 1] = 0;
            db[i + 2] = da[i + 2] = 255;
            db[i + 3] = da[i + 3] = 255;
        }
    }
}

function pad(img: PNG, width: number, height: number): PNG {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height, fill: true });
    out.data.fill(0);
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
}

/** Groups differing pixels into boxes: mark 8px cells, join cells within 3 cells of each other, box each group. */
function findRegions(diff: PNG, width: number, height: number): Bounds[] {
    const cell = 8;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const hot = new Uint8Array(cols * rows);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            // pixelmatch paints differences in the diff colors; everything else is a faded grey.
            const r = diff.data[i];
            const g = diff.data[i + 1];
            const b = diff.data[i + 2];
            if ((r === 255 && g === 40 && b === 90) || (r === 40 && g === 160 && b === 255)) hot[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
        }
    }
    const reach = 3;
    const seen = new Uint8Array(cols * rows);
    const regions: Bounds[] = [];
    for (let start = 0; start < hot.length; start++) {
        if (!hot[start] || seen[start]) continue;
        let minX = cols, minY = rows, maxX = 0, maxY = 0;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
            const index = stack.pop()!;
            const cx = index % cols;
            const cy = Math.floor(index / cols);
            minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            for (let dy = -reach; dy <= reach; dy++) {
                for (let dx = -reach; dx <= reach; dx++) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                    const n = ny * cols + nx;
                    if (hot[n] && !seen[n]) {
                        seen[n] = 1;
                        stack.push(n);
                    }
                }
            }
        }
        regions.push({
            x: minX * cell,
            y: minY * cell,
            width: Math.min((maxX + 1) * cell, width) - minX * cell,
            height: Math.min((maxY + 1) * cell, height) - minY * cell,
        });
    }
    return regions.sort((p, q) => q.width * q.height - p.width * p.height).slice(0, 40);
}
