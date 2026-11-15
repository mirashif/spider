import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

test('default server accepts LAN connections; explicit loopback stays local', { timeout: 10000 }, async () => {
    const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
    const root = mkdtempSync(join(tmpdir(), 'spider-host-'));
    try {
        const server = await startServer(root, undefined, { port: 0 });
        try {
            assert.equal((await fetch(server.url + '/api/jobs/current')).status, 200);
            if (address) {
                const networkUrl = `http://${address}:${new URL(server.url).port}`;
                assert.ok(server.networkUrls.includes(networkUrl));
                assert.equal((await fetch(networkUrl + '/api/jobs/current')).status, 200);
            }
        } finally {
            await server.close();
        }
        const local = await startServer(root, undefined, { port: 0, host: '127.0.0.1' });
        try {
            assert.equal((await fetch(local.url + '/api/jobs/current')).status, 200);
            assert.deepEqual(local.networkUrls, []);
            if (address) await assert.rejects(fetch(`http://${address}:${new URL(local.url).port}/api/jobs/current`, { signal: AbortSignal.timeout(1000) }));
        } finally {
            await local.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
