# A hidden window has no clock: what `capturePage()` actually photographs

Implementer session, 2026-11-05. Companion to `artist-item8-ring-header.md`,
which found the effect. This file closes the question that file left open,
widens the mechanism, and records two of my own wrong calls so the next
session does not reach for them again.

## The short version

`scripts/shoot.ts` opens `show: false` windows. A window that is never shown
is never composited, and Chromium drives painting — and with it CSS
transition progression — off frames rather than wall-clock time.
`capturePage()` is one of the few things that asks a hidden window for a
frame.

So in a hidden window, until something forces a frame:

- a CSS transition stays pinned on the value it started from;
- a scroll position set from script is not reflected in what is captured;
- **painting** does not happen, which is what all of the above amounts to.

The harness now discards three captures 500 ms apart before keeping one.

**The rule to carry away:** in a hidden window the DOM and computed styles are
trustworthy; the pixels are not. Distrust the PNG, not the reading.

An earlier version of this file claimed React could not commit a state update
without a frame. That is wrong and is corrected in full below — believing it
would make probes harder rather than safer, because it would tell you to
disbelieve the readings that actually solve things.

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

## What is frame-gated, and what is not

I first probed ring mode and got `cardCls="card"`, `isRing=0`, and reported
that the class was missing from the app. It is not. `App.tsx` builds
`` `card${variant === 'ring' ? ' is-ring' : ''}` ``, and my probe simply never
clicked the variant toggle — I measured **bar mode** and called it ring. That
reading is evidence about my probe, not about the app or about React.

I then drew a second, wider conclusion from it — that `setVariant` cannot
flush in an uncomposited window, so the DOM itself is stale — and that is
**also wrong**. The artist disproved it directly. Their `ring-rest` case ran
on a freshly created hidden window on which `capturePage()` had *never* been
called: `loadFile`, wait, click the toggle, wait, read. Zero frames had ever
been composited, and it returned `cardClass: "card is-ring"`,
`head.opacity: "0"`, `anyHover: 0`. React committed and style resolution ran
with no frame in existence.

That is what React 18 should do: a `setState` inside a click handler is a
discrete update flushed at the end of the event, and the scheduler uses
`MessageChannel`, not `requestAnimationFrame`. Nothing in it is frame-gated.
Style recalculation is not frame-gated either.

So the boundary is narrower than I had it:

| | frame-gated? |
| --- | --- |
| React commit of a state update | no |
| DOM mutation, class changes | no |
| Style resolution / `getComputedStyle` | no |
| **CSS transition progression** | **yes** |
| **Painting, and therefore `capturePage()`** | **yes** |

**One caveat on "computed styles are trustworthy".** They report the current
value honestly, but if a transition is in flight that value is the frozen one.
My own harness probe, after clicking the toggle and waiting 900 ms, read
`cardCls="card is-ring"` — class applied, confirming the above — alongside
`headOp=1` and `anims=1`: a transition that had started and not advanced. The
artist's fresh-window case had already settled to 0. So a computed style is
accurate about *now*, and "now" can be the start of a transition that will
never move until something paints. Read it, but check `getAnimations()` before
treating it as the settled value.

**Consequence for anyone writing a probe:** read the DOM freely, before any
capture — those readings are sound, and they are what solved this. Distrust
the PNG, and distrust a computed style only while an animation is pending.

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
