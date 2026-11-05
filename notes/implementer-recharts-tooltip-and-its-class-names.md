# The hours chart's tooltip, and four wrong readings on the way to it

Implementer session, 2026-11-05, spec item 15. Three findings: the cause of the
hours chart reporting the wrong day, a set of Recharts class names that produced
three confident measurements of the wrong element, and the Chromium switch
without which none of it can be measured twice.

## The cause

```tsx
<XAxis dataKey="tick" interval={0} tickLine={false} />
```

`Point.tick` is the axis *text*, and it is deliberately blank on every bucket
that does not carry a label - the comment on the field said so: "Pre-labelled;
blank elsewhere so Recharts cannot thin the wrong ones."

**A category axis deduplicates its domain.** With 56 days of which most have
`tick: ''`, the domain collapses to the three or four values that have text.
d3's ordinal scale keeps the first occurrence, so every blank-tick day resolves
to the position of the *first* blank day.

The fix keys the scale on `from`, which is `isoDate(key)` and unique per
bucket, and moves the thinning into a `tickFormatter` that looks the text up.
The axis prints exactly what it printed before - verified, both builds read
`["11 Sep","20 Sep","29 Sep"]` - and the scale now has 56 distinct bands.

## Why it was invisible

**A band scale draws by index and resolves tooltips by value.** The area, the
value labels and the axis text are all placed by index, so the chart looked
correct - in screenshots and to the eye. Only the tooltip goes through the
scale by value, and only hovering it showed anything was wrong.

That is why this survived a screenshot pass. Add it to the list of things a
capture cannot see: the project already knew a hidden window cannot be trusted
and that reading JSX predicts nothing about layout. This is the third kind -
**a chart can be drawn correctly and still be wired up wrongly**, and no
still image of it will ever say so.

## The measurements

`scripts/hours-tooltip-check.ts`, which drives its own window through
`webContents.debugger` and samples 24 positions across the plot. Each build run
twice; the two runs agreed exactly.

| build | answered | named the day under the pointer | distinct days |
| --- | --- | --- | --- |
| `dataKey="tick"` | 22-24 / 24 | **3-4** | **4** |
| `dataKey="from"` + formatter | 24 / 24 | **24** | **24** |

The shape of the failure, left to right across the plot:

```
HEAD   #..xxxxxxxxxxxx#xxx#xxxx
fixed  ########################
```

One hover on the old axis reported `09/12/2026` while the active dot sat
1,070px away from the pointer.

## Four wrong readings, three of them from class names

Each was carefully measured and each was of the wrong element. Recorded because
the names are genuinely misleading, not because anyone was careless.

| Selector | What I took it for | What it is |
| --- | --- | --- |
| `.recharts-cartesian-axis-tick` | an axis tick, so the band count | the tick **line** group - 56 of them, all empty because `tickLine={false}` |
| `.recharts-cartesian-axis-tick-value` | the tick text | nothing; it does not exist in Recharts 3.x |
| `.recharts-xAxis .recharts-cartesian-axis-tick-label` | the x tick labels | nothing - the label groups are **not** descendants of `.recharts-xAxis` |

The tick text is a `<text>` whose parent carries
`recharts-cartesian-axis-tick-label`, reachable from the chart wrapper but not
under `.recharts-xAxis`.

What those produced, in order: "56 bands now, up from 3" (tick lines, and the
count is 56 in both arms, so the number proved nothing); then "zero tick labels,
the axis is dead" (wrong selector - the axis was fine, and I nearly abandoned a
working fix on it); then a before/after comparison whose **two arms used
different selectors** and so could not be compared at all.

**The rule that would have caught all three:** a count that is identical in
both arms is not evidence. 56 tick-line groups before and 56 after should have
been the tell - the thing I claimed to be measuring was supposed to change.

The practice that did catch them: one probe, run against both builds, rather
than a probe per build. Writing the comparison as a single script forces the
selectors to be identical. That is now what the committed check is.

## The fourth: an instrument that gave two different answers

The worst of the four, because it was not a selector mistake and nothing about
it looked wrong.

**Chromium marks a covered window occluded and treats it as hidden, and a
hidden page does not run the hover state.** An identical sweep against the
same build gave **29/60 responses in one run and 0/48 in the next**. Both were
real readings. Neither meant anything.

It was mid-diagnosis, so each run looked like evidence about the fix: the first
said the fix worked on half the chart, the second said it had broken the chart
outright. I spent a hypothesis on a stale layout and another on an overlay
stealing the pointer - and hit-tested the overlay idea, which disproved it -
before noticing the readings were not stable enough to support any hypothesis.

```ts
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
```

With those, two runs per build agree exactly. **Check that an instrument
repeats before believing what it says** - and when two runs disagree, stop
forming hypotheses about the subject, because the thing that needs explaining
is the instrument.

## Harness notes

- **Bound every CDP call.** A response that never arrives leaves the await
  pending for ever and the run produces no output at all - worse than a
  failure, which at least says where it got to. One unbounded call cost a 180s
  timeout and an empty log.
- **Do not pipe a slow run through `tail`.** It buffers to EOF, so a stuck run
  looks identical to one producing nothing. Redirect to a file.
- **Put the navigation inside the probe.** Clicking through to the tab from a
  separate script meant the sampler once ran against a page that was not on
  Analytics. It threw on a missing wrapper, which is the good failure, but a
  step you have to remember is a step that gets forgotten.
- **Drive input through the debugger, not a remote port.** `webContents.debugger`
  needs no port, no second process and no wait for the port to open; a
  synthetic `dispatchEvent` does not drive hit-testing at all and cannot tell
  a working tooltip from a broken one.
- Each input-and-read round trip costs about 2s here. 48 samples is a minute
  and a half - budget for it rather than diagnosing a hang.

## See also

- `implementer-contextbridge-cannot-be-faked.md` - the same "true reading of
  the wrong thing" pattern, and the rule it produced: assert the artifact is of
  what you think it is before reading what it says.
- `implementer-hidden-window-capture.md` - a hidden window does not paint; the
  occlusion switch above is the same hazard arriving through a window that
  looks visible.
