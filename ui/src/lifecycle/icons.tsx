/** The alert icon of the boards' danger banners: a ring with an exclamation mark, in the danger colour. */
export function AlertIcon() {
  return (
    <svg className="alert-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle className="alert-icon-stroke" cx="8" cy="8" r="6.5" strokeWidth="1.4" />
      <path className="alert-icon-stroke" d="M8 4.8v4" strokeWidth="1.4" strokeLinecap="round" />
      <circle className="alert-icon-fill" cx="8" cy="11.2" r="0.9" />
    </svg>
  );
}
