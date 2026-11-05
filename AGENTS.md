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

## Before adding any control that overlays the dial

Electron resolves overlapping drag regions by **document order, not
`z-index`**. This has broken the build three separate times, always the same
way: a control declared before the surface it sits on renders, highlights in
devtools, and never receives a click.

Any interactive element overlapping a draggable surface must be the **last
sibling** in its container, with visual order fixed by flexbox `order`. The
full checklist and the symptom-to-cause table are in `CLAUDE.md`; read them
before writing the JSX, not after the click fails to fire.

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
