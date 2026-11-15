import type { VariantKey } from '@contracts';
import { useEffect, useMemo, useRef } from 'react';
import { entryStatus, runFileUrl, shotFor, type Entry, type Model } from './model';
import { StatusDot } from './ui';

interface Props {
    model: Model;
    entries: Entry[];
    variant: VariantKey;
    selectedId?: string;
    onSelect: (id: string | undefined) => void;
}

export function ScreensView({ model, entries, variant, selectedId, onSelect }: Props) {
    const viewport = model.map.run.viewports.find((v) => v.id === variant.viewport) ?? model.map.run.viewports[0];
    const mobile = viewport.width < 700;
    const aspect = `${viewport.width} / ${viewport.height}`;

    // Group by persona, then sort by route so the tree and the grid read in the same order.
    const groups = useMemo(() => {
        const byPersona = new Map<string, Entry[]>();
        for (const entry of entries) {
            const list = byPersona.get(entry.screen.persona) ?? [];
            list.push(entry);
            byPersona.set(entry.screen.persona, list);
        }
        for (const list of byPersona.values()) list.sort((a, b) => a.id.localeCompare(b.id));
        return [...byPersona.entries()];
    }, [entries]);

    const selectedRef = useRef<HTMLButtonElement>(null);
    useEffect(() => selectedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), [selectedId]);

    return (
        <div className="screens">
            <nav className="tree" aria-label="Routes">
                {groups.map(([persona, list]) => (
                    <div key={persona} className="tree-group">
                        <div className="tree-persona">{persona}</div>
                        {list.map((entry) => {
                            const depth = entry.screen.route === '/' ? 0 : entry.screen.route.split('/').length - 2;
                            return (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className={`tree-item${entry.id === selectedId ? ' on' : ''}`}
                                    style={{ paddingInlineStart: 12 + depth * 12 + (entry.screen.state ? 12 : 0) }}
                                    onClick={() => onSelect(entry.id)}
                                >
                                    <StatusDot status={entryStatus(entry, variant)} />
                                    <span>{entry.screen.state ? `› ${entry.screen.state}` : lastSegment(entry.screen.route)}</span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>
            <div className="grid-scroll">
                {groups.map(([persona, list]) => (
                    <section key={persona} className="grid-section">
                        <h2>{persona}</h2>
                        <div className={`grid${mobile ? ' grid-mobile' : ''}`}>
                            {list.map((entry) => {
                                const shot = shotFor(entry.screen, variant);
                                const status = entryStatus(entry, variant);
                                const selected = entry.id === selectedId;
                                return (
                                    <button
                                        key={entry.id}
                                        ref={selected ? selectedRef : undefined}
                                        type="button"
                                        className={`card${selected ? ' card-selected' : ''}${status ? ` card-${status}` : ''}`}
                                        onClick={() => onSelect(entry.id)}
                                    >
                                        <div className="card-thumb" style={{ aspectRatio: aspect }}>
                                            {shot && <img src={runFileUrl(entry.runId, shot.path)} alt="" loading="lazy" />}
                                        </div>
                                        <div className="card-label">
                                            <StatusDot status={status} />
                                            <span className="card-route">{entry.screen.route}</span>
                                        </div>
                                        {entry.screen.state && <div className="card-state">{entry.screen.state}</div>}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

function lastSegment(route: string): string {
    if (route === '/') return '/';
    const parts = route.split('/').filter(Boolean);
    return `/${parts[parts.length - 1]}`;
}
