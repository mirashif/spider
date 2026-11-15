import type { JobInfo } from '@contracts';
import { AlertTriangle, Check, KeyRound, LoaderCircle, Square, X } from 'lucide-react';
import { useState } from 'react';
import { api } from './api';

const PHASE: Record<string, string> = {
    prepare: 'Preparing the app',
    routes: 'Reading routes',
    'sign-in': 'Checking sign-in',
    crawl: 'Crawling',
    states: 'Capturing interactions',
    write: 'Saving',
};

/** Bottom bar: progress while a job runs, then its outcome until dismissed. Never blocks the page. */
export function JobBar({ job, onOpen }: { job: JobInfo | null; onOpen: (job: JobInfo) => void }) {
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (!job || dismissed === job.id) return null;

    const p = job.progress;
    if (job.status === 'running') {
        const total = (p?.done ?? 0) + (p?.queued ?? 0);
        const pct = total ? Math.round(((p?.done ?? 0) / total) * 100) : 0;
        const label = job.kind === 'login' ? `Waiting for you to sign in as ${job.label} in the browser window…` : (PHASE[p?.phase ?? ''] ?? 'Starting');
        return (
            <div className="jobbar" role="status">
                <LoaderCircle size={14} className="spin" />
                <span className="jobbar-label">
                    {label}
                    {p?.persona && job.kind !== 'login' && <span className="muted"> · {p.persona}</span>}
                    {job.by === 'cli' && <span className="chip">from CLI</span>}
                </span>
                {job.kind !== 'login' && p?.phase === 'crawl' && (
                    <>
                        <span className="muted tabular">
                            {p.done} captured · {p.queued} queued
                        </span>
                        <div className="meter">
                            <i style={{ width: `${pct}%` }} />
                        </div>
                        <span className="mono muted jobbar-route">{p.route}</span>
                    </>
                )}
                {job.kind !== 'login' && job.by === 'ui' && (
                    <button type="button" className="btn ghost" onClick={() => api.cancel()}>
                        <Square size={12} /> Stop
                    </button>
                )}
            </div>
        );
    }

    const close = (
        <button type="button" className="icon-btn" onClick={() => setDismissed(job.id)} aria-label="Dismiss">
            <X size={14} />
        </button>
    );

    if (job.status === 'needs-sign-in') {
        return (
            <div className="jobbar jobbar-warn" role="alert">
                <KeyRound size={14} />
                <span className="jobbar-label">Sign in first: {job.needsSignIn?.join(', ')} has no saved session.</span>
                <div className="spacer" />
                {error && <span className="muted">{error}</span>}
                {job.needsSignIn?.map((persona) => (
                    <button key={persona} type="button" className="btn primary" onClick={() => api.login(persona).catch((e: Error) => setError(e.message))}>
                        Sign in as {persona}
                    </button>
                ))}
                {close}
            </div>
        );
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
        return (
            <div className="jobbar jobbar-error" role="alert">
                <AlertTriangle size={14} />
                <span className="jobbar-label">{job.status === 'cancelled' ? 'Stopped.' : (job.error ?? 'Failed.')}</span>
                <div className="spacer" />
                {close}
            </div>
        );
    }

    // Done.
    const s = job.result?.summary;
    const changed = s ? s.modified + s.added + s.removed : 0;
    return (
        <div className="jobbar jobbar-ok" role="status">
            <Check size={14} />
            <span className="jobbar-label">
                {job.kind === 'login'
                    ? `Signed in as ${job.label}. The session is saved.`
                    : s
                      ? changed
                          ? `${changed} screen${changed === 1 ? '' : 's'} changed · ${s.unchanged} unchanged`
                          : `No visual changes across ${s.unchanged} screens`
                      : `${job.result?.screens ?? 0} screens captured. This run is now the baseline.`}
            </span>
            <div className="spacer" />
            {job.kind !== 'login' && (
                <button type="button" className="btn" onClick={() => onOpen(job)}>
                    Open
                </button>
            )}
            {close}
        </div>
    );
}
