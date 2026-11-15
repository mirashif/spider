// Route presets against small fixture apps, one per framework. Run: pnpm test

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectPreset, parseDjangoUrls, parseLaravelRoutes, parseRailsRoutes, presetById, type RouteEntry } from '../src/presets/frameworks.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Writes a fixture app: { 'path/file': contents }. Dependencies go in package.json. */
function app(files: Record<string, string>, deps: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'spider-preset-'));
    dirs.push(dir);
    const all = { 'package.json': JSON.stringify({ name: 'fixture', dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) }), ...files };
    for (const [path, contents] of Object.entries(all)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), contents);
    }
    return dir;
}

const empty = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, '']));
const patterns = (entries: RouteEntry[]) => entries.map((e) => e.pattern).sort();
const routesOf = (id: string, dir: string) => presetById(id)!.routes(dir, {});

describe('file-based routers', () => {
    test('Next.js app and pages routers', () => {
        const dir = app(
            empty([
                'app/page.tsx',
                'app/layout.tsx',
                'app/(marketing)/about/page.tsx',
                'app/blog/[slug]/page.tsx',
                'app/shop/[...all]/page.tsx',
                'app/docs/[[...path]]/page.mdx',
                'app/_private/secret/page.tsx',
                'app/@modal/(.)photo/page.tsx',
                'app/dashboard/layout.tsx',
                'pages/_app.tsx',
                'pages/api/hello.ts',
                'pages/legacy/[id].tsx',
            ]),
            ['next'],
        );
        assert.equal(detectPreset(dir)?.id, 'nextjs');
        const entries = routesOf('nextjs', dir);
        assert.deepEqual(patterns(entries), ['/', '/about', '/blog/:slug', '/docs/:path?', '/legacy/:id', '/shop/:all']);
        assert.equal(entries.find((e) => e.pattern === '/blog/:slug')?.file, 'app/blog/[slug]/page.tsx');
    });

    test('Nuxt pages', () => {
        const dir = app(empty(['pages/index.vue', 'pages/users/[id].vue', 'pages/(admin)/settings.vue', 'pages/[[lang]]/docs.vue', 'pages/blog/[...slug].vue']), ['nuxt']);
        assert.equal(detectPreset(dir)?.id, 'nuxt');
        assert.deepEqual(patterns(routesOf('nuxt', dir)), ['/', '/:lang?/docs', '/blog/:slug', '/settings', '/users/:id']);
    });

    test('Nuxt 4 app/pages', () => {
        const dir = app(empty(['app/pages/index.vue', 'app/pages/about.vue']), ['nuxt']);
        assert.deepEqual(patterns(routesOf('nuxt', dir)), ['/', '/about']);
    });

    test('SvelteKit', () => {
        const dir = app(
            empty([
                'src/routes/+page.svelte',
                'src/routes/+layout.svelte',
                'src/routes/(app)/dashboard/+page.svelte',
                'src/routes/blog/[slug=word]/+page.svelte',
                'src/routes/blog/[slug=word]/+page.ts',
                'src/routes/[[lang]]/about/+page.svelte',
                'src/routes/api/+server.ts',
            ]),
            ['@sveltejs/kit'],
        );
        assert.equal(detectPreset(dir)?.id, 'sveltekit');
        const entries = routesOf('sveltekit', dir);
        assert.deepEqual(patterns(entries), ['/', '/:lang?/about', '/blog/:slug', '/dashboard']);
        assert.equal(entries.find((e) => e.pattern === '/blog/:slug')?.file, 'src/routes/blog/[slug=word]/+page.svelte');
    });

    test('Remix flat routes', () => {
        const dir = app(
            empty([
                'app/routes/_index.tsx',
                'app/routes/about.tsx',
                'app/routes/concerts.$city.tsx',
                'app/routes/_auth.tsx',
                'app/routes/_auth.login.tsx',
                'app/routes/concerts_.mine.tsx',
                'app/routes/($lang).docs.tsx',
                'app/routes/files.$.tsx',
                'app/routes/dashboard/route.tsx',
                'app/routes/dashboard/chart.tsx',
                'app/routes/sitemap[.]xml.tsx',
            ]),
            ['@remix-run/react'],
        );
        assert.equal(detectPreset(dir)?.id, 'remix');
        assert.deepEqual(patterns(routesOf('remix', dir)), ['/', '/:lang?/docs', '/about', '/concerts/:city', '/concerts/mine', '/dashboard', '/files/:splat', '/login', '/sitemap.xml']);
    });

    test('React Router v7 routes.ts', () => {
        const dir = app(
            {
                'app/routes.ts': `import { index, route } from "@react-router/dev/routes";\nexport default [index("./home.tsx"), route("products/:pid", "./product.tsx"), route("about", "./about.tsx")];`,
                ...empty(['app/home.tsx', 'app/product.tsx', 'app/about.tsx']),
            },
            ['react-router', '@react-router/dev'],
        );
        assert.equal(detectPreset(dir)?.id, 'remix');
        const entries = routesOf('remix', dir);
        assert.deepEqual(patterns(entries), ['/', '/about', '/products/:pid']);
        assert.equal(entries.find((e) => e.pattern === '/products/:pid')?.file, 'app/product.tsx');
    });

    test('TanStack Router route files', () => {
        const dir = app(
            empty([
                'src/routes/__root.tsx',
                'src/routes/index.tsx',
                'src/routes/posts.$postId.tsx',
                'src/routes/_layout.tsx',
                'src/routes/_layout.dashboard.tsx',
                'src/routes/settings/index.tsx',
                'src/routes/settings/profile.lazy.tsx',
                'src/routes/-components/card.tsx',
                'src/routes/(group)/about.tsx',
                'src/routes/files/$.tsx',
                'src/routes/{-$lang}/docs.tsx',
            ]),
            ['@tanstack/react-router'],
        );
        assert.equal(detectPreset(dir)?.id, 'tanstack-router');
        assert.deepEqual(patterns(routesOf('tanstack-router', dir)), ['/', '/:lang?/docs', '/about', '/dashboard', '/files/:splat', '/posts/:postId', '/settings', '/settings/profile']);
    });

    test('TanStack Router generated route tree', () => {
        const dir = app(
            {
                'src/routeTree.gen.ts': [
                    `import { Route as rootRouteImport } from './routes/__root'`,
                    `import { Route as ChatIndexRouteImport } from './routes/_chat.index'`,
                    `import { Route as ChatSettingsRouteImport } from './routes/_chat.settings'`,
                    `import { Route as ChatEnvironmentIdThreadIdRouteImport } from './routes/_chat.$environmentId.$threadId'`,
                    `export interface FileRoutesByFullPath {`,
                    `  '/': typeof ChatIndexRoute`,
                    `  '/settings': typeof ChatSettingsRouteWithChildren`,
                    `  '/$environmentId/$threadId': typeof ChatEnvironmentIdThreadIdRoute`,
                    `}`,
                ].join('\n'),
                ...empty(['src/routes/_chat.index.tsx', 'src/routes/_chat.settings.tsx', 'src/routes/_chat.$environmentId.$threadId.tsx']),
            },
            ['@tanstack/react-router'],
        );
        const entries = routesOf('tanstack-router', dir);
        assert.deepEqual(patterns(entries), ['/', '/:environmentId/:threadId', '/settings']);
        assert.equal(entries.find((e) => e.pattern === '/settings')?.file, 'src/routes/_chat.settings.tsx');
    });

    test('Astro', () => {
        const dir = app(empty(['src/pages/index.astro', 'src/pages/blog/[slug].astro', 'src/pages/rss.xml.ts', 'src/pages/_drafts/x.md', 'src/pages/docs/[...path].md']), ['astro']);
        assert.equal(detectPreset(dir)?.id, 'astro');
        assert.deepEqual(patterns(routesOf('astro', dir)), ['/', '/blog/:slug', '/docs/:path']);
    });

    test('SolidStart', () => {
        const dir = app(empty(['src/routes/index.tsx', 'src/routes/(marketing)/about.tsx', 'src/routes/users/[id].tsx', 'src/routes/blog/(blog).tsx']), ['@solidjs/start']);
        assert.equal(detectPreset(dir)?.id, 'solid-start');
        assert.deepEqual(patterns(routesOf('solid-start', dir)), ['/', '/about', '/blog', '/users/:id']);
    });

    test('Qwik City', () => {
        const dir = app(empty(['src/routes/index.tsx', 'src/routes/layout.tsx', 'src/routes/about/index.tsx', 'src/routes/product/[id]/index.tsx']), ['@builder.io/qwik-city']);
        assert.equal(detectPreset(dir)?.id, 'qwik');
        assert.deepEqual(patterns(routesOf('qwik', dir)), ['/', '/about', '/product/:id']);
    });

    test('Gatsby', () => {
        const dir = app(empty(['src/pages/index.js', 'src/pages/about.js', 'src/pages/products/{Product.slug}.js', 'src/pages/404.js']), ['gatsby']);
        assert.equal(detectPreset(dir)?.id, 'gatsby');
        assert.deepEqual(patterns(routesOf('gatsby', dir)), ['/', '/about', '/products/:slug']);
    });
});

describe('config-based client routers', () => {
    test('Vue Router config', () => {
        const dir = app({ 'src/router/index.ts': `createRouter({ routes: [{ path: '/', component: Home }, { path: '/users/:id', component: User }, { path: '/:pathMatch(.*)*', component: NotFound }] })` }, ['vue-router']);
        assert.equal(detectPreset(dir)?.id, 'vue-router');
        assert.ok(patterns(routesOf('vue-router', dir)).includes('/users/:id'));
    });

    test('React Router library mode', () => {
        const dir = app(
            { 'src/App.tsx': `<Routes><Route path="/" element={<Home />} /><Route path="/settings" element={<S />} /><Route path="*" element={<X />} /></Routes>\ncreateBrowserRouter([{ path: "/inbox/:id" }])` },
            ['react-router-dom'],
        );
        assert.equal(detectPreset(dir)?.id, 'router-scan');
        assert.deepEqual(patterns(routesOf('router-scan', dir)), ['/', '/inbox/:id', '/settings']);
    });

    test('a meta-framework wins over the router it uses', () => {
        assert.equal(detectPreset(app({}, ['next', 'react-router-dom']))?.id, 'nextjs');
        assert.equal(detectPreset(app({}, ['@remix-run/react', 'react-router']))?.id, 'remix');
    });
});

describe('server frameworks', () => {
    test('Laravel route:list', () => {
        const json = JSON.stringify([
            { domain: null, method: 'GET|HEAD', uri: '/' },
            { domain: null, method: 'GET|HEAD', uri: 'users/{user}' },
            { domain: null, method: 'POST', uri: 'users' },
            { domain: null, method: 'GET|HEAD', uri: 'posts/{post?}' },
        ]);
        assert.deepEqual(parseLaravelRoutes(json), ['/', '/posts/:post?', '/users/:user']);
        // A domain filter only applies when the app registers routes for that domain.
        assert.deepEqual(parseLaravelRoutes(json, 'localhost'), ['/', '/posts/:post?', '/users/:user']);
    });

    test('rails routes', () => {
        const output = [
            '                  Prefix Verb   URI Pattern                Controller#Action',
            '                   users GET    /users(.:format)           users#index',
            '                         POST   /users(.:format)           users#create',
            '                    user GET    /users/:id(.:format)       users#show',
            '                    root GET    /                          home#index',
            '                         GET    /files/*path(.:format)     files#show',
        ].join('\n');
        assert.deepEqual(parseRailsRoutes(output), ['/', '/files/:path', '/users', '/users/:id']);
    });

    test('django show_urls', () => {
        const json = JSON.stringify([{ url: '/' }, { url: '/polls/<int:question_id>/' }, { url: '/articles/(?P<year>[0-9]{4})/' }, { url: '/about/' }]);
        assert.deepEqual(parseDjangoUrls(json), ['/', '/about', '/articles/:year', '/polls/:question_id']);
    });
});
