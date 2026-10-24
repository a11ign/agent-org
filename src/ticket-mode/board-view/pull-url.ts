// @ts-check
// module: the repository and number of a GitHub pull request, from its address -- PURE

/** The repository and number of a GitHub pull request, from its URL's `/<owner>/<repo>/pull/<n>`, or null for any other URL. PURE. */
export function parsePull(url: string): Readonly<{ repo: string; number: string }> | null {
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repo: match[1], number: match[2] };
}
