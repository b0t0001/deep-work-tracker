# Installing over the app the user is using

Written 2026-11-05 after an install closed the app while the user was mid-
session. Nothing was lost, and the reason it was not lost is the app being
well designed rather than the procedure being safe.

## Ask the user before closing the app, every time

**"Yes, rebuild" is consent to the build. It is not confirmation that they
are not using the app right now.** The two arrive in the same message and are
easy to conflate.

The sessions announce builds to each other, and that protocol works — it
stops two of us packaging at once. It does nothing about the person actually
running the timer, who is not in the conversation and whose session is the
thing the whole project exists to record.

So: ask immediately before closing, not when the rebuild was requested. The
gap between those two moments is where a session starts.

This is the user's own instruction, given after the incident below.

## What happened, and why it cost nothing

The user was running `id 2478` — "Editing", a 20-minute timer stopped at
9m34s with `8 seconds edited` recorded — when an install closed the app.

It survived because **the stop prompt holds the window open for its
30-second undo banner**, so the session had already been written before
anything closed. That is `recordSession` firing on every finished run and the
undo window keeping the process alive, both working as designed.

Do not read that as "installs are safe during a session". Read it as one
specific design decision having covered one specific case.

## A graceful close can legitimately take 30 seconds

A 12-second timeout is not long enough and will make a correct guard refuse
to install. That happened here, and the guard was right: the app was holding
the window open for the undo banner, which is exactly what it should do.

- Wait at least 30 seconds before concluding a close has failed.
- **Never force-kill past it.** `CLAUDE.md` records what `Stop-Process
  -Force` cost on 2026-10-02: `-wal` and `-shm` left behind and
  `database disk image is malformed` on the next launch. The checkpoint on
  every write makes a kill *more* dangerous than it used to be, because
  truncating the WAL is precisely the moment to be interrupted during.
- A guard refusing to install is the system working. Lengthen the wait, do
  not weaken the guard.

## The launch-then-exit after an install

Two independent sightings on 2026-11-05, from two sessions: the app starts
after an install, answers briefly, then exits. A second launch works and it
has not recurred.

**Unexplained.** The leading guess is `requestSingleInstanceLock` racing an
install that has not finished finalising, and neither session demonstrated
it. Recorded as a pattern rather than a cause deliberately — writing the
guess down as the explanation is the mistake that cost this project an
afternoon at the other end of the same day, when a confident mechanism for
the ring-mode header turned out to be wrong three times running.

If it happens: relaunch. Do not conclude the install failed.

## The order that works

1. Build in a detached worktree, so nobody has to stop (see
   `implementer-never-package-a-dirty-tree.md`).
2. **Ask the user before closing their app.**
3. Close with `CloseMainWindow`, allowing 30 seconds.
4. Install, then launch; relaunch once if it exits immediately.
5. Verify against the installed artifact, not the build you made.
6. State the installed timestamp plainly, so nobody has to infer it.
