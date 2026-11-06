/**
 * One panel's own range control.
 *
 * The tab had a single `Averages over` picker at the top and the user
 * rejected it in those terms: "every single PANEL needs to have a timescale
 * control dropdown somewhere that will change how the data is viewed! it
 * shouldn't be one central control". So this is the control, and it appears
 * once per panel rather than once per tab.
 *
 * The argument the central control was built on - that one definition of "the
 * past 8 weeks" cannot disagree with itself - is kept where it actually
 * matters: every one of these reads the same `WINDOWS` list and resolves
 * through the same `windowRange`, so two panels set to the same period cover
 * exactly the same days. What is no longer shared is which period each panel
 * is *set* to, which is the thing the user wanted back.
 *
 * **Every picker offers every option.** Panels used to narrow the list for
 * defensible local reasons - the calendar dropped the shortest windows, the
 * comparison box offered five of eight - and together those made no two
 * dropdowns alike: *"every timescale dropdown should have the same presets"*.
 * Where an option genuinely cannot apply it is rendered **disabled with the
 * reason as its tooltip**, so the list is visibly the same list and the
 * exception is something you can see and hover rather than something missing.
 *
 * **Quiet by construction.** No border and no fill at rest, dim text at the
 * caption's size, and it only acquires an outline on hover or focus. A
 * bordered select in every panel head would put eight boxes on a page whose
 * job is to show figures, and the figures have to stay the loudest thing on
 * it.
 */
import { parseSpan } from '@shared/span'
import { CUSTOM_WINDOW, WINDOWS, type WindowId } from '@shared/windows'

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
.an-range option:disabled {
  color: var(--text-dim);
}

/* The typed span sits beside the select rather than under it: the panel head
   is a single line and a second row would push the chart down every time
   Custom is chosen. The error goes under the field, which is the only place
   there is room for a sentence. */
.an-range__custom {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
}
.an-range__custom input {
  width: 8.5em;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  padding: 2px 6px;
}
.an-range__custom input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.an-range__custom input.is-bad {
  border-color: #fca5a5;
}
/* Absolute, so a message appearing does not change the height of the panel
   head and shove the chart down a line while you are still typing. */
.an-range__problem {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 3px;
  color: #fca5a5;
  font-size: 10.5px;
  white-space: normal;
  width: 17em;
  text-align: right;
  z-index: 3;
}
`

/**
 * `disabled` names the options this panel cannot answer, with the reason.
 *
 * A map rather than a list of ids, because the reason is the point: an
 * option that is simply greyed out is more confusing than one that is
 * missing, and the tooltip is what turns it back into information.
 */
export function RangePicker({
  value,
  onChange,
  label,
  disabled,
  customText,
  onCustomText
}: {
  value: WindowId
  onChange: (next: WindowId) => void
  /** Read by a screen reader, so it names the panel: "Range for Hours by project". */
  label: string
  disabled?: Partial<Record<WindowId, string>>
  /** What this target's Custom field holds, as typed. */
  customText?: string
  onCustomText?: (next: string) => void
}): React.JSX.Element {
  /*
   * Fully controlled, with no local copy.
   *
   * The first version kept the text in `useState` and synced it from the
   * prop in an effect, on the reasoning that writing every keystroke to the
   * layout would re-render the tab. That reasoning was wrong, because it
   * wrote every keystroke to the layout anyway - the local copy bought
   * nothing and cost a prop-to-state effect, which is the pattern the
   * `react-hooks/set-state-in-effect` rule exists to catch. One source of
   * truth, and the stored text is it.
   */
  const typed = customText ?? ''
  const parsed = parseSpan(typed)
  const isCustom = value === CUSTOM_WINDOW

  return (
    <span className="an-range">
      <style>{RANGE_PICKER_CSS}</style>
      <select
        value={value}
        aria-label={`Range for ${label}`}
        onChange={(event) => onChange(event.target.value as WindowId)}
      >
        {WINDOWS.map((option) => {
          const why = disabled?.[option.id]
          return (
            <option key={option.id} value={option.id} disabled={why !== undefined} title={why}>
              {/* Capitalized here rather than in `WINDOWS`, whose labels are
                  written to read after "over the" in a sentence. A dropdown
                  is not a sentence. */}
              {option.id === CUSTOM_WINDOW
                ? 'Custom…'
                : option.label.charAt(0).toUpperCase() + option.label.slice(1)}
            </option>
          )
        })}
      </select>
      {isCustom && onCustomText !== undefined ? (
        <span className="an-range__custom">
          <input
            value={typed}
            aria-label={`Custom range for ${label}`}
            placeholder="45 days"
            className={parsed.problem === '' ? undefined : 'is-bad'}
            onChange={(event) => {
              /*
               * Stored on every keystroke, valid or not.
               *
               * The alternative - storing only what parses - loses the text
               * the moment it is half-typed, so switching panels mid-word
               * discards it. What is stored is text; what is *applied* is
               * the parse, and an unreadable span resolves to all time with
               * the reason shown here. Nothing is silently substituted.
               */
              onCustomText(event.target.value)
            }}
          />
          {parsed.problem === '' ? null : (
            <span className="an-range__problem" role="status">
              {parsed.problem}
            </span>
          )}
        </span>
      ) : null}
    </span>
  )
}
