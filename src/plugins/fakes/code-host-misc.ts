// @ts-check
// module: the in-memory code host's operations for the claim's clock, the provenance audit, the reachability check, the duplicate-row check and the label strip (A11-160, step 7)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row's label history is the gate's (`world.gate.events`), the closed rows, open rows and pull requests are the
// world's, and what the provenance audit reads beyond them (why a row closed, the pull request that closed it) is `world.misc`. The three provenance reads answer GitHub's TEXT, as the contract says, rendered from
// those rows and events, so a core test seeds rows and not a stubbed answer. A refused read is `world.failures` naming the operation, which `createFakeRows` applies to every operation.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** The pull request a closed row's closing event names, as the audit reads it. */
export type FakeClosingPull = { number: number; headRefName: string; merged: boolean; createdAt: string; labels: string[] };

/** What the audit and the clock read of the world beyond its rows and the gate's label history. */
export type FakeMisc = {
  /** Why a closed row closed (`COMPLETED`, `NOT_PLANNED`), by number; absent is a row whose listing carries none. */
  stateReasons: Map<number, string>;
  /** The pull request that closed a row, by number; `null` or absent is a row no pull request closed. */
  closingPulls: Map<number, FakeClosingPull | null>;
};

export const emptyMisc = (): FakeMisc => ({ stateReasons: new Map(), closingPulls: new Map() });

const rowOf = (world: FakeRowsWorld, repo: string, number: number): FakeRow => {
  const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
};

const historyOf = (world: FakeRowsWorld, number: number) => {
  const events = world.gate.events.get(number) ?? [];
  if (events instanceof Error) throw events;
  return events;
};

/** Records the read in the world's calls, then makes it. */
const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

/** An open pull request or a closed one, as GitHub words its state. */
const stateOfPull = (pull: { merged: boolean; closedAt?: string | null }): string => (pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN");

export function miscOperations(world: FakeRowsWorld): Pick<CodeHostRows, "labelEventsOf" | "removeLabelsFromRow" | "closingTimelineTextOf" | "closedRowListingTextOf" | "labelEventLogTextOf" | "pullStatesOf" | "pullStatesOfBranchIn"
  | "rowFactsIn" | "openRestListingOf" | "rowBodyIn"> {
  return {
    labelEventsOf: ({ row }) => historyOf(world, row).map(({ event, label, at }) => ({ event, label, at })),
    removeLabelsFromRow: ({ repo, number, labels }) => {
      const row = rowOf(world, repo, number);
      row.labels = row.labels.filter((label) => !labels.includes(label));
      world.calls.push(`removeLabelsFromRow #${number}`);
    },
    closingTimelineTextOf: ({ number }) => {
      const closing = world.misc.closingPulls.get(number) ?? null;
      const nodes = closing === null ? [] : [{ closer: { number: closing.number, headRefName: closing.headRefName, merged: closing.merged, createdAt: closing.createdAt, labels: { nodes: closing.labels.map((name) => ({ name })) } } }];
      return JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes } } } } });
    },
    closedRowListingTextOf: ({ limit }) => JSON.stringify([...world.rows.values()].filter((row) => row.state === "CLOSED").slice(0, limit)
      .map(({ number, title, closedAt }) => ({ number, title, closedAt, ...(world.misc.stateReasons.has(number) ? { stateReason: world.misc.stateReasons.get(number) } : {}) }))),
    labelEventLogTextOf: () => [...world.gate.events].flatMap(([number, events]) => (events instanceof Error ? [] : events.map(({ event, label, at }) => JSON.stringify({ number, event, label, at })))).map((line) => `${line}\n`).join(""),
    pullStatesOf: ({ limit }) => [...world.pulls.values()].slice(0, limit).map((pull) => ({ number: pull.number, state: stateOfPull(pull), headRefName: pull.headRefName })),
    pullStatesOfBranchIn: ({ branch }) => [...world.pulls.values()].filter((pull) => pull.headRefName === branch).map((pull) => ({ number: pull.number, state: stateOfPull(pull) })),
    rowFactsIn: ({ repo, number }) => {
      const row = rowOf(world, repo, number);
      return { body: row.body, labels: row.labels.map((name) => ({ name })), state: row.state, closedAt: row.closedAt };
    },
    openRestListingOf: ({ kind }) => noted(world, `openRestListingOf ${kind}`, () => (kind === "issues"
      ? [...world.rows.values()].filter((row) => row.state === "OPEN").map(({ number, title, body }) => ({ number, title, body }))
      : [...world.pulls.values()].filter((pull) => stateOfPull(pull) === "OPEN").map(({ number, title, body, createdAt }) => ({ number, title: title ?? "", body, created_at: createdAt })))),
    rowBodyIn: ({ repo, number }) => noted(world, `rowBodyIn #${number}`, () => rowOf(world, repo, number).body),
  };
}
