// A TRACKER'S ISSUES OR PULL REQUESTS SINCE A TIME, READ WITHOUT SEARCH -- #5076 (the third half of #5050; #5039 is `rows-by-label.ts`).
//
// `gh pr list --search "merged:>=T"` and `gh issue list --search "closed:T..U"` are sent as a GitHub SEARCH, whose allowance the scheduler App's installation
// spent on 2026-10-11 (#5039). `repository.pullRequests(states:)` and `repository.issues(states:)` are CONNECTIONS, charged to the GraphQL points the gate already
// budgets. A connection has no `merged:` or `closed:` filter, so the window is read by the one thing a connection CAN order by: a row's `createdAt` or
// `updatedAt`, newest first, paged until a row falls before `since`.
//
// WHY THE WINDOW IS A SUPERSET, AND THE CALLER FILTERS: `closedAt <= updatedAt` and `mergedAt <= updatedAt`, so every row closed or merged at or after `since` has an
// `updatedAt` at or after it and is inside the pages read; a row UPDATED after `since` and closed before it is read too, so the caller keeps only the rows whose own
// time it means (`mergedAt`, `closedAt`). Ordering by `createdAt` is the same argument for `created:>=`.
//
// THE TWO RULES EVERY READ ON THIS PATH SHARES (see `rows-by-label.ts`): a failed read THROWS and the caller turns it into `null` and never `[]`, and a read
// refused for a limit is not asked again in the process. A window that does not fit `MAX_PAGES` pages is REFUSED, never returned in part: a count of "merged
// since T" that quietly stops at the newest 1,000 is the defect this module exists to be unable to produce.
//
// `run` IS HANDED IN and nothing here spawns `gh`. The page builder and the page parser are
// exported on their own for a caller whose `run` is asynchronous (`messaging/watch.ts`): it pages by the same two functions and the same `foldPage`.
import type { Page, RowsHelpers, RowsRun as Run, SinceRead } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AsyncRowsRun as AsyncRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import { type Pool, readUnlessRefused } from "./rows-by-label.ts";

/** The error a window longer than its pages throws: core's class (`RowsHelpers.WindowCutShort`), so a caller's `instanceof` finds it. */
export type CutShort = RowsHelpers["WindowCutShort"];

/** A GraphQL connection page is 100 at most. */
export const SINCE_PAGE_SIZE = 100;
/** The most pages one read walks: 1,000 rows. A window longer than this is refused with the rows it could not see counted as unseen, not as absent. */
export const SINCE_MAX_PAGES = 10;

// A window longer than the pages the read was allowed throws `WindowCutShort` (core's class, handed in): the rows past the last page are UNSEEN, which a caller may report as a limit hit rather than as unreadable.

const orderField = (ask: SinceRead): "createdAt" | "updatedAt" => (ask.orderBy === "CREATED_AT" ? "createdAt" : "updatedAt");

function queryOf(ask: SinceRead): string {
  const states = ask.states.join(",");
  const selection = ask.select.split(/\s+/).includes(orderField(ask)) ? ask.select : `${ask.select} ${orderField(ask)}`;
  const labelled = ask.label === undefined ? "" : "$label:String!,";
  const filter = ask.label === undefined ? "" : "labels:[$label],";
  return `query($owner:String!,$name:String!,${labelled}$after:String){repository(owner:$owner,name:$name){`
    + `${ask.kind}(states:[${states}],${filter}first:${SINCE_PAGE_SIZE},after:$after,orderBy:{field:${ask.orderBy},direction:DESC})`
    + `{pageInfo{hasNextPage endCursor} nodes{${selection}}}}}`;
}

/** The `gh` argv of one page: a GraphQL call, whose variables are the repository and the cursor. */
export function sincePageArgs(ask: SinceRead, after: string | null): string[] {
  const [owner, name] = ask.repo.split("/");
  return ["api", "graphql", "-f", `query=${queryOf(ask)}`, "-F", `owner=${owner}`, "-F", `name=${name}`,
    ...(ask.label === undefined ? [] : ["-F", `label=${ask.label}`]), ...(after === null ? [] : ["-F", `after=${after}`])];
}

/** Is this argv one of this reader's pages? For a fake that must tell a window read from another connection read. */
export function isSinceRead(args: readonly string[]): boolean {
  return args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.startsWith("query=") && /(?:issues|pullRequests)\(states:\[[A-Z,]+\],(?:labels:\[\$label\],)?first:\d+,after:\$after,orderBy:/.test(arg));
}

/** One page, parsed. A payload that is not a connection THROWS: "could not read" is never an empty page. */
export function parsePage(raw: string, ask: SinceRead): Page {
  const parsed = JSON.parse(raw);
  const connection = parsed?.data?.repository?.[ask.kind];
  if (!Array.isArray(connection?.nodes)) {
    throw new Error(`the ${ask.kind} of ${ask.repo} did not come back as a connection: ${String(parsed?.errors?.[0]?.message ?? "no `data`")}`);
  }
  const hasNextPage = connection.pageInfo?.hasNextPage === true;
  const endCursor = typeof connection.pageInfo?.endCursor === "string" && connection.pageInfo.endCursor !== "" ? connection.pageInfo.endCursor : null;
  // A page that says another follows and names no cursor to ask it with is not a page: `foldPage` reads a null cursor as "the read is whole", which would end the read short and call it complete.
  if (hasNextPage && endCursor === null) throw new Error(`the ${ask.kind} of ${ask.repo} came back with pageInfo.hasNextPage and no endCursor: another page follows that cannot be asked for`);
  return { nodes: connection.nodes, hasNextPage, endCursor };
}

/**
 * Fold one page into the rows so far. `next` is the cursor of the page still to read, or `null` when the read is whole.
 * Throws when the window is longer than `maxPages` pages: the rows past the last page are unseen, and a caller must not read them as absent.
 */
export function foldPage({ ask, rows, page, pagesRead }: { ask: SinceRead; rows: any[]; page: Page; pagesRead: number; }, WindowCutShort: CutShort): { rows: any[]; next: string | null; } {
  const all = [...rows, ...page.nodes];
  if (ask.newest !== undefined) {
    if (all.length >= ask.newest) return { rows: all.slice(0, ask.newest), next: null };
  } else if (ask.since !== undefined) {
    const from = Date.parse(ask.since);
    const field = orderField(ask);
    const cut = all.findIndex((row) => Date.parse(row?.[field]) < from);
    if (cut >= 0) return { rows: all.slice(0, cut), next: null };
  }
  if (!page.hasNextPage) return { rows: all, next: null };
  if (pagesRead >= (ask.maxPages ?? SINCE_MAX_PAGES)) {
    throw new WindowCutShort(`the ${ask.kind} of ${ask.repo} since ${ask.since ?? "the newest"}: more than ${pagesRead * SINCE_PAGE_SIZE} rows, so the window may be cut short`);
  }
  return { rows: all, next: page.endCursor };
}

/**
 * THE WINDOW'S PAGE LOOP, ONCE: the argument list of the page to ask now, and what to do with the raw answer. `fold` answers the rows when the read is whole, or the argument list of the page still to ask. The sync reader and
 * the async one differ only in how they run a page, so the order of pages, the cut-short refusal and the cursor rule cannot drift between them.
 */
function pageWalk(ask: SinceRead, WindowCutShort: CutShort): { first: string[]; fold(raw: string): { rows: any[] } | { args: string[] } } {
  let rows: any[] = [];
  let pagesRead = 0;
  return {
    first: sincePageArgs(ask, null),
    fold(raw) {
      pagesRead += 1;
      const folded = foldPage({ ask, rows, page: parsePage(raw, ask), pagesRead }, WindowCutShort);
      rows = folded.rows;
      return folded.next === null ? { rows } : { args: sincePageArgs(ask, folded.next) };
    },
  };
}

/**
 * The rows of `ask`, each as the `select` asked, in the connection's own shape, or a THROW when they could not be read whole.
 * @param ask `since` bounds the window by time and refuses one that does not fit; `newest` bounds it by count and truncates
 */
export function readRowsSince({ ask, run, log }: { ask: SinceRead; run: Run; log?: (line: string) => void; }, { pool, WindowCutShort }: { pool: Pool; WindowCutShort: CutShort; }): any[] {
  if (ask.since === undefined && ask.newest === undefined) throw new Error("readRowsSince needs `since` or `newest`: an unbounded read of a connection is a read of every row there is");
  if (ask.since !== undefined && !Number.isFinite(Date.parse(ask.since))) throw new Error(`readRowsSince: \`since\` is not a time: ${ask.since}`);
  const what = `the ${ask.kind} of ${ask.repo} (${ask.states.join("/")}), ${ask.since === undefined ? `${ask.newest} newest` : `since ${ask.since}`}`;
  return readUnlessRefused({ what, run, pool, ...(log === undefined ? {} : { log }), read: () => {
    const walk = pageWalk(ask, WindowCutShort);
    for (let args = walk.first; ; ) {
      const step = walk.fold(run(args));
      if ("rows" in step) return step.rows;
      args = step.args;
    }
  } });
}

/**
 * {@link readRowsSince} for a caller that holds an ASYNC `run` (the chairman's watch, A11-160 step 8): every page through that run, the rows in the shape `gh <kind> list --json` gave. It keeps no memory of refusals (the watch
 * reads once a tick, in a process of its own) and a caller's `guard` on the run applies to each page's argument list.
 */
export async function readRowsSinceAsync({ ask, run }: { ask: SinceRead; run: AsyncRun }, { WindowCutShort }: { WindowCutShort: CutShort }): Promise<any[]> {
  const walk = pageWalk(ask, WindowCutShort);
  for (let args = walk.first; ; ) {
    const step = walk.fold(await run(args));
    if ("rows" in step) return step.rows.map(asListJson);
    args = step.args;
  }
}

/**
 * A node in the shape `gh <kind> list --json` gave, so the comparisons that read it did not change: a connection property (`{ nodes: [...] }`) is its array, so
 * `labels` is `[{ name }]` and `files` is `[{ path }]`, and `author`, `mergeCommit` and the scalars are untouched.
 */
export function asListJson(node: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(node).map(([key, value]) => {
    const nodes = (value as { nodes?: unknown; } | null)?.nodes;
    return [key, Array.isArray(nodes) ? nodes : value] as const;
  });
  return Object.fromEntries(entries);
}

/**
 * The pull requests MERGED, with the fields asked, in `gh pr list --json` shape. `window` is `{ since }` for the merges at or after a time (refused when it does not fit
 * the pages), or `{ newest }` for the newest N by creation, which is what `gh pr list --state merged --limit N` was.
 * @param base keep only pull requests merged into this branch
 */
export function readMergedPullRequests({ repo, select, run, window, base }: {
  repo: string; select: string; run: Run; window: { since: string; maxPages?: number; } | { newest: number; }; base?: string;
}, deps: { pool: Pool; WindowCutShort: CutShort; }): Record<string, unknown>[] {
  const fields = `${select} mergedAt${base === undefined ? "" : " baseRefName"}`;
  const states = ["MERGED"] as const;
  if ("newest" in window) {
    const ask: SinceRead = { kind: "pullRequests", states, orderBy: "CREATED_AT", repo, select: fields, newest: window.newest };
    return readRowsSince({ ask, run }, deps).filter((row) => base === undefined || row.baseRefName === base).map(asListJson);
  }
  const ask: SinceRead = { kind: "pullRequests", states, orderBy: "UPDATED_AT", repo, select: fields, since: window.since, ...(window.maxPages === undefined ? {} : { maxPages: window.maxPages }) };
  const from = Date.parse(window.since);
  return readRowsSince({ ask, run }, deps).filter((row) => Date.parse(row.mergedAt) >= from && (base === undefined || row.baseRefName === base)).map(asListJson);
}
