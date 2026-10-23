// a11ign#5117: A TRACKER'S ISSUE COMMENTS SINCE A MOMENT, read through an injected `run` (`gh`, as the caller hands it in). This file spawns nothing:
// the spawn stays with whoever owns the runner, as `open-incidents.ts` and `open-pulls.ts` leave it (`gh-call-ratchet.test.ts`).
//
// ONE LIST AND NOT A FETCH PER ROW. `repos/<repo>/issues/comments?since=` is repository-wide, so the 24 hours of "Underspecified: <field>" stops
// (`spec-lint.ts`) cost one paginated call per tracker however many rows were commented on. It is a REST read, which spends the core pool and
// never the search allowance a `gh issue list --label` would (#5039).

import type { CommentRead } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * EVERY COMMENT of `repo` made at or after `since`, or `null` for "could not ask": a refused `run`, and an answer that is not a list of lists.
 * `null` is never "no comment": a caller that read a failed read as an empty list would report a day without stops that it never looked at.
 *
 * @param ask `run` returns what `gh api --paginate --slurp` printed, parsed (one array per page), or `null` when the read was refused
 */
export function commentsSince({ repo, since, run }: { repo: string; since: number; run: (args: string[]) => unknown[] | null }): CommentRead[] | null {
  const pages = run(["api", "--paginate", "--slurp", `repos/${repo}/issues/comments?since=${new Date(since).toISOString()}&per_page=100`]);
  if (pages === null || !pages.every(Array.isArray)) return null;
  return (pages as CommentRead[][]).flat();
}
