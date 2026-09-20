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
hours, 2,336 task segments, 1,782 blocks, 889 active days** (2023-03-27 to
2026-09-19), plus 376 days explicitly marked `N/A` as deliberate rest.

The old timer is **Hourglass** for Windows — a *countdown* timer with loop and
always-on-top. This dictates the whole mental model:

- A **block** is one countdown from a preset duration down to 0:00:00.
- Inside a block, the user switches tasks without stopping the clock. Each
  segment's end reading becomes the next segment's start reading.
- Therefore `Start` and `End` in the CSV are **time remaining on the countdown,
  not wall-clock time**. Every one of the 2,336 rows has `end < start`, and
  `|start - end|` matches the recorded hours exactly. Do not read them as clock
  times.
- **Consequence: the historical data contains no time-of-day information.**
  Time-of-day analytics can only ever cover sessions recorded by this app.
  Never present a time-of-day chart that silently includes imported rows.

Block labels are a category plus an ordinal for that day: `HW 1`, `HW 2`,
`College Apps 3`. 2,117 of 2,336 rows follow this. The category is the project;
the number is the block index within the day. Up to 11 blocks in a single day.

Real preset durations, by frequency: 60 min (381), 90 (354), 120 (195), 30
(169), 180 (145), 40 (85), 45 (76), 20 (67), 270 (31), 150 (26), 80 (24),
240 (22). Ship 60 and 90 as defaults, but duration must be freely settable.

### Output tracking is a first-class feature, not a nice-to-have

**2,262 of 2,336 segments (97%) record a quantity of work produced and a derived
rate.** Examples: `19 problems` -> `0.613 problems/minute`, `126 words` ->
`39.375 words/minute`. This is how the user drives pace targets ("100 words per
20 minutes"). Any design that treats this as optional metadata is wrong.

212 distinct units appear, dominated by questions (707), words (509), slides
(159), pages (57), cells (52). They need singular/plural normalization
(question/questions, video/videos, component/components). Nine rows record the
literal value `unquantifiable`, which must stay representable.

## Data model

`sessions` is the append-only heart of the app. Everything else is derived.
When in doubt, record more per session rather than aggregating early —
aggregation can always be recomputed, lost detail cannot.

- `projects` — id, name, color, archived. Seeded from block categories (HW,
  College Apps, Entrepreneurship, SAT, Scioly, Startup, Internship, ...).
- `presets` — timer configs: duration, loop behavior, optional pace target
- `blocks` — one countdown run: project_id, preset_id, planned_duration_s,
  started_at, ended_at, block_index (ordinal within the day), completed
- `sessions` — one task segment inside a block: id, block_id, task,
  started_at, ended_at, duration_s, work_quantity, work_unit, unquantifiable,
  focus_rating, notes, source (`app` | `import`)
- `rest_days` — date, reason. Preserves the 376 `N/A` days; a logged rest day
  is different from missing data and must not be averaged as a zero silently.

Derived, never stored: rate (`work_quantity / minutes`), totals, streaks.

Timestamps are ISO 8601 UTC strings. Durations are integer seconds. Imported
rows have real `duration_s` but **null `started_at`/`ended_at`**, since the
countdown readings cannot be converted to clock times. Queries must handle this.

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
