// Data shapes shared by the CLI and the viewer. Browser-safe: no Node imports.

export const MAP_CONTRACT = 'spider-web/screen-map@1';
export const COMPARISON_CONTRACT = 'spider-web/comparison@1';

export type ColorScheme = 'light' | 'dark';

export interface ViewportSpec {
    /** Short id used in file names and the viewer, e.g. "desktop". */
    id: string;
    width: number;
    height: number;
}

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** One way of looking at a screen: a viewport and a color scheme. */
export interface VariantKey {
    viewport: string;
    colorScheme: ColorScheme;
}

export function variantId(key: VariantKey): string {
    return `${key.viewport}-${key.colorScheme}`;
}

export interface Shot {
    variant: VariantKey;
    /** Path relative to the run directory. */
    path: string;
    width: number;
    height: number;
    /** True when the page was taller than the cap and the image was cut. */
    truncated: boolean;
    /** Elements visible on this shot (`ElementInfo[]` as JSON), relative to the run directory. */
    elements?: string;
    /** Areas covered by the config's masks when this was shot; compare ignores them on both sides. */
    masked?: Bounds[];
}

export type ElementKind = 'interactive' | 'heading' | 'landmark' | 'image' | 'text';

/** One element on a shot, measured in that variant's layout. Annotations, journeys and hotspots point at these. */
export interface ElementInfo {
    /** Index in the shot's element list. */
    id: number;
    kind: ElementKind;
    tag: string;
    role?: string;
    /** Accessible name: aria-label, label text, alt, or visible text. */
    name?: string;
    testId?: string;
    /** CSS selector that matched exactly this element when it was captured. */
    selector: string;
    /** For text in repeated rows (tables, lists): a selector for the same element in every row. */
    group?: string;
    /** In CSS pixels on the full-page shot. */
    box: Bounds;
    href?: string;
    /** A few computed styles, for interactive elements and headings. */
    styles?: { font: string; color: string; background?: string; radius?: string };
    /** Source location from a dev plugin attribute (data-source, data-insp-path…), when the app has one. */
    source?: string;
}

export interface LinkOut {
    label: string;
    href: string;
    /** Screen id the link leads to, when it stays in scope. */
    targetScreenId?: string;
    /** Why the link was not followed, when it was not. */
    skipped?: 'external' | 'excluded' | 'limit' | 'download' | 'other-persona';
    /** Bounds on the desktop light shot, in CSS pixels. */
    bounds?: Bounds;
}

export interface Screen {
    /** Stable across runs: persona + route pattern (+ state). Comparisons match on it. */
    id: string;
    persona: string;
    /** Route pattern, e.g. /admin/projects/:project */
    route: string;
    /** The concrete URL path that was captured for this pattern. */
    url: string;
    /** Set for an interaction state on top of a route, e.g. "Invite admin dialog". */
    state?: string;
    title: string;
    httpStatus: number | null;
    /** Final path after redirects, when different from url. */
    redirectedTo?: string;
    depth: number;
    /** Inertia page component, e.g. Admin/Projects/Index. */
    component?: string;
    /** Best guess at the source file behind the screen, relative to the target repo. */
    sourceFile?: string;
    shots: Shot[];
    links: LinkOut[];
    consoleErrors: string[];
    capturedAt: string;
}

export interface Transition {
    id: string;
    from: string;
    to: string;
    label: string;
    kind: 'link' | 'state' | 'redirect';
}

export interface Gap {
    kind: 'unreached-route' | 'capture-error' | 'login-failed' | 'state-failed';
    message: string;
    route?: string;
    screenId?: string;
}

export interface RunInfo {
    id: string;
    /** "baseline" is the accepted state reviews compare against; it's assembled from accepted runs. */
    kind?: 'run' | 'baseline';
    /** Baseline only: bumped on every accept. */
    revision?: number;
    /** Baseline only: the runs its screens were accepted from, newest first. */
    acceptedFrom?: string[];
    /** Set when the crawl covered only part of the app (--as, --only, "Recrawl this section"). */
    scope?: { personas?: string[]; only?: string[] };
    target: string;
    targetLabel: string;
    label?: string;
    baseURL: string;
    /** Absolute path of the target's checkout, for opening source files. */
    repoPath?: string;
    startedAt: string;
    completedAt: string;
    gitCommit?: string;
    gitBranch?: string;
    gitDirty?: boolean;
    viewports: ViewportSpec[];
    colorSchemes: ColorScheme[];
    personas: string[];
}

export interface ScreenMap {
    contract: typeof MAP_CONTRACT;
    run: RunInfo;
    screens: Screen[];
    transitions: Transition[];
    gaps: Gap[];
}

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface VariantChange {
    variant: VariantKey;
    status: ChangeStatus;
    /** Share of pixels that differ, 0..1, over the larger of the two images. */
    diffRatio: number;
    diffPixels: number;
    /** Changed regions on the head image, in image pixels. */
    regions: Bounds[];
    /** Path relative to the comparison directory. */
    diffPath?: string;
    sizeChanged: boolean;
}

export interface ScreenChange {
    screenId: string;
    status: ChangeStatus;
    route: string;
    persona: string;
    state?: string;
    variants: VariantChange[];
    /** Text that differs, from the links on the page. */
    linksAdded: string[];
    linksRemoved: string[];
}

export interface Comparison {
    contract: typeof COMPARISON_CONTRACT;
    id: string;
    target: string;
    createdAt: string;
    base: RunInfo;
    head: RunInfo;
    threshold: number;
    changes: ScreenChange[];
    summary: Record<ChangeStatus, number>;
}

/** What the viewer's index endpoint returns. */
export interface DataIndex {
    runs: RunInfo[];
    comparisons: { id: string; target: string; createdAt: string; base: string; head: string; summary: Record<ChangeStatus, number> }[];
    baseline?: RunInfo;
}

/** What /api/project returns: enough for the UI to label things and offer actions. */
export interface ProjectInfo {
    name: string;
    root: string;
    configPath: string;
    baseURL: string;
    appDir: string;
    personas: { name: string; signIn: 'none' | 'steps' | 'manual'; hasSession: boolean }[];
    viewports: ViewportSpec[];
    colorSchemes: ColorScheme[];
}

export type RouteKind = 'page' | 'json' | 'download' | 'error' | 'needs-param';

/** One route from the app's route list, checked with a single request (no browser, no cookies). */
export interface RouteCheck {
    pattern: string;
    /** The concrete path that was requested, with parameters filled in. */
    path?: string;
    status: number | null;
    kind: RouteKind;
    /** Redirected to a sign-in page. */
    signIn: boolean;
    redirect?: string;
    /** Values found for each parameter, the first one used. */
    params?: Record<string, string[]>;
    /** Matches the config's route `exclude`: hidden in the picker by default. */
    hidden: boolean;
    error?: string;
}

export interface RoutesResult {
    source: 'preset' | 'hook' | 'sitemap' | 'run' | 'links' | 'none';
    /** E.g. "laravel: ./vendor/bin/sail artisan route:list". */
    detail?: string;
    checkedAt: string;
    durationMs: number;
    routes: RouteCheck[];
}

/** Progress from a crawl, streamed to the UI (SSE) and to agents (NDJSON on stderr). */
export type CrawlEvent =
    | { type: 'start'; run: string; personas: string[] }
    | { type: 'phase'; phase: 'prepare' | 'routes' | 'sign-in' | 'crawl' | 'states' | 'write'; persona?: string }
    | { type: 'screen'; persona: string; screenId: string; route: string; title: string; done: number; queued: number }
    | { type: 'gap'; gap: Gap }
    | { type: 'log'; message: string };

export interface JobInfo {
    id: string;
    kind: 'crawl' | 'review' | 'login';
    /** Who started it: the UI (server) or a CLI process relaying its progress. */
    by: 'ui' | 'cli';
    status: 'running' | 'done' | 'failed' | 'needs-sign-in' | 'cancelled';
    startedAt: string;
    endedAt?: string;
    label?: string;
    /** Latest progress, so a page that connects mid-crawl can catch up. */
    progress?: { persona?: string; phase?: string; done: number; queued: number; route?: string };
    result?: { run?: string; comparison?: string; summary?: Record<ChangeStatus, number>; screens?: number };
    error?: string;
    needsSignIn?: string[];
}
