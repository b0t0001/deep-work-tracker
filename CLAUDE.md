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

The main process is the single source of truth for both timers.

**Store a target end timestamp and derive remaining time from `Date.now()`.
Never decrement a counter on an interval.** A decrementing counter drifts and
breaks outright when the machine sleeps or the window is hidden. The renderer
ticks only to repaint; if renderer and main disagree, main wins.

### Two independent timers

The user ran two Hourglass windows at once. The app must reproduce that.

1. **Session timer** — the countdown for the work session. Freely settable;
   presets 60, 90, 30, 120, 20 min. On expiry it notifies and auto-starts
   another run of the same length (Hourglass's loop). Each run is its own
   `sessions` row. No break interval — breaks are not tracked.
2. **Pace loop** — an independent repeating interval, often short (3, 5, 10,
   20 min), expressing a target rate such as "100 words per 20 minutes". On each
   loop it plays a **subtle, short** sound and briefly shows the **cumulative
   target** (third 20-minute loop reads `target: 300 words`). Session expiry
   uses a clearly different and more prominent sound — the two events mean
   different things and must never be confused by ear. A 3-minute pace loop
   fires often, so its cue must be hearable without breaking focus.

**The pace loop never asks for input.** The user's words: they will not log data
mid-essay. It cues; they judge. Quantity is entered once, at stop.

### Pause and stop are different actions

This distinction is load-bearing and was missed in the first draft.

- **Pause** — temporary. Bathroom, brief interruption. The session continues
  afterwards. **Paused time is not work time**: `running_duration_s` counts only
  time the clock was actually running, never the wall-clock span from
  `started_at` to `ended_at`. Pause intervals are recorded so this is auditable.
- **Stop** — the session is over. Only stop prompts for work quantity.
- **A session paused longer than the auto-end threshold ends automatically**,
  recording time up to the pause. Default 15 minutes, configurable. This exists
  because the user's habit is to pause and close the window rather than stop.

**Stopping must be undoable.** A 30-second "undo — resume session" banner after
stopping, and the session stays editable in history afterwards. Accidentally
hitting stop instead of pause must never lose timing data.

### Windows

- **Compact window** — small, frameless, draggable, `alwaysOnTop: true`. Shows
  the task label and the countdown. A setting toggles the progress visual
  between a **bar** and a **circular ring** (like the Windows Clock app).
  The ring defaults to the project's colour, and **the colour is user-editable
  in settings** — the default is a starting point, not a constraint.
- **Dashboard window** — normal window with analytics and session history.

**The compact window appears in timelapse videos the user posts to social
media.** Its visual design is a functional requirement, not polish. It should
look good on camera: clean typography, a genuinely attractive ring, no visual
debris. When trading off between information density and looking good, lean
toward looking good — the user can open the dashboard for detail.

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

- `projects` — id, name, color, archived. The category (`HW`, `Startup`, `Job`).
  A real row, not a string, so renaming fixes history and drift cannot recur.
- `tags` — id, name, project_id (nullable). The optional second dimension,
  chiefly course codes such as `WRIT 0580`.
- `presets` — saved session durations and saved pace-loop intervals.
- `sessions` — id, project_id, tag_id (nullable), task (free text), started_at,
  ended_at, planned_duration_s, **running_duration_s** (excludes paused time),
  stop_reason, work_quantity, work_unit, unquantifiable, notes,
  pace_target_qty, pace_target_interval_s, source (`app` | `import`)
- `pauses` — session_id, paused_at, resumed_at. Makes `running_duration_s`
  auditable rather than a number nobody can check.

`stop_reason` is a small set the user defined from their own behaviour:
`finished_early`, `tired`, `interrupted`, a free-text `other` for cases none of
them fit, plus null when they skip it. Free text lives in `stop_reason_note`, so
it stays queryable as a reason rather than disappearing into `notes`. It is
**optional and one click** — roughly 75% of sessions end early, so a mandatory
prompt would fire almost every time and the logging would stop happening.

There is deliberately **no `completed` boolean**. Stopping early is usually
success (work finished faster) or good judgement (fatigue, returning fresh), and
a boolean would render a 16% "completion rate" that reads as failure and means
nothing. `planned_duration_s` and `running_duration_s` are facts; the
interpretation belongs to `stop_reason` or to nobody.

There is **no `focus_rating`** — cut at the user's request. Work quantity per
minute is already an objective efficiency signal, and notes carry the rest.

There is **no `rest_days` table**. Days with no work are simply days with no
sessions; averages run over calendar days in the range, not active days only.
The spreadsheet's `N/A` marks existed only to satisfy conditional formatting.

There are **no terms or semesters**. Rolling windows only.

Derived, never stored: rate (`work_quantity / running minutes`), streaks,
working stretches (from wall-clock gaps), totals.

### Labeling must be fast

The user labels every session and it costs roughly 30 seconds each — about
19 hours over the 2,336 historical sessions. Reducing that is a real feature,
not a nicety.

Sessions are labeled **before** starting, with a predicted default: the most
likely project and tag given time of day, weekday, and recent history. This is
a frequency lookup over the user's own data, **not a model**. Every field stays
editable, dropdowns are keyboard-navigable, and the previous session's labels
carry over. Prediction is cold at first, since imported rows have no clock times
to learn from.

Timestamps are ISO 8601 UTC strings. Durations are integer seconds. Imported
rows have real durations but **null `started_at`/`ended_at`**, since countdown
readings cannot become clock times. Every query must handle that.

### Rates are only comparable within a unit

Words per minute and questions per minute are different quantities. **Never
chart, average, or trend them together.** Any rate comparison is scoped to a
single `work_unit`, and the UI must say which unit it is showing.

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
