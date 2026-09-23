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

The app must be _at least as good as the old timer_ at the timer part, or the
user will stop using it. Two non-negotiables carried over from the old tool:

1. **Always-on-top compact window.** The timer must stay visible above other
   applications while working.
2. **Looping.** A preset runs work/break intervals repeatedly until stopped.

## Stack

- **Electron** — required for always-on-top and for accurate background timing.
  Chosen over Tauri because the machine has Node but no Rust toolchain.
- **React + TypeScript + Vite** — renderer UI.
- **electron-vite** — build tooling for main / preload / renderer.
- **`node:sqlite`** — SQLite built into Electron's bundled Node 24
  (`DatabaseSync`), used in the main process. Chosen over better-sqlite3, which
  is a native module: its prebuilt binary targets Node's ABI, not Electron's, so
  it needs a node-gyp rebuild, and that needs Visual Studio Build Tools — the
  multi-gigabyte dependency avoided by not choosing Tauri. `node:sqlite` has the
  same synchronous API shape, ships with the runtime, and cannot break on
  install.
- **Recharts** — analytics charts.

### Why Vite and not Next.js

This gets questioned, so it is recorded here. Next.js is not an alternative to
Vite — Vite is a build tool, Next.js is a framework built around a Node web
server, with its own bundler. The real question is whether this app should have
a server. It should not: there is no network, no URLs, no SEO, and the data is
a SQLite file on the same disk as the UI.

Running Next.js inside Electron has two forms, both worse here:

- **Static export** disables middleware, Server Actions and API routes, and
  Server Components execute at _build time_, so they cannot read live session
  data. All of Next.js's weight, none of its benefits.
- **Standalone mode** boots a real HTTP server inside the desktop app: slower
  startup, port and lifecycle management, harder packaging, and a network hop
  between the UI and a local file.

Structurally, Electron needs three builds with different targets (`main` = Node,
`preload` = sandboxed bridge, `renderer` = browser). electron-vite handles all
three; Next.js has no concept of a main or preload process, so it would have to
run _alongside_ another bundler rather than replace one.

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

### Two independent timers, two windows

The user ran two Hourglass windows at once. The app reproduces that literally.

**1. The session timer** — the countdown for the work session, one per timer
window. On expiry it cues and auto-starts another run of the same length
(Hourglass's loop, on by default). Each run is its own `sessions` row.
No break interval — breaks are not tracked.

A run that reaches zero records **exactly its planned duration**, not the
polling overshoot. Expiry is noticed by a 100 ms tick, so recording elapsed
time would inflate every completed session by up to one tick — and those are
the sessions whose duration is least in doubt.

**2. The pace loop** — a target rate such as "100 words per 20 minutes",
expressed as **its own small circular window** beside the timer it belongs to.
It shows time to the next cue and the cumulative target by then (`300 words` on
the third lap).

Rules that hold it together:

- **It belongs to one timer, not to the app.** A writing sprint and a problem
  set running side by side keep different rates. It is configured from the pace
  button beside start, never from settings.
- **It is a view onto its parent's clock, not a second clock.** Everything it
  shows is derived from the parent's snapshot, so the two cannot drift apart.
- **It counts running time**, so pausing suspends it. A cue at an empty desk is
  worse than no cue.
- **The window exists exactly when a pace loop does.** Clearing the interval
  closes it; closing it clears the interval. There is no separate on/off to
  fall out of step. It closes with its parent and is skipped in the taskbar.
- **It records nothing.** The session it paces is the only row written.
  `pace_target_qty` / `pace_target_interval_s` are stored *on that session*, so
  prediction can later be compared against what actually happened.
- **It never asks for input.** The user will not log data mid-essay. It cues;
  they judge. Quantity is entered once, at stop.

### The pace window's lifetime and state

The pace window is part of a timer, not a window in its own right, and
everything about it follows from that.

- **Its accent is the app's accent.** Every window reads the same stored value
  through the shared `useAccentSync` hook and follows the same storage event, so
  they cannot disagree. Do not give any window its own copy.
- **It dims with its parent** when the session pauses — a paused session is not
  being paced. **Only the ring and the reading fade.** The card *is* the
  window's background, so fading the element itself makes the whole window
  see-through rather than quiet.
- **It ends with the session it was set for.** Looping does not pass through
  idle — expiry starts the next run directly — so a repeating session keeps its
  pace across laps, while stopping, auto-ending, or expiring without loop closes
  it.
- **Closing it is session-aware.** Mid-session, closing dismisses a window
  rather than abandoning the pace — the run is still being paced against it — so
  the values stay and clicking the pace icon brings the same loop back. With
  nothing running there is nothing to return to, so closing means remove it and
  the fields clear. Ending with a session behaves like the first case.
- **Re-arming needs no stored position.** Lap and remaining both derive from
  running time, so a pace switched off and back on lands wherever the session
  has got to — no replayed laps, no restart from zero.
- **Undo brings it back.** The pace a completed run was carrying is kept, and
  undoing the stop restores it with the window. Lap position needs no special
  handling: it derives from running time, which the restored snapshot already
  carries, so it resumes mid-lap rather than from zero.
- **It opens without taking focus** (`showInactive`). It appears as soon as the
  interval parses, which is while the user is still typing it, and activating
  would pull the caret out of the field mid-word.
- **Its close control is always visible**, not hover-only. A control that
  appears only once you happen to hover the right spot is one nobody knows
  exists.

### The pace panel

Opened from the button beside start, never from settings.

- **Opening it applies whatever the fields already hold.** Values left behind by
  a finished session are exactly the case where re-arming should be one click;
  requiring an edit meant retyping a value already on screen.
- **Enter walks the fields** — interval, quantity, unit — then closes the panel
  and focuses the clock, so the next Enter starts the session and its pace
  together. A pace can be set and started without the mouse.
- **The confirm button is a checkmark, not an X.** Settings apply as they are
  typed, so it confirms rather than dismisses.

### Which fields constrain input, and which must not

- **Digits only:** the pace quantity and the auto-end minutes. Both are counts.
- **No digits:** the pace unit. A digit there is always meant for the quantity
  box beside it, so it is dropped rather than rejected — the rest of the word
  still lands.
- **Deliberately unconstrained:** the clock and the pace interval. Both read
  durations like `one hour` and `20 min`, so letters are valid input. Do not
  "fix" these to numeric.

Partial forms stay allowed everywhere — an empty field, and `1.` mid-decimal.
Rejecting those makes a field impossible to clear or type a decimal into, which
is the same bug as the old duration field forcing a `1` back in.

### The two cues must differ in timbre, not volume

Session expiry plays **Hourglass's own beep**, extracted from `BeepNormal` in
its binary's embedded resources (`Hourglass.Properties.Resources`) and bundled
at `renderer/src/assets/sounds/`. The loop therefore sounds exactly as it
always has.

The pace cue is **synthesised**: a short double tick at a much higher pitch.

This is deliberate and must not be "simplified" back to one sound at two
volumes. The same waveform quieter is exactly the confusable case — in a loud
room a quiet beep and a loud beep are the same sound. Different timbre and
rhythm stay distinct however loud the room is.

### The clock is the duration field

There are no preset buttons. They crowded a 250 px window and Hourglass has
none: you type the time into the clock itself and press Enter.

Parsing follows Hourglass's TimeSpanToken, and what the clock displays is
always something you can type back:

| Input | Reads as |
|---|---|
| `90` | 90 minutes — a bare number is minutes |
| `5:30`, `1:30:00` | mm:ss, h:mm:ss |
| `one hour`, `1 HR`, `1hr`, `1h` | 1 hour |
| `onem`, `one min` | 1 minute |
| `1h30m`, `2 hours 15 min` | combined units |
| `twenty five min` | spelled-out numbers, including tens plus ones |
| `half an hour` | fractions and articles |
| `90 sec`, `30s` | seconds |

Enter starts the timer and rewrites the field into canonical form; leaving the
field does the same. While typing, the caption shows how the input was read, so
`one hour` confirms itself as `1:00:00` before it is committed.

**The word matcher uses `(^|[^a-z])`, not `\b`.** Not style: the escape kept
collapsing through the tooling between source and file, leaving a literal
backspace that silently matched nothing. A pattern with no escape in it cannot
fail that way.

### Pause and stop are different actions

This distinction is load-bearing and was missed in the first draft.

- **Pause** — temporary. Bathroom, brief interruption. The session continues
  afterwards. **Paused time is not work time**: `running_duration_s` counts only
  time the clock was actually running, never the wall-clock span from
  `started_at` to `ended_at`. Pause intervals are recorded so this is auditable.
- **Stop** — the session is over. Only stop prompts for work quantity.
- **A session paused longer than the auto-end threshold ends automatically**,
  recording time up to the pause. Default 3 hours, configurable. This exists
  because the user's habit is to pause and close the window rather than stop.
  The threshold is deliberately long: it is a backstop for a pause that was
  forgotten, not a judgement about how long a break may be.

**Stopping must be undoable.** A 30-second "undo — resume session" banner after
stopping, and the session stays editable in history afterwards. Accidentally
hitting stop instead of pause must never lose timing data.

### Windows

Four kinds, from one renderer bundle routed by URL hash.

- **Timer window** — small, frameless, draggable, `alwaysOnTop: true` at
  `screen-saver` level, which is what keeps it above full-screen apps rather
  than merely above normal ones. **Several can be open at once**: each carries
  its own `TimerEngine`, so two timers never touch each other's clock and an
  undo in one cannot reach into another's session. New windows cascade so a
  second is not hidden behind the first.
- **Pace window** — see above. A child of a timer window.
- **Dashboard** — one window, tabs for Settings, Data, Analytics and Import.
- Settings that belong to the *app* (loop, auto-end, shortcuts) apply to every
  open timer and are inherited by later ones. Settings that belong to a *timer*
  (the pace loop) do not.

**Accents are named after stones** — Diamond, Ruby, Sapphire, Turquoise, Jade,
Amber, Moonstone — defined once in `shared/accents.ts` and read by every window
through `useAccentSync`. The hex value is what gets stored, so renaming one
cannot orphan a saved choice.

**Sizing is taken from Hourglass, not guessed.** The user's Hourglass config
runs it at 250x150 — its own minimum — and its XAML caps the timer text at
18 pt (~24 px) with 10 px padding. An earlier attempt rendered a 40 px clock in
a 216 px window, which read as cramped no matter how the spacing was tuned: the
window was never the problem, the type was. Current minimums are 250x136 for
the bar and 250x220 for the ring, which needs more height because a circle is
bounded by the shorter dimension while a bar is not.

**The bar's fill spans the whole window**, edge to edge, as Hourglass paints
it. Inset inside the card's padding it read as a panel with air trapped in it.

**The ring's face box must fit inside the stroke.** The dial is squared so the
circle and its container are the same thing, then the face sits at 66% x 54% —
half-diagonal 0.85r against a clear radius of 0.88r. Sizing the face against
the *dial* instead of the circle is the bug to avoid: the dial is as wide as
the window while the circle is only as wide as the window is tall.

**The timer window appears in timelapse videos the user posts to social media.**
Its visual design is a functional requirement, not polish. Clean typography, a
genuinely attractive ring, no visual debris. When trading off information
density against looking good, lean toward looking good — the dashboard carries
the detail.

### Electron drag regions: check this before adding any control

This has now broken the build three separate times. It is not background
reading — it is a check to run **before** writing the JSX, not a thing to
remember afterwards.

**The rule that keeps being broken:**

> Any interactive element that visually overlaps a draggable surface must be
> the **last sibling** in its container.

Electron resolves overlapping drag regions by **document order, not
`z-index`**. Writing chrome first and content second is the natural reading
order and it is wrong here: the later element wins, so a button declared before
the thing it sits on top of is silently dead. It renders, it highlights in
devtools, it never receives a click and never fires `:hover`.

Every occurrence so far was the same shape — an interactive control added to
the top of a component that overlays the dial:

| What broke | Why |
| --- | --- |
| Ring-mode header never appeared on hover | declared before the dial |
| Ring mode could not be dragged at all | drag zone declared before the dial |
| Pace window's close button did nothing | declared before the ring |

**Before adding a control that overlays a dial, ring or card, ask:**

1. Does it sit on top of a draggable surface? If no, stop — this does not apply.
2. Is it declared **after** that surface in the markup? If not, move it.
3. Does it need `-webkit-app-region: no-drag`? Buttons and inputs get this
   automatically; a plain `div` or the container around them does not.
4. If the visual order now disagrees with the markup order, fix it with flexbox
   `order`, never by moving the element back.

**Two more rules that follow from the same mechanism:**

- **A drag region consumes mouse events at the OS level** — no hover, no
  clicks, no `mousedown`. This is why a full-width clock input once turned the
  middle of the window into a dead band nothing could drag, and why the card
  drops `-webkit-app-region: drag` entirely while a field is focused.
- **`no-drag` nests inside `drag`, but `drag` does not nest inside `no-drag`.**
  Inverting the card to make a floating panel hoverable killed dragging
  outright.

**Symptom-to-cause, since these look like unrelated bugs:**

| Symptom | Cause |
| --- | --- |
| Button visible but clicks do nothing | declared before the draggable surface |
| `:hover` styles never apply | same |
| A region of the window cannot be dragged | a `no-drag` element covers it |
| Dragging stopped everywhere | `drag` nested inside `no-drag` |

### Global shortcuts

Bindings for pause/resume, stop and new-timer, set in the dashboard by pressing
the keys rather than typing an accelerator — nobody should have to know
Electron spells it `CommandOrControl+Shift+Space`. Backspace clears, Escape
cancels.

Registration **fails silently** when another application owns a combination
(and throws on a malformed one), so failures are reported back and shown in
red. A shortcut that quietly does nothing is worse than one you know is taken.

## Source data and its quirks

3.5 years of history exists in a spreadsheet exported to CSV: **2,545 logged
hours, 2,336 timer runs, 889 active days** (2023-03-27 to 2026-09-19), plus 376
days explicitly marked `N/A` as deliberate rest.

The old timer is **Hourglass** for Windows — a _countdown_ timer with loop and
always-on-top. `Start` and `End` in the CSV are **time remaining on the
countdown, not wall-clock time**. Every one of the 2,336 rows has `end < start`,
and `|start - end|` matches the recorded hours exactly.

**A blank `End` means the countdown reached 0:00:00** — the sheet leaves it
empty when a run went to term and computes the duration from `Start` alone. Its
own Total Time column agrees on all 19 such rows. Reading a blank End as
missing data instead discards 19 real sessions and 23 hours. A row with neither
reading is genuinely untimed and gets no row: an absence of timing is not a
zero-length session.

**Consequence: the historical data contains no time-of-day information.**
Time-of-day analytics can only ever cover sessions recorded by this app. Never
present a time-of-day chart that silently includes imported rows.

### One row is one timer run

Each CSV row is an independent timer set to a round duration and usually stopped
before it expired. Verified:

- **97% of 2025-2026 rows start at a round duration** (a multiple of 5 minutes)
  — that value is what the timer was _set to_.
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

Grouping consecutive runs into a working stretch is a _derived_ analytic,
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
- `presets` — saved session durations and pace-loop intervals. **Unused so
  far**: preset buttons were removed from the timer and return only as a
  settings toggle if asked for. The table exists for that.
- `sessions` — id, project_id, tag_id (nullable), task (free text),
  **session_date**, started_at, ended_at, planned_duration_s,
  **running_duration_s** (excludes paused time), stop_reason, stop_reason_note,
  work_quantity, work_unit, unquantifiable, notes, pace_target_qty,
  pace_target_interval_s, source (`app` | `manual` | `import`)

`session_date` is the local calendar date, separate from `started_at`.
Imported rows know their date but not their time of day, so without it the date
would have been lost and every trend with it. It is the local date rather than
UTC because a session at 11pm belongs to that day as lived, which is how daily
totals and streaks are read.
- `pauses` — session_id, paused_at, resumed_at. Makes `running_duration_s`
  auditable rather than a number nobody can check.

**Every finished run flows through one path.** Stopped by hand, expired, or
auto-ended, each emits `completed` and is recorded in the same place, so no
path can silently fail to record. That is also what makes undo possible: the
last completed run is held per timer window, and undoing deletes the row and
restores the timing exactly rather than making it be re-entered.

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

### Manual entry and editing

Two separate needs, both required.

**Every field of every session is editable from the UI**, reachable from
settings and from the session history. The user's words: this data informs real
decisions, so being unable to correct it is disqualifying. Edits are applied to
the row in place; no shadow "corrected" copy.

**Sessions can be created retroactively.** Not everything is timed — a six-hour
club meeting (Penn Electric Racing) is entered afterwards from memory. These get
`source = 'manual'`.

**Manual entry must not be the default surface.** Opening the app presents the
timer; retroactive entry is deliberately one step further in. The timer is the
primary path and must stay uncluttered.

`source` matters analytically. Manual rows carry approximate times, usually no
work quantity, and no pace data. **Time-of-day analytics should weight or
exclude them** — a remembered "about six hours" is not evidence about when focus
happens. Charts must never silently mix precise and remembered timings.

### Browsing the data

The table holds thousands of rows, so it is filtered and paged rather than
capped. A fixed cap is the failure mode to avoid: it silently hides the rest
and leaves no way to reach it.

**The default view is the 100 most recent sessions**, newest first, no filters.
That is the question the tab is opened to answer — what have I been doing
lately — so it must be what you land on without touching a control.

Filters, all applied in SQL rather than by slicing an array in the renderer:

- **Search** over task *or* project name, debounced 200 ms. Both, because the
  two are used interchangeably when looking for something: "the essay" is a
  task, "College Apps" is a project, and nobody remembers which one a given
  label ended up in. `%` and `_` in the box are escaped so they stay literal.
- **Project**, listed most-used first and only for projects that have sessions.
  The import leaves 66, most of them a handful of rows from years ago;
  alphabetical would bury the nine that carry the recent history.
- **Source** — Any / Timed / Manual / Imported. `source` already drives which
  rows analytics may use, so being able to see each set is how that gets
  checked.
- **Date range**, as From/To plus 7 days / 30 days / 90 days / 12 months.
- **Rows per page** — 100 / 250 / 1000 / All, with Previous and Next.

Rules that hold it together:

- **Totals cover the filter, not the page.** `querySessions` returns the row
  count and summed hours for the whole filter, so turning a page cannot change
  the figure in the header.
- **"All" is a real option.** A null limit means no limit — SQLite reads a
  negative `LIMIT` as unbounded.
- **The pager sits above the table**, because "All" runs to thousands of rows
  and a control below that is one nobody reaches.
- **Any change to a filter or page size returns to page one.** Staying on page
  14 of a filter that now has three shows an empty table.
- **A date filter excludes undated rows rather than guessing.**
  `session_date` arrived in a later migration, so rows can be null. Comparing
  those through `COALESCE` sorts them before every real date, which means an
  open-ended `to` sweeps them in while a `from` drops them — the same row
  appearing or vanishing depending on which end of the range was typed. They
  show only when nothing is filtered.
- **Date inputs need `color-scheme: dark`.** Chromium otherwise paints the
  native calendar glyph for a light page: a black icon on a near-black field.

**Deleting an imported row asks twice.** Imported rows are 3.5 years the app
did not record, sitting in the same table as a session from ten minutes ago
with the same Delete button beside them — the only place where a misclick costs
something this app cannot reconstruct. App-recorded and manual rows keep the
single confirmation; a second dialog on every delete would train the reflex
that makes both meaningless.

**The import must report its failures.** `commit()` once had no `catch`, so a
rejected invoke left the button disabled forever and said nothing — the import
never ran, the Data tab stayed empty, and nothing on screen connected the two.
The button also sat below the full projects table, which at 66 projects is a
scroll long enough that choosing a file looks like the whole interaction. Any
destructive or long-running action in the dashboard needs both: a visible
trigger and a visible failure.

### Automatic backups

`main/backup.ts` writes the whole history to a CSV twice a week. Settings shows
the folder, the schedule and what is currently kept.

- **Twice a week is an interval, not two named days.** A "Monday and Thursday"
  schedule needs the app running on Monday and Thursday. Every 3.5 days only
  needs it running at some point in between, which is how the app is used. It
  is checked ten seconds after launch and every six hours after that, so a
  backup that came due while the app was closed happens at the next launch
  rather than being skipped.
- **The schedule is derived from the files, not from remembered state.** "Is
  the newest backup older than 3.5 days?" cannot drift out of step with what is
  on disk, and needs nothing persisted — which matters, because app settings
  are currently in memory only and do not survive a restart.
- **They live in `Documents/Deep Work Tracker/Backups`, not in userData.**
  userData is where the database already is, so a copy beside it survives
  neither an uninstall nor a wiped profile — the two cases a backup exists for.
- **One file restores everything.** Projects and tags are written as names
  rather than ids, because ids mean nothing without the tables that define
  them, and pauses are packed into one column as `paused|resumed` pairs
  separated by semicolons. A backup needing three files is a backup with three
  ways to go missing.
- **Eight are kept, and the rest go to the Recycle Bin.** `shell.trashItem`,
  not `unlink` — deleting outright means a bug in the retention rule destroys
  data silently, while the bin holds them for 30 days. Only files matching
  `deep-work-backup-YYYY-MM-DD-HHMM.csv` are ever listed or pruned, so anything
  else in that folder is left alone.
- **An empty database is not backed up.** Eight slots at 3.5 days is a month of
  history; filling one with a snapshot of nothing pushes a real one out.

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

The timer engine is exercised directly in the meantime — see
**Working practices**.

`npm run dist` produces an installer; it does not update the installed app.
See **Working practices**.

`package.json` carries an `allowScripts` field. npm 11 blocks install scripts
by default, and Electron's postinstall is what downloads the 246 MB binary —
without the approval a fresh `npm install` silently yields an app that cannot
start. If that happens, run `node node_modules/electron/install.js`.

## Conventions

- TypeScript strict mode. No `any` without a comment justifying it.
- Functional React components with hooks. No class components.
- Database migrations are numbered entries in `main/db/migrations.ts`, applied
  in order at startup and recorded in `schema_migrations`. Never edit a
  migration that has already run; add a new one.
- Keep business logic (streaks, totals, trend math) in plain testable functions
  under `src/shared/`, not inside components.

## Working practices

Three things learned by getting them wrong here, not general advice:

**Work on a branch, never commit straight to `main`.** Eight commits went onto
`main` directly before this was noticed, which also cost the user the
added/removed line counter in the desktop app — it measures a branch against its
base, and on `main` there is no base to measure against. Branch before starting
a piece of work.

**`npm run dist` does not update the installed app.** The copy under
`AppData\Local\Programs\deep-work-tracker` is a snapshot taken at build time
with no link to the source. Changes reach it only by rebuilding *and* running
the installer again, which upgrades in place. The user tests from the desktop
icon, so **rebuild and reinstall as part of the change** rather than telling
them to — a day was lost to them looking at a stale build and reporting bugs
that were already fixed.

**Exercise the timer engine rather than assuming it.** Bundling it standalone
and driving it from Node has already caught two real defects that review did
not: completed runs recording the polling overshoot, and every spelled-out
duration silently failing to parse. Anything touching the engine gets a script:

```
npx esbuild src/main/timer.ts --bundle --platform=node --format=esm --outfile=<tmp>/t.mjs
node <tmp>/your-test.mjs
```

**The user does not run git commands.** Branch, commit, push and merge are all
done here, without being asked each time. Give them the result, not the
instructions.

**Editing gotchas that have each cost a wasted turn more than once:**

- **Large heredocs fail.** Writing a long file in one `cat <<'EOF'` block dies
  with `unexpected EOF while looking for matching quote` and writes nothing.
  Split it across two appends, or stage the content in a temp file and splice
  it in with Python. Check the file afterwards — a failed write leaves the
  original untouched, which is easy to mistake for success.
- **Prettier runs after every change, so exact-match patches go stale.** It
  collapses multi-line imports to one line, reflows ternaries, and rewraps JSX.
  A patch written against what was authored will not match what is on disk.
  Re-read the region before patching by exact string.
- **Backslash escapes collapse in transit.** `\b` in a regex has arrived in the
  file as a literal backspace character, which silently matches nothing and
  looks like a logic bug. Prefer patterns with no escape at all — `[^a-z]`
  rather than `\b` — and when one is unavoidable, read the line back and
  confirm what actually landed.

**Sticky table headers need three things, not one.** `position: sticky` alone
looks like it should work and does not: table cells paint in document order, so
rows are drawn over the header without a `z-index`, and `border-collapse:
collapse` gives the border to the table rather than the cell so it scrolls away.
Sticky, a z-index, and `border-collapse: separate` together.

## Working with the user

The user is new to agentic programming but technically capable (Arduino, KiCad,
LabVIEW, a CS course). So:

- Explain _why_ a choice is made, not just what changed. Skip basic programming
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
