import type { RoutesResult } from '@contracts';
import { ArrowLeft, Check, FolderOpen, Globe, KeyRound, LoaderCircle, Monitor, Moon, Play, RefreshCw, Smartphone, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, useJob, type Detected, type FoundServer, type SetupDraft, type SetupState } from './api';
import { isSuggested, RoutePicker } from './RoutePicker';

type Step = 'app' | 'routes' | 'signin' | 'run';
const STEPS: { id: Step; label: string }[] = [
    { id: 'app', label: 'App' },
    { id: 'routes', label: 'Routes' },
    { id: 'signin', label: 'Sign in' },
    { id: 'run', label: 'First run' },
];

const DESKTOP = { id: 'desktop', width: 1440, height: 900 };
const MOBILE = { id: 'mobile', width: 390, height: 844 };

/** First launch: pick the app, pick its routes, sign in if needed, capture the baseline. */
export function Setup({ initial, onDone }: { initial: SetupState; onDone: () => void }) {
    const [step, setStep] = useState<Step>('app');
    const [servers, setServers] = useState<FoundServer[]>(initial.servers);
    const [scanning, setScanning] = useState(false);
    // A server that's actually answering beats what config files claim (.env often says :8000 while Sail serves :80).
    const [url, setUrl] = useState(
        initial.servers.find((s) => s.url === initial.detected.url)?.url ?? initial.servers.find((s) => s.status < 400)?.url ?? initial.detected.url ?? initial.servers[0]?.url ?? '',
    );
    const [appDir, setAppDir] = useState('.');
    const [detected, setDetected] = useState<Detected>(initial.detected);
    const [name, setName] = useState(initial.detected.name ?? '');
    const [nameEdited, setNameEdited] = useState(false);
    const [routes, setRoutes] = useState<RoutesResult | null>(null);
    const [checking, setChecking] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [params, setParams] = useState<Record<string, string>>({});
    const [onlySelected, setOnlySelected] = useState(true);
    const [persona, setPersona] = useState('user');
    const [mobile, setMobile] = useState(false);
    const [dark, setDark] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { job } = useJob(() => undefined);
    const signingIn = job?.kind === 'login' && job.status === 'running';
    const signedIn = job?.kind === 'login' && job.status === 'done' && job.label === persona;
    const signInFailed = job?.kind === 'login' && job.status === 'failed' && job.label === persona ? job.error : undefined;

    const picked = useMemo(() => (routes?.routes ?? []).filter((r) => selected.has(r.pattern)), [routes, selected]);
    const needsSignIn = picked.some((r) => r.signIn);
    const steps = needsSignIn ? STEPS : STEPS.filter((s) => s.id !== 'signin');

    const check = async (nextParams = params) => {
        setChecking(true);
        setError(null);
        try {
            const result = await api.setupRoutes({ baseURL: url, appDir, params: nextParams });
            setRoutes(result);
            // Keep what the person picked; on the first check, start from the suggestion.
            setSelected((prev) => (prev.size ? new Set([...prev].filter((p) => result.routes.some((r) => r.pattern === p))) : new Set(result.routes.filter(isSuggested).map((r) => r.pattern))));
            // Discovered by following links: no route list to stay inside, so follow links by default.
            setOnlySelected(result.source === 'preset' || result.source === 'hook');
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setChecking(false);
        }
    };

    const draft = (overrides: Partial<SetupDraft> = {}): SetupDraft => ({
        name: name || detected.name || new URL(url).host,
        baseURL: url,
        appDir,
        selection: picked.map((r) => ({ pattern: r.pattern, path: r.path, signIn: r.signIn })),
        params,
        onlySelected,
        signInPersona: persona,
        viewports: mobile ? [DESKTOP, MOBILE] : [DESKTOP],
        colorSchemes: dark ? ['light', 'dark'] : ['light'],
        hidden: (routes?.routes ?? []).filter((r) => r.hidden).map((r) => r.pattern),
        // Without a route list, the patterns were guessed from links: keep them so crawls fold URLs the same way.
        patterns: routes && routes.source !== 'preset' && routes.source !== 'hook' ? routes.routes.map((r) => r.pattern) : undefined,
        replace: true,
        ...overrides,
    });

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const variants = (mobile ? 2 : 1) * (dark ? 2 : 1);
    const estimate = Math.round(picked.length * variants * 1.3 + 6);

    return (
        <div className="setup">
            <header className="setup-head">
                <div className="brand">
                    <SpiderMark /> <span>spider-web</span>
                </div>
                <ol className="steps" aria-label="Setup steps">
                    {steps.map((s, i) => {
                        const at = steps.findIndex((x) => x.id === step);
                        const state = i < at ? 'done' : i === at ? 'on' : '';
                        return (
                            <li key={s.id} className={`step ${state}`} aria-current={state === 'on' ? 'step' : undefined}>
                                <b>{state === 'done' ? <Check size={11} /> : i + 1}</b>
                                {s.label}
                            </li>
                        );
                    })}
                </ol>
                <span className="muted mono setup-root" title={initial.root}>
                    {initial.root}
                </span>
            </header>

            <main className="setup-body">
                {step === 'app' && (
                    <section className="setup-card">
                        <h1>Which app should we map?</h1>
                        <p className="muted">spider-web runs it in a browser, follows its links and screenshots every screen. Nothing leaves your machine.</p>

                        <div className="field-label">
                            Running on this machine
                            <button
                                type="button"
                                className="icon-btn"
                                title="Look again"
                                aria-label="Look for running servers again"
                                onClick={() => {
                                    setScanning(true);
                                    api.servers().then(setServers).finally(() => setScanning(false));
                                }}
                            >
                                <RefreshCw size={13} className={scanning ? 'spin' : undefined} />
                            </button>
                        </div>
                        <div className="server-list">
                            {servers.map((s) => (
                                <button key={s.url} type="button" className={`server${url === s.url ? ' on' : ''}`} onClick={() => setUrl(s.url)}>
                                    <Globe size={14} />
                                    <span className="server-main">
                                        <b>{s.title || s.url.replace('http://', '')}</b>
                                        <span className="muted mono">
                                            {s.url}
                                            {s.poweredBy ? ` · ${s.poweredBy}` : ''}
                                        </span>
                                    </span>
                                    <span className={`pill ${s.status < 400 ? 'pill-ok' : ''}`}>{s.status}</span>
                                </button>
                            ))}
                            {servers.length === 0 && <div className="muted server-none">{scanning ? 'Looking…' : 'No dev servers found on the usual ports. Start your app, or type its URL below.'}</div>}
                        </div>

                        <label className="field">
                            <span className="field-label">URL</span>
                            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" spellCheck={false} />
                            {detected.url && detected.url !== url && (
                                <button type="button" className="hint" onClick={() => setUrl(detected.url!)}>
                                    The app folder says {detected.url}. Use it
                                </button>
                            )}
                        </label>

                        <label className="field">
                            <span className="field-label">
                                App folder <span className="muted">optional: route list, source links, git info</span>
                            </span>
                            <span className="input-icon">
                                <FolderOpen size={14} />
                                <input
                                    value={appDir}
                                    onChange={(e) => setAppDir(e.target.value)}
                                    onBlur={() =>
                                        api.detect(appDir).then((d) => {
                                            setDetected(d);
                                            // Follow the folder's own name (APP_NAME, package name) until the person types one.
                                            if (!nameEdited) setName(d.name ?? '');
                                        }, (e: Error) => setError(e.message))
                                    }
                                    spellCheck={false}
                                />
                            </span>
                            <span className="muted small">{detected.summary ? `Detected: ${detected.summary}` : 'No framework detected. Routes will be found by following links.'}</span>
                        </label>

                        <label className="field">
                            <span className="field-label">Name</span>
                            <input
                                value={name}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    setNameEdited(true);
                                }}
                                placeholder={detected.name}
                            />
                        </label>

                        <Footer error={error}>
                            <button type="button" className="btn primary" disabled={!url || checking} onClick={() => check().then(() => setStep('routes'))}>
                                {checking ? <LoaderCircle size={13} className="spin" /> : null} Find routes
                            </button>
                        </Footer>
                    </section>
                )}

                {step === 'routes' && routes && (
                    <section className="setup-card wide">
                        <h1>Pick the routes to map</h1>
                        <p className="muted">
                            {routes.routes.length} routes from {routes.detail ?? describeSource(routes.source)}, each checked once ({(routes.durationMs / 1000).toFixed(1)}s). Start with a
                            few; you can crawl more any time.
                        </p>
                        <RoutePicker
                            routes={routes.routes}
                            selected={selected}
                            onChange={setSelected}
                            params={params}
                            onParam={(k, v) => {
                                const next = { ...params, [k]: v };
                                if (!v) delete next[k];
                                setParams(next);
                                void check(next);
                            }}
                        />
                        <label className="toggle setup-only">
                            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
                            Only these routes <span className="muted">(off: also follow links to pages not in this list)</span>
                        </label>
                        <Footer error={error} back={() => setStep('app')}>
                            <span className="muted">
                                {picked.length} selected{needsSignIn ? ` · ${picked.filter((r) => r.signIn).length} need sign-in` : ''}
                                {checking && ' · checking…'}
                            </span>
                            <button type="button" className="btn primary" disabled={picked.length === 0} onClick={() => setStep(needsSignIn ? 'signin' : 'run')}>
                                Continue
                            </button>
                        </Footer>
                    </section>
                )}

                {step === 'signin' && (
                    <section className="setup-card">
                        <h1>Sign in once</h1>
                        <p className="muted">
                            {picked.filter((r) => r.signIn).length} of your routes need a signed-in user. A browser window opens: sign in the way you normally would (SSO and 2FA work), then
                            close it. The session is saved in <span className="mono">.spider/auth</span> and reused until it expires.
                        </p>
                        <label className="field">
                            <span className="field-label">Who is signing in? <span className="muted">a short name, like admin or owner</span></span>
                            <input value={persona} onChange={(e) => setPersona(e.target.value.replace(/[^\w-]/g, ''))} disabled={signingIn || signedIn} />
                        </label>
                        {signingIn && (
                            <div className="callout">
                                <LoaderCircle size={14} className="spin" /> Waiting for you in the browser window… close it when you're signed in.
                            </div>
                        )}
                        {signedIn && (
                            <div className="callout ok">
                                <Check size={14} /> Signed in as {persona}. The session is saved.
                            </div>
                        )}
                        {signInFailed && <div className="callout bad">{signInFailed}</div>}
                        <Footer error={error} back={() => setStep('routes')}>
                            <button
                                type="button"
                                className="btn ghost"
                                disabled={busy || signingIn}
                                onClick={() => {
                                    setSelected(new Set(picked.filter((r) => !r.signIn).map((r) => r.pattern)));
                                    setStep('run');
                                }}
                                title="Leave out the routes that need sign-in"
                            >
                                Skip: open routes only
                            </button>
                            {signedIn ? (
                                <button type="button" className="btn primary" onClick={() => setStep('run')}>
                                    Continue
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="btn primary"
                                    disabled={busy || signingIn || !persona}
                                    onClick={() =>
                                        run(async () => {
                                            await api.saveSetup(draft());
                                            await api.login(persona);
                                        })
                                    }
                                >
                                    <KeyRound size={13} /> {signInFailed ? 'Try again' : 'Open browser to sign in'}
                                </button>
                            )}
                        </Footer>
                    </section>
                )}

                {step === 'run' && (
                    <section className="setup-card">
                        <h1>Capture the baseline</h1>
                        <p className="muted">
                            One pass over {picked.length} route{picked.length === 1 ? '' : 's'}
                            {onlySelected ? '' : ', plus pages they link to'}. This first run becomes the baseline: later reviews show what changed since.
                        </p>
                        <div className="field-label">Shoot each screen in</div>
                        <div className="variant-grid">
                            <Toggle on disabled icon={<Monitor size={14} />} label="Desktop" detail="1440 × 900" />
                            <Toggle on={mobile} onClick={() => setMobile(!mobile)} icon={<Smartphone size={14} />} label="Mobile" detail="390 × 844" />
                            <Toggle on disabled icon={<Sun size={14} />} label="Light" />
                            <Toggle on={dark} onClick={() => setDark(!dark)} icon={<Moon size={14} />} label="Dark" />
                        </div>
                        <p className="muted small">
                            {picked.length} screens × {variants} variant{variants === 1 ? '' : 's'} ≈ {estimate < 60 ? `${estimate}s` : `${Math.round(estimate / 60)} min`}. Add more later in
                            spider.json or Settings.
                        </p>
                        <Footer error={error} back={() => setStep(needsSignIn ? 'signin' : 'routes')}>
                            <button
                                type="button"
                                className="btn primary"
                                disabled={busy}
                                onClick={() =>
                                    run(async () => {
                                        await api.saveSetup(draft());
                                        await api.review({ label: 'first' });
                                        onDone();
                                    })
                                }
                            >
                                <Play size={13} /> Capture baseline
                            </button>
                        </Footer>
                    </section>
                )}
            </main>
        </div>
    );
}

function describeSource(source: RoutesResult['source']): string {
    return { preset: 'the app', hook: 'spider.config.ts', sitemap: 'the sitemap', run: 'earlier runs', links: 'links on the home page', none: 'nowhere' }[source];
}

function Footer({ children, back, error }: { children: React.ReactNode; back?: () => void; error: string | null }) {
    return (
        <footer className="setup-foot">
            {back && (
                <button type="button" className="btn ghost" onClick={back}>
                    <ArrowLeft size={13} /> Back
                </button>
            )}
            {error && <span className="setup-error">{error}</span>}
            <div className="spacer" />
            {children}
        </footer>
    );
}

function Toggle({ on, disabled, onClick, icon, label, detail }: { on: boolean; disabled?: boolean; onClick?: () => void; icon: React.ReactNode; label: string; detail?: string }) {
    return (
        <button type="button" role="switch" aria-checked={on} className={`vtoggle${on ? ' on' : ''}`} disabled={disabled} onClick={onClick}>
            {icon}
            <span>
                {label}
                {detail && <span className="muted"> {detail}</span>}
            </span>
            <span className="vtoggle-check">{on && <Check size={12} />}</span>
        </button>
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

export function useSetupState() {
    const [state, setState] = useState<SetupState | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        api.setup().then(setState, (e: Error) => setError(e.message));
    }, []);
    return { state, error };
}
