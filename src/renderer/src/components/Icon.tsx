/**
 * Inline SVG rather than unicode glyphs: symbol characters render
 * inconsistently across fonts and some turn into colour emoji, which would
 * look wrong in footage. These inherit currentColor and stay crisp at any size.
 */
export type IconName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'ring'
  | 'bar'
  | 'expand'
  | 'collapse'
  | 'settings'
  | 'minimize'
  | 'close'

const PATHS: Record<IconName, React.JSX.Element> = {
  play: <path d="M5 3.5v9l8-4.5z" />,
  pause: <path d="M5 3.5h2.2v9H5zm3.8 0H11v9H8.8z" />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />,
  ring: <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />,
  bar: <rect x="2.5" y="6.5" width="11" height="3" rx="1.5" />,
  expand: (
    <path
      d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  collapse: (
    <path
      d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  settings: (
    <path
      d="M8 5.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM7.1 1.5h1.8l.3 1.7 1.3.5 1.4-1 1.3 1.3-1 1.4.5 1.3 1.7.3v1.8l-1.7.3-.5 1.3 1 1.4-1.3 1.3-1.4-1-1.3.5-.3 1.7H7.1l-.3-1.7-1.3-.5-1.4 1-1.3-1.3 1-1.4-.5-1.3-1.7-.3V7.1l1.7-.3.5-1.3-1-1.4 1.3-1.3 1.4 1 1.3-.5z"
      fillRule="evenodd"
    />
  ),
  minimize: <rect x="3" y="7.4" width="10" height="1.4" rx="0.7" />,
  close: (
    <path
      d="M4 4l8 8M12 4l-8 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  )
}

export default function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
