// Builds a chat-sized, self-contained spider-web card from a real run.
// Usage: node docs/chat-card/make-card.mjs data/runs/<run-id> card.html
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [runDir, out] = process.argv.slice(2);
const map = JSON.parse(readFileSync(join(runDir, 'map.json'), 'utf8'));
const abs = (p) => resolve(runDir, p);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const screens = map.screens.map((s) => ({
    id: s.id,
    persona: s.persona,
    route: s.route,
    url: s.url,
    state: s.state,
    title: s.title,
    source: s.sourceFile,
    shots: Object.fromEntries(s.shots.map((x) => [`${x.variant.viewport}-${x.variant.colorScheme}`, { w: x.width, h: x.height }])),
    links: s.links
        .filter((l) => l.targetScreenId && l.bounds && l.bounds.width > 2 && l.bounds.x >= 0)
        .map((l) => ({ label: l.label, to: l.targetScreenId, b: [l.bounds.x, l.bounds.y, l.bounds.width, l.bounds.height].map((n) => Math.round(n)) })),
}));

const store = map.screens
    .flatMap((s) => s.shots.map((x) => `<img data-k="${esc(s.id)}|${x.variant.viewport}-${x.variant.colorScheme}" data-path="${esc(abs(x.path))}" src="${esc(abs(x.path))}">`))
    .join('\n');

const run = map.run;
const data = {
    run: { label: run.label, target: run.targetLabel, branch: run.gitBranch, commit: run.gitCommit?.slice(0, 7), dirty: run.gitDirty, baseURL: run.baseURL, repo: run.repoPath, at: run.completedAt },
    screens,
    transitions: map.transitions.length,
    gaps: map.gaps.map((g) => g.route),
};

const html = readFileSync(new URL('./card-template.html', import.meta.url), 'utf8')
    .replace('/*DATA*/', `const DATA = ${JSON.stringify(data)};`)
    .replace('<!--STORE-->', store);
writeFileSync(out, html);
console.log(`wrote ${out}: ${screens.length} screens, ${map.screens.reduce((n, s) => n + s.shots.length, 0)} shots`);
