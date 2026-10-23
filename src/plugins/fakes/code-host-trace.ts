// @ts-check
// module: the in-memory code host's operations for the trace (A11-160, step 8)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row is the world's row. What the trace reads beyond rows, the conditional GETs of `trace/publish.ts` and the REST pages of
// `trace/trace.ts`, answers GitHub's own TEXT (a status line and its headers; a page of a timeline), which the fake does not model: they throw by name, and a test of the code that reads them runs against the GitHub plugin.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

/** What the trace posts: the comments handed over by input, in order. */
export type FakeTrace = { inputComments: { repo: string; number: string; body: string }[] };

export const emptyTrace = (): FakeTrace => ({ inputComments: [] });

const unmodeled = (operation: string) => (): never => {
  throw new Error(`the fake rows do not model ${operation}: its answer is GitHub's own, so a test that needs it runs against the GitHub plugin's rows`);
};

type Operations = Pick<CodeHostRows, "commentOnRowByInput" | "rowSnapshotOf" | "apiTextOf" | "conditionalGetOf">;

export function traceOperations(world: FakeRowsWorld): Operations {
  const isHome = (repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);
  const rowIn = (repo: string, number: number) => {
    const row = isHome(repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
    if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
    return row;
  };
  return {
    commentOnRowByInput: ({ repo, number, body }) => {
      rowIn(repo, Number(number)).comments.push({ id: world.nextCommentId++, body, createdAt: new Date(world.now()).toISOString() });
      world.reports.trace.inputComments.push({ repo, number: String(number), body });
    },
    rowSnapshotOf: ({ repo, number }) => {
      const row = rowIn(repo, number);
      return { number: row.number, state: row.state, title: row.title, body: row.body, labels: row.labels.map((name) => ({ name })) };
    },
    apiTextOf: unmodeled("apiTextOf"),
    conditionalGetOf: unmodeled("conditionalGetOf"),
  };
}
