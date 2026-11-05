# A preload bridge of the wrong shape has exactly one catcher

Implementer session, 2026-11-05. The most reusable thing learned on a day
that produced a lot of lessons, and the one worth reading first if you are
about to test anything that crosses the preload boundary.

## The finding

**`contextBridge` freezes what it exposes, so you cannot replace a channel
method from the renderer to test what happens when it fails.** Measured on
the running app:

```
Object.isFrozen(window.api)                                true
Object.isFrozen(window.api.layout)                         true
Object.getOwnPropertyDescriptor(window.api.layout, 'set')  { writable: false,
                                                             configurable: false }
```

Assigning `window.api.layout.set = () => Promise.reject(...)` **does not
throw**. In non-strict code it is silently ignored, and reading the property
back gives you the original function. The test then runs against a perfectly
healthy channel and reports that nothing went wrong, which is exactly what it
would report if the fix were broken.

That nearly recorded a working safety fix as broken. The sequence was: make
the write reject, press the button, observe no warning, conclude the flag
does not fire. Every step was correctly executed. Nothing had been broken.

**If you need a channel to fail, break it on the far side of the bridge** —
in a harness that owns the `ipcMain.handle`, as `scripts/persists-check.ts`
and `scripts/record-failure-check.ts` both do.

## Why this matters more than it looks

The episode that cost this project an afternoon was a preload bridge of the
**wrong shape**: the renderer declared `set(layout: Layout)` while preload
declared `set(json: string)`. Every write threw in the main process, the
rejection was swallowed by a `catch` that exists for good reasons, and the
"Not saved" warning could not fire because it was checking that the functions
*existed*.

Three defences were then built, and it is worth being precise about which one
covers that case:

| Defence | Catches |
| --- | --- |
| `persists` meaning "a write succeeded" | a handler that throws at runtime |
| a harness that throws in `ipcMain` | a handler that throws at runtime |
| **removing the `as unknown as` cast** | **a bridge of the wrong shape** |

The first two cover a *handler that fails*. Neither can reach a *shape
mismatch*, because the renderer cannot substitute a differently-shaped
channel to find out — the bridge is frozen. A shape mismatch also produces no
runtime symptom that a test could assert on until a real write happens with
real arguments.

So: **deriving the channel type from `DeepWorkApi` instead of casting is the
sole remaining defence against the specific failure that actually happened
here.** It is not a tightening. If the cast comes back, nothing else in the
codebase is watching for that class of fault.

Verified the way it should be, by reintroducing the old string contract in
preload and watching the compiler object:

```
src/renderer/src/lib/layout.ts(96,13): error TS2345:
  Argument of type 'Layout' is not assignable to parameter of type 'string'.
```

## The thing all of today's mistakes had in common

Four instances between two sessions in one afternoon, each a **true reading
of the wrong thing**:

| What was measured | What it was actually of |
| --- | --- |
| `.recharts-text` font size | a chart *label*, not an axis tick |
| the dial, clean and unclipped | a window that was not at its minimum size |
| "no warning after a failed read" | a state a later successful write had cleared |
| `--clock`, set and having no effect | a variable ring mode overrides elsewhere |

Add the frozen-bridge override above and it is five. Every one was carefully
executed by someone who knew the trap existed — two of them by the person
writing the rule about it, while writing it.

**That is the argument for mechanical checks rather than careful ones.** Care
is not the variable. The checks that actually worked today were the ones with
no judgement in them: a clean-tree test inside the build command, a harness
that refuses to run against a stale bundle, a compiler comparing two halves
of an interface, and a deliberate break to prove a safeguard can see.

The rule that falls out, and the one to apply before trusting any
measurement:

> **Assert that the artifact is of what you think it is, before reading what
> it says.**

For a probe: confirm you reached the state you mean to measure. For a
capture: confirm the bundle is current. For a test that breaks something:
**confirm the break took.**

## See also

- `implementer-hidden-window-capture.md` — frames, and what a hidden window
  does not do
- `implementer-never-package-a-dirty-tree.md` — the worktree escape hatch and
  the stale-tree table
- `AGENTS.md` — the consolidated table, including "the fix is present and the
  effect is absent"
