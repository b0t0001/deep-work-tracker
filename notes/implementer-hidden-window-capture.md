# A hidden window has no clock: what `capturePage()` actually photographs

Implementer session, 2026-11-05. Companion to `artist-item8-ring-header.md`,
which found the effect. This file closes the question that file left open,
widens the mechanism, and records two of my own wrong calls so the next
session does not reach for them again.

## The short version

`scripts/shoot.ts` opens `show: false` windows. A window that is never shown
is never composited, and Chromium drives both CSS transitions and React's
commit loop off frames rather than wall-clock time. `capturePage()` is one of
the few things that asks a hidden window for a frame.

So in a hidden window, until something forces a frame:

- a CSS transition stays pinned on the frame it started from;
- a React state update **does not commit**, so the DOM itself is stale;
- a scroll position set from script is not reflected in what is captured.

The harness now discards three captures 500 ms apart before keeping one.

## Item 8 is closed: it was never an app defect

This is what `artist-item8-ring-header.md` lists under "Still open" — nobody
had looked at the installed build. Done now.

Installed build, real composited window, driven over CDP with
`--remote-debugging-port=9222`, nothing hovered in any reading:

| | `.card` className | `.card.is-ring` count | `.card__head` opacity |
| --- | --- | --- | --- |
| at rest (bar, the default) | `card` | 0 | — |
| after clicking the variant toggle | `card is-ring` | **1** | **0** |

`document.getAnimations()` was 0 and `:hover` was empty. The class applies and
the CSS hides the header correctly. **There is no app defect and nothing in
`main.css` needed changing.** The window was restored to bar afterwards.

Three mechanisms were proposed for item 8 over two days. All three were wrong
and the symptom was real every time:

1. `backdrop-filter` on `.card.is-ring .tools` escaping the opacity group —
   wrong, and checkable without running anything: a later rule in `main.css`
   sets it back to `none`.
2. Mine: `is-ring` is applied to no element, so the 46 `.card.is-ring` rules
   are dead — wrong, see below.
3. A frozen CSS transition — right about the cause, incomplete about reach.

## One discarded capture is not enough

The artist's write-up suggests capture / wait 400 ms / capture again. Applied
exactly, through the real `shoot()` path on the committed
`timer-ring-running` shot, **it did not work** — the icons were still painted.
Three captures 500 ms apart cleared it and the header came back empty.

I did not chase why that differs from their probe; three captures are cheap
and one demonstrably is not. The thing worth remembering is that a single
discard *looks* sufficient and is not, which is the worst shape a fix can
have.

## The mechanism reaches further than CSS: React does not commit either

I probed ring mode and got `cardCls="card"`, `isRing=0`, and reported that the
class was missing from the app. It is not. `App.tsx` builds
`` `card${variant === 'ring' ? ' is-ring' : ''}` ``, and my probe simply never
clicked the variant toggle — I measured **bar mode** and called it ring.

But the correction is more interesting than the mistake. Even a probe that
*does* click the toggle reads a stale DOM: `click('.icon')` calls
`setVariant`, and in an uncomposited window that state update has no frame to
commit on. Measured, in the harness, after clicking the toggle and waiting
900 ms: `cardCls="card is-ring"`, `anims=1` — the class had landed and the
transition was in flight but frozen. Earlier, with a shorter path, the class
had not landed at all.

The proof that the app was always fine is the artist's own result rather than
any reading of the source: if the app never applied `is-ring`, extra frames
could not have fixed the PNG. Frames are what let React commit.

**Consequence for anyone writing a probe:** reading the DOM in a hidden window
after a state change is unreliable. Force a frame first, and prefer a reading
taken after a capture to one taken before it.

## What this did *not* affect: the Analytics charts

Worth stating plainly, because the alarm when this was found was that every
Analytics screenshot might be showing Recharts at frame zero.

`dash-analytics-tall`, shot against the real history, is **byte-identical —
same md5 — with zero, one and three discarded frames.** Nothing on that tab
depends on a CSS transition, and the Recharts series all carry
`isAnimationActive={false}`, so there was never a clock to freeze. The item 5
evidence stands on its own and never depended on the harness fix.

The same holds for `dash-data-unlabelled`: identical md5 across one and three
discards.

This is also the general rule the fix rests on — a settled page captures the
same either way, so the extra frames only change the pages that have
something in flight. It is insurance, not a correction.

## A correction to `dd7bb41`'s commit message

That commit says the old `dash-analytics-foot` shot's `window.scrollTo`
"succeeded, moved nothing". That is probably wrong in mechanism. The artist
measured that a scroll *does* take effect but is not reflected in a single
capture — captured once shows the top, captured twice shows the scrolled
position. So the scroll likely worked and the capture was stale, which is this
same bug rather than a second one.

The resolution stands for a different reason than the one I gave: the shot is
now a 1280x1900 window that holds the whole tab with nothing scrolled, and a
shot that never scrolls cannot be wrong about where it scrolled to. Prefer a
window taller than the content over driving a scroll, in a harness where the
scroll position is this hard to verify.

## Also explained by this, so nobody re-reports them

- The **Settings tab rendering white while inactive** — I reported this as a
  CSS fault from a screenshot. The artist measured peak text luminance on a
  settled capture at Settings 145, Data 147, Import 150 against
  `--text-dim #8b919c` = 145. All three inactive tabs sit on the dim token;
  the CSS is correct. `.tab` has `transition: color 120ms ease` and a frozen
  frame catches Settings part way back from white.
- The Data tab capturing **"Loading..."** was *not* this bug. That one was a
  real 400 ms wait against a 2,477-row query, and raising it to 2500 ms fixed
  it. JavaScript timers and IPC run normally in a hidden window; only the
  frame-driven things stall. Worth keeping the two apart.
