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
