// module: a repository's open pull requests, as the code host reads them (A11-160)
//
// Read through the plugin's `gh` runner, so this file spawns nothing. Row mode's own reader of the same list (`src/ticket-port/open-pulls.ts`, which also takes each body) stays in core
// until row mode's calls move into this plugin, so the two are written apart on purpose: this one is the ticket-mode read only.
import type { Gh } from "./gh.ts";

/** The most `gh pr list` returns in one read. A list AT this length may be cut short, so it is no reading (`null`), never a complete list. */
export const OPEN_PULLS_LIMIT = 200;

/**
 * THE ADDRESSES OF THE OPEN PULL REQUESTS OF `repo`, or `null` for "could not ask": a refused `gh`, an answer that does not parse, and a list at `OPEN_PULLS_LIMIT`.
 * `null` is never "nothing is open" (#1286): a caller that refuses on an open pull request must not read a failed read as an empty list.
 */
export function openPullUrlsOf(repo: string, gh: Gh): string[] | null {
  try {
    const pulls: { number: number; body: string }[] = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(OPEN_PULLS_LIMIT), "--json", "number,body"]));
    if (!Array.isArray(pulls) || pulls.length >= OPEN_PULLS_LIMIT) return null;
    return pulls.map(({ number }) => `https://github.com/${repo}/pull/${number}`);
  } catch (error) {
    void error; // no list is "cannot say", which the caller refuses on
    return null;
  }
}
