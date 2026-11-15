import type { RoutesResult } from '@contracts';
import { LoaderCircle, Play, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { patternGlob, RoutePicker } from './RoutePicker';

/** "Review selection": the first-launch route picker, reused to review just part of the app. */
export function CrawlDialog({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
    const [routes, setRoutes] = useState<RoutesResult | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);

    const load = (refresh: boolean) => {
        setLoading(true);
        api.routes(refresh)
            .then((r) => setRoutes(r))
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        dialog.current?.showModal();
        load(false);
    }, []);

    const start = () => {
        const only = [...selected].map(patternGlob);
        api.review({ only, label: 'selection' }).then(onStarted, (e: Error) => setError(e.message));
    };

    return (
        <dialog ref={dialog} className="dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
            <header className="dialog-head">
                <div>
                    <h2>Review a selection</h2>
                    <p className="muted">Crawl only these routes and compare them with the baseline. Everything else stays as it is.</p>
                </div>
                <button type="button" className="icon-btn" onClick={() => dialog.current?.close()} aria-label="Close">
                    <X size={16} />
                </button>
            </header>
            <div className="dialog-body">
                {routes ? (
                    <RoutePicker routes={routes.routes} selected={selected} onChange={setSelected} params={{}} height={380} />
                ) : (
                    <div className="empty small">{loading ? 'Checking routes…' : (error ?? 'No routes.')}</div>
                )}
            </div>
            <footer className="dialog-foot">
                <button type="button" className="btn ghost" onClick={() => load(true)} disabled={loading} title="Check every route again">
                    {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Re-check
                </button>
                {error && <span className="setup-error">{error}</span>}
                <div className="spacer" />
                <span className="muted">{selected.size} selected</span>
                <button type="button" className="btn primary" disabled={selected.size === 0} onClick={start}>
                    <Play size={13} /> Review selection
                </button>
            </footer>
        </dialog>
    );
}
