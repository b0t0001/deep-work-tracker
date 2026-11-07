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
window. On expiry it cues and starts another lap of the same length
(Hourglass's loop, on by default). No break interval — breaks are not tracked.

**A loop is one session, not one row per lap.** This is the reason the app
exists rather than a hand count, in the user's words. Output is entered once,
at stop, and read as a rate across the whole loop; a row per lap split a
2.35-hour MATH 1410 loop into two rows and pinned the quantity on the last lap
alone. So expiry with loop on does not end the session: the countdown restarts,
and running time, pauses and the pace loop carry straight on. The row records
`laps` (laps begun, so stopping ten minutes into lap two is two).

**`planned_duration_s` is one lap - what the timer was set to - never laps ×
lap.** It was laps × lap for a day, and the user caught what that hid: two
45-minute laps showed "1.5 h planned, 1.16 h run", which reads as a goal met
early, when the goal was 45 minutes and the work took 70. Planned means what
the timer was set to on every other row (an imported row's Start is exactly
that), so a loop is the same setting gone round more than once. Migration 6
divided the looped rows written under the old rule.

**Why planned matters this much:** the user sets these timers *slightly short
on purpose* - a little less time than the work seems to need, to rush
themselves. So the number worth keeping is the goal they set, readable on its
own against what it actually took. The Data tab therefore shows **Planned**
(the goal), **Laps**, **Total** (planned × laps, derived, never stored) and
**Actual** as separate columns, and the add/edit form takes Planned and Laps
and shows the total as it is typed. A loop therefore runs past 100% of
planned, and "Are your timers the right length?" raises its ceiling above 100%
when a length's runs average past it rather than clipping the overrun.

**A loop is saved at every lap**, then finished at stop. The engine emits
`lap`; main writes the row on the first and updates the same row after
(`loopSessionId` on the timer instance), and stop finishes it rather than
writing a second. A loop written only at stop would be lost whole to a crash
in its fifth hour. An update writes only what the timer knows - timing, laps,
pauses, project, task, pace - never the stop prompt's quantity or reason, and a
row deleted mid-loop is written afresh rather than the loop being dropped.

Each lap ends on **exactly its planned length**, not the polling overshoot.
Expiry is noticed by a 100 ms tick, so the next lap starts at the instant the
last one ran out, and the overshoot belongs to it rather than being counted
twice or lost. A loop switched off mid-lap ends when that lap reaches zero.
`scripts/loop-check.ts` drives the engine through all of this with a fake
clock; `scripts/loop-record-check.ts` covers the row, the migration and the
backup round trip.

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
field does the same, which is the whole of the feedback. There was once a grey
echo under the clock showing how the input had been read - it was removed as
noise, because the field rewriting itself says the same thing in the place you
are already looking.

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
- **Stop** — the session is over, and the only point that asks for anything.
  The strip that appears offers Undo, a quantity and unit, and the one-click
  reasons. The unit arrives pre-filled from the last one this task was measured
  in, falling back to the most recent unit used at all, so the common case is
  typing one number. Both fields write as they are typed rather than behind a
  confirm button, and **touching either cancels the 30-second auto-dismiss** —
  a prompt that vanishes mid-word is one you stop bothering with.
- **A session paused longer than the auto-end threshold ends automatically**,
  recording time up to the pause. Default 3 hours, configurable. This exists
  because the user's habit is to pause and close the window rather than stop.
  The threshold is deliberately long: it is a backstop for a pause that was
  forgotten, not a judgement about how long a break may be.

**Stopping must be undoable.** A 30-second "undo — resume session" banner after
stopping, and the session stays editable in history afterwards. Accidentally
hitting stop instead of pause must never lose timing data.

### The app speaks for itself

**Information, validation and failures are shown in the app's own UI, never
in a Windows dialog.** The user's rule, 11/06/2026: *"i don't want windows
popups to convey the information, the app should display it itself"* - a
native message box breaks the app's look and reads as a different program
interrupting. A form marks the field and writes a red line under its
buttons; a tab that cannot load says so in place, with Try again; a save that
fails says why beside the button that was pressed. `ui:alert` was removed
rather than left for the next convenient use.

The exception is a failure with no window to speak in: startup steps that
fail before any window exists, and the damaged-database warning at launch,
still use a native dialog, because the alternative is saying nothing.
Confirmations of destructive actions (delete, restore, replace an import)
are still native `ui:confirm` dialogs - see Known gaps.

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

**The accent has an opposite, and it is computed.** *"in the data tab, I
want the color of the text that says manual to be whatever the opposite of
the current accent color is."* `complementAccent` in `shared/accents.ts` turns
the hue 180° and keeps the saturation (Diamond gives orange, Ruby cyan, Jade
magenta), lifted to a lightness of at least 0.65 because straight rotation
failed contrast for Turquoise and Jade; Moonstone, which has no hue, gets the
app's text white, as the user asked. `useAccentSync` sets `--accent` and
`--accent-complement` together, so every window follows a change live. Only
the `manual` source badge uses it. `scripts/accents-check.ts` asserts the
relationship.

**The dashboard mounts `useAccentSync` once, at its root.** It used to set
`--accent` itself and mount the hook only inside Analytics, so on every other
tab there was an accent and no complement until Analytics had been opened,
and the manual badge fell back to white. That is exactly the drift the
one-hook rule exists to prevent: no window or tab sets `--accent` on its own.

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

### The timer window's chrome

Everything here was arrived at by iteration and is easy to undo by accident.

- **Fullscreen exists for projecting the clock onto a big screen**, not for
  everyday use. While fullscreen, switching between ring and bar is ignored -
  the variant carries a minimum size, and applying one to a fullscreen window
  resizes it out of fullscreen.
- **Each dial has its own minimum, and switching carries the window with it.**
  A window sitting *at* the old minimum snaps to the new one, which is what
  makes the ring shrink back on the way to bar. A size the user chose
  deliberately is left alone unless it is now below the new minimum. The test is
  `width <= minimum.width + 2`, not equality, because the OS rounds.
- **Minimize and close live on the timer window itself.** It is frameless, so
  without them there is no way to get rid of it but the tray.
- **Chrome is hover-revealed in both modes.** The header tools and the
  pause/stop controls fade in on hover and are otherwise invisible, because the
  window is filmed. In ring mode the title is suppressed entirely while the
  controls are showing - there is no room for both, and overlapping them was
  the bug that took the longest to settle.
- **The dial is declared before the chrome and reordered with flexbox.** This
  is a drag-region consequence, not a styling preference. See below.

### Closing a timer mid-session: recorded, and saved for later

Until 2026-11-06, closing a timer window or quitting the app disposed the
engine **without recording anything** - so a session paused and closed, which
is the user's stated habit, was simply lost. Hourglass never did that: a
running timer that is closed goes into its **Saved timers** list (ten, in the
right-click and tray menus, with Open all and Clear) and can be reopened where
it left off.

This app now does the same, with the session recorded first:

- **Closing pauses, records, then saves.** The window's `close` event (which
  quitting also fires, for every window) and Windows' `session-end` call
  `saveRunning()` in `main/savedTimers.ts`. Running is paused first, because
  time spent closed is not work. The row is written - or updated, for a loop
  or a timer that was itself reopened - and an entry pointing at it goes on
  the list. A timer that is idle or already finished saves nothing.
- **Reopening carries on in the same row.** `reopenSaved()` restores the
  timer paused, with its pace, and the window keeps the row id, so stopping
  it later finishes that session rather than starting another. The stretch it
  spent closed is the pause that closing opened, so it is recorded and never
  counted. The window takes its project and task from the restored session
  rather than pushing the last-used project over it.
- **The list is a shortcut, not the record.** Ten entries, newest first,
  stored as JSON in `app_settings` so a timer saved by quitting is there after
  the next launch. Clearing it, or an entry falling off the end, never touches
  a recorded session. A damaged value reads as an empty list.
- **Right-click works everywhere on the timer.** Most of the window is a
  drag region, where a right-click is the OS caption menu rather than a page
  event, so `system-context-menu` is answered with the same menu as
  `context-menu`.

`scripts/saved-timers-check.ts` (24) covers the logic on a copy; a run of the
real built app over CDP confirmed that closing the window records the row and
lists it.

### The tray

One icon for the whole app, not one per timer.

- **Its tooltip is every running timer**, joined - `25:00 running | 04:12
  paused` - so two timers can be read without focusing either.
- **Clicking it hides or shows all timers at once**, choosing by whether *any*
  is currently hidden, so one click always resolves a mixed state.
- The menu covers New timer, Show timers, Settings and data, and Quit.

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

**Consolidated to 36 projects on 2026-09-23**, from 66, with the session count
and the hour total unchanged — every merge was a rename, nothing was dropped.
The map lives in `PROJECT_ALIASES` in `main/import/csv.ts` with the reasoning
beside it. Most of the tail was mechanical: a `Block N:` prefix, a digit stuck
on with no space (the ordinal stripper only catches ` 1`), and two typos. The
judgement calls were put to the user rather than guessed — Entrepreneurship and
Startup stay separate, every application-shaped project stays distinct, summer
homework is homework, and `Tutor` joins `Job` while `Work` does not, because
Work's tasks are a valedictorian speech and thank-you cards rather than a job.

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

`sessions` is the atomic unit: **one row per session**, where a loop of
several laps is one session. Everything else is
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
  pace_target_interval_s, source (`app` | `manual` | `import` | `test`),
  **laps** (1 for a single run; planned covers every lap)

`test` is what any unpackaged build writes (`app.isPackaged === false`), so a
row written by `npm run dev` or a harness is marked automatically rather than
found later. It renders as an orange TEST badge in the Data tab, has its own
Source filter option, and is excluded from every analytics query. Added
2026-11-05 after five rows written by testing sessions had to be deleted from
the real history.

This includes `npm run preview`: what is recorded there is `test`, and is
deleted with the preview's copy when it closes - see "The preview is
read-only".

`session_date` is the local calendar date, separate from `started_at`.
Imported rows know their date but not their time of day, so without it the date
would have been lost and every trend with it. It is the local date rather than
UTC because a session at 11pm belongs to that day as lived, which is how daily
totals and streaks are read.
- `pauses` — session_id, paused_at, resumed_at. Makes `running_duration_s`
  auditable rather than a number nobody can check.
- `app_settings` — key/value text, added in migration 3. Everything else the
  app calls a setting lives in a plain object in the main process and resets on
  close, which is fine for a toggle the user can see and flip again. It is not
  fine for anything the app acts on unattended: forgetting the backup folder
  means the next unattended backup goes somewhere else in silence.

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

**A session entered by hand requires date, project, task, planned, laps and
actual; output is optional.** Required fields carry an asterisk. A missing or
unreadable field is outlined in red and named in a red line under the
buttons, and nothing is written - never a Windows dialog (see "The app speaks
for itself"). Text that cannot be read as a duration is reported as
unreadable rather than missing. Laps defaults to 1. The rule is `shared/sessionForm.ts`, applied by the form
and again by main's `sessions:create`, so a write that skipped the form is
refused too. Edits keep the smaller rule (date and actual) because imported
rows without a project must stay fixable one field at a time.

This came from a session that silently went unsaved on 11/05/2026. Three
things combined, each now fixed: the page showed **two** blue "Add session"
buttons while the form was open and the bigger toolbar one only opens the
form, so clicking it with a filled form did nothing (it is now hidden while
the form is open); the empty Project field showed a grey `HW` placeholder that
read as a value (placeholders now say `required` / `optional`); and `save()`
had no `catch`, so a rejected write vanished (it now says so in a popup and
keeps what was typed). The form's button is never disabled - a disabled
button with a grey line beside it is the failure being fixed.
`scripts/shoot.ts --only probe-add-missing-project,probe-add-unreadable,probe-add-complete-enter`
shows all three paths.

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
- **Rows per page** — 100 / 250 / 1000 / All, as a dropdown.

Project is a column in the table as well as a filter. Task alone does not say
which category a session belonged to, and that is usually the question.

**Source and rows-per-page are dropdowns, not segmented buttons.** Four buttons
spend a row's worth of width to say one word each, and the selected one takes
the accent fill - which made a filter state the loudest thing on the page,
louder than Add session. The date presets stay as buttons because they are
one-tap shortcuts rather than a persistent selection.

**The pager is two arrows and `5 / 24`, kept small and on the left**, with
Undo / Redo / Add session on the right of the same row. It reports a position;
it should not look like the primary action of the page. Between the dropdowns
and this, the controls went from five full-width rows to three.

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

Three layout faults that each looked like something else, all found by
screenshotting the real dashboard rather than reading the markup:

| Symptom | Cause |
| --- | --- |
| Every row twice as tall as it needs to be | `2026-02-20` wrapping; the date column needs `nowrap` |
| Table cramped beside a third of an empty window | `.panel` capped at 900px, a reading width; the Data tab opted into `.panel--wide` at 1500px. Both caps are gone now — see **Width belongs to prose, not to panels** |
| A dead gap between the numeric columns | they were absorbing the spare width; give it to Task with `width: 100%` |

Giving Task the slack then squeezes the numeric columns into wrapping
`1.5 question` over two lines, which undoes the height saving - so `.num` is
`nowrap` too. Fixing one of these without the others makes the table worse.

**Deleting an imported row asks twice.** Imported rows are 3.5 years the app
did not record, sitting in the same table as a session from ten minutes ago
with the same Delete button beside them — the only place where a misclick costs
something this app cannot reconstruct. App-recorded and manual rows keep the
single confirmation; a second dialog on every delete would train the reflex
that makes both meaningless.

**Replacing an import is confirmed; a first import is not.** Replace deletes
every imported row before writing the new ones, which is the largest
destructive action in the app and the only one hiding behind a button labelled
as an import. A first import has nothing to lose, so it goes straight through.

**The import must report its failures.** `commit()` once had no `catch`, so a
rejected invoke left the button disabled forever and said nothing — the import
never ran, the Data tab stayed empty, and nothing on screen connected the two.
The button also sat below the full projects table, which at 66 projects is a
scroll long enough that choosing a file looks like the whole interaction. Any
destructive or long-running action in the dashboard needs both: a visible
trigger and a visible failure.

### The Analytics tab

**Every panel carries its own range, and there is no central one.** There was
one `Averages over` picker at the top of the tab, shared by the figure row and
every panel below it, on the argument that one definition of "the past 8
weeks" cannot disagree with itself. The user rejected it in those terms:
*"you're misunderstanding the spec. every single PANEL needs to have a
timescale control dropdown somewhere that will change how the data is viewed!
it shouldn't be one central control"*. They are right that two things were
conflated. What the shared picker was protecting is that the same words cover
the same days everywhere, and that still holds — every control reads `WINDOWS`
and resolves through `windowRange` in `shared/windows.ts`. Only the *choice* is
local.

- **A choice is stored per target, sparsely**, in the same `app_settings` row
  as the layout (`Layout.ranges`). Sparse, so a target nobody has touched
  follows its default if the default ever changes — the same argument as
  appending an unknown panel rather than treating a stored order as the
  complete list.
- **Two tiles in the figure row deliberately have none.** The baseline tile
  compares the first year against the last and both ends have to be fixed for
  that to mean anything; wired to a control it read +321% on one setting and
  +295% on another, the same claim with two numbers. (The baseline tile has
  since gained a one-ended control, below; the insights card follows its own
  range in full, because every insight is built from dated sessions.) A
  dropdown that cannot change the figure beside it is worse than no dropdown.
- **Narrowing has two shapes, and `shared/ranges.ts` exists because of it.**
  An aggregate that still carries dates — `daily`, `ratesByUnit`, `pace` — is
  filtered in the renderer. Three others had already thrown their dates away:
  `SUM(hours) GROUP BY project` over the whole history has no "past week"
  hiding inside it. So the main process sends those three again grouped by day
  (`projectDays`, `hourDays`, `plannedRuns`) and they are re-totalled per
  range. A panel must not have to know which shape it was handed.
- **`bucketMinutes` is shared with the main process** for the same reason: the
  renderer re-buckets the planned-length chart per range, and two copies of
  the thresholds would drift — with the drift looking like the range control
  changing the shape of the chart.
- **`all` means no filter, not `windowRange('all')`.** Every window ends on the
  **last complete day**, which is right for an average and wrong for a
  calendar — it would leave today's square unfilled on a grid whose whole job
  is to show that today is filled.

**A rate is only comparable within one unit AND one subject.** The rate panel
was a scatter of every session, and it was unreadable for a reason that was
not about the scatter: *"this graph doesn't tell me anything! i can't read any
data points, are you trying to tell me if im getting more efficient? that
doesn't make sense because right now you would be comparing MATH 1410
questions to CIS 1200 questions"*. The unit rule was already in this file; the
subject half was missing, and without it no movement in the series could mean
anything. There is now a course picker beside the unit picker, the title names
both, and the sessions pool into weekly or monthly bars with the value written
on each - the Hours-by-project format, which the user named as the one they
can read.

- **The bar is the pooled rate**, total quantity over total minutes, not the
  mean of each session's rate. Those are different numbers: a ten-minute
  session at 2 a minute and a two-hour session at 0.5 average to 1.25 one way
  and 0.58 the other, and only the second answers "how many did I get through
  per minute of work".
- **Empty buckets are left out, not drawn as zero.** The hours chart does the
  opposite and is right to - a week with no work really is zero hours. A week
  with no sessions has no *rate*; a bar at zero would read as a collapse in
  pace.
- **Sessions under five minutes and manual sessions are excluded**, and the
  caption says so. A quantity over two minutes is where every
  impossible-looking rate in the history came from, and a manual row's
  minutes are a remembered estimate - which `CLAUDE.md` already says to
  exclude wherever timing is the point.

**`shared/courses.ts` is a stand-in for tags, and should be deleted when tags
are real.** Course codes live in the task text the user already types; `tags`
exists in the schema for exactly this and nothing writes to it. When something
does, this file is replaced by a join, not extended.

The pattern is not the obvious one, and the difference is measured. Over the
2,353 quantified sessions a naive `[A-Za-z]{2,5} ?\d{3,4}` found 24
"courses" and **half were not courses**: `ALYZE 2022` from "Analyze 2022",
`EVIEW 645` from "Princeton Review 645+", `RNELL 100` from "Cornell 100",
`GRADE 2019`, `LANG 2018`, `PRING 2027`, `ST 1600` from a video title. Two
rules remove all of them:

- **The letters must be capitals as typed.** Every real code is written that
  way; every false positive came from an ordinary word. This would need
  revisiting if the user ever typed one in lower case.
- **A number in 1900-2099 is a year, not a course number.** A real course
  numbered in that span would be missed, which against twelve invented
  courses is the right way round - and those sessions still appear under All
  courses.

Only 114 of 2,353 quantified sessions carry a code at all, so **All courses is
the normal case and says plainly that it mixes subjects**. The picker lists
only the courses present in the chosen unit: offering `CIS 1200` while
`words` is selected is an option that selects an empty chart.

**One comparison box, not three readings of one number.** The tab showed
"3.21 h a day over the past week", "3.75 h a day worked in the past week" and
a Stats table whose first row was 3.21 again. The difference was that the
first divided 22.5 hours by 7 calendar days and the second divided the same
22.5 by the 6 days that had work on them - defensible separately, indefensible
together, and the user said so: *"look at how much redundant data there is...
I want ONE general box that i can quickly do comparisons on."* Both tiles and
the whole Stats panel are gone. `CompareBox` asks [Average|Median] hours per
[day|week|month] over [range] and answers with one figure, the same statistic
over the previous period of equal length, and over all time.

- **Only the calendar-day reading survives**, which `CLAUDE.md` had already
  settled: dividing by worked days answers how long a working day is, not how
  much gets done. The percentage moved from -31% to -41% as a result, because
  the worked-day version was comparing 6 days against 7.
- **An option that can only answer "—" is not offered.** `grainsFor` lists
  only the grains a range is long enough to fill, so "hours a month over the
  past week" is not in the menu rather than in the menu printing an em dash.
- **A grain that stops fitting is not forgotten**, only unused. Shortening the
  range falls back to the longest grain that fits and widening it returns to
  what was chosen.
- **All time has no previous period**, so there is no percentage. Comparing it
  against the stretch before the first session would be comparing against
  zero, and "up ∞%" is the loudest possible way to say nothing.
- The baseline tile stays and is **not** a duplicate: the box compares a
  period against the one before it, the baseline compares the present against
  a fixed point three years back, and no setting of the box produces that.

**The baseline tile's range moves one end only.** It had none at first,
because a comparison with both ends moving is not a comparison - wired to the
old shared window it read +321% on "past week" and +295% on "past year", the
same claim with two numbers. That was right about the first year and wrong
about the recent end: those are two different and equally true claims, and
what was missing was a caption saying which. So the first year stays fixed,
the control chooses what is held against it, and the caption names it -
"against your first year · 0.74 h a day then, 2.93 h a day over the past 12
months". Measured across its four windows: +295% over 12 months, +314% over
90 days, +472% over 30 days, +333% over the week, with the `0.74 h then`
unchanged in all four. **All time is not offered**: it contains the first
year, so the tile would be comparing the history partly against itself and
the percentage would fall as the history grew, which reads as getting
worse.

**The fun fact says what was done, not just how much.** *"285 components means
285 components CADded across XYZ sessions... it shouldn't just tell me '285
components.'"* The verb map in `shared/facts.ts` is built from the user's own
history - the distinct `work_unit` values listed by frequency against a copy
of the real database, and for each frequent one a sample of its tasks read -
not from guesses about what the words might mean. That is where `components`
→ CADded comes from: all 49 of its sessions are tasks beginning "CAD".

- **Where the work genuinely goes two ways, the tasks decide.** `page` is the
  case: 63 of them, split between a novel read in Chinese (`Read 三体`,
  `读三体`) and a Bio workbook worked through. `verbFor` counts which kind of
  task dominates rather than taking the first match, so one `Review Answers`
  among sixty written pages does not flip the sentence. The payload carries a
  sample of tasks per unit for this; a unit typed as a phrase (`seconds
  edited`) already contains its verb and is left alone.
- **Never a bare noun.** The fallback is "done".
- **Numbers are exact.** An earlier version wrote "nearly 300k words", which
  reads well and throws away the figure the card exists to show - *"no. big
  numbers should always be exact"*. 292,358, and a fractional quantity keeps
  its real precision with trailing zeros trimmed.
- **The verb map is still where output sentences get their verbs**, now
  read by the insights card below rather than by a fact tile.

**The fun fact became insights.** *"It doesn't just have to be about the total
amount of work. It could also be about the efficiency... The fun fact should
help me make sense of the data. It shouldn't just be raw data... I want you to
basically just have insights."* `shared/insights.ts` builds every statement
the chosen range supports; `components/InsightCard.tsx` shows one at a time,
strongest first, with ‹ › and `3 / 14` to step through them. Each is a figure,
the sentence it completes, and one small line of the numbers it rests on, so
it can be checked rather than trusted.

- **What it says:** the busiest two hours of the day; a typical working day
  (median sessions and hours over days with work, median session length);
  the strongest weekday, or weekends against weekdays when that is the story;
  which course is taking the most time; the share of time one project took;
  the project whose share moved most against the previous period of equal
  length (all time: the past 12 months against the 12 before); pace within
  one unit and one course, latest half of the sessions against the first
  half; how often timers are stopped before they run out and how much of the
  set time a typical run uses; how many laps a looped session runs; the
  longest streak and the current one; the share of calendar days worked and
  the longest break; the biggest day against a typical one; the longest
  session; output per unit with its pace (words as novels, at 90,000 a
  novel); hours as forty-hour work weeks; hours spent editing; and whether
  sessions are getting longer.
- **Every insight has a minimum sample and is skipped below it**, and every
  comparison has a floor below which it is not worth saying - a weekday 3%
  above average is not a strongest day. The numbers are `INSIGHT_MIN`, and
  `scripts/insights-check.ts` tests each insight's arithmetic on a fixture
  worked out by hand and again one step under its threshold, where it must
  not appear. An insight that speaks from too little data looks exactly like
  one that works.
- **Time of day is app-timed rows only**, at least 20 sessions over 5 days,
  and the busiest two hours must hold a quarter of the timed hours. On the
  history as of 11/06/2026 there are two, so it is built and silent - which
  is right, and it will turn itself on.
- **Pace is never compared across units or courses**, only within one of
  each, and pooled (total quantity over total minutes), with manual rows and
  runs under five minutes left out - the rate panel's rules. The sentence
  says "pace", never "better": a course getting harder is the usual reason a
  rate falls, and the card cannot tell the difference. The CIS 1200 question
  pace reads +679% on the real history; the arithmetic is right and the
  detail line shows both rates, so the user can judge what changed.
- **Stopping early is reported as a habit, not a failure rate**, for the
  reasons under "There is deliberately no `completed` boolean".
- **Everything follows the card's range.** The payload carries
  `sessionRows` - every counted, dated session, cut to the fields the card
  reads - because medians, records, courses and rates do not survive being
  summed by day. Its `hour` is null for any row not recorded by the app, so a
  time-of-day claim cannot be built from an imported row by forgetting a
  filter.
- **It opens somewhere different each time**, weighted toward the strong
  ones and never on the one shown last (`dwt.lastInsight`). The random number
  and the last id are read in the payload handler, off the render path, for
  the reasons given beside the old fun-fact state. Changing the range keeps
  your place where that insight still applies.
- **Its range control sits in the card's footer, beside the stepper**, not in
  the top-right corner like the other tiles. The figure can be a word -
  `MATH 1410`, `Weekends` - and at 1150px a corner control either ran under
  it or, given clearance, broke a course code across two lines.
- **A range with nothing to say still renders the card**, saying so, because
  the range control is on the card: a card that vanished would take the only
  way back with it.
- It keeps the fun fact's range target id, `fact`, so a range already chosen
  for the fun fact carries over. `buildFacts`/`pickFact` in `facts.ts` are no
  longer rendered; `scripts/stats-check.ts` still covers them.

**One tooltip for every chart: a quiet caption and a loud number.** *"just
make whatever the text is like gray and then make the font size smaller. The
actual statistic should be white and it should pop out and it should be in a
bigger font size."* Recharts' default draws `Hours : 10.51 h` - one line, one
size, the label and the figure given equal weight and joined by a colon. The
figure is the only part anyone hovers for, so it is 17px and white and the
words around it are 10.5px and dim; the colon went with the single line,
because a label above its value needs no punctuation to join them.

It is a `content` component (`ChartTip`), not the `contentStyle` /
`labelStyle` props, because those can only colour the default markup - they
cannot put the name and the value on separate lines at different sizes. It
names no font family: the app is on one face and chart text inherits it, so
naming it again would be a second place to change it.

**No hover highlight anywhere.** *"I hate this highlight effect. Get rid of
it."* `cursor={false}` on every chart. The grey band Recharts paints behind
the hovered band reads as a selection the user did not make, and on this tab
it also sat over the value labels that exist so the bars can be read without
hovering at all.

**The heatmaps now show the same box**, which took building them a hover
layer: they are hand-drawn svg, not Recharts, and their hover text was an svg
`<title>` that the OS draws - a different font, a different delay, a
different corner of the screen, and nothing about it stylable. Two tooltip
designs in one tab is the kind of difference the user notices before anyone
else does.

- **The box is a child of the panel**, positioned in the panel's
  coordinates. Not a `<foreignObject>`, which would inherit the svg's scale
  and grow with the grid; not a portal to `document.body`, which would escape
  the one rectangle it has to stay inside. It is clamped on both axes - at
  the right-hand edge of a 52-week grid it would otherwise be clipped by the
  panel's border radius.
- **The cell's position is read from the DOM, not from the viewBox.** The
  grid is scaled by `maxWidth`, so a cell's position in viewBox units is not
  its position on screen and the two disagree by the scale factor.
- **Every `<title>` is gone**, element and attribute both. Leaving one beside
  the styled box shows two tooltips, one of them late and in the OS's font.
  The empty-state track carried the *attribute* form, which a check counting
  only elements would have passed.
- **The hovered cell takes a thin stroke, not a rectangle behind it.** The
  objection to the chart cursor was a grey block appearing *behind* the thing
  hovered, which reads as a selection nobody made; a stroke on the square's
  own edge reads as the square lighting up.
- **The cells are deliberately not focusable.** Making 1,300 calendar squares
  tab stops would be a worse keyboard experience than none, and it is not a
  regression: a native `<title>` was never reachable by keyboard either. The
  svg keeps its `role="img"` and `aria-label`. If this is ever wanted, the
  answer is roving tabindex on one cell with arrow-key movement, not a stop
  per square.

`scripts/tooltip-check.ts` hovers a bar on all four bar charts and a cell on
both heatmaps through CDP
and reads the **computed** size and colour of the value against the words
around it, rather than trusting that a class was applied - and asserts that
no `.recharts-tooltip-cursor` exists while a tooltip is open, which is the
only way to tell `cursor={false}` from a cursor that is merely transparent.

Two things that check got wrong about itself first, both now recorded in it:
it computed a bar's position, waited 420ms and then hovered the coordinates,
which went stale the moment a layout change moved the panel - so it reported
"no tooltip" for a tooltip that was fine. And it hovered the middle cell of
each grid, which on this history is an empty day, so it proved the box opens
without ever proving it can show a figure; it now hovers candidates until one
answers with a digit.

**Sections and panels are dragged with pointer events, and the rest of the
page moves out of the way as you go.** *"when I'm modifying the layout of the
analytics tab, I should be able to move the headers around. And also, I want
you to add like a live preview of how my dragging is affecting the other
panels."*

**Why not HTML5 drag-and-drop**, which is what this used and is less code:
during a native drag the browser owns the gesture, the drag image is a
snapshot taken at `dragstart` and cannot be styled, and the only position
information arriving is a `dragover` per sibling rather than a continuous
track - so the siblings can be re-ordered but not animated. Native drag also
interacts with `-webkit-app-region`, which this project has lost three builds
to. Pointer events give a continuous position and leave the DOM ours to
animate; the cost is that capture and cancellation are ours to get right,
which is most of `renderer/src/lib/arrange.ts`.

- **Slot positions are captured once, at drag start**, and the target is
  "which captured slot centre is the pointer nearest". They are a property of
  the layout, not of what currently sits in them. Re-measuring each frame
  reads positions that are mid-animation and feeds them back into the hit
  test, which oscillates.
- **FLIP for the siblings**: measure, set the inverse transform with no
  transition, force a reflow so the browser takes the start position as a
  fact, then transition to zero. Skipping the reflow read collapses both
  writes into one frame and nothing animates. The dragged element is excluded
  and follows the pointer - it must not be 170ms behind the hand.
- **The preview lives in the hook, not in the layout.** `onCommit` fires only
  on a successful drop, which is what makes Escape and a release outside into
  cancels without either being handled at the call site.
- **`prefers-reduced-motion` is honoured in the hook**, not only in CSS: a
  `transition: none` rule would stop the tween but the element would still be
  given a transform and then have it cleared, which is a flash rather than an
  instant move.
- **The grip is the handle, not the whole panel.** A drag that could start
  anywhere would swallow every click inside a panel, including the range
  dropdowns, which stay usable while arranging.
- **Cross-section panel drops are still refused.** A section is a property of
  a panel (see `SECTIONS`); now that sections themselves move, the way to put
  Habits above Hours is to drag Habits.
- **"At a glance" is a section like the others.** It used to be rendered above
  the loop because its body is the figure row rather than a grid - which also
  made it the one header that could not be dragged. It goes through the same
  loop and the same drag group now; only its body differs.
- **`Layout.sections` is separate from `order`.** Panels move within a
  section and sections move as wholes; one flat list would make "which
  section is this panel in" a function of position. A stored layout with no
  `sections` key resolves to the declared order, so old layouts need no
  migration beyond that.

**The Modify panels bar is one row, at the right edge, with no instructions.**
*"I don't need the instructions when im modifying the layout of the data. All
it really should do is just the buttons should just move all the way to the
side. The done button should move all the way to the side."* The hint
sentence is gone - it was written when entering the mode was the only chance
to explain it, and the grips and hide buttons now appear on every panel the
instant the mode opens. Everything stays in the header row rather than
opening a second one, so nothing below the header moves when the mode is
entered, which matters because the next thing the user does is drag the
things underneath. **Done is last**, in the place Modify panels occupied, so
the button pressed to come in is the button pressed to leave.

`scripts/arrange-check.ts` drives a real drag through CDP and asserts a
sibling has moved **while the pointer is still down** - a behaviour no amount
of reading the component can confirm. Pointer events are dispatched through
CDP rather than synthesised in the page: a synthetic `PointerEvent` does not
go through the capture machinery, so a handler bound with
`setPointerCapture` never sees the moves. It also captures mid-gesture, which
is the only way to screenshot something that is over before any other tool
could look.

**The reflow animates only while a drag is in progress.** The FLIP pass runs
on every render, which is right for *measuring* - positions have to be
current when a drag starts, and what moved them is not expressible as a
dependency - and was wrong for *animating*: any render that changed a height
got the full treatment, so changing one panel's range threw the whole page to
its previous layout and eased it back. That is the user's *"the panels want
to move up or something like that and then they quickly go back down... just
there for a split second"*.

It is invisible to a layout assertion, which is why the first version of the
check passed while the bug was live. `offsetTop` never moves - a transform
does not change where an element is laid out. Measured frame by frame on a
range change:

```
offsetTop  147 147 147 147 ... 147   (never moves)
rect.top   -353 147 -853 -839 -779 -682 -608 -482 -391 -367 -358 -353
```

A transform thrown 1,000px and eased back over fifteen frames, for a layout
change nobody dragged. `scripts/reflow-check.ts` samples every section and
slot on every animation frame for 500ms after a range change and asserts
that none is ever **transformed** - read from `getComputedStyle`, not
inferred from a position, because neither `offsetTop` (transform-blind) nor
`getBoundingClientRect` (scroll-sensitive, and section-relative for a slot)
can tell a transform from a layout change on its own.

**A drop must not commit from inside a state updater.** `finish` used to call
`onCommit` inside its `setDrag` updater, which reads as a tidy way to have
the drag state and the decision in one place and is a side effect in a
function React may call during the render phase - and does.

What that broke is not in the drag engine at all. `useLayout`'s `update` took
the new layout out of its own `setLayout` updater into a local variable and
sent *that* to the main process. React evaluates an updater eagerly only when
the component has no pending work: true of a click on a range dropdown, which
is why every other control persisted correctly, and false of a drop. So a
dragged order reached the database as the order it started with, while the
screen showed the new one - one write, 2ms after the release, with the
preview visibly correct and the engine passing the right array. `update` now
resolves against a ref that is written with every layout change, and `finish`
reads `drag` and `preview` from the render it belongs to.

**A range change re-renders only its own panel.** Each panel body is a
memoized `PanelContent` taking its range and custom text as props rather
than the whole layout, and the two handlers are `useCallback`s, so changing
one panel's range does not redraw the others - measured with a
MutationObserver over every panel, which went from four other panels
redrawing to none. Declared as a function and memoized separately rather
than `memo(function ...)` in one expression: `react/prop-types` cannot
resolve a component through the `memo` call and reports every prop as
undeclared.

Measured on the real history at both widths: `analytics()` 37-47ms (median of
7), payload 1,011 KB, no per-frame work in a panel that is not animating.

**Every dropdown offers the same presets, and one of them is Custom.**
*"every timescale dropdown should have the same presets... and then a custom
field where i can insert anything"*. Panels used to narrow the list for
defensible local reasons - the calendar dropped the shortest windows, the
comparison box offered five of eight, the baseline tile four - and together
those meant no two dropdowns looked alike. The list now lives once in
`shared/windows.ts` and every picker renders all of it.

- **The order is the user's and is deliberately not monotonic.** 60 days sits
  before 8 weeks although 56 is shorter, and 30 days after 4 weeks although
  30 is longer. Those pairs mean different things to the person choosing - a
  month versus four weeks of work - and sorting by length would scatter them.
- **A month is a twelfth of a 365-day year**: 6 months is 183 days, 12 months
  365, 24 months 730. That keeps `1y` at the 365 it has always been, so the
  baseline figures and every stored id are unchanged. `1m` is **not** a month
  window - it is the 30-day one, which is why "past 4 weeks" (28) and "past
  30 days" (30) can both be in the list. `shared/span.ts` separately treats a
  *typed* month as 30 days, because someone who types "10 months" expects 300.
- **An option that cannot apply is disabled with its reason, never removed.**
  A list that changes length as you use it is a list you cannot learn. Two
  cases exist: All time on the baseline tile (it contains the first year), and
  a grain longer than the comparison box's period.
- **Custom stores the text, not the parsed days**, so "3 weeks" reads back as
  "3 weeks". It is parsed on every read; a span that stops parsing degrades to
  all time with the reason shown, rather than to a number nobody can account
  for. A half-typed span resolving to all time is the safe direction - it
  shows more than was asked for rather than a week nobody chose.
- **An unreadable span says so in the panel, in red, beside the field.** No
  dialog: see "The app speaks for itself". An empty field is not an error -
  it is a box nobody has finished typing in.

**Every bar carries its number, which is what decides the grain.** *"numbers
still don't display on this chart"* - at past 8 weeks the hours chart drew 56
daily points and labelled exactly one, the peak, because 56 labels would have
collided. The user had already said a chart whose data points they cannot read
tells them nothing, so the answer is not to thin labels harder: it is to draw
fewer, bigger buckets. It is bars rather than an area for the same reason an
area could not be fixed - an area has points, not slots, and there is nowhere
for a label to sit that is unambiguously one day's.

`grainFor` walks day → week → month → quarter and takes the first whose bucket
count fits `MAX_BARS` (32, which is 34px a bar at 1,150px against a label of
12-31px). Choosing by count rather than by day thresholds means a custom span
of any length lands somewhere sensible without a rule being written for it,
and the condition tests the thing being guaranteed.

The threshold was found by measuring. Fixed day thresholds put all time on 45
monthly bars with **0.8px** between the closest pair of labels - which passes
an overlap test and still reads as one number. `axis-clip-check.ts` now
requires a 4px *gap* between value labels rather than merely the absence of
overlap, and sweeps 336 states. With the count rule, all time is 15 quarterly
bars and the tightest gap anywhere is 18.1px, at 30 days.

The grain is named in the title ("Hours per week", "Hours per quarter")
because a bar's value means a different thing at each one. A zero bar is
labelled `0` rather than left blank: an unlabelled bar among labelled ones is
exactly the ambiguity the panel exists to remove.

**The calendar grid's zoom is bounded, and a day is always the same size.**
The grid is an svg with a viewBox and `width: 100%`, which is what makes it
the first thing you see at 12 months - and, unbounded, what made a 30-day
range draw 225px squares in a panel 2,304px tall. The user: *"the zoom of the
heatmap is NOT proportional to the timescale. look what happens - it zooms in
hella and then i can't see anything."* Measured at 1,900px before the fix:

| range | viewBox | scale | day square | panel |
| --- | --- | --- | --- | --- |
| 30 days | 96 | 18.7x | 224.9px | 2,304px |
| 8 weeks | 156 | 11.5x | 138.4px | 1,453px |
| 12 months | 816 | 2.2x | 26.5px | 353px |
| all time | 831 | 2.2x | 26.0px | 348px |

`MAX_CELL_PX` is 26 because that is what the two long ranges already drew -
the state nobody complained about - so the cap leaves them untouched and
every short range now matches them. **A week is a smaller picture than a year
because it contains less, not because its squares are smaller.** It is
expressed as a `maxWidth` on the svg rather than a transform, so `height:
auto` keeps the squares square and the panel short without a second rule to
keep in step.

`scripts/heatmap-size-check.ts` sweeps every range at two widths and two text
sizes. Its invariant took a failing run to state: "the same size at every
range" is true at 1,900px and **false at 1,150px**, where a 52-column year
needs ~1,800px and has 1,090, so it shrinks to 15.2px - which is correct, and
the assertion was wrong, not the code. What it checks now is that a square is
either at the cap or smaller *only because the grid ran out of room*. Two
things that bit while writing it: a bounding rect on the parent includes its
padding, so a grid filling every pixel measured 38px short; and a backtick in
a comment inside a template literal ends the literal.

**Axis sizes are measured, never typed.** Every `YAxis width` and chart
`margin` was a number chosen while looking at one chart with one set of data,
and both of those change underneath it: a range control can swap a two-digit
axis for a three-digit one, and the Modify panels A+ button scales every tick
to 1.6x while the typed width stays put. `scripts/axis-clip-check.ts` sweeps
every panel against every timescale at two window widths and two text sizes
and compares each label's box against the chart's svg: 216 states, 42 clipped
labels in four places. `renderer/src/lib/measure.ts` sizes them from the
widest label the chart is about to draw, at the size it is about to draw it,
using the browser's own text measurement rather than characters times a
constant - this is a proportional face, and `11/05` and `Nov '26` are not the
same width for the same character count. Same sweep after: zero.

Three things that are easy to get wrong here:

- **A y axis sized for its labels still needs a right margin**, because the
  last x tick is centred on the final point and half of it hangs past the
  plot. That is `Thu 5` and `Nov '26` being cut.
- **The top tick is centred on the top gridline**, so half its line box is
  above the plot too - `margin.top` is not only for value labels.
- **The tick size is read from the live `--an-fs`**, not passed down from the
  layout. The scale is a custom property on an ancestor, so a prop would be a
  second copy of it; `Frame` reads its own computed value and hands it to the
  chart body through a **render prop**, not a context - the chart body is
  written inside the same component that renders the frame, so it would sit
  outside any provider that component set up and read the default forever.

**A `<select>` needs its own focus rule** - the suppressor above does not
reach it, and that is only visible by measuring. Clicked with a real mouse, a
button and an svg report `:focus-visible` **false** while a select reports
**true**, because a select takes keyboard input once focused and the spec says
such a control always matches. So `:focus:not(:focus-visible)` is exactly the
wrong key for it, and the range dropdowns kept the amber ring after the chart
fix was signed off. `.dashboard select:focus` drops the outline and tints the
border instead.

**Panels sit in named sections: At a glance, Hours and consistency, Habits,
Projects and output.** A section is a property of a panel, like its width, not
a second arrangement the user maintains — otherwise a heading describes
whatever happens to be under it and stops being worth reading. So a drag
across a section boundary is refused rather than silently reordering the flat
list. A section with everything in it hidden renders nothing, not an empty
heading.

**Nothing caps the width of text, and Settings is one section per row.**
Panels were once capped at 900px, then paragraphs at `78ch`, on the usual
argument that very long lines are hard to follow. The user rejected both:
*"any text, for example in the backup section, all the text just doesn't flow
across the page. I need the text to resize so that whenever the window
resizes, the text will follow it. It should not just be fixed to like a
maximum length. also this is because the opening the file folder stretches
across the entire window so naturally the text should as well."* The last
clause is the reason, not a preference: the folder path beside the prose
already spans the window, so a paragraph stopping short reads as text that
failed to fill its box. If line length is ever the complaint, narrow the
section, never the paragraph inside it.

Settings is **one full-width section per section, stacked, scrolled through**:
*"I don't want three sections across the page. I want one section per
section... I just have to scroll down in order to access all the settings."*
This replaced a responsive three-column grid. Inside a section, controls
still lay out sensibly - shortcut bindings at the right edge, accent swatches
in a row.

**The yellow box on clicking a chart was Chromium's, not the app's.** *"why
does a yellow box appear when i click on something?? remove this"*. Nothing in
`main.css` painted it. Measured in a real window with a real mouse click
through CDP — a scripted `el.click()` does not move focus, and `el.focus()` in
an unfocused window does not match `:focus`, so two earlier probes reported no
ring at all and nearly closed it as unreproducible:

| | |
| --- | --- |
| focused element | `svg.recharts-surface`, `tabindex="0"`, `role="application"` |
| computed outline | `auto 4.8px rgb(229, 151, 0)` |
| pseudo-classes | `:focus` true, `:focus-visible` **false** |
| author rules matching | none |

The amber is `-webkit-focus-ring-color`, which on Windows is the **system**
accent — so it is not the app's accent, it does not move when the accent is
changed, and it is a different colour on another machine. Looking for the rule
in this stylesheet was never going to find it. Recharts 3 makes the chart
surface keyboard-focusable, so every chart is a focusable element the size of
its panel.

`.dashboard :focus:not(:focus-visible) { outline: none }` is the fix: gone for
a pointer, kept for Tab. Verify the suppressor **matches** rather than assuming
it — the ring painted while `:focus-visible` reported false, and a rule keyed
on a pseudo-class the engine disagrees with would have done nothing. After the
fix the same click computes `none`.

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
- **Documents means the local profile folder, not whatever OneDrive redirected
  it to.** `app.getPath('documents')` resolves the Documents known folder, and
  with OneDrive Folder Backup on that folder is inside the OneDrive tree — so
  the obvious call quietly puts the whole history into cloud sync. When the
  redirect is in force, `%USERPROFILE%\Documents` is used instead. The folder
  can also be overridden, stored in `app_settings` so the choice survives a
  restart; most app settings are still in-memory only, which is tolerable for a
  toggle the user can see but not for something the app acts on unattended.
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

### Committed is not the same as safe: checkpoint after writing

In WAL mode a committed row lives in `deepwork.db-wal` until a checkpoint
copies it into `deepwork.db`. Normally invisible — SQLite reads both as one and
checkpoints on the last clean close. But if the `-wal` is ever separated from
the `.db` while nothing is running, the database opens perfectly and is simply
missing everything since the last checkpoint. **No error, no corruption
warning, just rows that are gone.**

This is not hypothetical. On 2026-09-23 the database held 2,363 imported
sessions — proven by a backup taken while they existed — and afterwards the
main file reported `page_count 13` and `freelist_count 0`, meaning it had never
grown past an empty schema. The rows had only ever been in a `-wal` that was
later lost. **The cause was never established**, which is the point: the window
should not exist to be exploited by causes nobody has identified.

So **anything that writes rows worth keeping checkpoints**. `TRUNCATE` rather
than `PASSIVE` because the aim is to leave nothing behind, and it is allowed to
fail quietly since a concurrent reader can refuse it and the next write will
try again.

For a long time that rule was stated here and honoured by two functions.
`recordSession` and `importRows` called `checkpoint()`; **nine other write
paths did not** — work quantity, stop reasons, manually entered sessions, every
edit and delete from the Data tab, the pauses restored by undo, and the backup
directory in `app_settings`. Audited and closed 2026-11-05.

That gap was worse than it sounds, because each of those writes *modifies a
session row that had already been checkpointed*. Losing the `-wal` would not
have lost the session; it would have reverted the row to the version without
its output, leaving a session that looks complete and quietly has no
`work_quantity`. Nothing on screen would say so. Work quantity is on 97% of the
history and is a first-class feature, a manually entered session cannot be
reconstructed from a timer at all, and the backup directory is acted on
unattended — which is the case `app_settings` exists for.

Two mechanisms, because the writes have two shapes:

- **`checkpoint()`** for a finished run and a completed import: one-shot,
  decisive, worth an exclusive lock immediately.
- **`checkpointSoon()`** for everything else, which arrives in bursts. Work
  quantity is written as the user types it and an edit is a field at a time, so
  a `TRUNCATE` per keystroke would thrash the lock to no purpose. It coalesces
  onto a 1.5-second trailing timer, unref'd so it never holds the process open,
  and `closeDatabase()` flushes a pending one.

The residual window is that 1.5 seconds. That is not nothing, but the window it
replaced was unbounded. `scripts/checkpoint-check.ts` proves both halves by
copying the `.db` **without** its `-wal` — which is exactly what the 2026-09-23
loss looked like — and reading it: before the checkpoint the quantity is not
there, after it is.

### Two builds, one database — and why they are now separated

There are two copies of this app and they are the same source, never different
programs. They are only ever **different versions**:

| | `npm run dev` | installed |
| --- | --- | --- |
| runs from | `out/` in the project | `app.asar` under `AppData\Local\Programs` |
| updates when | you rebuild | you run the installer |

That skew is why a change can appear to do nothing — the desktop icon is a
snapshot taken at `npm run dist`, with no link to the source. Hence the
practice of reinstalling as part of the change.

**The real hazard was that both resolved `userData` to the same folder**, so
the two shared one SQLite file. `requestSingleInstanceLock` cannot help: it
only stops two copies of the *same* executable, and these are different
binaries that will happily run together. Two connections competing for one
file is what produced `database is locked`, and every test run wrote rows into
the real history — three such rows were found in it.

**Backups had to be split the same way.** `defaultBackupDirectory()` is based
on Documents rather than userData, so splitting the database alone left a worse
hole than before: a dev run writes a snapshot of its throwaway rows into the
real backup folder, and with eight retention slots enough of them push the real
history out. One such file — a single test session beside a 2,363-row backup —
was created before this was noticed. When `app.isPackaged` is false, backups go
to `userData/Backups` instead. **Anything that picks a location outside
userData needs this check**; the database split does not cover it.

So **the dev build now keeps its own profile**, `deep-work-tracker-dev`, set
before `whenReady` because `userData` is fixed the first time any path is
resolved. The installed app stays the daily driver with its own data; dev can
be run, tested against and killed without touching it. Verified: a dev run
created `deep-work-tracker-dev\deepwork.db` and left the real file at the same
row count and `quick_check: ok`.

### The preview is read-only

`npm run preview` is a third profile, `deep-work-tracker-preview`: the current
source running against a fresh copy of the real history, for trying a change
on real data before it is installed. **Nothing in it reaches the real
history.** Anything recorded is `test` (the TEST badge), and when the preview
closes its copy is deleted - and with it everything recorded there. The banner
says all of that and points real work at the installed app.

**This was decided after the opposite was tried.** On 11/06/2026 the user
logged real sessions in a preview and nearly lost them, and for one day the
preview copied its changes back into the real history on close (a three-way
merge against a baseline, with backups and refusal thresholds). The user
rejected it: *"isn't using the real production data like really bad
practice?"* It is - a snapshot of production for testing is normal; an
unreleased build writing to it is not, and no amount of safeguarding makes
the untested build trustworthy. The write-back code was deleted, not kept
behind a flag.

- **The copy is of the real file.** From inside the Claude sandbox the script
  detects the redirect (a probe file written to `%APPDATA%` turns up under a
  package's LocalCache) and takes the snapshot by starting a copy of itself
  through WMI, outside the sandbox, in `--snapshot-helper` mode, handing it
  every path and reading the result back through Temp, which is not
  redirected. Outside the sandbox it reads directly.
- **`VACUUM INTO`, read-only, counted and `quick_check`ed on both sides**,
  retried on a transient failure. The source is never opened for writing.
- **Discard first, discard last.** A copy left by a preview that was killed
  rather than closed is deleted before the next snapshot, so its rows cannot
  outlive it; a closed preview deletes its own.
- **It refuses to start while a preview is open** (Chromium holds `lockfile`
  in the profile; opening it fails with `EBUSY`), since replacing the copy
  under a running app would corrupt it.
- `--no-launch` takes the snapshot only; `--remote-debugging-port=N` is passed
  through to Electron so a check can drive the preview. Verified 11/06: a
  session created in the preview read back as `test` with the TEST badge,
  closing deleted the copy, and the real history - read from outside the
  sandbox - still had 2,478 sessions and no test rows.

### Claude's sandbox redirects AppData: the profile was split for seven weeks

**Read this before touching the real profile from a terminal.** The Claude
desktop app is MSIX-packaged, and every process started from its shell - Bash,
PowerShell, node scripts, `npx electron`, even the *installed*
`deep-work-tracker.exe` - has its writes to `%APPDATA%\Roaming` silently
redirected to `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\`,
and its reads of that folder see the redirected copy first.
`%LOCALAPPDATA%\Programs` (where the installer writes) and `Documents` are not
redirected, which is why installs and backups always landed for real.

From 9/19 to 11/06/2026 this split the app's data in two. Every instance
started from the shell after an install used the hidden copy, which received
the import and every session since - 2,478 sessions. A launch from the desktop
icon, when no shell-started instance was running, opened the real
`deepwork.db`: a 15-page file from 9/23, later corrupt. A second launch while
a shell-started instance ran just handed off to it (single-instance lock), so
the user mostly saw their data and occasionally saw none. That is the 11/06
"NO data", the "database disk image is malformed" on every launch, and very
likely the 9/23 "rows only ever in a -wal" loss. Every check run from the
shell read the healthy hidden copy and reported all was well.

Fixed 11/06/2026: a verified `VACUUM INTO` copy of the hidden database was put
in the real folder, the 9/23 file moved to
`Documents/Deep Work Tracker/Recovery/move-to-real-2026-11-06-1414/`, and the
app relaunched via Explorer; the real `errors.log` showed a clean start and a
copy taken from outside the sandbox read 2,478 sessions.

**Rules that follow:**

- **Never launch the installed app from the shell.** Use
  `Start-Process explorer.exe -ArgumentList '"<exe>"'` (Explorer starts it
  outside the package) or let the user use the icon.
- **Read or write the real profile only from outside the package**:
  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` runs a
  command through WMI, outside the sandbox. Copy files out to `Documents`, then
  inspect the copy. A read of `$APPDATA` from the shell proves nothing about
  what the user's app sees.
- **Prove where a launch went**: the real `logs/errors.log` gets an
  `INFO Started` line and the redirected one does not.
- **`npm run preview` handles this itself**: it detects the sandbox and takes
  its snapshot from outside it. See "The preview is read-only".

### One process, and a busy timeout

Two copies of the app meant two SQLite connections competing for one file, and
the connection carried **no `busy_timeout`** - the default is zero, so a write
while any other connection holds the lock fails instantly with `database is
locked` rather than waiting. The throw landed in the `completed` event handler,
where an exception is uncaught in main: Electron turned it into a crash dialog
and the stop never finished, so the clock kept running while the user was told
about SQLite. Adding `checkpoint()` to every session write made this far more
likely by taking an exclusive lock on each one.

Two fixes, both needed:

- **`PRAGMA busy_timeout = 5000`.** Verified across two real processes: without
  it the second writer threw immediately, with it the write waited 1,087 ms for
  the lock and succeeded. `node:sqlite` is synchronous, so this only helps
  across processes - within one process a blocked write cannot yield.
- **`requestSingleInstanceLock`.** A second launch opens another timer window
  in the running app instead of starting a rival process. Multiple timers were
  always meant to be multiple windows - each already carries its own
  `TimerEngine` - so nothing is lost by refusing to run twice, and the
  contention disappears at the source.

**Never force-kill the app to install over it.** `Stop-Process -Force` while
it holds the database open leaves `-wal` and `-shm` behind - a clean close
deletes both - and on 2026-10-02 the next launch reported
`database disk image is malformed` from whichever query touched the file
first. Ask the window to close (`CloseMainWindow`), wait, and force only as a
last resort. The checkpoint on every write makes a kill more dangerous than it
used to be, because truncating the WAL is exactly the moment to be interrupted
during.

**Errors go to a log file: `userData/logs/errors.log`.** On 11/06/2026 a
launch of the installed app failed partway through startup: no timer window,
the Data tab on "Loading..." forever, the user's 2,478 sessions intact on disk,
and the cause unrecoverable because the packaged app has no console. So:

- `main/errorLog.ts` starts right after `userData` is chosen (each profile has
  its own log) and mirrors every `console.error` / `console.warn` to the file,
  so the existing reporting needed no changes. It also catches uncaught
  exceptions, unhandled rejections, dead renderer or helper processes, and
  errors a page logs or throws (via `console-message`). Synchronous appends,
  1 MB then rotate to `errors.1.log`, and a failed write is swallowed - a
  logger that throws turns a report into a crash. One `INFO Started` line per
  launch separates runs.
- **Startup is a list of independent steps** (`step()` in `whenReady`): one
  failing is logged with its stack, the rest still run, and a dialog names the
  failure and the log's path. The app either works or says it does not.
- **Nothing in the UI may wait forever on a rejected call.** The Data tab and
  Backups had no `catch`; a failure now shows as a failure, with Try again and
  Open the error log. A stuck "Loading..." reads as "you have no data", which
  is the worst thing this app can say.
- **The tray must not depend on the database.** Its Saved timers submenu read
  `app_settings`, so an unreadable file took the tray icon with it; the read
  now falls back to an empty list.
- Settings shows the log's path with Open folder.

Verified by running the real build on the dev profile with its database
swapped for a file that is not one: the timer still opened, the tray still
appeared, both tabs said what failed, and every failure was in the log with
its stack.

**A read the app can live without must not be able to break it.** The two
project lookups run on every timer window's first paint. When they threw, the
invoke rejected, the renderer never caught it, and one bad read filled the
console while leaving the field empty with no explanation. They now go through
`safely()`, which returns a fallback and logs each distinct failure once -
repeating the same stack on every paint makes the log useless. A suggestion
list is a convenience; losing it must not take the timer with it.

**`healthCheck()` runs `quick_check` once at startup** and shows a dialog
naming the problem and pointing at Restore. A damaged file otherwise announces
itself as whichever query happened to touch the bad page, which reads like a
bug in that query rather than a damaged file.

**Recording a session must never throw into an event handler.** A failure is
logged and sent to the window as `timer:recordFailed`; the timer still stops
cleanly. Losing one row is bad, but a crash dialog over a clock that will not
stop is worse, and it hides which of the two actually went wrong.

### Restoring from a backup

`main/restore.ts` rebuilds the database from a backup CSV, which is what makes
the loss above survivable rather than merely detectable.

- **It replaces, never merges.** A backup is a whole-history snapshot; half of
  one grafted onto a different half is worse than either.
- **It takes a backup of what it is about to discard, first.** Restoring the
  wrong file is then an inconvenience rather than a second loss.
- **It keeps the original ids**, so a restored database is the same database
  rather than a renumbered copy.
- **It validates the header before touching anything** and names the missing
  columns, so pointing it at the *source spreadsheet* by mistake is refused
  rather than half-applied.
- **Projects and tags are rebuilt from their names**, which is why the backup
  writes names rather than ids.

### Where labels are asked for, and why there

Split by what can be known when: **project before starting, output at stop.**
You know what you are about to work on; you cannot know how many questions you
got through until you are done.

- **Neither blocks.** A timer that will not start until a form is filled is
  worse than Hourglass, and losing to Hourglass sinks the project. Enforcement
  is by making gaps visible, not by refusing to run: the Data tab's project
  filter carries an **Unlabelled** option, so a week of missed labels is one
  filter and a few edits rather than archaeology.
- **The project field never compares raw strings.** An exact, case-sensitive
  lookup is what let `hw` become a second project beside `HW` and turned
  fifteen real categories into sixty-six; reinstating it in the timer would
  rebuild the mess by hand. `shared/projects.ts` ranks what is typed against
  what exists, the field offers the best matches as a list, and only a
  genuinely new name creates a row. `findOrCreateProject` resolves through the
  same function, so even text that never passed through the UI lands correctly.
- **Matching is lexical, not semantic.** It collapses case, spacing,
  punctuation and the trailing ordinal, then scores exact, squashed, prefix,
  word-prefix, initials, substring, edit distance and subsequence in that
  order. It will not know `essay` belongs with `Writing` - that needs the LLM
  work this project defers, and calling edit distance semantic would be a lie.
- **Suggesting and snapping are deliberately different thresholds.**
  `rankProjects` is generous, because a suggestion you ignore costs nothing.
  `canonicalProjectName` only accepts a match differing by case, spacing,
  punctuation or an ordinal, because silently filing a session under the wrong
  project is what makes the data untrustworthy. The tests that matter are the
  negative ones: `Job` must not become `JPL`, `SAT` must not become `Startup`,
  `Scioly` must not become `Scholarships`, and `HW reading` must stay itself
  rather than collapsing into `HW`.
- **The list is a floating menu, not a `datalist`.** A datalist only does
  literal prefixes, cannot be ranked, and cannot show which entry Enter will
  take. The menu floats over the dial rather than pushing it, because at 136px
  there is nowhere to grow, and it shows at most four.
- **Typing a new name is still how projects come into existence** - there is no
  "manage projects" screen, because a step between deciding to work and
  starting is a reason not to label.
- **It defaults to the last session's project.** Work comes in runs - several
  HW sessions, then several on the essay - so the previous answer is nearly
  always this one, and the common case is touching nothing.
- **It lives under the clock, inside the dial, where the status word was.**
  `ready` / `running` restated what the digits already showed; what belongs
  there - and on camera - is what the session is for. It borrows the clock's
  treatment rather than the caption's: inherited family, light weight, tight
  tracking, no uppercasing, sized between the two so it reads as a subtitle and
  not a second headline, and **white like the clock** - it is the answer to
  what this session is for, which is the one thing besides the time worth
  reading at a glance. Only the placeholder stays dim, because an empty field
  is a prompt rather than a value. It must not go in the head: six icons and the task
  field already fill 250px, and a fourth control there pushed the window
  buttons off the edge.
- **Nothing else ever appears there.** The slot previously showed the status,
  then the echo of how a typed duration had been read. Both are gone at the
  user's request. The echo was redundant rather than load-bearing: the clock
  rewrites itself into canonical form on Enter and on leaving the field, so
  `30 min` visibly becomes `30:00` in the field itself, and a grey second copy
  underneath sat where the useful answer belongs.
- **Tab runs task to duration to project.** Tab out of the clock focuses the
  project rather than the window buttons, because labelling a session and
  setting its length is one sequence and that is the order it happens in.
- **The name, not the id, rides on the snapshot**, resolved to a row only when
  the session is written. That keeps the engine ignorant of the database and
  survives a project being created after the timer started.
- **A project set but never recorded is never created.** `findOrCreateProject`
  runs at write time, so abandoning a run leaves no empty category behind.
- **`projectId: -1` is the Unlabelled sentinel** in `querySessions`. A real id
  cannot be negative, and it keeps the filter one control - unlabelled is a
  choice of project, not a separate axis.

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
npm run preview    # current source against a read-only copy of the real history; discarded on close
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
  migration that has already run; add a new one. Before any pending migration
  runs on a database that has sessions, the runner writes a full copy to
  `userData/pre-migration/` with `VACUUM INTO`, and refuses to migrate if it
  cannot. A transaction undoes a migration that fails; only a copy undoes one
  that succeeds and is wrong, which migration 4's first draft did.
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

**Screenshot the UI rather than reasoning about the markup.** Reading JSX and
CSS predicted none of the three table faults above, and a night was lost
diagnosing a missing desktop icon from window handles when one screenshot
answered it immediately. The dashboard can be rendered headlessly against real
data: bundle an entry that registers only the handlers the tab calls
(`sessions:query`, `sessions:projects`, `history:state`), point `userData` at a
copy of the database, load `out/renderer/index.html` with hash `/dashboard`,
click through to the tab with `executeJavaScript`, and save
`webContents.capturePage()`. It takes a minute and it is the only way to see
what the user sees.

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

- **Python on Windows writes CRLF.** `open(p, 'w')` in text mode turns every
  line feed into carriage return plus line feed, so a scripted edit leaves the
  whole file with Windows line endings: 1,873 prettier warnings in one file on
  2026-11-05, and nothing wrong in git, which normalizes on commit. Open with
  `newline=''` for both read and write, or run prettier on the file afterwards.

**Sticky table headers need three things, not one.** `position: sticky` alone
looks like it should work and does not: table cells paint in document order, so
rows are drawn over the header without a `z-index`, and `border-collapse:
collapse` gives the border to the table rather than the cell so it scrolls away.
Sticky, a z-index, and `border-collapse: separate` together.

## Known gaps between this document and the code

Kept here deliberately: a spec that quietly disagrees with the build is worse
than no spec.

- **Tags are still unused.** `tags` exists for course codes such as
  `WRIT 0580`, and nothing writes to it. Projects are labelled; the second
  dimension is not.
- **The backup folder can be changed but not from the UI.**
  `setBackupDirectory` and its `app_settings` key work; no picker calls them.
  The automatic default is what matters and it is correct, so this is a
  convenience, not a hole.
- **Destructive confirmations are still Windows dialogs.** Delete, the
  second confirm for an imported row, restore and replace-import go through
  `ui:confirm`. "The app speaks for itself" says information belongs in the
  app; whether a yes/no question counts has not been put to the user.
- **`presets` is still an unused table.** Named in the schema for the settings
  toggle that would bring preset durations back. Nothing writes it.

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
