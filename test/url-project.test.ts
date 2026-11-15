import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { urlProject } from '../src/url-project.ts';

test('URL projects normalize hosts and keep origins separate', () => {
    const site = urlProject(' Example.COM ', '/tmp/home');
    assert.equal(site.baseURL, 'https://example.com');
    assert.equal(site.root, '/tmp/home/.spider/projects/example.com');
    assert.equal(urlProject('https://example.com/docs?q=1#intro').seed, '/docs?q=1');
    assert.equal(urlProject('https://example.com/docs').root, urlProject('example.com/').root);
    const origins = ['https://example.com', 'http://example.com', 'http://localhost:3000', 'http://localhost:3001'];
    assert.equal(new Set(origins.map((url) => urlProject(url).root)).size, origins.length);
    for (const url of ['', 'ftp://example.com', 'https://user:pass@example.com', 'https://']) {
        assert.throws(() => urlProject(url));
    }
});

test('URL launch creates a project, serves it, and reuses its config', { timeout: 20000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'spider-url-'));
    const env = { ...process.env, HOME: home };
    const args = ['bin/spider.js'];
    const child = spawn(process.execPath, [...args, '--url', 'example.com/docs', '--json', '--no-open'], { env });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise((done) => child.once('exit', done));
        }
        rmSync(home, { recursive: true, force: true });
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const info = await new Promise<{ url: string }>((resolve, reject) => {
        let stdout = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0]));
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Exited ${code}: ${stderr}`)));
    });
    const root = urlProject('example.com', home).root;
    const path = join(root, 'spider.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.baseURL, 'https://example.com');
    assert.deepEqual(config.personas.user.seeds, ['/docs']);
    const response = await fetch(`${info.url}/api/project`);
    assert.equal((await response.json() as { baseURL: string }).baseURL, 'https://example.com');
    config.mask = ['.clock'];
    writeFileSync(path, JSON.stringify(config));
    const again = spawnSync(process.execPath, [...args, '--url', 'https://example.com', '--json', '--no-open'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).alreadyRunning, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
    const mismatch = spawnSync(process.execPath, [...args, '--url', 'other.example', '-C', root, '--json'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(mismatch.status, 2);
    assert.equal(JSON.parse(mismatch.stdout).error, 'config');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
});
