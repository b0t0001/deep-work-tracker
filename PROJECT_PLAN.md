# Deep Work Tracker — Project Plan

**Goal:** replace the manual timer + spreadsheet workflow with a desktop app
that logs sessions automatically, labels what was worked on, and makes analytics
easy to extend.

**Decisions locked in:**

| Decision | Choice | Why |
|---|---|---|
| Platform | Electron desktop app | Only option that supports always-on-top and accurate background timing |
| Storage | Local SQLite file | Private, no signup, already backed up via OneDrive |
| Spreadsheet history | Import it | Keeps trends meaningful from day one |
| LLM insights | Deferred | Prove the data layer first; schema is designed to support it later |

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

This phase is the whole risk of the project. If the timer is worse than the old
one, nothing else matters.

- Compact frameless window, `alwaysOnTop: true`, draggable by its body
- Start / pause / resume / stop
- Timer authority lives in the main process, driven by a target end timestamp
  (never a decrementing counter — see CLAUDE.md)
- **Looping presets:** duration and number of loops (or run until stopped).
  Ship 60 and 90 min as defaults; duration must be freely settable (the data
  shows 12+ distinct durations in use).
- **On reaching 0:00:00, notify and immediately start the next block** of the
  same length, matching Hourglass's loop. No break interval in between — breaks
  are not tracked (decided 2026-09-19). Each repeat is its own `sessions` row.
  Looping must stay accurate over long unattended runs.
- **Starting the next timer must be near-instant.** A typical sitting is three
  or four separate timers (20 min writing, 30 min a small task, the rest on CS),
  each its own run. Project and tag should carry over from the previous session
  by default so a new timer is one keystroke, not a form.
- **Stopping early is the normal case, not an exception.** 72-84% of recent runs
  were stopped before expiry. Stopping must be one obvious control, and the run
  records `planned` and `actual` separately.
- **Pace target (optional):** "100 words per 20 min". You set a target rate and
  update your count as you go; the timer shows ahead or behind against it.
  **Informational only — it must never interrupt, prompt, or alert**
  (decided 2026-09-19). It is a readout, not a second timer.
- Desktop notification + sound on each interval boundary
- System tray icon showing remaining time; click to show/hide
- Survives laptop sleep with correct elapsed time

**Done when:** the app can replace the current timer for a full work day, even
though it is not yet saving anything.

**Watch out for:** sleep/resume, multi-monitor placement, and the window
reappearing on top after other apps steal focus.

---

## Phase 2 — Persistence and labeling

Now make it worth more than the old timer.

- SQLite via `better-sqlite3`, numbered migrations applied at startup
- Schema per CLAUDE.md: `projects`, `presets`, `cycles`, `sessions`
- Every completed interval writes a `sessions` row automatically
- Distinguish sessions that ran to term from ones stopped early
- Pick a project + type a task label before (or during) a session
- **Capture work done on every segment: quantity + unit** ("19 problems",
  "126 words"), and show the derived rate. 97% of historical segments have this,
  so the prompt must be fast — remember the last unit used per task and default
  to it. Allow an explicit "unquantifiable" value.
- Optional end-of-session prompt: focus rating 1–5, notes
- Session history list: view, edit, delete, and **manually add a past session**
  (for work done away from the computer)

**Done when:** a full day of work is captured with zero manual transcription.

---

## Phase 3 — Spreadsheet import

The CSV has been analyzed; the mapping is known. 2,336 segments across 1,782
blocks, 2,545 hours, 2023-03-27 to 2026-09-19.

| CSV column | Destination |
|---|---|
| `Date` | `sessions` date (M/D/YY). No clock time exists, so `started_at` stays null. |
| `Block` | strip the trailing number, map to `projects.name` (`HW 2` -> HW). The ordinal is discarded — it carries no meaning. |
| `Tasks` | `sessions.task` |
| `Start` | `planned_duration_s` — what the timer was set to |
| `End` | remaining when stopped; `actual_duration_s = start - end`, `completed = (end == 0)` |
| `Total Time (hours)` | verification only — recompute, then assert it matches |
| `Work Done` | parse into `work_quantity` + `work_unit`; `unquantifiable` -> flag |
| `Efficiency` | discard — recomputed from quantity and duration |
| `Notes` | `sessions.notes` (253 rows) |
| `Task List` | discard — a one-off header note, not row data |

- Normalize unit plurals (question/questions, video/videos, component/components)
- **Consolidate drifted category names** before import: `College Apps` /
  `College Applications` / `College` / `Applications` are one project, as are
  `Study for APs` / `Study AP` and `Internship` / `Internships`. 68 raw
  categories should collapse to roughly 15. Confirm the mapping with the user.
- Rows with `Block = N/A` (376) become `rest_days`, not zero-hour sessions
- Skip the ~325 empty future-dated scaffold rows
- Imported rows get `source = 'import'` and null wall-clock times
- Dry-run preview before committing; then assert total imported hours = 2,544.8

## Phase 4 — Analytics dashboard

The reason for leaving the spreadsheet. All trend math lives in tested pure
functions under `src/shared/`, so new metrics are cheap to add.

- Totals: today, this week, this month, all time
- Weekly trend line with comparison to the previous period
- **Time-of-day heatmap** — when during the day focus actually happens.
  **App-recorded sessions only.** The imported history has no clock times, so
  this chart must state its date range and never silently include imported rows.
- Day-of-week breakdown
- Hours by project, and by task within a project
- Session length distribution
- **Output and pace:** quantity per unit over time, and rate trends per task
  type (words/min when writing, questions/min when problem-setting). The
  analysis the spreadsheet made hardest and the user most wants.
- Completion rate: how often sessions run to term vs. get cut short
- Focus rating over time
- Streaks and daily goal tracking
- CSV export (so the data is never trapped in this app)

**Done when:** every number the spreadsheet produced is reproduced, plus at
least three insights the spreadsheet never showed.

---

## Phase 5 — Polish and packaging

- Settings: default presets, daily goal, notification sound, launch on startup
- Light/dark theme
- Keyboard shortcuts, including a global hotkey for start/stop
- Automatic database backup to a dated file
- Package a Windows installer with `electron-builder`

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

## Note on OneDrive

This folder is under OneDrive. Once `node_modules` exists (~50,000 files for
Electron), OneDrive will sync-thrash and may lock files mid-build. Recommended:
move the project to a non-synced path such as `C:/Users/jamwa/code/` and rely on
GitHub for backup instead. Cheap now, painful after the first install.
