// @ts-check
// module: the in-memory code host's operations for wake (A11-160, step 7)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. What wake reads of a row is the row the world holds (its title, labels, state, comments with their authors and the history of
// its labels, `world.gate.events`), and what it reads of a pull request is whether the world's pull request has merged, was closed or sits in the merge queue. A row of another tracker's repository is among `world.foreignRows`.
// A reference the world does not hold is a refused read, except where the operation says a missing one is `null` (a 404). `ownRunWithin` has no `gh` to start, so it throws.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** What wake reads of the world beyond its rows and pull requests: nothing yet (a test seeds rows, pull requests, label events and the merge queue). */
export type FakeWake = Record<string, never>;

export const emptyWake = (): FakeWake => ({});

/** Whether `repo` names the world's own repository: by name, by `gh`'s own placeholder, or by naming none. */
const isHome = (world: FakeRowsWorld, repo: string | undefined): boolean => [undefined, "", "{owner}/{repo}", world.repo].includes(repo);

/** The row `repo#number`, in this repository's world or among the foreign rows; `null` when the world holds none. */
function findRow(world: FakeRowsWorld, repo: string | undefined, number: number): FakeRow | null {
  return (isHome(world, repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`)) ?? null;
}

function rowIn(world: FakeRowsWorld, repo: string | undefined, number: number): FakeRow {
  const row = findRow(world, repo, number);
  if (row === null) throw new Error(`the fake holds no row ${repo ?? world.repo}#${number}`);
  return row;
}

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

export function wakeOperations(world: FakeRowsWorld): Pick<CodeHostRows, "titleAndCommentsOf" | "labelNamesOfRow" | "rowStateOf" | "labelsBodyTitleOf" | "closeHomeRowWithComment" | "fileRowWithLabels" | "lastLabelEventOf"
  | "markedCommentsOf" | "isPullQueued" | "pullStateWordOf" | "issueStateAndLabelsOf" | "firstCommentTimeStartingWith" | "ownRunWithin" | "readRestJson"> {
  return {
    titleAndCommentsOf: ({ repo, number }) => {
      const row = rowIn(world, repo, number);
      return { title: row.title, comments: row.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, author: { login: comment.author } })) };
    },
    labelNamesOfRow: ({ repo, number }) => [...rowIn(world, repo, number).labels],
    rowStateOf: ({ number, repo }) => rowIn(world, repo, number).state,
    labelsBodyTitleOf: ({ repo, number }) => {
      const row = rowIn(world, repo, number);
      return { labels: [...row.labels], body: row.body, title: row.title };
    },
    closeHomeRowWithComment: ({ number, comment }) => {
      const row = rowIn(world, undefined, number);
      row.comments.push({ id: world.nextCommentId++, body: comment, createdAt: iso(world) });
      row.state = "CLOSED";
      row.closedAt = iso(world);
    },
    fileRowWithLabels: ({ title, body, labels }) => {
      const number = world.nextNumber++;
      world.rows.set(number, { number, title, body, state: "OPEN", labels: [...labels], createdAt: iso(world), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null });
      return `https://github.com/${world.repo}/issues/${number}\n`;
    },
    lastLabelEventOf: ({ number, label }) => {
      const events = world.gate.events.get(number) ?? [];
      if (events instanceof Error) throw events;
      const last = events.filter((event) => event.label === label).at(-1);
      return last === undefined ? null : { event: last.event, at: Date.parse(last.at), by: String(last.actor) };
    },
    markedCommentsOf: ({ number, marker }) => rowIn(world, undefined, number).comments.map((comment) => ({ id: comment.id, login: comment.author ?? "", at: Date.parse(comment.createdAt), marked: comment.body.includes(marker) })),
    isPullQueued: ({ number }) => !(world.queue.entries instanceof Error) && world.queue.entries.some((entry) => entry.pull === number),
    pullStateWordOf: ({ repo, number }) => {
      const pull = isHome(world, repo) ? world.pulls.get(number) : undefined;
      if (pull === undefined) throw new Error(`the fake holds no pull request ${repo}#${number}`);
      return pull.merged || pull.closedAt != null ? "closed" : "open";
    },
    issueStateAndLabelsOf: ({ repo, number }) => {
      const row = findRow(world, repo, number);
      if (row !== null) return { open: row.state === "OPEN", labels: [...row.labels] };
      const pull = isHome(world, repo) ? world.pulls.get(number) : undefined;
      return pull === undefined ? null : { open: !pull.merged && pull.closedAt == null, labels: [...pull.labels] };
    },
    firstCommentTimeStartingWith: ({ repo, number, prefix }) => rowIn(world, repo, number).comments.find((comment) => comment.body.startsWith(prefix))?.createdAt ?? null,
    readRestJson: () => {
      throw new Error("the fake code host has no gh: a test of code that reads GitHub's REST api through the code host runs against the GitHub plugin");
    },
    ownRunWithin: () => () => {
      throw new Error("the fake code host has no gh: a test of code that reaches GitHub through the code host's own runner runs against the GitHub plugin");
    },
  };
}
