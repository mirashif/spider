import type { ColorScheme, Comparison, DataIndex, JobInfo, ProjectInfo, ScreenMap, VariantKey } from '@contracts';
import { CheckCheck, LayoutGrid, ListChecks, Monitor, Moon, Network, Play, Smartphone, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useJob } from './api';
import { CrawlDialog } from './CrawlDialog';
import { Inspector } from './Inspector';
import { JobBar } from './JobBar';
import { MapView } from './MapView';
import { comparisonModel, entryStatus, fetchJson, runModel, type Model } from './model';
import { ScreensView } from './ScreensView';
import { Segmented, StatusDot } from './ui';

type View = 'map' | 'screens';

interface UrlState {
    run?: string;
    compare?: string;
    view: View;
    screen?: string;
    vp?: string;
    cs?: ColorScheme;
    persona?: string;
    changed: boolean;
}

function readUrl(): UrlState {
    const p = new URLSearchParams(location.search);
    return {
        run: p.get('run') ?? undefined,
        compare: p.get('compare') ?? undefined,
        view: p.get('view') === 'screens' ? 'screens' : 'map',
        screen: p.get('screen') ?? undefined,
        vp: p.get('vp') ?? undefined,
        cs: (p.get('cs') as ColorScheme | null) ?? undefined,
        persona: p.get('persona') ?? undefined,
        changed: p.get('changed') === '1',
    };
}

function writeUrl(state: UrlState) {
    const p = new URLSearchParams();
    if (state.compare) p.set('compare', state.compare);
    else if (state.run) p.set('run', state.run);
    if (state.view !== 'map') p.set('view', state.view);
    if (state.screen) p.set('screen', state.screen);
    if (state.vp) p.set('vp', state.vp);
    if (state.cs) p.set('cs', state.cs);
    if (state.persona) p.set('persona', state.persona);
    if (state.changed) p.set('changed', '1');
    const next = `${location.pathname}${p.size ? `?${p}` : ''}`;
    if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
}

export function App() {
    const [index, setIndex] = useState<DataIndex | null>(null);
    const [url, setUrl] = useState<UrlState>(readUrl);
    const [model, setModel] = useState<Model | null>(null);
    const [error, setError] = useState<string | null>(null);

    const update = useCallback((patch: Partial<UrlState>) => setUrl((prev) => ({ ...prev, ...patch })), []);

    useEffect(() => writeUrl(url), [url]);

    const [project, setProject] = useState<ProjectInfo | null>(null);
    const [crawlDialog, setCrawlDialog] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const startedHere = useRef(false);

    const refreshIndex = useCallback(
        () =>
            fetchJson<DataIndex>('/api/index')
                .then((data) => {
                    setIndex(data);
                    // Open the newest full review against the baseline (not a one-screen recrawl), else the baseline,
                    // else the newest run.
                    setUrl((prev) => {
                        if (prev.run || prev.compare) return prev;
                        const scoped = new Set(data.runs.filter((r) => r.scope).map((r) => r.id));
                        const review = data.comparisons.find((c) => c.base === 'baseline' && !scoped.has(c.head));
                        if (review && review.summary.modified + review.summary.added + review.summary.removed > 0) return { ...prev, compare: review.id };
                        if (data.baseline) return { ...prev, run: 'baseline' };
                        if (data.runs[0]) return { ...prev, run: data.runs[0].id };
                        return prev;
                    });
                    return data;
                })
                .catch((e: Error) => setError(e.message)),
        [],
    );

    useEffect(() => {
        void refreshIndex();
        api.project().then(setProject, () => undefined);
    }, [refreshIndex]);

    const openJob = useCallback(
        (job: JobInfo) => {
            if (job.result?.comparison) update({ compare: job.result.comparison, run: undefined, screen: undefined, changed: true });
            else if (job.result?.run) update({ run: 'baseline', compare: undefined, screen: undefined });
        },
        [update],
    );

    const { job } = useJob((ended) => {
        void refreshIndex();
        if (ended.kind === 'login') api.project().then(setProject, () => undefined);
        // Jump to the result of a review started from this tab; a CLI crawl only refreshes the list.
        if (ended.status === 'done' && startedHere.current) openJob(ended);
        startedHere.current = false;
    });
    const running = job?.status === 'running';

    const startReview = useCallback(() => {
        startedHere.current = true;
        api.review().catch((e: Error) => {
            startedHere.current = false;
            setError(e.message);
        });
    }, []);

    const acceptScreens = useCallback(
        async (screens?: string[]) => {
            const head = model?.comparison?.head.id;
            if (!head) return;
            const result = await api.accept(head, screens);
            await refreshIndex();
            if (result.comparison) update({ compare: result.comparison });
            else update({ run: 'baseline', compare: undefined, screen: undefined });
            setReloadKey((k) => k + 1);
        },
        [model, refreshIndex, update],
    );

    useEffect(() => {
        setModel(null);
        setError(null);
        if (url.compare) {
            const id = url.compare;
            fetchJson<Comparison>(`/data/comparisons/${encodeURIComponent(id)}/comparison.json`)
                .then(async (comparison) => {
                    const [base, head] = await Promise.all([
                        fetchJson<ScreenMap>(`/data/runs/${encodeURIComponent(comparison.base.id)}/map.json`),
                        fetchJson<ScreenMap>(`/data/runs/${encodeURIComponent(comparison.head.id)}/map.json`),
                    ]);
                    setModel(comparisonModel(comparison, base, head));
                })
                .catch((e: Error) => setError(e.message));
        } else if (url.run) {
            fetchJson<ScreenMap>(`/data/runs/${encodeURIComponent(url.run)}/map.json`)
                .then((map) => setModel(runModel(map)))
                .catch((e: Error) => setError(e.message));
        }
    }, [url.run, url.compare, reloadKey]);

    const variant: VariantKey = useMemo(
        () => ({
            viewport: url.vp && model?.viewports.includes(url.vp) ? url.vp : (model?.viewports[0] ?? 'desktop'),
            colorScheme: url.cs && model?.colorSchemes.includes(url.cs) ? url.cs : (model?.colorSchemes[0] ?? 'light'),
        }),
        [url.vp, url.cs, model],
    );

    const visible = useMemo(() => {
        if (!model) return [];
        return model.entries.filter((entry) => {
            if (url.persona && entry.screen.persona !== url.persona) return false;
            if (url.changed && model.kind === 'comparison' && entryStatus(entry, variant) === 'unchanged') return false;
            return true;
        });
    }, [model, url.persona, url.changed, variant]);

    const selected = url.screen && model ? model.byId.get(url.screen) : undefined;
    const select = useCallback((id: string | undefined) => update({ screen: id }), [update]);

    // Arrow keys step through the visible screens; Escape closes the inspector.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
            if (event.key === 'Escape') select(undefined);
            if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'j' || event.key === 'k') && visible.length) {
                const at = visible.findIndex((e) => e.id === url.screen);
                const step = event.key === 'ArrowRight' || event.key === 'j' ? 1 : -1;
                const next = visible[(at + step + visible.length) % visible.length];
                select(next.id);
                event.preventDefault();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visible, url.screen, select]);

    const viewportIcon = (id: string) => (/mobile|phone/.test(id) ? <Smartphone size={14} /> : <Monitor size={14} />);

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <SpiderMark />
                    <span>{project?.name ?? 'spider-web'}</span>
                </div>
                <SourcePicker
                    index={index}
                    value={url.compare ? `c:${url.compare}` : url.run ? `r:${url.run}` : ''}
                    onChange={(value) =>
                        value.startsWith('c:') ? update({ compare: value.slice(2), run: undefined, screen: undefined }) : update({ run: value.slice(2), compare: undefined, screen: undefined })
                    }
                />
                <Segmented
                    label="View"
                    value={url.view}
                    onChange={(view) => update({ view })}
                    options={[
                        { value: 'map', label: 'Map', icon: <Network size={14} /> },
                        { value: 'screens', label: 'Screens', icon: <LayoutGrid size={14} /> },
                    ]}
                />
                <div className="spacer" />
                {model && model.personas.length > 1 && (
                    <Segmented
                        label="Persona"
                        value={url.persona ?? ''}
                        onChange={(persona) => update({ persona: persona || undefined })}
                        options={[{ value: '', label: 'All' }, ...model.personas.map((p) => ({ value: p, label: p }))]}
                    />
                )}
                {model && model.viewports.length > 1 && (
                    <Segmented
                        label="Viewport"
                        value={variant.viewport}
                        onChange={(vp) => update({ vp })}
                        options={model.viewports.map((v) => ({ value: v, label: v, icon: viewportIcon(v) }))}
                    />
                )}
                {model && model.colorSchemes.length > 1 && (
                    <Segmented
                        label="Color scheme"
                        value={variant.colorScheme}
                        onChange={(cs) => update({ cs })}
                        iconOnly
                        options={model.colorSchemes.map((c) => ({ value: c, label: c, icon: c === 'dark' ? <Moon size={14} /> : <Sun size={14} /> }))}
                    />
                )}
                {index?.baseline && (
                    <button type="button" className="btn" onClick={() => setCrawlDialog(true)} disabled={running} title="Pick routes to review">
                        <ListChecks size={13} /> Selection…
                    </button>
                )}
                <button type="button" className="btn primary" onClick={startReview} disabled={running} title="Crawl the app and compare it with the baseline">
                    <Play size={13} /> {index?.baseline ? 'Review' : 'Capture baseline'}
                </button>
            </header>

            {model?.comparison && (
                <div className="summary">
                    <span className="summary-title">{model.title}</span>
                    {(['modified', 'added', 'removed', 'unchanged'] as const).map((status) => (
                        <span key={status} className="summary-item">
                            <StatusDot status={status} /> {model.comparison!.summary[status]} {status}
                        </span>
                    ))}
                    <div className="spacer" />
                    <label className="toggle">
                        <input type="checkbox" checked={url.changed} onChange={(e) => update({ changed: e.target.checked })} />
                        Changed only
                    </label>
                    {model.comparison.base.kind === 'baseline' && model.comparison.summary.modified + model.comparison.summary.added + model.comparison.summary.removed > 0 && (
                        <button type="button" className="btn" onClick={() => void acceptScreens()} title="Make this whole run the new baseline">
                            <CheckCheck size={13} /> Accept all
                        </button>
                    )}
                </div>
            )}

            <main className={`main${selected ? ' has-inspector' : ''}`}>
                <section className="stage">
                    {error && <Empty title="Couldn't load" body={error} />}
                    {!error && index && index.runs.length === 0 && !index.baseline && (running ? (
                        <Empty title="Capturing your first screens…" body="They appear here when the run finishes. Progress is in the bar below." />
                    ) : (
                        <Empty title="No screens yet" body="Capture every screen once. That first run becomes the baseline later reviews compare against.">
                            <button type="button" className="btn primary" onClick={startReview}>
                                <Play size={13} /> Capture baseline
                            </button>
                        </Empty>
                    ))}
                    {!error && model && visible.length === 0 && <Empty title="Nothing to show" body="No screens match these filters." />}
                    {!error && model && visible.length > 0 && url.view === 'map' && (
                        <MapView model={model} entries={visible} variant={variant} selectedId={url.screen} onSelect={select} />
                    )}
                    {!error && model && visible.length > 0 && url.view === 'screens' && (
                        <ScreensView model={model} entries={visible} variant={variant} selectedId={url.screen} onSelect={select} />
                    )}
                </section>
                {selected && model && (
                    <Inspector
                        key={selected.id}
                        model={model}
                        entry={selected}
                        variant={variant}
                        onSelect={select}
                        onAccept={model.comparison?.base.kind === 'baseline' ? (id) => acceptScreens([id]) : undefined}
                        onRecrawl={
                            running || !index?.baseline
                                ? undefined
                                : (screen) => {
                                      startedHere.current = true;
                                      api.review({ personas: [screen.persona], only: [screen.url.split('?')[0]], label: 'recrawl' }).catch((e: Error) => setError(e.message));
                                  }
                        }
                    />
                )}
            </main>
            <JobBar job={job} onOpen={openJob} />
            {crawlDialog && (
                <CrawlDialog
                    onClose={() => setCrawlDialog(false)}
                    onStarted={() => {
                        startedHere.current = true;
                        setCrawlDialog(false);
                    }}
                />
            )}
        </div>
    );
}

function SourcePicker({ index, value, onChange }: { index: DataIndex | null; value: string; onChange: (value: string) => void }) {
    if (!index) return <select className="source" disabled />;
    const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
        <select className="source" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Run or comparison">
            {index.comparisons.length > 0 && (
                <optgroup label="Comparisons">
                    {index.comparisons.map((c) => (
                        <option key={c.id} value={`c:${c.id}`}>
                            {shortRun(c.base)} → {shortRun(c.head)} · {c.summary.modified + c.summary.added + c.summary.removed} changed
                        </option>
                    ))}
                </optgroup>
            )}
            {index.baseline && (
                <optgroup label="Baseline">
                    <option value="r:baseline">
                        Baseline · revision {index.baseline.revision} · {when(index.baseline.completedAt)}
                    </option>
                </optgroup>
            )}
            <optgroup label="Runs">
                {index.runs.map((r) => (
                    <option key={r.id} value={`r:${r.id}`}>
                        {r.label ? `${r.label} · ` : ''}
                        {when(r.startedAt)}
                        {r.gitCommit ? ` · ${r.gitBranch}@${r.gitCommit.slice(0, 7)}${r.gitDirty ? '*' : ''}` : ''}
                    </option>
                ))}
            </optgroup>
        </select>
    );
}

function shortRun(id: string): string {
    if (id === 'baseline') return 'baseline';
    // Run ids are <yyyymmdd-hhmmss>[_label] (older ones had a prefix): show the label, else the time.
    const stamp = id.match(/\d{8}-(\d{2})(\d{2})\d{2}/);
    if (!stamp) return id;
    const label = id.slice((stamp.index ?? 0) + stamp[0].length + 1);
    return label || `${stamp[1]}:${stamp[2]}`;
}

function Empty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
    return (
        <div className="empty">
            <strong>{title}</strong>
            <span>{body}</span>
            {children && <div className="empty-actions">{children}</div>}
        </div>
    );
}

function SpiderMark() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            <path d="M12 2v7.6M12 14.4V22M2 12h7.6M14.4 12H22M4.9 4.9l5.4 5.4M13.7 13.7l5.4 5.4M19.1 4.9l-5.4 5.4M10.3 13.7l-5.4 5.4" />
            <path d="M12 6.5 15.9 8.1 17.5 12 15.9 15.9 12 17.5 8.1 15.9 6.5 12 8.1 8.1Z" opacity=".55" />
        </svg>
    );
}
