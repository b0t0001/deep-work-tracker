/**
 * One panel's own range control.
 *
 * The tab had a single `Averages over` picker at the top and the user rejected
 * it in those terms: "every single PANEL needs to have a timescale control
 * dropdown somewhere that will change how the data is viewed! it shouldn't be
 * one central control". So this is the control, and it appears once per panel
 * rather than once per tab.
 *
 * The argument the central control was built on - that one definition of "the
 * past 8 weeks" cannot disagree with itself - is kept where it actually
 * matters: every one of these reads the same `WINDOWS` list and resolves
 * through the same `windowRange`, so two panels set to the same period cover
 * exactly the same days. What is no longer shared is which period each panel
 * is *set* to, which is the thing the user wanted back.
 *
 * **Quiet by construction.** No border and no fill at rest, dim text at the
 * caption's size, and it only acquires an outline on hover or focus. A
 * bordered select in every panel head would put eight boxes on a page whose
 * job is to show figures, and the figures have to stay the loudest thing on
 * it. The chevron is the browser's, which is the one part of a native select
 * worth keeping: it says "there are other options" without a label saying so.
 */
import { WINDOWS, type WindowId } from '@shared/windows'

export const RANGE_PICKER_CSS = `
.an-range {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}
.an-range select {
  appearance: auto;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  padding: 2px 4px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease;
}
.an-range select:hover,
.an-range select:focus {
  border-color: var(--border);
  color: var(--text);
}
/* The options are drawn by the OS, which does not inherit the page's colors -
   without this the open list is black text on a light menu in a dark app on
   some Windows builds, and unreadable on others. */
.an-range option {
  background: var(--surface-raised);
  color: var(--text);
}
`

/**
 * `options` narrows the list where a window would be meaningless for a panel
 * rather than merely unusual - the calendar draws a year-wide grid, so "past
 * week" would be one square. Everything else gets the full ladder, because a
 * range someone asks for and cannot have is more annoying than a short list.
 */
export function RangePicker({
  value,
  onChange,
  label,
  options
}: {
  value: WindowId
  onChange: (next: WindowId) => void
  /** Read by a screen reader, so it names the panel: "Range for Hours by project". */
  label: string
  options?: readonly WindowId[]
}): React.JSX.Element {
  const list = options ? WINDOWS.filter((option) => options.includes(option.id)) : WINDOWS
  return (
    <span className="an-range">
      <style>{RANGE_PICKER_CSS}</style>
      <select
        value={value}
        aria-label={`Range for ${label}`}
        onChange={(event) => onChange(event.target.value as WindowId)}
      >
        {list.map((option) => (
          <option key={option.id} value={option.id}>
            {/* Capitalized here rather than in `WINDOWS`, whose labels are
                written to read after "over the" in a sentence. A dropdown is
                not a sentence. */}
            {option.label.charAt(0).toUpperCase() + option.label.slice(1)}
          </option>
        ))}
      </select>
    </span>
  )
}
