// @ts-check
// module: a pull request's address as the board names it (PURE)

/** A pull request's address as the board names it: `owner/repo #number`, read off its url (A11-119). */
export function pullLabel(url: string): string {
  return url.replace("https://github.com/", "").replace("/pull/", " #");
}
