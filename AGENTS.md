# Working as several Claude sessions on this repo

Three sessions run against this one checkout: a **manager**, an **implementer**
and an **artist**. They share a working directory, a git repository, a build
output folder and - the dangerous one - a database holding 3.5 years of the
user's real history.

This file is the contract between them. `CLAUDE.md` says what the app is and
why; this says who may touch what, and how to avoid the specific ways three
agents in one checkout destroy each other's work.

Every rule below exists because it already went wrong here, or because it went
wrong with two sessions and gets worse with three.

## Roles and what each one owns

Ownership means **the only session that edits those files**. Another session
that needs a change there describes the change and asks the owner for it; it
does not edit and it does not "just quickly fix" it.

| Owner | Files | Remit |
| --- | --- | --- |
| **Manager** | `src/main/db/**`, `src/main/import/**`, `src/main/backup.ts`, `src/main/restore.ts`, `src/shared/analytics.ts`, `AGENTS.md`, `CLAUDE.md`, `package.json` | Data integrity, schema, migrations, the IPC surface, auditing other sessions' claims, merging, final verification |
| **Implementer** | `src/main/timer.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/**/*.tsx` logic, `scripts/**` | Behaviour: timer correctness, windows, IPC handlers, state, tests |
| **Artist** | `src/renderer/src/**/*.css`, visual structure of components, `src/shared/accents.ts` | How it looks and feels: typography, spacing, the dial, chrome, accents |

Where implementer and artist both touch one `.tsx`, the split is **logic vs
markup/style**. Say which you are changing in your first message about it. If
the change is both, one session does both - agree who, do not interleave.

## The database is the user's real history. Treat it as production.

This is the rule that matters more than the rest of this file combined.

- **Never run the packaged app to test.** `npm run dev` resolves `userData` to
  `deep-work-tracker-dev` and is the only build any session may write to. The
  installed app under `AppData\Local\Programs` owns the real data.
- **Never write to `AppData\Roaming\deep-work-tracker`.** Not a test row, not
  an import, not a migration trial. If a task genuinely needs it - an import,
  a restore, a repair - it goes to the **manager**, who backs up first.
- **Read it read-only, from a copy.** To inspect real data, copy
  `deepwork.db` plus any `-wal` and `-shm` to the scratchpad and open the copy
  with `{ readOnly: true }`. Opening the live file for writing while the app
  holds it is how `database is locked` and `database disk image is malformed`
  both arrived.
- **Copy the `-wal` with the `.db` or you are reading a stale file.** In WAL
  mode committed rows live in `deepwork.db-wal` until a checkpoint. A `.db`
  taken on its own can report an empty schema while the app shows thousands of
  rows. That asymmetry is what made the September loss look like corruption.
- **Never force-kill the app.** `Stop-Process -Force` while it holds the
  database leaves `-wal` and `-shm` behind, and the next launch reported
  `database disk image is malformed`. Ask it to close (`CloseMainWindow`),
  wait, and force only as a genuine last resort.
- **Only one session runs the app at a time.** Announce it before you launch,
  and say when you have closed it. `requestSingleInstanceLock` stops two
  copies of the *same* binary; it does not stop a dev build and an installed
  build running together, which is two connections to one file.

There are three historical `userData` locations - `Roaming\Electron` (from
before the app name was set), `Roaming\deep-work-tracker` and
`Roaming\deep-work-tracker-dev`. Only the middle one is real. If you find rows
somewhere else, report it rather than merging it.

## Before any destructive operation

Destructive here means: replacing an import, restoring a backup, deleting
rows, editing a migration, or anything that runs `DELETE` without a `WHERE`.

1. Confirm with the user, or with the manager if the user already approved the
   shape of the work.
2. Take a backup first and **say where it is**.
3. Do the delete and the write **in one transaction**, so a failed write
   cannot leave the delete standing.
4. Verify afterwards by reading the row count back, and state the number.

An operation that deletes and then writes is only safe as one unit. A replace
that deletes 2,362 rows and then throws has destroyed the history and reported
an error, which is the worst of both.

## Git: branch per session, manager merges

- **Nobody commits to `main`.** Eight commits went straight onto it before this
  was noticed, which also cost the user the added/removed line counter in the
  desktop app - it measures a branch against its base.
- **One branch per session**, named for the work, not the role.
- **Commit your own files only.** `git commit -a` in a shared checkout commits
  the other two sessions' half-finished work. Name the paths explicitly.
- **The user does not run git commands.** Branch, commit, push and merge
  happen here without being asked each time. Give them the result.
- The manager merges and resolves conflicts. If your branch will not merge,
  say so rather than rewriting history.

Because all three sessions share one working tree, **an uncommitted file you
did not create may belong to another session mid-edit.** Check `git status`
before assuming a stray file is debris, and never `git checkout --` or `git
clean` a path you do not own.

## Verification: evidence, not assertion

"Done" means you ran something and read the output. State what you ran.

| Change | Minimum proof |
| --- | --- |
| Anything typed | `npm run typecheck` clean |
| Timer engine | bundle it standalone and drive it from Node - see `CLAUDE.md` |
| Pure logic (`src/shared/**`) | a script under `scripts/` with real assertions |
| Any UI change | a screenshot of it rendered, not a reading of the JSX |
| Data layer | row counts read back, and the numbers quoted |

Two of this project's worst defects - completed runs recording the polling
overshoot, and every spelled-out duration silently failing to parse - passed
review and were caught only by driving the engine. Three table layout faults
were invisible in the markup and obvious in a screenshot. Reasoning about the
code is not verification.

**Report what you did not do** as well as what you did. A report that lists
only successes is one the manager has to re-audit from scratch.

## In a hidden window the readings are true and the pixels are not

`scripts/shoot.ts` opens `show: false` windows. A window that is never shown is
never composited, and Chromium drives **painting** off frames rather than off
wall-clock time. `capturePage()` is one of the few things that asks a hidden
window for a frame.

So until something forces a frame, a CSS transition stays pinned on the value
it started from, and a scroll set from script is not reflected in the capture.
Waiting longer never helps, because nothing during the wait draws anything.
The harness discards three captures 500 ms apart before keeping one; a single
discard *looks* sufficient and is not, measured through the real `shoot()`
path.

**The rule to carry away: distrust the PNG, not the reading.** The DOM and
computed styles in a hidden window are trustworthy. It is the image that lags
them.

That direction matters more than it sounds. An earlier version of this section
said React could not commit a state update without a frame. **That is wrong**,
and it is wrong in the dangerous direction: it tells the next session to
disbelieve the probe readings that actually solve things, which would have
made every investigation here harder rather than safer. Corrected 2026-11-05
by the implementer session, who disproved their own earlier claim.

Four phantom defects came out of this in one day, two of them written into a
spec as fact. Three were the image lagging. The fourth was something else
entirely and is worth separating:

| Reported | Actually |
| --- | --- |
| Ring-mode header icons never hide | image lag - the capture caught a 160 ms opacity transition on its first frame |
| Settings tab renders white while inactive | image lag - `.tab` has `transition: color 120ms ease`, caught part way back from the active colour |
| Analytics series render empty | **neither** - `isAnimationActive={false}`, and the shots are byte-identical across 0, 1 and 3 discarded frames. They were always fine. |
| `is-ring` is on no element, 46 CSS rules dead | **not image lag at all** - the probe never clicked the toggle, so it read bar mode correctly and reported it as ring. A true reading of the wrong state. |

The last row is the one that gets misfiled. It was not a frozen frame and it
was not a lying DOM; it was a measurement of a page that had never been put
into the state being measured. The fix for that is to assert you reached the
state before you measure it, not to distrust the reading.

**Before reporting any visual finding as a defect:**

1. Confirm it on a **settled** capture - the three-capture loop in `shoot.ts`,
   not a single shot - or on a real composited window over CDP.
2. Assert the page is in the state you think it is. Read back the class, the
   route, the row count - whatever defines it - before measuring anything else.
3. If the element has a `transition`, suspect image lag first. Grep the
   stylesheet for one before writing up a mechanism.
4. `document.getAnimations().length === 0` does **not** mean nothing was
   animating. It also means the class carrying the transition never applied.
5. Prefer the installed build for anything about the timer window. It is what
   the user looks at, and it is composited.

One more thing worth keeping, from the third row. The Analytics series were
fine all along, and "the harness fix landed, so the evidence is sound" was the
wrong reason to believe it - the right reason was that the images came back
byte-identical with and without the fix. A correct conclusion reached through a
broken argument leaves the broken argument in place for next time, which is
how the first three of these happened.

## Never reach `window.api` through a cast

`preload/index.ts` exports `DeepWorkApi = typeof api`, and
`preload/index.d.ts` declares `window.api` as it. So the renderer gets the
real shape of every channel for free, and a mismatch between the two halves
is a compile error.

Writing `window.api as unknown as { thing?: Thing }` throws that away. It
looks harmless - the local interface says what you believe the channel is -
and it is the single worst place in this codebase to do it, because an IPC
boundary is the one surface where **both sides may be written by different
sessions at the same time**.

That is not hypothetical. For three commits the renderer declared
`set(layout: Layout)` while preload declared `set(json: string)`: saving a
layout threw a `TypeError` in the main process, the rejection was swallowed by
a `catch` that exists so a preference failure cannot interrupt anyone, and the
"Not saved" warning could not fire because it checks that the functions
*exist*, not that they work. Typecheck was clean the entire time, because the
cast meant there was nothing to compare.

Removing the cast and deriving from `DeepWorkApi` was verified by
reintroducing the old shape in preload: `error TS2345: Argument of type
'Layout' is not assignable to parameter of type 'string'`. The compiler now
catches in a second what took three sessions and an installed build to find.

Use `Partial<DeepWorkApi>` when a channel may genuinely be absent - that
handles absence without hiding shape.

## They are all one bug: the artifact is real, and it is of something else

Six incidents on 2026-11-05, and they look like six unrelated faults until
they are put side by side:

| What was trusted | What it was actually of |
| --- | --- |
| the installed app | a build from before the change |
| a `shoot` capture | `out/`, which nobody had rebuilt |
| a screenshot of the ring | a frame captured before the transition ran |
| a probe reading `isRing: 0` | bar mode, because the toggle was never clicked |
| a `:hover` reading of 8 | a synthetic pointer left by an earlier click |
| "the tree is clean" | a moment that had passed before the message was read |
| "the `--an-fs` fix landed" | a commit that was present while its effect was absent |

**None of these is caught by looking harder at the artifact, because the
artifact is not lying.** The screenshot is a real screenshot, the probe really
read what it says, the tree really was clean. Each is a true reading of
something other than the thing being reasoned about.

So the check is never "look again" - it is **assert the artifact is of what
you think it is**, which is something that can be written down rather than
remembered: read back the class before measuring it, compare the bundle hash
before trusting a screenshot, put the clean-tree test inside the build command.
`scripts/shoot.ts` now refuses to run against a stale bundle for exactly this
reason; a warning would scroll past, and the failure mode is a result that
looks right.

### The sharpest form: a commit is not an effect

The last row is the one worth knowing on its own, because it does not look
like the others and all three sessions walked into it within the hour.

`0fb9149` was titled "Instrument Sans for words, JetBrains Mono for every
number" and contained a fix for the font-scale control not resizing the
headline figures. It typechecked, it was committed, it was installed. Each of
us said some version of "the installed app carries the `--an-fs` fix" - and it
did carry the commit. Measured on the running app:

| | at scale 1 | forced to 1.6 |
| --- | --- | --- |
| `.an-panel__title` | 13.5px | **21.6px** |
| `.an-stat strong` | 27px | **27px** |

The rule was correct and read a variable that never reached it: `--an-fs` was
set on `.an`, while `.an-stats` is a *sibling* of `.an`, not a descendant, so
`getComputedStyle` returned it empty. Panel text scaled; the headline figures
the control exists for did not.

**A commit title is a statement of intent. A green typecheck is a statement
about types.** Neither is evidence that the effect occurred, and reading
either as though it were is the same move as reading a screenshot as evidence
about current source.

This also has a shape worth naming separately, because it is how a feature
gets signed off while broken:

> "The control is present" and "the control does its job" are different
> claims.

That split has now appeared four ways here - the bundle versus the window, the
DOM versus the pixels, the typecheck versus the contract, and the control
versus its effect. Item 13 was reported verified on the strength of the first
of each pair: the control rendered, and nobody had pressed it.

**And the measurement itself can be of the wrong thing.** Checking whether the
chart ticks scaled, I measured `.recharts-text` and found it unchanged - but
the tick text carries `recharts-cartesian-axis-tick-value`, and
`.recharts-text` matched a chart *label*. A true reading of the wrong element,
inside an investigation into true readings of the wrong thing. Verified
correct afterwards by measuring the right selector: 11px to 17.6px.

So when a fix is described as landed, the question is not whether the commit
is in. It is: **what number would change if it worked, and has anyone watched
it change?**

The full account, including the git-worktree escape hatch for building while
another session holds the tree, is in
`notes/implementer-never-package-a-dirty-tree.md`.

## `npm run shoot` renders `out/`, not your source

The harness loads `out/renderer/index.html`, which `electron-vite build`
produces. It does **not** rebuild it. So a shot taken straight after an edit
shows the previous build, silently and convincingly - it is a real screenshot
of a real page, just not of the code you are holding.

Caught on 2026-11-05 shooting the week tile straight after changing it: the
image showed the old `-31%` with complete conviction, and the only reason it
was noticed is that the expected number was known in advance. Had the change
been one whose result was not predicted, the shot would have been read as
evidence that it did not work.

**Run `npm run build` before `npm run shoot`** whenever the renderer changed.
Same family as the stale installed build, one level down, and with the same
signature: the artifact is real, and it is of something else.

## Before adding any control that overlays the dial

Electron resolves overlapping drag regions by **document order, not
`z-index`**. This has broken the build three separate times, always the same
way: a control declared before the surface it sits on renders, highlights in
devtools, and never receives a click.

Any interactive element overlapping a draggable surface must be the **last
sibling** in its container, with visual order fixed by flexbox `order`. The
full checklist and the symptom-to-cause table are in `CLAUDE.md`; read them
before writing the JSX, not after the click fails to fire.

## The working tree is shared, so nothing you observed about it is still true

Two near-misses on 2026-11-05, in opposite directions, both from treating a
reading of the tree as a durable fact.

**`npm run dist` packages the working tree, not `HEAD`.** So a build started
while another session has edits in flight ships *their* half-finished file to
the user's desktop icon, where nobody sees it until something looks odd. This
is the stale-build problem inverted: the usual failure is installing older code
than you wrote, and this one installs code nobody has finished writing.

Caught before it happened because the implementer checked `git status` rather
than assuming, found another session's `Icon.tsx` modified, and refused to
build. That refusal was worth more than the seven minutes it cost.

**And the reverse: "the tree is clean" has a shelf life of seconds.** The
manager checked, found it clean, and told the implementer to build. By the time
that message was read, the implementer had started the next item and the tree
had three modified files and a failing typecheck. Nobody was wrong; the fact
had simply expired in transit.

The same thing happened twice with the artist's state, who was twice reported
as having uncommitted work they had already committed.

**So:**

1. **Never state another session's tree state as current.** Quote the commit
   you saw it at - "clean at `1f70729`" - so the reader can tell whether it
   still holds. An unqualified "the tree is clean" is a claim about a moment
   that has already passed.
2. **Re-check immediately before you act**, not when you decide to act. Any
   instruction that depends on tree state is conditional on the state at
   execution: treat "build now" as "build when `git status` is clean, and check
   first".
3. **Never build while anyone else has edits in flight.** Ask, or wait for
   them to commit. Committing is cheap and a WIP commit on the branch can be
   amended; a shipped installer cannot be recalled from the user's desktop.
4. **`git pull` before auditing anyone**, and prefer `git log` over the file
   system for what someone has done. A file's state is shared and momentary;
   a commit is neither.

**Do not rely on the typecheck gate to stop a bad build.** `npm run dist` runs
`npm run build`, which runs `npm run typecheck` first, so a tree with a *type
error* cannot produce an installer. That is worth keeping and worth not routing
around by calling `electron-builder` directly.

But it is not the protection it looks like, and this document said it was for
about an hour. The gate catches types; it does not catch **incompleteness**.
In-flight work spends most of its life compiling perfectly well while being
half-wired, and an IPC surface connected on one side and not the other
typechecks fine - `preload` exposing a channel nothing sends, a renderer
subscribing to an event never emitted, a handler that silently does nothing.
Caught 2026-11-05 by the artist session: the same three modified files that
failed typecheck at one moment passed it twenty minutes later, still
unfinished. Had anyone built in that window it would have packaged and
installed in silence.

That is the worse case, not the better one. A build that breaks announces
itself; a build that quietly ships someone's half-finished edit to the user's
desktop icon shows up later as behaviour nobody can trace to a source, which is
the "a day was lost to a stale build" entry in `CLAUDE.md` wearing a different
hat - and `App.tsx` is the timer window, which is the one the user films.

**The only real precondition for packaging is a clean tree.** Check
`git status` immediately before, and if it is dirty, the session that owns
those files commits or stashes them. Do not reach into another session's
in-flight work to unblock your own build.

## Editing in a shared checkout

- **Prettier runs after every change, so exact-match patches go stale.**
  Re-read the region immediately before patching by exact string. In a shared
  tree it may also have gone stale because another session touched the file.
- **Large heredocs fail** with `unexpected EOF while looking for matching
  quote` and write nothing. Split into two appends, and check the file after.
- **Backslash escapes collapse in transit.** `\b` has arrived in a file as a
  literal backspace that silently matches nothing. Prefer `[^a-z]` over `\b`,
  and read the line back.
- **No new npm dependency without the manager.** npm 11 blocks install
  scripts, and Electron's postinstall is what downloads the 246 MB binary;
  `package.json` carries `allowScripts` for this reason. A careless install
  yields an app that cannot start.
- **Migrations are append-only.** Never edit one that has run. Only the
  manager adds them, because a migration is the one change that cannot be
  reverted by editing code.

## Analytics rules that are easy to break by accident

- **Rates are only comparable within one unit.** Never chart, average or trend
  words per minute together with questions per minute. The UI must name the
  unit it is showing.
- **Time-of-day analytics cover app-recorded sessions only.** Imported rows
  carry a date and no clock time, because Hourglass's Start/End are countdown
  readings. A chart that silently includes them invents a working pattern.
- **Manual rows are remembered, not measured.** Weight or exclude them in
  anything about when focus happens, and never mix precise and remembered
  timings in one series without saying so.

## Handing work back

Finish with: what changed, which files you touched, how you verified it, what
you deliberately did not do, and anything you found that belongs to someone
else. Name files with full paths. If you believe another session's claim is
wrong, say which claim and what you checked - disagreement is useful, deference
is not.

---

## There are three `userData` folders. Only one is real.

Checked 2026-11-05. A build that resolves `userData` to the wrong one reads and
writes a database nobody is looking at, and reports an empty history with no
error at all - which is the most confusing failure this app can produce, and
one that has already wasted time here.

| Path under `%APPDATA%` | What it is | State |
| --- | --- | --- |
| `deep-work-tracker` | **The real history.** The installed app. | 2,474 imported + 3 app sessions |
| `deep-work-tracker-dev` | `npm run dev`. The only build any session may write to. | empty by design |
| `Electron` | Historical. A run from before `app.name` was set, so Electron used its own default. | `deepwork.db` exists, **15 pages, 0 sessions** |

`Roaming\Electron\deepwork.db` is dated 2026-09-23 01:58 - twenty-eight minutes
after the backup that proves 2,363 sessions existed in the real profile. It has
never held a row. It is worth knowing about for two reasons:

- It explains how a session can look at a perfectly healthy database and
  conclude the history is gone. It is not what caused the September loss - the
  rows were in `deep-work-tracker` and a backup taken at 01:30 proves it - but
  it is the same *shape* of confusion.
- `src/main/index.ts` now sets `userData` to `deep-work-tracker-dev` for an
  unpackaged build, before `whenReady`, because the path is fixed the first
  time anything resolves it. Nothing should reach `Electron` again. If a
  session ever finds rows there, **report it, do not merge it** - rows in a
  folder nothing writes to would mean the resolution order is wrong, which is
  a bigger problem than the rows.

Do not delete it without asking the user. It costs 146 KB and it is evidence.

# Handoff - manager session, 2026-11-05

State at shutdown, written into the repo because a session's own context does
not survive one.

## The database is full again, and the loss mode is closed

`AppData\Roaming\deep-work-tracker\deepwork.db` holds **2,474 imported + 3 app
sessions, 2,750.91 hours, 2023-03-27 to 2026-11-03, 36 projects**,
`quick_check: ok`, `page_count 89`, **and no `-wal` beside it**.

That last detail is the one that matters. In September the rows were committed
but lived only in `deepwork.db-wal`; the main file sat at `page_count 13`, an
empty schema, and 2,363 sessions went with the log. This time the rows are
checkpointed into `deepwork.db` itself, which is why its page count moved.

**Verified independently of the importer's own report**, by parsing the
spreadsheet and the database separately and comparing: 2,473 rows against
2,474 timed rows in the sheet, 2,749.8 hours against 2,750.9. The gap is one
row, found and explained below. **Closed on 2026-11-05**: the database was
re-imported through the fixed parser and now holds all 2,474, with the
recovered row at id 226 carrying a null `project_id`. Every imported row has `started_at IS NULL`,
as it must - a countdown reading cannot become a clock time.

## Why data was lost, as far as the evidence supports

Stated as findings and limits, because the honest answer has both.

**Proven.** The import succeeded: a backup CSV holds 2,363 rows
(`app:1, import:2362`). The main `.db` was afterwards at 13 pages, which
cannot hold 2,363 rows. So the rows existed, and existed only in the WAL.

**Not proven.** What removed the WAL. A clean close checkpoints it; a crash
leaves it and the next open replays it. It is only lost if separated from the
`.db` while nothing is running. Repeated `Stop-Process -Force` during install
cycles is the likeliest candidate and is documented in `CLAUDE.md`, but it
cannot be demonstrated from what survives. **Do not let a later session
present this as settled.**

**A latent hazard found while looking.** There are three historical `userData`
locations: `Roaming\Electron` (from before the app name was set, dated
2026-09-23 01:58), `Roaming\deep-work-tracker`, and
`deep-work-tracker-dev`. Both of the first and last are empty - 15 pages, zero
sessions - so neither holds lost history. But a build resolving `userData` to
`Roaming\Electron` would read and write a database nobody is looking at, and
report an empty history with no error. If a session ever sees rows there,
report it rather than merging it.

**Structural holes now closed**, each of which could produce silent loss
independently of which one actually fired:

| Hole | Closed by |
| --- | --- |
| Rows in the WAL, never in the `.db` | `checkpoint()` after every row-writing commit |
| A snapshot of a collapsed database spending a retention slot | `backupBlockedReason` refuses to write one smaller than the biggest retained backup |
| Retention binning the only real backup | `staleBackups()` never evicts the largest file, by a deliberately different mechanism so one bug cannot disable both |
| An import discarding rows that carry real timing | only a missing date skips a row now |
| A damaged file announcing itself as a random query error | `healthCheck()` at startup |
| A convenience read taking the timer down with it | `safely()` |

## Done

- The analytics data path, end to end: `analytics:get` -> `main/db/analytics.ts`
  (one SQL aggregation) -> `shared/analytics.ts` (streaks, week-over-week,
  sittings, fillDays) -> `preload.analytics.get`.
- `components/AnalyticsCharts.tsx` - `HoursOverTime`, `ByProject`,
  `PlannedVsActual`, `RateTrend`. Note the type import is aliased
  `PlannedVsActualPoint`, because a type and a component of one name collide.
- `components/Heatmaps.tsx` - `CalendarHeatmap` (rolling 53-week window, paged
  back a window at a time), `TimeOfDayHeatmap`.
- `scripts/analytics-check.ts` - 103 assertions, all passing.
- Two shared-maths fixes and the importer fix, all in commit `deeb0a4`.

## Half-done, and exactly where

**`AnalyticsTab` in `src/renderer/src/Dashboard.tsx` is still the placeholder
`<ul className="plan">` list.** Everything it needs exists and is committed;
nothing is wired to it. That is the single remaining step to a visible
Analytics tab:

1. `window.api.analytics.get()` in an effect; it resolves to `Analytics | null`.
   **Null means the read failed** - say so, do not render zeroes, because a
   zeroed payload reads as "you have never worked".
2. Accent via `useAccentSync`, passed to every chart.
3. Header figures from `totalHours`, `totalSessions`, `activeDays`,
   `calendarDays`, plus `streaks()` and `weekOverWeek()` with today's local
   date. Averages run over calendar days in range, not active days.
4. Then the four charts and two heatmaps.
5. The Analytics tab needs `.panel--wide`, as the Data tab does - `.panel` caps
   at 900px, a reading width, and the charts are cramped inside it.

**Then screenshot it against the real database.** The harness is
`scripts/shoot.ts`, and `CLAUDE.md` documents the pattern. This is not
optional politeness: screenshotting caught three faults in these very charts
that SSR and markup review both missed, including Recharts silently dropping
every other category tick.

## Known lint debt, not mine to fix silently

`npm run lint` exits non-zero: `scripts/analytics-check.ts:83` wants an
explicit return type (one **error**), plus prettier warnings there and one in
`src/main/db/analytics.ts`. Typecheck is clean. `npx prettier --write` on both
plus that return type clears it.

## Next after the tab

The MVP gate is the user's own: it must feel no different from Hourglass in
daily use. So after the tab renders, **rebuild and reinstall** - the desktop
icon is a snapshot with no link to the source, and a day was already lost to
them testing a stale build. Close the app gracefully first; never force-kill
it while it holds the database.
