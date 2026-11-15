# spider-web

Screen maps and visual change review for web apps, running entirely on your machine. It's a web take on
[expo/explore](https://github.com/expo/explore): screenshots of every screen, connected by the links between them, and a
before/after diff of what changed.

It's built for two kinds of users: people using the app (`spider-web`), and coding agents using the CLI (`--json`,
meaningful exit codes, no prompts). The plan and open decisions are in [docs/plan.md](docs/plan.md).

## Quick start

Open a website directly:

```bash
spider --url example.com
spider --url http://localhost:3000
```

Missing schemes default to HTTPS. Each origin gets a saved project under `~/.spider/projects/`;
opening it again reuses its configuration, sessions and baseline. Different protocols and ports stay separate.
Spider listens on `0.0.0.0` by default and prints Network URLs you can open from another device on your LAN
or Tailscale network. Use `--host 127.0.0.1` for localhost-only access, or `--host ADDRESS` to bind a specific interface.
A URL path becomes the first crawl's seed when creating the project. Use `-C DIR` to choose a folder instead.
An existing folder configured for a different origin is left untouched and reports an error.
`spider-web` remains an alias for the same CLI.

Run it in your app's repo, or in any empty folder:

```bash
spider-web          # opens http://localhost:4320; without a spider.json, it starts with setup
```

**Setup** has four steps:

1. **App:** it lists dev servers it finds running, and reads the app folder (Laravel routes and Inertia pages are
   detected).
2. **Routes:** each route is checked once, and you pick which ones to map. Routes that need sign-in, parameters
   such as `:project` and API routes are flagged. Without a route list, patterns like `/author/:author` are guessed
   from the links.
3. **Sign in:** shown only if a picked route needs it. A browser window opens and you sign in by hand.
4. **First run:** captures the baseline.

After that:
- **Review** crawls again and compares with the baseline.
- **Selection…** reviews just some routes. The ↻ button in a screen's panel recrawls that one screen.
- Accept changes one screen at a time, or **Accept all**.
- If something changes on its own (a time, a counter), **Mask…** in the screen's panel finds the element under the
  changed area and adds it to the masks.

Agents and scripts can skip the UI: `spider-web init --url http://localhost:3000` writes `spider.json` directly.

From this repo, while there's no published package:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm spider --url example.com                   # open any website, no init or -C needed
pnpm dev                                        # open setup in the current folder
pnpm spider review -C ~/.spider/projects/example.com  # review a saved URL project
```

## CLI for agents

```bash
spider-web review --json                        # crawl, then compare with the baseline
spider-web review --only '/settings/**' --json  # just part of the app
spider-web show 'admin:/settings' --elements --json
```

- `--json` prints one result object on stdout, and progress goes to stderr as one JSON event per line.
- Results give absolute paths for before, after and diff PNGs, and for the source file behind each screen.
- Nothing prompts. Anything only a person can do exits with 3 and a `next` hint, e.g.
  `{"error":"needs-sign-in","next":"ask the user to run: spider-web login admin"}`.
- Exit codes:

  | Code | Meaning |
  | --- | --- |
  | 0 | done, nothing changed |
  | 1 | visual changes |
  | 2 | error |
  | 3 | needs a person |

- If the app is open, a CLI crawl shows up live in its progress bar.

| Command | What it does |
| --- | --- |
| `init --url URL […]` | Writes `spider.json`. Options: `--persona`, `--login manual`, `--route GLOB`, `--exclude GLOB`, `--param K=V`, `--app DIR`. |
| `routes [--refresh]` | Lists the app's routes, each requested once: status, sign-in wall, missing parameter values. |
| `login PERSONA` | Opens a browser. Sign in by hand, close the window, and the session is saved. |
| `crawl [--as P] [--only GLOB] [--label L] [--skip-prepare] [--headed]` | Captures one run. |
| `review [crawl flags] [--base REF]` | Crawls, then compares with the baseline. The first review creates the baseline. |
| `compare [BASE] [HEAD]` | Compares two runs: ids, labels, `latest`, `previous`, `baseline`. |
| `accept [SCREEN…] [--run REF]` | Makes a run, or some of its screens, the new baseline. |
| `mask [--css SEL]… [--unmask SEL]…` | Lists, adds or removes masks. Masked areas are ignored in comparisons from the next review on. |
| `runs`, `screens`, `show SCREEN` | Lists runs and screens, or shows one screen, with absolute paths. |
| `serve` | Opens the app (same as `spider-web` with no command). |
| `explain` | Prints the `spider.json` schema. |

## Config

- **`spider.json`** holds everything the app edits: URL, personas, seeds, include/exclude globs, viewports, route
  preset, masks and states. Schema: [src/spider.schema.json](src/spider.schema.json).
  - Globs: `/admin/**` matches `/admin` and everything below it. Prefix a pattern with `re:` for a regex.
  - `${NAME:-default}` reads an environment variable, so secrets stay out of the file.
- **`spider.config.ts`** (optional) holds hooks that need code: `routes()`, `sourceFile()`, and login steps.
- **`.spider/`** holds data. It comes with its own `.gitignore`: runs, comparisons and sign-in sessions stay out of git.

Signing in works one of two ways:
- `"login": "manual"` uses `spider-web login`, which handles SSO and 2FA.
- Scripted steps (`goto`, `fill`, `click`, `waitForURL`…) sign in automatically.

Sessions are reused while they still work.

Keep passwords in environment variables without literal defaults, or use manual sign-in.
Do not commit saved sessions, captures of private pages, or local project configuration.

## Frameworks

Setup detects the framework in the app folder. In a monorepo root, it offers the apps below it (`apps/web`…). The
preset reads the route list, so URLs fold into screens, the picker shows every page, and unreached pages are
reported. File-based presets also link each screen to the file that renders it.

| Preset | Reads | Source links |
| --- | --- | --- |
| `laravel` | `artisan route:list` (Sail when present) | Inertia page components |
| `rails` | `bin/rails routes` | |
| `django` | `manage.py show_urls` (needs django-extensions) | |
| `nextjs` | `app/**/page.tsx` and `pages/` | ✓ |
| `nuxt` | `pages/` or `app/pages/` | ✓ |
| `sveltekit` | `src/routes/**/+page.svelte` | ✓ |
| `remix` | `app/routes` flat routes, or React Router v7 `app/routes.ts` | ✓ |
| `tanstack-router` | `routeTree.gen.ts`, else `src/routes` files | ✓ |
| `astro` | `src/pages` (endpoints skipped) | ✓ |
| `solid-start`, `qwik`, `gatsby` | their route folders | ✓ |
| `vue-router` | file routes (unplugin-vue-router), else router config | best effort |
| `router-scan` | React Router library mode, Angular, Solid Router, wouter: paths in route definitions | best effort |

Without a preset, the sitemap and the links on the pages are used, and patterns like `/author/:author` are guessed.
Set `routes.dir` when the routes folder isn't the framework's default.

## How it works

1. **Routes.** The app's route list (Laravel's `route:list`, `sitemap.xml`, or a hook) decides which URLs count as the
   same screen (`/projects/alpha` → `/projects/:project`). It also fills the route check, and reports routes no
   link reached.
2. **Crawl.** Each persona signs in once, then visits pages breadth-first from its seeds, following links that stay
   inside its include/exclude rules.
3. **Shots.** Every screen is shot in each viewport and colour scheme, with the clock frozen and animations off.
   Each shot also records its visible elements (`*.elements.json`): role, name, test id, selector, position, styles
   and source attribute. Annotations, journeys and change requests build on these.
4. **States.** `states` run steps on top of a route (open a dialog, submit a form) and capture the result as its own
   screen.
5. **Baseline and compare.** Screens are matched by id (`persona:route#state`) and diffed with pixelmatch. Changed
   pixels are grouped into regions. The baseline moves forward only when you accept changes.

## Layout

```
src/cli.ts           the CLI (human output, --json, exit codes)
src/server.ts        local server: viewer, /api, SSE progress, /data
src/ops.ts           crawl / review / accept, shared by CLI and server
src/crawl.ts         Playwright crawl, shots, states
src/capture/         in-page scripts (element capture)
src/check.ts         route check
src/setup.ts         first launch: server discovery, framework detection, picker → spider.json
src/mask.ts          masks: element under a changed area → selector
src/baseline.ts      accepting into the baseline
src/compare.ts       pixel diff and change regions
src/config.ts        spider.json + spider.config.ts loading
src/presets/         framework presets: route lists and source files per framework
src/contracts.ts     data shapes shared with the viewer
test/                preset fixtures and route tests (pnpm test)
viewer/              React + Vite + React Flow
docs/                plan, mockups, chat-card prototype
```

## Known limits

- **Data is part of the picture.** Lists show whatever is in the dev database, and server-rendered relative times
  ("2 hours ago") change between runs. Mask them (**Mask…** in the app, or `spider-web mask`), or use seeded data.
- **Only links are followed.** Buttons that navigate through JavaScript, and dialogs, need a `states` entry until
  journeys land.
- **Old comparisons show the current baseline.** The baseline is rebuilt on every accept, so an old comparison's
  "before" images are today's baseline.
