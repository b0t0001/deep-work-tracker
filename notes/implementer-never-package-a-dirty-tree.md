# `npm run dist` packages the working tree, not `HEAD`

Implementer session, 2026-11-05. Near-miss rather than an incident: it was
caught twice in one hour, from two directions, and shipped nothing either
time.

## The rule

**Never package while `git status --porcelain` is non-empty — whoever owns the
dirt.**

And check it in the *same command* that builds, not before deciding to build:

```sh
if [ -n "$(git status --porcelain)" ]; then echo "ABORT: tree dirty"; git status --porcelain; exit 1; fi
npm run dist
```

That form has no gap to go stale in. Every other form does.

## Why it matters here specifically

`electron-builder` bundles whatever is on disk. The installed app under
`AppData\Local\Programs` is a snapshot with no link back to source, and the
user tests from the desktop icon. So a half-finished file that happens to be
saved when someone runs `npm run dist` lands on their desktop and stays there
until the next installer, with nothing on screen connecting the two.

Three sessions share this checkout, so at any moment the tree is likely to
hold somebody's in-flight work. Twice on 2026-11-05 a build was about to go
out over a file its owner was still editing:

- once over the artist's `Icon.tsx`, stopped because `git status` was checked
  first;
- once over this session's own half-wired item 11 — `main/index.ts`,
  `preload/index.ts`, `App.tsx` — flagged by the artist.

`App.tsx` is the timer window, which is the one the user films.

## The typecheck gate does not protect you

This was believed and is false. `dist` runs `build`, which runs `typecheck`
first, so the reasoning was that a broken tree cannot produce an installer.

The gate catches types. It does not catch incompleteness, and the two are not
the same thing. Item 11 is the proof, because it was all three of these at
once and typechecked clean for as long as it was broken:

- a preload channel that nothing sends to,
- a renderer subscribing to an event that never arrives,
- a handler that silently does nothing and resolves successfully.

A build that fails announces itself. A build that ships half-finished work
does not, and surfaces later as behaviour nobody can trace to a commit. The
silent case is the worse one, and it is the case the gate lets through.

**The only real precondition for packaging is a clean tree.**

## The part that generalises past packaging

On 2026-11-05 four sessions produced five contradictory readings of this
tree's state inside an hour, every one of them honest and every one of them
stale by the time it was read:

- "the tree is clean, build now" — had expired in transit;
- "you have three files uncommitted" — they were committed and pushed;
- "`Icon.tsx` is uncommitted" — it had landed in `40fd7d2`;
- "a type error means `dist` cannot build" — it passed minutes later;
- "`is-ring` is on no element" — a true reading of the wrong state.

The fix is not more careful checking. Everyone *was* checking. The thing being
described changes faster than a message takes to write, so tree state cannot
survive being passed between sessions at all.

So: **do not accept another session's report of the tree as a precondition for
anything.** Read it yourself, at the moment of use, inside the command that
depends on it. Quote the commit you observed state at (`git fetch` first —
local `HEAD` is itself a stale reading of the branch), and prefer `git log`
over the file system for what someone has done, because a commit is durable
and a modified file is a snapshot of a moment.

The same failure in a different hat: a probe that reads the DOM before
confirming it reached the state it means to measure. See
`implementer-hidden-window-capture.md` — a true reading of the wrong state
looks exactly like a false reading of the right one.

## The escape hatch: build from a worktree, not the shared tree

Added 2026-11-05 after the rule above blocked a build twice in ten minutes.

The rule is right and it has a cost: with three sessions in one checkout, a
clean tree is a rare and short-lived condition, and "wait for everyone to
stop" is not a plan. There is no need to wait.

```sh
WT=<somewhere outside the repo>
git worktree add --detach "$WT" HEAD
cmd //c mklink //J "$WT\node_modules" "<repo>\node_modules"   # Windows
cd "$WT" && npm run dist
git worktree remove --force "$WT"
```

A detached worktree at `HEAD` is a clean checkout of exactly what is
committed. It cannot see the shared working tree, so nobody's in-flight edits
can reach the installer and nobody has to stop. The junction means no second
`npm install` and no second 246 MB Electron download.

Two cautions, both learned here:

- **`rm -rf` on a Windows junction can recurse into the target.** Remove the
  worktree with `git worktree remove --force`, and if you do delete the
  junction by hand, check `node_modules` afterwards. Losing it is recoverable
  but slow, and `npm install` needs the `allowScripts` approval or you get an
  Electron that cannot start.
- **`git worktree prune` afterwards**, so the repo does not accumulate
  registrations pointing at deleted temp directories.

This was first used to ship SPEC item 12a while the artist was mid-way
through a typography change. Worth knowing that the blocking work was reverted
minutes later, so waiting would in fact have been short — but that was not
knowable at the time, and the tree had already moved under a decision twice in
five minutes.

## The same bug one level down: `npm run shoot` does not rebuild

`npm run shoot` renders whatever is in `out/`. It does not build it. So
editing a component and shooting produces a real screenshot of a real page —
of the previous build.

This fired on 2026-11-05: a shot of the week tile showed the old figure with
total conviction, minutes after the change that altered it. It was caught only
because the expected number was known in advance. An unpredicted result would
have been read as the change not working.

`scripts/shoot.ts` now refuses to run when any file under `src/renderer`,
`src/preload` or `src/shared` is newer than `out/renderer/index.html`, naming
the file that is ahead. `--stale-ok` is there for deliberately shooting an old
bundle. It refuses rather than warns because a warning scrolls past and the
whole failure mode is a result that looks correct.

One implementation note, since it cost a 200-second hang: **do not `throw` at
module scope in an Electron main process.** It does not exit the way it would
under plain Node. Print and `process.exit(1)`.

## The pattern behind all of these

Stale installed app, stale `out/` under the harness, a capture taken before
the frame settled, a probe that read bar mode and reported it as ring, a
`:hover` left stuck by an earlier synthetic click, a tree reading that expired
in transit. Six distinct bugs on one day, one shape:

> The artifact is real, and it is of something else.

None of them is caught by looking harder at the artifact, because the artifact
is not lying. They are caught by asserting that it is of what you think it is
— which is a check you can write down, not a thing to remember.
