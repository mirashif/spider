// Turning concrete URLs into route patterns, so /admin/projects/alpha and
// /admin/projects/beta are one screen.

interface CompiledPattern {
    pattern: string;
    regex: RegExp;
}

export function compilePatterns(patterns: string[]): CompiledPattern[] {
    return patterns.map((pattern) => {
        const body = pattern
            .split('/')
            .map((segment) => {
                if (segment.startsWith(':')) return segment.endsWith('?') ? '(?:[^/]+)?' : '[^/]+';
                return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            })
            .join('/');
        return { pattern, regex: new RegExp(`^${body}/?$`) };
    });
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{24,}$/;

/** The route pattern for a path: a configured pattern when one matches, else ids and tokens folded. */
export function routeFor(path: string, patterns: CompiledPattern[]): string {
    const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
    for (const { pattern, regex } of patterns) if (regex.test(clean)) return pattern;
    return clean
        .split('/')
        .map((segment) => {
            if (NUMERIC.test(segment) || UUID.test(segment)) return ':id';
            if (TOKEN.test(segment)) return ':token';
            return segment;
        })
        .join('/');
}

/** True when a concrete route (no params) or a pattern was captured. */
export function patternCovered(pattern: string, capturedRoutes: Set<string>): boolean {
    if (capturedRoutes.has(pattern)) return true;
    const [compiled] = compilePatterns([pattern]);
    for (const route of capturedRoutes) if (compiled.regex.test(route) || route === pattern) return true;
    return false;
}

/**
 * Route patterns guessed from concrete paths, for apps without a route list: where paths differ in just one
 * segment and those values look like data (many of them, or slugs and ids), the segment becomes a parameter named
 * after the segment before it.
 *   /author/jane-austen, /author/steve-martin, /author/albert-einstein → /author/:author
 * A few plain words (/settings/profile, /settings/billing) are separate pages and stay; so do top-level pages.
 */
export function inferPatterns(paths: string[], minGroup = 3, manyGroup = 8): string[] {
    const dataLike = (values: string[]) =>
        values.length >= manyGroup || (values.length >= minGroup && values.filter((v) => /[\d_-]|[A-Z]/.test(v) || v.length > 20).length * 2 > values.length);
    let current = [...new Set(paths.map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/'))];
    for (let pass = 0; pass < 4; pass++) {
        const next = new Set<string>();
        const folded = new Set<string>();
        const bySize = new Map<number, string[][]>();
        for (const path of current) {
            const parts = path.split('/');
            (bySize.get(parts.length) ?? bySize.set(parts.length, []).get(parts.length)!).push(parts);
        }
        for (const [size, group] of bySize) {
            // Never the first segment: top-level paths are sections (/login, /about), not data.
            for (let i = 2; i < size; i++) {
                const buckets = new Map<string, string[][]>();
                for (const parts of group) {
                    if (parts[i].startsWith(':')) continue;
                    const key = parts.map((p, j) => (j === i ? '\u0000' : p)).join('/');
                    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(parts);
                }
                for (const members of buckets.values()) {
                    if (!dataLike(members.map((m) => m[i]))) continue;
                    const name = (members[0][i - 1] || 'segment').replace(/[^A-Za-z0-9]/g, '').replace(/s$/, '') || 'param';
                    const pattern = members[0].map((p, j) => (j === i ? `:${name}` : p)).join('/');
                    next.add(pattern);
                    for (const m of members) folded.add(m.join('/'));
                }
            }
        }
        for (const path of current) if (!folded.has(path)) next.add(path);
        const result = [...next].sort();
        if (result.join('|') === current.sort().join('|')) break;
        current = result;
    }
    return current.sort();
}
