/**
 * a11ign/a11ign#5128: the gate's hot polling reads, moved to REST with `If-None-Match` where a validator can answer them, read only where
 * something changed, and held to a per-tick budget of GraphQL points.
 *
 * WHY IT IS GRAPHQL THAT IS BUDGETED. `gh pr list`, `gh pr view` and `gh issue list` spend the GraphQL pool (5,000 points an hour per
 * account); `gh api` spends REST core. GitHub's documentation says a 304 is not charged to the primary limit; that is not measured here, and
 * the live measurement is what would confirm it. The per-tick cap is therefore a limit on what the tick may still ask GraphQL, not on REST.
 *
 * THE FLAG IS A MARKER FILE, as `draining` is (`work-gate/reads.ts`): `touch` turns the REST path on for the next tick, `rm` turns it off,
 * and nothing needs a unit-file edit. With the marker absent the reads are the ones the gate has always made.
 *
 * THE CAP IS A GUARD, NOT A MEASUREMENT. The points a caller charges to each cause are its own estimates; the live one-hour measurement (#5169)
 * reads the `gate-budget` lines the tick writes once the gate's reads go through this module, and that is where the estimates are checked.
 */
import { existsSync } from "node:fs";
import { stateEntryPath } from "./host-config.ts";
import { conditionalReader, type Ask, type Validated } from "./trace/publish.ts";

export const REST_CONDITIONAL_MARKER = "gate-rest-conditional";
/** Where the kept ETags live between ticks: a directory of its own, so the trace publisher's store is never read as the gate's. */
export const GATE_VALIDATORS_DIR = "gate-conditional";

/** A tick may spend this many GraphQL points before the rest of its reads are refused (the row's "a tick stops at its cap").
 * Kept at 60 on a measurement (agent-org#1620, a11ign/agent-org#1618): the scheduler account spent about 74% of the 5,000-point hour, so a higher cap
 * has no pool to pay for it, and `repository.issues` was 55% of the points (agent-org#1636 cuts it). */
export const TICK_POINTS_CAP = 60;

/**
 * Is the REST path on? The marker is read at the start of each tick, so a change takes effect on the next one and never mid-tick.
 */
export function restConditionalOn(path: string = stateEntryPath(REST_CONDITIONAL_MARKER), exists: (p: string) => boolean = existsSync) {
  return exists(path);
}

/**
 * GETs that send the ETag they were last given and answer a 304 from the value kept with it, for ONE tick. `held` is the store the
 * caller loads with `readValidators` and saves with `saveValidators`; this does not write it.
 */
export function conditionalGate({ held, ask, now }: { held: Record<string, Validated>; ask: Ask; now: number; }) {
  return conditionalReader({ held, ask, now });
}

/** What a tick has seen of each open pull request: the head it was read at and the `updatedAt` it carried. */
export type Seen = Map<number, { headRefOid: string; updatedAt: string; }>;

export const seenOf = (prs: readonly { number: number; headRefOid: string; updatedAt: string; }[]): Seen =>
  new Map(prs.map((pr) => [pr.number, { headRefOid: pr.headRefOid, updatedAt: pr.updatedAt }]));

/**
 * The pull requests whose detail must be read again. One whose head AND `updatedAt` both match the last tick's is unchanged, and its
 * kept detail is still true. A pull request not seen before is read.
 */
export function partitionUnchanged<T extends { number: number; headRefOid: string; updatedAt: string; }>(prs: readonly T[], seen: Seen) {
  const reread: T[] = [];
  const unchanged: T[] = [];
  for (const pr of prs) {
    const last = seen.get(pr.number);
    const same = last !== undefined && last.headRefOid === pr.headRefOid && last.updatedAt === pr.updatedAt;
    (same ? unchanged : reread).push(pr);
  }
  return { reread, unchanged };
}

export type BudgetSummary = { total: number; cap: number; byCause: Record<string, number>; };

/**
 * The tick's GraphQL points. `spend` charges a read to its cause and returns true, or refuses it and charges nothing when it would pass the
 * cap; a caller that gets `false` stops the reads it has not yet made.
 */
export function budgetOf({ cap = TICK_POINTS_CAP }: { cap?: number; } = {}) {
  const byCause = new Map<string, number>();
  let total = 0;
  return {
    spend(cause: string, points: number): boolean {
      if (total + points > cap) return false;
      total += points;
      byCause.set(cause, (byCause.get(cause) ?? 0) + points);
      return true;
    },
    exhausted: (): boolean => total >= cap,
    summary: (): BudgetSummary => ({ total, cap, byCause: Object.fromEntries(byCause) }),
  };
}

/** The line the tick log carries for one tick, so the spend by cause is read from the log and not inferred. */
export function budgetLine({ total, cap, byCause }: BudgetSummary): string {
  const causes = Object.entries(byCause).map(([cause, points]) => `${cause} ${points}`).join(", ");
  return `gate-budget: ${total}/${cap} points (${causes})`;
}

export type Budget = ReturnType<typeof budgetOf>;

/** Each tick is its own process, so one budget per process is one budget per tick. */
export const tickBudget: Budget = budgetOf();

/**
 * The points one GraphQL read is charged. An ESTIMATE of one per call, not a measurement: `gh`'s own cost is per query, and the live
 * one-hour measurement is what would say whether one is right.
 */
export const POINTS_PER_GRAPHQL_READ = 1;

/**
 * A read that spends GraphQL: `gh pr|issue list|view` and `gh api graphql` that is a QUERY. A mutation is not a read and is never refused
 * by the cap, because a refused write is a lost write (`pr merge`, `issue edit`, the graphql arm call).
 */
export function graphqlReadOf(args: string[]): boolean {
  const [head, verb] = args;
  const isReadOnly = (head === "pr" || head === "issue") && (verb === "list" || verb === "view");
  if (isReadOnly) return true;
  return head === "api" && verb === "graphql" && !args.some((arg) => /^query=\s*mutation\b/.test(arg));
}

const causeOf = (args: string[]) => args.slice(0, 2).join(" ");

const refusalOf = (args: string[], budget: Budget) => `gate-budget: refused \`gh ${causeOf(args)}\` at ${budget.summary().total}/${budget.summary().cap} points`;

/**
 * `run`, metered: a GraphQL read is charged to the budget first, and REFUSED when the charge would pass its cap. A refusal THROWS, as a failed
 * `gh` does, so every reader's own refusal path takes it: nothing new is thrown at a caller. A `null` budget is the flag being off, and
 * `run` comes back as it was.
 */
export function meteredRun(run: (args: string[], repo?: string) => string, budget: Budget | null): (args: string[], repo?: string) => string {
  if (budget === null) return run;
  return (args, repo) => {
    if (graphqlReadOf(args) && !budget.spend(causeOf(args), POINTS_PER_GRAPHQL_READ)) throw new Error(refusalOf(args, budget));
    return run(args, repo);
  };
}

/**
 * `send`, metered call by call, as `meteredRun` meters a read one at a time: each GraphQL read in the batch is charged in order, and one that
 * would pass the cap is answered as a failed call (`refused`) and never sent. The charge is made BEFORE the batch goes out, so a batch whose
 * worker is killed is still counted, which is what GitHub may have spent; the caller's one-by-one fallback then charges its reads again.
 * A `null` budget sends the whole batch as it always was.
 */
export function meteredBatch<T extends { args: string[]; }, A>(calls: T[], budget: Budget | null, send: (sent: T[]) => A[], refused: (message: string) => A): A[] {
  if (budget === null) return send(calls);
  const refusals = calls.map(({ args }) => (graphqlReadOf(args) && !budget.spend(causeOf(args), POINTS_PER_GRAPHQL_READ) ? refusalOf(args, budget) : null));
  const sent = calls.filter((_, at) => refusals[at] === null);
  const answers = sent.length === 0 ? [] : send(sent);
  let next = 0;
  return refusals.map((message) => (message === null ? answers[next++] : refused(message)));
}
