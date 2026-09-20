# Deep Work Tracker

A desktop app that replaces a manual time-tracking spreadsheet. The user runs a
looping interval timer while doing focused work; the app records every session
automatically, tags it with what was being worked on, and surfaces analytics
that the spreadsheet made painful to extend.

## Why this exists

The previous workflow was: start a looping timer in a separate app, work, stop
it, then hand-type the start and stop times into a spreadsheet that computed
durations and weekly trends. Two problems: manual transcription, and analytics
that were hard to change once written as formulas.

The app must be *at least as good as the old timer* at the timer part, or the
user will stop using it. Two non-negotiables carried over from the old tool:

1. **Always-on-top compact window.** The timer must stay visible above other
   applications while working.
2. **Looping.** A preset runs work/break intervals repeatedly until stopped.

## Stack

- **Electron** — required for always-on-top and for accurate background timing.
  Chosen over Tauri because the machine has Node but no Rust toolchain.
- **React + TypeScript + Vite** — renderer UI.
- **electron-vite** — build tooling for main / preload / renderer.
- **better-sqlite3** — synchronous SQLite in the main process.
- **Recharts** — analytics charts.

### Why Vite and not Next.js

This gets questioned, so it is recorded here. Next.js is not an alternative to
Vite — Vite is a build tool, Next.js is a framework built around a Node web
server, with its own bundler. The real question is whether this app should have
a server. It should not: there is no network, no URLs, no SEO, and the data is
a SQLite file on the same disk as the UI.

Running Next.js inside Electron has two forms, both worse here:

- **Static export** disables middleware, Server Actions and API routes, and
  Server Components execute at *build time*, so they cannot read live session
  data. All of Next.js's weight, none of its benefits.
- **Standalone mode** boots a real HTTP server inside the desktop app: slower
  startup, port and lifecycle management, harder packaging, and a network hop
  between the UI and a local file.

Structurally, Electron needs three builds with different targets (`main` = Node,
`preload` = sandboxed bridge, `renderer` = browser). electron-vite handles all
three; Next.js has no concept of a main or preload process, so it would have to
run *alongside* another bundler rather than replace one.

Next.js would be the right call for a future web or mobile client reading this
data over a network. That is a separate application, and the React components
would largely port to it. It is not a reason to add a server to the desktop app.

## Architecture

Three processes, strict separation:

```
src/
  main/      Electron main. Owns windows, tray, notifications, DB, timer truth.
  preload/   contextBridge. The ONLY surface between main and renderer.
  renderer/  React UI. No Node APIs, no direct DB access.
```

Rules:

- `nodeIntegration: false`, `contextIsolation: true`. Never relax these.
- The renderer talks to the main process only through the typed API exposed in
  `preload/index.ts`. No `ipcRenderer` calls scattered in components.
- All SQL lives in `main/db/`. Never build SQL strings in the renderer.

### Timer correctness

The main process is the single source of truth for the running timer.

**Store a target end timestamp and derive remaining time from `Date.now()`.
Never decrement a counter on an interval.** A decrementing counter drifts,
and it breaks outright when the machine sleeps or the window is hidden. The
renderer ticks only to repaint; if the renderer and main disagree, main wins.

Sessions are recorded with absolute UTC timestamps. Convert to local time only
at the display layer.

### Windows

- **Compact window** — small, frameless, draggable, `alwaysOnTop: true`. This is
  the default working view.
- **Dashboard window** — normal window with analytics and session history.

## Source data and its quirks

3.5 years of history exists in a spreadsheet exported to CSV: **2,545 logged
hours, 2,336 timer runs, 889 active days** (2023-03-27 to 2026-09-19), plus 376
days explicitly marked `N/A` as deliberate rest.

The old timer is **Hourglass** for Windows — a *countdown* timer with loop and
always-on-top. `Start` and `End` in the CSV are **time remaining on the
countdown, not wall-clock time**. Every one of the 2,336 rows has `end < start`,
and `|start - end|` matches the recorded hours exactly.

**Consequence: the historical data contains no time-of-day information.**
Time-of-day analytics can only ever cover sessions recorded by this app. Never
present a time-of-day chart that silently includes imported rows.

### One row is one timer run

Each CSV row is an independent timer set to a round duration and usually stopped
before it expired. Verified:

- **97% of 2025-2026 rows start at a round duration** (a multiple of 5 minutes)
  — that value is what the timer was *set to*.
- **72-84% of recent runs were stopped early.** Only 16-28% reached 0:00:00.
  `planned` vs `actual` duration is therefore a real and interesting signal, not
  bookkeeping.

An earlier reading of this data — that a block is one long countdown subdivided
by task switches — was **wrong for everything after early 2023**. That pattern
appears in 22 of 22 multi-row blocks in 2023-H1 and in essentially none
afterwards (0 in 2025, 1 in 2026). The user now starts a separate timer per
task. **Do not build a "switch task without stopping the clock" feature.**

### Block labels are a category; the number is noise

`HW 1`, `HW 2`, `HW 3` are the same thing. The user has confirmed the ordinal
carries no meaning — several consecutive timers in one sitting often share a
single label. **Only the category matters.** Do not store `block_index`.

Grouping consecutive runs into a working stretch is a *derived* analytic,
computed from wall-clock gaps between sessions. It is never something the user
labels by hand.

Stripping the number leaves 68 categories across the full history, but 2026 use
is concentrated: HW (153), College Apps (75), Startup (70), Entrepreneurship
(49), Job (38), College (29), Scioly (20), Scholarships (20), Sprocket (17).
Note the drift — `College Apps` / `College Applications` / `College` /
`Applications` are one thing, as are `Study for APs` / `Study AP` and
`Internship` / `Internships`. Free-text labels degraded over 3.5 years, which is
the argument for projects being real rows rather than strings.

### Output tracking is a first-class feature, not a nice-to-have

**2,262 of 2,336 runs (97%) record a quantity of work produced and a derived
rate.** Examples: `19 problems` -> `0.613 problems/minute`, `126 words` ->
`39.375 words/minute`. This drives pace targets ("100 words per 20 minutes").
Any design that treats it as optional metadata is wrong.

212 distinct units appear, dominated by questions (707), words (509), slides
(159), pages (57), cells (52). They need singular/plural normalization. Nine
rows record the literal value `unquantifiable`, which must stay representable.

## Data model

`sessions` is the atomic unit: **one row per timer run**. Everything else is
derived. Record more per session rather than aggregating early — aggregation can
be recomputed, lost detail cannot.

- `projects` — id, name, color, archived. The category tag (`HW`, `Startup`,
  `Job`). A real row, not a string, so renaming fixes history everywhere and the
  drift above cannot recur.
- `tags` — id, name, project_id (nullable). The optional second dimension,
  chiefly course codes such as `WRIT 0580`. Stable enough to be an entity, which
  makes "hours per course this semester" a real query.
- `presets` — saved durations. Seed 60, 90, 30, 120, 20 min (the real top five).
- `sessions` — id, project_id, tag_id (nullable), task (free text, autocompleted
  from history), started_at, ended_at, planned_duration_s, actual_duration_s,
  completed, work_quantity, work_unit, unquantifiable, focus_rating, notes,
  pace_target_qty, pace_target_minutes, source (`app` | `import`)
- `rest_days` — date, reason. Preserves the 376 `N/A` days; a logged rest day is
  different from missing data and must not silently average as a zero.

Derived, never stored: rate (`work_quantity / actual minutes`), completion rate,
working stretches, totals, streaks.

Three structured fields (project, tag, preset) plus one free-text field (task)
is the deliberate balance. More structure means slower logging, and logging that
feels like work will simply stop happening.

Timestamps are ISO 8601 UTC strings. Durations are integer seconds. Imported
rows have real durations but **null `started_at`/`ended_at`**, since countdown
readings cannot become clock times. Every query must handle that.

## Commands

```
npm run dev        # dev with hot reload
npm run build      # typecheck + bundle all three processes
npm run typecheck  # typecheck only (node + web configs)
npm run dist       # package a Windows installer
npm run lint
npm run format
```

No test runner yet — Vitest arrives in Phase 2, alongside the first real
logic worth testing. Do not reference `npm run test` until it exists.

`package.json` carries an `allowScripts` field. npm 11 blocks install scripts
by default, and Electron's postinstall is what downloads the 246 MB binary —
without the approval a fresh `npm install` silently yields an app that cannot
start. If that happens, run `node node_modules/electron/install.js`.

## Conventions

- TypeScript strict mode. No `any` without a comment justifying it.
- Functional React components with hooks. No class components.
- Database migrations are numbered SQL files in `main/db/migrations/`, applied
  in order at startup. Never edit a migration that has already run; add a new one.
- Keep business logic (streaks, totals, trend math) in plain testable functions
  under `src/shared/`, not inside components.

## Working with the user

The user is new to agentic programming but technically capable (Arduino, KiCad,
LabVIEW, a CS course). So:

- Explain *why* a choice is made, not just what changed. Skip basic programming
  explanations; do explain Electron/React-specific reasoning.
- Prefer small, runnable increments. Each phase should end with something the
  user can actually launch and click, not scaffolding that only works later.
- Flag when a decision is hard to reverse later (schema shape, IPC surface)
  versus trivially changeable (styling, layout).

## Deferred

LLM-powered insights ("your mornings are twice as focused as your evenings")
are explicitly **out of scope for now**, but the schema above is designed to
support them: rich per-session rows with tags, ratings, and completion state are
exactly what a model would need. Do not add AI code until asked.
