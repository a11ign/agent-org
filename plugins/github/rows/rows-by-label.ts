// A TRACKER'S ROWS BY LABEL, READ WITHOUT SEARCH -- #5039.
//
// `gh issue list --label X` is not a list: it sends a GraphQL SEARCH (`label:X repo:... type:issue`, read with GH_DEBUG=api), and the search
// allowance is separate from, and far smaller than, the 5,000 GraphQL points. On 2026-10-11 the scheduler App's installation (170075049)
// exhausted it while 3,948 points were left: every claim was refused (`B4 COULD NOT BE ASKED`) for eighteen attempts in thirty minutes,
// and a plain `gh issue list` and a raw `gh api graphql` both still worked.
//
// `repository.issues(labels:)` is a CONNECTION, not a search: it is charged to the GraphQL points the gate already budgets, and it answers
// when the search allowance is spent. This is the one reader for it, so the claim, the sweep freeze beside it and the other label reads on
// the claim path ask in the same shape (and `plugins/github/wrapper/gh` answers an IDENTICAL repeated read from disk, so the claim's second look is free).
//
// `run` IS HANDED IN and nothing here spawns `gh`: the caller's executor carries its timeout, its memo and its call census (`src/plugins/contracts/code-host-rows.ts`). What core owns of GitHub's rate-limit
// answers (`api-pool.ts`) reaches this file as `pool`, since a plugin imports core's types only (ADR 0001).
//
// THE TWO RULES EVERY LOOKUP ON THIS PATH SHARES, stated here once:
// - a failed read THROWS and the caller turns it into `null`, never into `[]`: "could not read who holds what" is not "nobody does".
// - A READ REFUSED FOR A LIMIT IS NOT ASKED AGAIN in the same process (the tick). 593 of the 1,781 list calls in one outage hour were
//   refused ones, so a retry is the load that keeps the limit spent. The refusal is remembered, and the line names WHICH resource.
import type { ClaimedRow, LabelledRead as Ask, RowsHelpers, RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";

/** What core knows of GitHub's rate-limit answers, handed in by the activation (`RowsHelpers.pool`). */
export type Pool = RowsHelpers["pool"];

/** A GraphQL connection page is 100 at most; this many pages is the most one read walks before it says it is cut short. */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * What the first refusal for a limit said, for the life of this process -- ONE for every read, not one per read: the limit is a property of
 * the account's resource and not of the question, so the open rows' read being refused says the closed rows' read will be, and asking it
 * anyway is the multiplication this exists to stop.
 */
let refusal: string | null = null;

/** For a test: a fresh process. */
export function forgetRefusedReads(): void {
  refusal = null;
}

const stderrLine = (line: string): void => { process.stderr.write(`${line}\n`); };

function queryOf({ state, select, newest }: Pick<Ask, "state" | "select" | "newest">): string {
  const order = newest === undefined ? "" : ",orderBy:{field:CREATED_AT,direction:DESC}";
  const first = newest === undefined ? PAGE_SIZE : Math.min(newest, PAGE_SIZE);
  return "query($owner:String!,$name:String!,$label:String!,$after:String){repository(owner:$owner,name:$name){"
    + `issues(states:${state},labels:[$label],first:${first},after:$after${order}){pageInfo{hasNextPage endCursor} nodes{${select}}}}}`;
}

/** Is this argv one of this reader's reads? For a caller that folds repeated row reads in one claim (`row-claim.ts`'s `readsOnce`). */
export function isRowsByLabelRead(args: readonly string[]): boolean {
  return args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.startsWith("query=") && arg.includes("labels:[$label]"));
}

function pageArgs(ask: Ask, after: string | null): string[] {
  const [owner, name] = ask.repo === undefined ? ["{owner}", "{repo}"] : ask.repo.split("/");
  return ["api", "graphql", "-f", `query=${queryOf(ask)}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `label=${ask.label}`,
    ...(after === null ? [] : ["-F", `after=${after}`])];
}

function readPages(ask: Ask, run: Run): any[] {
  const rows: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const parsed = JSON.parse(run(pageArgs(ask, after)));
    const issues = parsed?.data?.repository?.issues;
    if (!Array.isArray(issues?.nodes)) throw new Error(`the rows labelled ${ask.label} did not come back as a connection: ${String(parsed?.errors?.[0]?.message ?? "no `data`")}`);
    rows.push(...issues.nodes);
    if (ask.newest !== undefined && rows.length >= ask.newest) return rows.slice(0, ask.newest);
    if (!issues.pageInfo?.hasNextPage) return rows;
    after = String(issues.pageInfo.endCursor);
  }
  // A MISSING ROW IS A FILE NOBODY HOLDS: a population this reader cannot hold whole is refused, never compared in part.
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} rows labelled ${ask.label}: the list may be cut short`);
}

const textOf = (error: unknown): string => {
  const { message = "", stderr = "", stdout = "" } = (error ?? {}) as { message?: string; stderr?: unknown; stdout?: unknown; };
  return `${message}\n${String(stderr)}\n${String(stdout)}`;
};

const isLimitRefusal = (error: unknown): boolean => /rate limit/i.test(textOf(error));

/**
 * WHICH RESOURCE WAS REFUSED, so the next one is diagnosed in one tick and not twenty minutes. The refusal text names an account or an
 * installation and never a resource, so the answer is read from the refused response's own `X-Ratelimit-Resource` when it carries one, and
 * otherwise from ONE follow-up read of the GraphQL pool, whose header names the pool that answered (`gh api rate_limit` is never asked: it
 * has reported a full pool during a total outage of that token, #1967).
 */
function exhaustedResource(error: unknown, run: Run, pool: Pool): string {
  if (/secondary rate limit/i.test(textOf(error))) return "secondary (the abuse limit, which no pool count shows)";
  const own = pool.fromResponse((error as { stdout?: string; })?.stdout ?? null);
  if (own?.resource) return `${own.resource} (${own.remaining} of ${own.limit} left, named by the refused response)`;
  const probe = pool.fromResponse(pool.rawResponse(GRAPHQL_POOL_PROBE, run));
  if (probe === null) return "UNREADABLE (the refusal names an account, and the follow-up read of the GraphQL pool failed too)";
  // #1523: an INSTALLATION refused while its pool reads healthy is a secondary limit, and the probe's count is the evidence for it, so the line says so.
  if (/for installation ID \d+/.test(textOf(error)) && probe.remaining > 0) {
    return `a secondary limit: the installation was refused while its pool reads ${probe.remaining} of ${probe.limit} left`;
  }
  return `not ${probe.resource ?? "the graphql pool"}'s count (the probe read ${probe.remaining} of ${probe.limit} left): the refusal came from another resource, `
    + "search or secondary, which the message does not name";
}

function noteRefusal({ what, run, error, log, pool }: { what: string; run: Run; error: unknown; log?: (line: string) => void; pool: Pool; }): void {
  const first = textOf(error).split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const reason = `refused for a rate limit on ${exhaustedResource(error, run, pool)}: ${first}`;
  refusal = reason;
  (log ?? stderrLine)(`rows-by-label: the read of ${what} was ${reason}; no label read is asked again this tick, and the next tick asks`);
}

/**
 * #5050: ANY GRAPHQL LIST READ OF THE TICK, under the one refusal memory. The gate's other connection reads (the closed rows owing an answer, the newest-updated closed rows)
 * are not by-label reads but spend the same account's resource, so one of them refused for a limit must stop the rest of the tick's asking and name the resource exactly as a
 * by-label read does. `read` is the call; a refusal that is not a limit is thrown on and remembered by nobody.
 *
 * @param ask `what` names the rows in the line a refusal leaves
 */
export function readUnlessRefused<T>({ what, run, log, read, pool }: { what: string; run: Run; log?: (line: string) => void; read: () => T; pool: Pool; }): T {
  if (refusal !== null) throw new Error(`not asked again this tick: an earlier read was ${refusal}`);
  try {
    return read();
  } catch (error) {
    if (isLimitRefusal(error)) noteRefusal({ what, run, error, log, pool });
    throw error;
  }
}

/**
 * THE ROWS of one tracker in `state` that carry `label`, each as the `select` asked, or a THROW when they could not be read whole.
 *
 * @param ask `select` is the node selection; `newest` bounds the read to the newest rows instead of refusing a long population
 */
export function readRowsByLabel(ask: Ask, pool: Pool): any[] {
  const { run, log } = ask;
  return readUnlessRefused({ what: `${ask.state} rows labelled ${ask.label}`, run, pool, ...(log === undefined ? {} : { log }), read: () => readPages(ask, run) });
}

/** The fields a claim comparison reads, in the connection's shape. */
const CLAIMED_SELECT = "number body labels(first:50){nodes{name}} blockedBy(first:50){nodes{number}}";

/**
 * EVERY OPEN ROW THAT IS `in-progress`, with body, labels and `blockedBy` edges, in the shape `gh issue list --json` gave -- so the
 * comparisons that read it did not change. Throws when the list could not be read whole.
 */
export function readClaimedRows({ run, repo, log }: { run: Run; repo?: string; log?: (line: string) => void; }, { pool, claimLabel }: { pool: Pool; claimLabel: string; }): ClaimedRow[] {
  const nodes = readRowsByLabel({ label: claimLabel, state: "OPEN", select: CLAIMED_SELECT, run,
    ...(repo === undefined ? {} : { repo }), ...(log === undefined ? {} : { log }) }, pool);
  return nodes.map((node) => ({
    number: Number(node.number), body: String(node.body ?? ""),
    labels: (node.labels?.nodes ?? []).map((label: { name: string; }) => ({ name: String(label.name) })),
    blockedBy: { nodes: (node.blockedBy?.nodes ?? []).map((edge: { number: number; }) => ({ number: Number(edge.number) })) },
  }));
}
