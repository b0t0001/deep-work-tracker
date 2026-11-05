# Item 8: the ring-mode CSS was never the bug

Artist session, 2026-11-05. Nothing in `main.css` was changed, because nothing
in `main.css` was wrong. The symptom was real; both mechanisms proposed before
this one were not.

Claims and inferences are kept apart below, because this item has now produced
three explanations and two of them were wrong.

## Measured

All on `out/renderer`, through a harness that opens no database. Every figure
here is a reading, not a deduction.

**1. There is no `backdrop-filter` on `.tools`.** `main.css:640` sets
`blur(8px)` on `.card.is-ring .tools` and siblings; `main.css:732` overrides the
same selectors to `backdrop-filter: none` under "controls as bare icons", later
in the file and therefore winning. Live, in ring mode: `backdropFilter: "none"`
on every header icon and on both `.tools` groups. Walking the chain from icon to
`<body>`: no `filter`, `mix-blend-mode`, `isolation`, `will-change` or `contain`
anywhere. Exactly one `.card__head` in the document, and the icons are inside
it.

**2. In a hidden window the class is applied and the computed style is correct,
while the pixels are stale.** On `show: false`, after clicking the variant
toggle and waiting 400 ms:

- `card.className` → `"card is-ring"`
- `.card__head` computed `opacity` → `0`
- `document.querySelectorAll(':hover').length` → `0`
- the PNG → all six icons painted at full strength

**3. The computed value moves across the capture.** With nothing hovered,
`.card__head` reads `opacity: 1` immediately *before* `capturePage()` and `0`
immediately *after* it. A variant forcing `opacity: 0.01` inline read back
`0.805752` after the capture — a value that exists only part way through a
transition.

**4. Three capture modes, same page, same bundle, nothing hovered:**

| mode | opacity before capture | after | icons in the PNG |
| --- | --- | --- | --- |
| hidden window, one `capturePage()` | 1 | 0 | **visible** |
| hidden window, capture, wait 400 ms, capture again | 1 | 0 | hidden |
| real visible composited window | 0 | 0 | hidden |

**5. On a composited window, with real pointer events**, ring mode behaves as
designed: at rest `opacity 0` and no icons painted; pointer over the middle of
the ring gives `opacity 1` and all six icons. Drag regions by `elementFromPoint`
plus the nearest ancestor that sets one: `125,180` (ring stroke) → `drag`;
`125,60` (dial interior) → `drag`; `14,12` (header band) → `no-drag`.

## Inferred

A `show: false` BrowserWindow is never composited, so nothing that depends on a
frame advances — not the compositor, and not the animation clock.
`capturePage()` forces one frame; the PNG is the state *before* that frame's
work is applied, and the catch-up happens behind it, which is why a reading
taken immediately afterwards disagrees with the picture.

Bar mode looked correct throughout, and that asymmetry is the strongest part of
the account because it predicts rather than explains: bar's `opacity: 0` sits on
`.tools` and is its value from first paint, so no transition ever runs and there
is no frame to freeze. Ring's sits on `.card.is-ring .card__head` with
`transition: opacity 160ms ease` and is reached by applying the class at
runtime.

## Two explanations that do not survive these readings

**`backdrop-filter` on `.tools` sampling the backdrop outside the ancestor's
opacity group.** Contradicted by measurement 1: the property resolves to `none`.

**`is-ring` never being applied, because React cannot commit without a frame.**
Contradicted by measurement 2: in a hidden window, after a click and a wait, the
class is present *and* the computed opacity is already `0`. React committed
without a composite — its scheduler does not wait on `requestAnimationFrame`.
What is stale is the painted frame, not the DOM.

That second account also predicts the wrong thing about measurement 3. If the
class had not been applied, there would be no `0.805752` to read back, because
the transition it belongs to would not exist.

## The fix, in `scripts/shoot.ts`

Discard the first capture. Landed by the implementer at `scripts/shoot.ts:420`.

Showing the window instead also works but is worse: `capturePage()` on a window
positioned fully off-screen fails with `UnknownVizError`, so it would have to be
visible on the user's desktop.

## What this invalidated elsewhere

Every shot whose `drive` script changed state was capturing a pre-transition
frame. Three separate "faults" turned out to be this harness rather than the
page:

- the ring header (this item);
- the Analytics tab's empty series — the charts render fully once the capture
  is settled;
- the **Settings tab rendering white while inactive**. Measured on a settled
  capture, peak text luminance across the tab row is Settings 145, Data 147,
  Import 150, Analytics 250, against `--text-dim #8b919c` = 145 and
  `--text #f2f4f7` = 243. All three inactive tabs are at the dim token and the
  CSS is correct. `.tab` carries `transition: color 120ms ease`, and the active
  tab moves off Settings when the harness clicks another, so a frozen frame
  catches Settings part way back from white.

A scroll also does not reach a single capture: the same shot captured once shows
the top of the tab, and captured twice shows the scrolled position.

## Still open

Nobody has looked at the **installed build** in ring mode at rest. Both the
original claim and this refutation came from harnesses. Thirty seconds at the
real window closes it, and it is worth doing because this is the component the
user films and it has produced three real bugs and one phantom.
