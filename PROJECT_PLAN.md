# Deep Work Tracker — Project Plan

**Goal:** replace the manual timer + spreadsheet workflow with a desktop app
that logs sessions automatically, labels what was worked on, and makes analytics
easy to extend.

**Decisions locked in:**

| Decision            | Choice               | Why                                                                    |
| ------------------- | -------------------- | ---------------------------------------------------------------------- |
| Platform            | Electron desktop app | Only option that supports always-on-top and accurate background timing |
| Storage             | Local SQLite file    | Private, no signup, already backed up via OneDrive                     |
| Spreadsheet history | Import it            | Keeps trends meaningful from day one                                   |
| LLM insights        | Deferred             | Prove the data layer first; schema is designed to support it later     |

**Success test:** after two weeks, the spreadsheet has not been opened once.

---

## Phase 0 — Scaffold

Get an empty Electron window opening reliably before any features exist.

- `npm create @quick-start/electron` with the React + TypeScript template
- Set up ESLint, Prettier, `tsconfig` strict mode
- `git init`, first commit, `.gitignore` covering `node_modules/`, `out/`, `*.db`
- Confirm `npm run dev` opens a window with hot reload

**Done when:** a window opens, edits to the React app appear without restart.

---

## Phase 1 — The timer (the part that must beat the old tool)

This phase is the whole risk of the project. If the timer is worse than
Hourglass, nothing else matters.

**Scope change:** Phase 1 now includes minimal SQLite persistence. Structured
labeling needs projects and tags to exist, and a timer that saves nothing is not
something the user can actually adopt. Phase 1 saves each run with a free-text
label; Phase 2 adds the structure.

**The window**

- Compact, frameless, draggable, `alwaysOnTop: true`
- Task label + countdown
- Setting toggles the progress visual between a **bar** and a **circular ring**
- Accent colour is editable in settings and shared by every window
- **This window is filmed for timelapse videos posted to social media.** Visual
  quality is a requirement, not polish. Clean type, a genuinely good-looking
  ring, no debris. Favour looking good over information density.
- System tray icon with remaining time; click to show/hide

**The session timer**

- Duration typed directly. Preset buttons were removed - they crowded a window
  this small, and Hourglass has none. They return as a settings toggle later.
- Target-timestamp driven, never a decrementing counter (see CLAUDE.md)
- On expiry: notify, then auto-start another run of the same length. Each run is
  its own row. No break interval.
- Survives sleep with correct elapsed time

**The pace loop — a second, independent timer**

- Arbitrary repeating interval (3, 5, 10, 20 min …)
- Expresses a target rate: "100 words per 20 minutes"
- Each loop: **subtle** sound + brief display of the **cumulative target**
  ("target: 300 words" on the third 20-minute loop). Session expiry uses a
  distinctly more prominent sound.
- **Never asks for input.** The user will not log data mid-essay.

**Pause, stop, undo**

- Pause and stop are separate controls with clearly different affordances
- Paused time is excluded from `running_duration_s`; pause intervals recorded
- Only stop ends the session
- Paused beyond the auto-end threshold (default 3 hours, configurable) → end
  automatically, recording time up to the pause
- **Stop is undoable:** 30-second "undo — resume session" banner, and the session
  stays editable in history afterwards
- Optional one-click `stop_reason` on the stop screen: finished early / tired /
  interrupted, plus free text when none fit. Skippable, and skipping is default.
- **Global hotkey for pause/resume.** Writing full-screen, reaching for the
  mouse breaks flow. Pause is the one that must work without leaving the
  document; stop and start-next can wait for Phase 5.

**Status: complete.** Built and verified: always-on-top compact window with ring
and bar dials, an editable clock reading Hourglass's duration formats, looping
with sound and flash, pause distinct from stop with paused time excluded,
auto-end on a long pause, the pace loop, one-click stop reasons, undo, a tray
icon, and every run written to SQLite.

**Done when:** the app replaces Hourglass for a full work day, and every session
that day is in the database with correct durations.

**Watch out for:** sleep/resume, multi-monitor placement, the window reappearing
on top after other apps steal focus, and two timers drifting apart.

## Phase 2 — Persistence and labeling

Now make it worth more than the old timer.

- SQLite via `node:sqlite`, numbered migrations applied at startup
- Schema per CLAUDE.md: `projects`, `tags`, `presets`, `sessions`, `pauses`,
  `app_settings`
- Every completed interval writes a `sessions` row automatically
- `planned_duration_s` vs `running_duration_s` says whether a run went to term.
  There is deliberately no `completed` boolean — see CLAUDE.md.
- Pick a project + type a task label before (or during) a session
- **Capture work done on every segment: quantity + unit** ("19 problems",
  "126 words"), and show the derived rate. 97% of historical segments have this,
  so the prompt must be fast — remember the last unit used per task and default
  to it. Allow an explicit "unquantifiable" value.
- Optional end-of-session prompt: `stop_reason`, notes. No focus rating — cut
  at the user's request.
- Session history list: view, edit, delete. **Every field of every session is
  editable**, reachable from settings and from history — this data informs real
  decisions, so it has to be correctable.
- **Retroactive session entry** for untimed work (a six-hour club meeting
  entered from memory). Marked `source = 'manual'`, and deliberately _not_ the
  default surface when the app opens — the timer is the primary path.

**Status: mostly complete.** Migrations, the full schema, automatic session
writes, the editable history table with add / delete / undo / redo, and
retroactive manual entry are all built. **Outstanding: nothing captures work
quantity at stop time**, so every app-recorded session has a null
`work_quantity`. That is the one thing standing between this phase and done.

**Done when:** a full day of work is captured with zero manual transcription.

---

## Phase 3 — Spreadsheet import

The CSV has been analyzed; the mapping is known. 2,336 segments across 1,782
blocks, 2,545 hours, 2023-03-27 to 2026-09-19.

| CSV column           | Destination                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Date`               | `sessions` date (M/D/YY). No clock time exists, so `started_at` stays null.                                         |
| `Block`              | strip the trailing number, map to `projects.name` (`HW 2` -> HW). The ordinal is discarded — it carries no meaning. |
| `Tasks`              | `sessions.task`                                                                                                     |
| `Start`              | `planned_duration_s` — what the timer was set to                                                                    |
| `End`                | remaining when stopped; `actual_duration_s = start - end`, `completed = (end == 0)`                                 |
| `Total Time (hours)` | verification only — recompute, then assert it matches                                                               |
| `Work Done`          | parse into `work_quantity` + `work_unit`; `unquantifiable` -> flag                                                  |
| `Efficiency`         | discard — recomputed from quantity and duration                                                                     |
| `Notes`              | `sessions.notes` (253 rows)                                                                                         |
| `Task List`          | discard — a one-off header note, not row data                                                                       |

- Normalize unit plurals (question/questions, video/videos, component/components)
- **Consolidate drifted category names** before import: `College Apps` /
  `College Applications` / `College` / `Applications` are one project, as are
  `Study for APs` / `Study AP` and `Internship` / `Internships`. 68 raw
  categories should collapse to roughly 15. Confirm the mapping with the user.
- Rows with `Block = N/A` are skipped entirely. There is no `rest_days` table —
  a day with no work is a day with no sessions.
- Skip empty future-dated scaffold rows
- Imported rows get `source = 'import'` and null wall-clock times
- Dry-run preview before committing

**Status: complete.** 2,362 sessions, 2,577.79 hours, 2023-03-27 to 2026-09-22,
reconciled against the spreadsheet's own total to within its rounding. A blank
`End` is read as a run that reached zero. Re-importing replaces rather than
appends, behind a confirmation. **Project consolidation was never done** — the
import still yields 66 projects where the plan expected ~15.

## Phase 4 — Analytics dashboard

The reason for leaving the spreadsheet. All trend math lives in tested pure
functions under `src/shared/`, so new metrics are cheap to add.

The user's brief was explicit: **make it exciting.** This is a dashboard someone
opens because they want to, not a report. Visual quality counts here too.

Confirmed wanted:

- **Total hours over time** — running totals, this week against last
- **Breakdown by category** — hours across HW, Startup, Job, and whether the
  balance is where they want it
- **Consistency and streaks** — days worked, gaps, current and best streak
- **Calendar heatmap** — contribution-graph style, one cell per day. Explicitly
  requested and should be prominent, not buried.
- **Time-of-day heatmap** — when focus actually happens. **App-recorded sessions
  only**; imported history has no clock times, so this chart must state its date
  range and never silently include imported rows.
- **Rate trends, scoped to one unit at a time.** The user raised this directly:
  work differs so much that rates are often incomparable. Words per minute and
  questions per minute must never be charted, averaged, or trended together, and
  the UI must always say which unit it is showing.
- **Pace target vs actual** — how good the user's own predictions are, now that
  targets are stored
- Working stretches derived from wall-clock gaps (the old "HW 1" grouping,
  inferred instead of typed)
- Session length distribution, planned vs actual
- CSV export, so the data is never trapped in this app

The user expects to add ideas here as they use it. Keep the metric layer easy to
extend — that ease is the entire point of leaving the spreadsheet.

## Phase 5 — Polish and packaging

Partly done already, out of order, because these came up in use.

- ~~Keyboard shortcuts, including a global hotkey for start/stop~~ — done,
  rebindable from the dashboard by pressing the keys
- ~~Automatic database backup to a dated file~~ — done, CSV every 3.5 days,
  eight kept, older ones to the Recycle Bin
- ~~Package a Windows installer with `electron-builder`~~ — done, per-user NSIS
  with a desktop shortcut
- Still open: default presets, daily goal, notification sound, launch on
  startup, light theme, and a folder picker for the backup directory

---

## Deferred — LLM insights

Out of scope for now, by decision. When picked up: send aggregated session
statistics (not raw notes) to the Claude API and render a written weekly review.
Requires an Anthropic API key held in the main process, never the renderer.

The Phase 2 schema already captures what this would need: per-session tags,
focus ratings, completion state, and timestamps.

---

## Open questions

Resolved: the CSV is mapped, presets are 60/90 min (plus many ad-hoc durations),
and the old timer is Hourglass for Windows. Decided 2026-09-19: blocks auto-loop
on expiry, breaks are not recorded, and the pace target is a passive readout.

Still open:

1. **Project seeding:** block categories suggest HW, College Apps,
   Entrepreneurship, SAT, Scioly, Startup, Internship, JPL, Boeing, Job,
   Sprocket. Which are still active?
2. **1,398 distinct task labels** is too many to browse. Autocomplete from
   history is the answer; the `tags` table captures the stable part (course
   codes) while `task` stays free text.

## Note on OneDrive — resolved 2026-09-23

Windows had silently redirected Desktop, Documents and Pictures into OneDrive
via Folder Backup (`SCOOBESilent`), so the project sat inside a synced tree.
All three known folders are now local, `KFMBlockOptIn` is set so it cannot
recur, and the repo lives at `C:\Users\jamwa\Documents\deep-work-tracker`
outside any sync root. Do not move it back: `node_modules` and `dist` are about
a gigabyte across 19,000 files, and OneDrive takes file handles mid-build.

The app's backups deliberately resolve Documents to the local profile folder
even if the redirect ever returns — see CLAUDE.md.
