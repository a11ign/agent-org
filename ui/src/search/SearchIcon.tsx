/** The boards' magnifier, in the colour of the text around it: 14px on the sidebar's button, 16px in the palette's box. */
export function SearchIcon({ size = 16 }: Readonly<{ size?: 14 | 16 }>) {
  return (
    <svg className="search-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
