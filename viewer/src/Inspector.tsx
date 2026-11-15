import type { Bounds, Screen, Shot, VariantKey } from '@contracts';
import { variantId } from '@contracts';
import { ArrowUpRight, Check, Code2, EyeOff, ExternalLink, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import { api } from './api';
import { useMemo, useState, type ReactNode } from 'react';
import { comparisonFileUrl, entryStatus, runFileUrl, screenLabel, shotFor, variantChangeFor, type Entry, type Model } from './model';
import { Segmented, StatusBadge, StatusDot } from './ui';

type Mode = 'slider' | 'after' | 'before' | 'diff';

interface Props {
    model: Model;
    entry: Entry;
    variant: VariantKey;
    onSelect: (id: string | undefined) => void;
    /** Accept this screen's new look into the baseline (comparisons against the baseline only). */
    onAccept?: (screenId: string) => Promise<void>;
    /** Crawl just this screen again (as its persona) and compare it with the baseline. */
    onRecrawl?: (screen: Screen) => void;
}

export function Inspector({ model, entry, variant, onSelect, onAccept, onRecrawl }: Props) {
    const [accepting, setAccepting] = useState(false);
    const [wide, setWide] = useState(false);
    const screen = entry.screen;
    const status = entryStatus(entry, variant);
    const change = variantChangeFor(entry.change, variant);
    const after = shotFor(screen, variant);
    const before = entry.before ? shotFor(entry.before, variant) : undefined;
    const comparable = Boolean(entry.change && entry.before && after && before && entry.change.status !== 'removed');
    const [mode, setMode] = useState<Mode>(comparable && change?.status === 'modified' ? 'slider' : 'after');
    const [outline, setOutline] = useState(true);
    const [showLinks, setShowLinks] = useState(false);

    const afterUrl = after ? runFileUrl(entry.runId, after.path) : undefined;
    const beforeUrl = before && entry.beforeRunId ? runFileUrl(entry.beforeRunId, before.path) : undefined;
    const diffUrl = change?.diffPath && model.comparison ? comparisonFileUrl(model.comparison.id, change.diffPath) : undefined;

    const incoming = useMemo(() => model.transitions.filter((t) => t.to === entry.id && model.byId.has(t.from)), [model, entry.id]);
    const primaryVariant = model.map.run.viewports[0]?.id === variant.viewport;
    const repoPath = model.map.run.repoPath;
    const appUrl = new URL(screen.redirectedTo ?? screen.url, model.map.run.baseURL).toString();

    const modes: { value: Mode; label: string }[] = comparable
        ? [
              { value: 'slider', label: 'Slider' },
              { value: 'after', label: 'After' },
              { value: 'before', label: 'Before' },
              ...(diffUrl ? [{ value: 'diff' as Mode, label: 'Diff' }] : []),
          ]
        : [];

    return (
        <aside className={`inspector${wide ? ' inspector-wide' : ''}`} aria-label="Screen details">
            <header className="inspector-head">
                <div className="inspector-title">
                    <div className="inspector-route">
                        <StatusDot status={status} />
                        <span>{screenLabel(screen)}</span>
                    </div>
                    <div className="inspector-sub">
                        <span className="chip">{screen.persona}</span>
                        <StatusBadge status={status} />
                        {change && change.status === 'modified' && <span className="muted">{formatRatio(change.diffRatio)} of pixels</span>}
                    </div>
                </div>
                {onAccept && entry.change && entry.change.status !== 'unchanged' && (
                    <button
                        type="button"
                        className="btn"
                        disabled={accepting}
                        onClick={() => {
                            setAccepting(true);
                            onAccept(entry.id).finally(() => setAccepting(false));
                        }}
                        title={entry.change.status === 'removed' ? 'Remove this screen from the baseline' : 'Make this the accepted look'}
                    >
                        <Check size={13} /> {entry.change.status === 'removed' ? 'Accept removal' : 'Accept'}
                    </button>
                )}
                {onRecrawl && !screen.state && (
                    <button type="button" className="icon-btn" onClick={() => onRecrawl(screen)} title="Crawl this screen again and compare it" aria-label="Recrawl this screen">
                        <RotateCw size={15} />
                    </button>
                )}
                <button type="button" className="icon-btn" onClick={() => setWide(!wide)} title={wide ? 'Narrow' : 'Widen'} aria-label={wide ? 'Narrow panel' : 'Widen panel'}>
                    {wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button type="button" className="icon-btn" onClick={() => onSelect(undefined)} title="Close (Esc)" aria-label="Close">
                    <X size={16} />
                </button>
            </header>

            <div className="inspector-body">
                {modes.length > 0 && (
                    <div className="inspector-tools">
                        <Segmented label="Compare mode" value={mode} onChange={setMode} options={modes} />
                        {change && change.regions.length > 0 && mode !== 'before' && (
                            <label className="toggle">
                                <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />
                                Outline changes
                            </label>
                        )}
                    </div>
                )}
                {modes.length === 0 && primaryVariant && screen.links.some((l) => l.bounds) && (
                    <div className="inspector-tools">
                        <label className="toggle">
                            <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} />
                            Show links
                        </label>
                    </div>
                )}

                <div className="shot-frame">
                    {mode === 'slider' && comparable && afterUrl && beforeUrl && after && before ? (
                        <Slider beforeUrl={beforeUrl} afterUrl={afterUrl} after={after} before={before} regions={outline ? (change?.regions ?? []) : []} />
                    ) : mode === 'before' && beforeUrl && before ? (
                        <ShotImage url={beforeUrl} shot={before} />
                    ) : mode === 'diff' && diffUrl && after ? (
                        <ShotImage url={diffUrl} shot={after} regions={outline ? change?.regions : undefined} />
                    ) : afterUrl && after ? (
                        <ShotImage
                            url={afterUrl}
                            shot={after}
                            regions={outline && comparable ? change?.regions : undefined}
                            links={showLinks ? screen.links.flatMap((l) => (l.bounds ? [{ bounds: l.bounds, label: l.label, target: l.targetScreenId }] : [])) : undefined}
                            onLink={(target) => target && model.byId.has(target) && onSelect(target)}
                        />
                    ) : (
                        <div className="empty small">No shot for {variantId(variant)}</div>
                    )}
                </div>
                {after?.truncated && <p className="note">Page continues past {after.height}px; the shot was cut there.</p>}
                {afterUrl && (
                    <a className="note link" href={mode === 'before' && beforeUrl ? beforeUrl : mode === 'diff' && diffUrl ? diffUrl : afterUrl} target="_blank" rel="noreferrer">
                        Open full size <ArrowUpRight size={12} />
                    </a>
                )}

                <Section title="Screen">
                    <dl className="meta">
                        <Row label="URL">
                            <a href={appUrl} target="_blank" rel="noreferrer" className="link">
                                {screen.url}
                                <ExternalLink size={12} />
                            </a>
                        </Row>
                        {screen.redirectedTo && <Row label="Landed on">{screen.redirectedTo}</Row>}
                        <Row label="Title">{screen.title || '—'}</Row>
                        <Row label="HTTP">{screen.httpStatus ?? '—'}</Row>
                        {screen.component && <Row label="Component">{screen.component}</Row>}
                        {screen.sourceFile && (
                            <Row label="Source">
                                {repoPath ? (
                                    <a className="link mono" href={`vscode://file/${repoPath}/${screen.sourceFile}`} title="Open in VS Code">
                                        <Code2 size={12} />
                                        {screen.sourceFile}
                                    </a>
                                ) : (
                                    <span className="mono">{screen.sourceFile}</span>
                                )}
                            </Row>
                        )}
                    </dl>
                </Section>

                {entry.change && entry.change.status !== 'unchanged' && (
                    <Section title="Changes">
                        <ul className="variant-list">
                            {entry.change.variants.map((v) => (
                                <li key={variantId(v.variant)} className={variantId(v.variant) === variantId(variant) ? 'on' : undefined}>
                                    <StatusDot status={v.status} />
                                    <span>
                                        {v.variant.viewport} · {v.variant.colorScheme}
                                    </span>
                                    <span className="muted">
                                        {v.status === 'modified' ? `${formatRatio(v.diffRatio)}${v.sizeChanged ? ' · size changed' : ''} · ${v.regions.length} region${v.regions.length === 1 ? '' : 's'}` : v.status}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {change && change.status === 'modified' && change.regions.length > 0 && model.comparison && (
                            <MaskRegions run={model.comparison.head.id} screenId={entry.id} variant={variantId(variant)} regions={change.regions} />
                        )}
                        {(entry.change.linksAdded.length > 0 || entry.change.linksRemoved.length > 0) && (
                            <ul className="link-diff">
                                {entry.change.linksAdded.map((l) => (
                                    <li key={`+${l}`} className="added">
                                        + {l}
                                    </li>
                                ))}
                                {entry.change.linksRemoved.map((l) => (
                                    <li key={`-${l}`} className="removed">
                                        − {l}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>
                )}

                {screen.links.length > 0 && (
                    <Section title={`Links out · ${screen.links.length}`}>
                        <ul className="links">
                            {screen.links.map((link, i) => {
                                const target = link.targetScreenId ? model.byId.get(link.targetScreenId) : undefined;
                                return (
                                    <li key={`${link.href}-${i}`}>
                                        {target ? (
                                            <button type="button" className="link-btn" onClick={() => onSelect(target.id)}>
                                                <span className="link-label">{link.label}</span>
                                                <span className="link-target">{target.screen.route}</span>
                                            </button>
                                        ) : (
                                            <div className="link-btn static">
                                                <span className="link-label">{link.label}</span>
                                                <span className="link-target muted">{link.skipped ?? 'not captured'}</span>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </Section>
                )}

                {incoming.length > 0 && (
                    <Section title={`Reached from · ${incoming.length}`}>
                        <ul className="links">
                            {incoming.map((t) => (
                                <li key={t.id}>
                                    <button type="button" className="link-btn" onClick={() => onSelect(t.from)}>
                                        <span className="link-label">{model.byId.get(t.from)!.screen.route}</span>
                                        <span className="link-target">{t.kind === 'state' ? 'interaction' : t.label || t.kind}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </Section>
                )}

                {screen.consoleErrors.length > 0 && (
                    <Section title={`Console errors · ${screen.consoleErrors.length}`}>
                        <ul className="errors">
                            {screen.consoleErrors.map((e, i) => (
                                <li key={i} className="mono">
                                    {e}
                                </li>
                            ))}
                        </ul>
                    </Section>
                )}
            </div>
        </aside>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="section">
            <h3>{title}</h3>
            {children}
        </section>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt>{label}</dt>
            <dd>{children}</dd>
        </>
    );
}

interface LinkBox {
    bounds: Bounds;
    label: string;
    target?: string;
}

function ShotImage({ url, shot, regions, links, onLink }: { url: string; shot: Shot; regions?: Bounds[]; links?: LinkBox[]; onLink?: (target?: string) => void }) {
    return (
        <div className="shot" style={{ aspectRatio: `${shot.width} / ${shot.height}` }}>
            <img src={url} alt="" draggable={false} />
            <Overlays shot={shot} regions={regions} links={links} onLink={onLink} />
        </div>
    );
}

function Overlays({ shot, regions, links, onLink }: { shot: Shot; regions?: Bounds[]; links?: LinkBox[]; onLink?: (target?: string) => void }) {
    const pct = (b: Bounds) => ({
        left: `${(b.x / shot.width) * 100}%`,
        top: `${(b.y / shot.height) * 100}%`,
        width: `${(b.width / shot.width) * 100}%`,
        height: `${(b.height / shot.height) * 100}%`,
    });
    return (
        <>
            {regions?.map((r, i) => <div key={`r${i}`} className="region" style={pct(r)} />)}
            {links
                ?.filter((l) => l.bounds.y < shot.height)
                .map((l, i) => (
                    <button
                        key={`l${i}`}
                        type="button"
                        className={`hotspot${l.target ? '' : ' hotspot-out'}`}
                        style={pct(l.bounds)}
                        title={l.label}
                        onClick={() => onLink?.(l.target)}
                    />
                ))}
        </>
    );
}

function Slider({ beforeUrl, afterUrl, before, after, regions }: { beforeUrl: string; afterUrl: string; before: Shot; after: Shot; regions: Bounds[] }) {
    const [at, setAt] = useState(50);
    // Both images share the larger frame so the wipe lines up even when the page height changed.
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const frame: Shot = { ...after, width, height };
    return (
        <div className="slider">
            <div className="shot" style={{ aspectRatio: `${width} / ${height}` }}>
                <img src={beforeUrl} alt="Before" draggable={false} style={{ width: `${(before.width / width) * 100}%` }} />
                <div className="slider-after" style={{ clipPath: `inset(0 0 0 ${at}%)` }}>
                    <img src={afterUrl} alt="After" draggable={false} style={{ width: `${(after.width / width) * 100}%` }} />
                    <Overlays shot={frame} regions={regions} />
                </div>
                <div className="slider-line" style={{ left: `${at}%` }} />
                <span className="slider-tag slider-tag-before">Before</span>
                <span className="slider-tag slider-tag-after">After</span>
                {/* Invisible range over the whole image: drag anywhere, or use the arrow keys once focused. */}
                <input
                    className="slider-range"
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={at}
                    onChange={(e) => setAt(Number(e.target.value))}
                    onKeyDown={(e) => e.stopPropagation()}
                    aria-label="Before and after split"
                />
            </div>
        </div>
    );
}

/**
 * Changed areas on this variant, each with a way to mask it: the element recorded under the area becomes a mask
 * selector in spider.json, so text that changes on its own (times, counters) stops showing up as a change.
 */
function MaskRegions({ run, screenId, variant, regions }: { run: string; screenId: string; variant: string; regions: Bounds[] }) {
    const [state, setState] = useState<Record<number, { selector?: string; label?: string; status: 'looking' | 'found' | 'none' | 'masked' | 'error'; error?: string }>>({});
    const look = async (i: number) => {
        setState((s) => ({ ...s, [i]: { status: 'looking' } }));
        try {
            const hit = await api.suggestMask({ run, screen: screenId, variant, region: regions[i] });
            setState((s) => ({
                ...s,
                [i]: hit
                    ? {
                          status: 'found',
                          selector: hit.selector,
                          label: [hit.element.role ?? hit.element.tag, hit.element.name && `“${hit.element.name.slice(0, 40)}”`, hit.single && '· every row'].filter(Boolean).join(' '),
                      }
                    : { status: 'none' },
            }));
        } catch (e) {
            setState((s) => ({ ...s, [i]: { status: 'error', error: (e as Error).message } }));
        }
    };
    const mask = async (i: number) => {
        const selector = state[i]?.selector;
        if (!selector) return;
        await api.mask([selector]);
        setState((s) => ({ ...s, [i]: { ...s[i], status: 'masked' } }));
    };
    return (
        <div className="mask-regions">
            <div className="muted small">Changed areas on this variant. Mask one if it changes on its own (a time, a counter).</div>
            <ul>
                {regions.slice(0, 8).map((r, i) => {
                    const st = state[i];
                    return (
                        <li key={i}>
                            <span className="mono muted">
                                {r.width}×{r.height} at {r.x},{r.y}
                            </span>
                            {!st && (
                                <button type="button" className="btn ghost small" onClick={() => look(i)}>
                                    <EyeOff size={12} /> Mask…
                                </button>
                            )}
                            {st?.status === 'looking' && <span className="muted">finding the element…</span>}
                            {st?.status === 'none' && <span className="muted">no single element covers it</span>}
                            {st?.status === 'error' && <span className="muted">{st.error}</span>}
                            {st?.status === 'found' && (
                                <>
                                    <span className="mask-target" title={st.selector}>
                                        {st.label}
                                    </span>
                                    <button type="button" className="btn small" onClick={() => mask(i)}>
                                        Mask it
                                    </button>
                                </>
                            )}
                            {st?.status === 'masked' && (
                                <span className="mask-done">
                                    <Check size={12} /> Masked. Review again to apply.
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function formatRatio(ratio: number): string {
    const pct = ratio * 100;
    if (pct === 0) return '0%';
    if (pct < 0.01) return '<0.01%';
    return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}
