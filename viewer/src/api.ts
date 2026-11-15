import type { Bounds, ChangeStatus, CrawlEvent, JobInfo, ProjectInfo, RoutesResult } from '@contracts';
import { useEffect, useRef, useState } from 'react';

async function post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${res.status} ${url}`);
    return data;
}

export interface FoundServer {
    url: string;
    port: number;
    status: number;
    title?: string;
    poweredBy?: string;
}

export interface Detected {
    appDir: string;
    framework?: string;
    summary?: string;
    name?: string;
    url?: string;
}

export interface SetupState {
    configured: boolean;
    root: string;
    detected: Detected;
    servers: FoundServer[];
}

export interface SetupDraft {
    name: string;
    baseURL: string;
    appDir?: string;
    selection: { pattern: string; path?: string; signIn: boolean }[];
    params?: Record<string, string>;
    onlySelected: boolean;
    signInPersona?: string;
    viewports?: { id: string; width: number; height: number }[];
    colorSchemes?: ('light' | 'dark')[];
    hidden?: string[];
    patterns?: string[];
    replace?: boolean;
}

export const api = {
    setup: () => fetch('/api/setup').then((r) => r.json() as Promise<SetupState>),
    servers: () => post<FoundServer[]>('/api/setup/servers', {}),
    detect: (appDir: string) => post<Detected>('/api/setup/detect', { appDir }),
    setupRoutes: (body: { baseURL: string; appDir?: string; params?: Record<string, string> }) => post<RoutesResult>('/api/setup/routes', body),
    saveSetup: (draft: SetupDraft) => post<ProjectInfo>('/api/setup/save', draft),
    routes: (refresh = false) => fetch(`/api/routes${refresh ? '?refresh=1' : ''}`).then((r) => r.json() as Promise<RoutesResult>),
    suggestMask: (body: { run: string; screen: string; variant: string; region: Bounds }) =>
        post<{ selector: string; single?: string; element: { tag: string; role?: string; name?: string; testId?: string } } | null>('/api/mask/suggest', body),
    mask: (add: string[], remove: string[] = []) => post<{ mask: string[] }>('/api/mask', { add, remove }),
    project: () => fetch('/api/project').then((r) => r.json() as Promise<ProjectInfo>),
    review: (body: { label?: string; personas?: string[]; only?: string[]; skipPrepare?: boolean } = {}) => post<JobInfo>('/api/crawl', { review: true, ...body }),
    cancel: () => post<{ ok: true }>('/api/crawl/cancel', {}),
    login: (persona: string) => post<JobInfo>('/api/login', { persona }),
    accept: (run: string, screens?: string[]) =>
        post<{ revision: number; accepted: string[]; run: string; comparison?: string; summary?: Record<ChangeStatus, number> }>('/api/accept', { run, screens }),
};

/** The current job (crawl, review, sign-in), live over SSE. `onEnd` fires once when a job stops running. */
export function useJob(onEnd: (job: JobInfo) => void): { job: JobInfo | null; last?: CrawlEvent } {
    const [state, setState] = useState<{ job: JobInfo | null; last?: CrawlEvent }>({ job: null });
    const onEndRef = useRef(onEnd);
    onEndRef.current = onEnd;
    useEffect(() => {
        const source = new EventSource('/api/events');
        let wasRunning: string | undefined;
        source.addEventListener('job', (e) => {
            const { job, event } = JSON.parse((e as MessageEvent<string>).data) as { job: JobInfo | null; event?: CrawlEvent };
            setState((prev) => ({ job, last: event ?? prev.last }));
            if (job?.status === 'running') wasRunning = job.id;
            else if (job && wasRunning === job.id) {
                wasRunning = undefined;
                onEndRef.current(job);
            }
        });
        return () => source.close();
    }, []);
    return state;
}
