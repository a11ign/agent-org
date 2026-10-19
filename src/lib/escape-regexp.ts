// no-token: none -- escapes text for a regular expression; nothing here reaches `gh`, `herdr` or `git`

/** The text with each character a regular expression reads as syntax backslashed, so it matches itself. PURE. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
