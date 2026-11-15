# spider-web plan

Status, 2026-11-15:
- Decisions 1–7 are taken as recommended.
- Step 1 of the build order is done: core, server, element capture, route check, and the CLI for agents. The UI can
  run reviews, show live progress, prompt for sign-in, and accept changes.
- Step 2 is done:
  - First launch: setup mode, server discovery, framework detection, the route picker, manual sign-in, first run.
  - The picker is reused for **Selection…** reviews and single-screen recrawls.
  - Masks are taken from changed areas.
- Framework presets are done: Laravel, Rails, Django, Next.js, Nuxt, SvelteKit, Remix/React Router v7, TanStack
  Router, Astro, SolidStart, Qwik, Gatsby, Vue Router and a best-effort client-router scan. Each has fixture tests.
  Monorepo roots suggest their apps.
- Next is step 3, annotations and "Copy for agent". Decisions 8–11 come first.

Files next to this one:

- [mockup.html](mockup.html): UI mockups of first launch, map, annotate, journeys and review, each with the matching
  CLI session (interactive and `--json`).
- [chat-card/](chat-card): a working generator for a self-contained card that T3 Code can show inline in chat.
  `node docs/chat-card/make-card.mjs data/runs/<run-id> card.html`

## Goals

1. **Standalone.** Works on any web app, not just example-app.
2. **UI first.** You set up, crawl, review, annotate and build journeys in the UI. The config file is what the UI
   saves; you shouldn't have to edit it.
3. **CLI for agents.** Every UI action has a command with `--json` output, except signing in and recording, which need
   a person.
4. **Works inside T3 Code.** Agents can run reviews and show the results in chat. People can see results inline or in
   T3's preview panel.

## Architecture

```
core      crawl · shots · element capture · compare · journeys · store   (a library, no CLI code; can use a browser passed in)
server    HTTP API + live progress events + the built viewer, on :4320
  ├─ UI   the viewer becomes the whole app
  ├─ CLI  uses the server if it's running, otherwise the core directly
  └─ MCP  `spider-web mcp`: the same operations as tools, plus MCP App cards
```

- Install it as a package and run it in the target app's repo: `npx spider-web`. The config and `.spider/` data
  folder live in that repo.
- The viewer is built once when the package is published, and served by the server. Vite isn't needed at runtime.
- Framework-specific code moves into optional presets:
  - Route sources: `laravel()`, `nextjs()`, `sitemap()`, or a plain list.
  - Source hints: `inertia()`, a dev plugin, or a custom function.
- The core accepts a browser passed in, so T3 could later drive it with its own Chrome.

### The new data it depends on

**Elements on each shot.** At capture time, record the visible buttons, inputs, links, headings and text blocks.
For each one:
- a stable way to find it: test id, then role and accessible name, then CSS selector
- its position on each variant
- its text
- a few styles: font, colour, radius
- its source location when known

Annotations snap to these elements, journeys record them, prototype hotspots come from them, and change requests
describe them. Today only link bounds are captured (`LinkOut.bounds` in `src/contracts.ts`).

**Route check.** One quick request per route before crawling, recording its status, whether it redirects to a login
page, and sample values for its parameters.

## First launch

Four steps, each with a default and skippable:

1. **App.** It lists dev servers it finds on common ports, or you paste a URL. You can also pick the project folder,
   which turns on route detection and source links.
2. **Routes.**
   - Routes are read from the framework, with `sitemap.xml` and then a quick link scan as fallbacks. Each one is
     checked.
   - The picker is a tree: partly selectable branches, search, status per route, sample values for parameters, and
     JSON or download routes hidden.
   - Your selection is saved as include rules.
   - The same picker is used for later crawls. On the map, "Recrawl this section" does the same for one branch.
3. **Sign in.** Only shown when the check found routes that need sign-in. You log in by hand in a real browser window,
   and the session is saved for that user type. You can add more user types.
4. **First run.** Defaults to desktop and light only, so it's fast, with a time estimate. The map fills in live, and
   progress stays in a bar at the bottom.

Elsewhere in the app:
- a command palette (⌘K)
- a project switcher
- settings in the UI that write the config
- empty states that say what to do next

## Journeys and prototyping

- **A journey** is a named list of steps. Each step has an action, the element it acted on, a URL and a screenshot.
  Today's `states` config becomes one-step journeys.
- **Ways to create one:**
  - record it in a real browser window
  - compose it from the map, following known links
  - have an agent write the JSON
- **Replay.** Journeys run on every crawl and are diffed step by step. If a step can't find its element, the journey
  is reported as broken.
- **Storyboard view.** The steps as a strip of screenshots, with the clicked element highlighted.
- **Play mode.** Click through the real screenshots, using the recorded elements as hotspots. It exports to a single
  HTML file.
- **Proposed steps.** A draft step made from a marked-up screenshot or an image (or a Figma frame). It works as a spec
  for an agent. After the agent builds it, the next replay shows the proposal next to what was built.

## Annotations and change requests

- **Pin notes** on any shot: a screen, a journey step or a diff. A click snaps to the recorded element. You can also
  draw a box or arrow on a region.
- **Kinds:** bug, change, copy, question.
- **The tray.** Notes collect across screens. Send them together as one change request, or send one note on its own.
- **Copy for agent** saves a bundle at `.spider/requests/<id>/` (`request.md`, `request.json`, the marked-up shots and
  close-up crops) and copies a prompt with:
  - **repro:** URL, user and session file, state steps
  - **where:** viewport, colour scheme, git branch and commit
  - **element:** role, name, test id, selector, position, styles
  - **code:** source file
  - **check:** the command that verifies the change (`spider-web review --screens <id> --json`)
- **Status:** open → sent → done. A request is marked done when a later crawl shows a change in the annotated area, and
  it can be reopened.
- **Agents can pull requests themselves:** `spider-web requests --status open --json`, or the MCP tool.

## CLI rules

- Human-readable output in a terminal. `--json` prints one result object on stdout, and progress goes to stderr as one
  JSON event per line.
- No prompts when there's no terminal.
- Results give absolute PNG and bundle paths, so an agent can show them as Markdown images.
- Exit codes:

  | Code | Meaning |
  | --- | --- |
  | 0 | done, nothing changed |
  | 1 | visual changes or a broken journey |
  | 2 | error (bad config, app down) |
  | 3 | needs a person (sign-in), with a `next` hint saying what to ask the user |

- **Commands:**
  - setup: `init`, `routes`, `login`
  - capture: `crawl`, `review [--changed-since REF] [--screens …]`
  - baselines: `accept`, `mask`
  - inspecting results: `screens`, `show`, `explain` (prints the config schema)
  - journeys: `journey record|run|propose|export`
  - annotations: `note`, `request create|show|done --verify`, `requests`
  - integrations: `card`, `mcp`
- The UI and the CLI use the same words: project, route, screen, journey, note, request, review.

## T3 Code integration

T3 Code has no plugin system. The right-panel kinds and the MCP toolkits are fixed lists in its source. Paths below
are in the t3code repo.

**Level 0: no T3 changes, works today.**
- Agents run the CLI and put diff PNGs in their reply as Markdown images. T3 serves those files to remote and mobile
  clients.
- `preview_open localhost:4320` shows the full viewer in T3's preview panel. Desktop shows it natively; remote clients
  get a screencast.
- A `t3.json` project script can run a review and open the viewer. The automatic preview opening only works in the
  desktop app.

**Level 1: no T3 changes, adds `spider-web mcp`.**
- **Static chat cards** (`spider-web card`) shown with `html_render`. Screenshots are embedded, so cards work on
  remote and mobile clients. Limits:
  - 25 MB per page and 10 MB per image
  - the card can't reach `localhost`
  - nothing saves back to spider-web
  - the prototype is in `docs/chat-card/`
- **MCP App cards**, returned by spider-web's own MCP tools. These are interactive and can call spider-web tools, but
  only while the agent's turn is running. Limits: 5 MB of HTML, and network access only to declared domains
  (`docs/user/html-renders.md`).

**Level 2: changes to a T3 fork.** Modelled on the Device panel (`docs/internals/devices.md`):

| Piece | Where |
| --- | --- |
| Schemas, RPCs and settings | `packages/contracts` |
| A crawl service reusing T3's Playwright and headless Chrome | `apps/server/src/preview/PreviewBrowser.ts` |
| Visual diff after each turn, triggered by `checkpoint.captured` | modelled on `PullRequestSyncReactor.ts` |
| Results attached to a turn | needs a new stored event and projection type; stored events must stay readable forever |
| A `screens_*` MCP toolkit with a capability gate | `McpHttpServer.ts`, `McpInvocationContext.ts`, plus updates to tool display, the context-budget test, agent instructions and evals |
| A new right-panel kind | `rightPanelStore.ts`, plus a mobile screen |

This is a large change across server, web and mobile. Upstream may not accept it, so it's realistic only in a fork.

## Build order

1. Core, server and element capture, plus the route check.
2. First launch with the route picker.
3. Annotations and Copy for agent, with `requests` in the CLI. This closes the loop between you, the agent and a fresh
   crawl.
4. Journeys: recorder, storyboard, replay and step diffs.
5. Play mode, proposed steps and HTML export, plus `card` and `mcp`.
6. T3 Level 2, only if the per-turn visual diff becomes the feature you use most.

## Open decisions

Each has a recommendation. Change any of them before building the step it affects. 1–7 are **decided** (as
recommended) and built.

### Affect step 1

1. **What a review compares against.** An accepted baseline (accepting moves it forward), or always the previous run
   as `pnpm review` does today?
   *Recommendation: accepted baseline.* Comparing to the previous run hides a change after the next run.
2. **Config format.** The UI has to write the config, and writing back into a TypeScript file full of regexes and
   functions is fragile.
   *Recommendation: `spider.json` for everything the UI edits, plus an optional `spider.config.ts` for code-only
   hooks* (route parsers, source mapping, custom login steps).
3. **Where data lives.** `.spider/` in each app's repo, or one central folder (`~/.spider-web/<project>`) with a
   project registry for the switcher?
   *Recommendation: `.spider/` in the repo, plus a small registry file in the home folder that only lists projects.*
4. **What's committed to git.**
   *Recommendation: commit config, journeys and masks. Ignore runs, sign-in sessions and change requests.* Change
   requests could be shared later if a team wants that.
5. **App shell.** A browser tab served by the local server, or a desktop app (Electron or Tauri)?
   *Recommendation: browser tab.* It works in T3's preview panel. Sign-in and recording open real browser windows
   anyway.
6. **When the CLI uses the server.** Always go through a running server (starting it if needed), or run the core
   directly?
   *Recommendation: use the server if it's running so the UI shows live progress; otherwise run the core directly.
   Allow one crawl at a time per project.*
7. **How much element data to capture.** Every element, or interactive elements and landmarks only, with a cap?
   *Recommendation: interactive elements, headings and labelled regions, about 500 per shot.*

### Affect steps 2–3

8. **Source locations outside Inertia.** React 19 no longer exposes them. Ship a Vite or Babel plugin that adds source
   attributes, or accept "source unknown"?
   *Recommendation: optional plugin later. Use the route-to-page mapping from presets first.*
9. **How change requests reach agents.** Clipboard only, agents pulling (`spider-web requests`), or pushing straight
   to a T3 thread (T3's webhook endpoints, or its MCP server through OAuth)?
   *Recommendation: clipboard and pull first. Push to T3 later.*
10. **Tray or single notes by default.**
    *Recommendation: tray, plus "send this note now".*
11. **Mapping changed files to screens** for `review --changed-since`. It relies on source hints.
    *Recommendation: when no screen maps to a changed file, crawl everything and say so in the result.*

### Affect steps 4–5

12. **Recorder.** Build our own, or wrap Playwright's codegen?
    *Recommendation: our own, small, emitting our `Step` format with the same locator priority as element capture.*
13. **Does a broken journey count as a change** (exit 1)?
    *Recommendation: yes,* so an agent's single "did I break anything" check covers it.
14. **Proposed steps.** Marked-up screenshots and uploaded images only, or also Figma frames and AI-generated mockups?
    *Recommendation: marked-up screenshots and images first.*
15. **Saving from chat cards.** Static cards can't save notes. MCP App cards can, but only while a turn is running.
    *Recommendation: static cards first, with Copy for agent. MCP App when saving matters.*
16. **Fitting large runs into a chat card.** 25 MB per card.
    *Recommendation: changed screens only, downscaled to WebP or JPEG, with full images in the viewer.*

### Not urgent

17. **Package name and licence.** Check whether `spider-web` is free on npm.
18. **Browser.** Use Playwright's own Chromium download, or a Chrome that's already installed?
19. **More than one app per config** (today's `targets` map), or one app per config file?
    *Recommendation: one app per config.* The project switcher covers multiple apps.
20. **Changing data in shots** (new tenants appearing as changes). The defaults for masking, and whether to recommend
    seeded test data.
