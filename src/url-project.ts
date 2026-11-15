import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One saved project per origin, regardless of which page opens it. */
export function urlProject(input: string, home = homedir()) {
    const value = input.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (!value || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP or HTTPS website URL without embedded credentials.');
    }
    const host = url.hostname.replace(/[^a-z\d.-]/gi, '_');
    const suffix = url.protocol === 'https:' && !url.port ? '' : `-${createHash('sha256').update(url.origin).digest('hex').slice(0, 12)}`;
    return {
        baseURL: url.origin,
        seed: url.pathname + url.search,
        root: join(home, '.spider', 'projects', host + suffix),
    };
}
