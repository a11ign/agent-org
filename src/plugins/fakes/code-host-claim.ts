// @ts-check
// module: the in-memory code host's operations for the claim (A11-160, step 7)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A claim reads a row's labels and comments, creates the labels it is about to add, sets the row's labels
// and takes them off again: the world's rows hold what those do. What GitHub does that a claim depends on is modelled: a row that is not there is a 404, and `issue edit --add-label` REFUSES a label that was
// never created (#749) after the removals in the same edit have landed (#677), which is why a claim creates what it is about to add. `claim.unreadable` makes a row's REST answer one the claim cannot read, and
// `claim.dropEdits` makes an edit that exits well and changes nothing, which is what the decline's read-back exists to catch (#2746).
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** What the claim reads of the world beyond its rows. */
export type FakeClaim = {
  /** A row's REST answer when it is not a row (the words the claim refuses in), and a row's comments' when they are not a list of pages. */
  unreadable: Map<number, string>;
  commentsUnreadable: Map<number, string>;
  /** An edit of a row's labels that exits well and changes nothing. */
  dropEdits: boolean;
  /** An edit of a row's labels whose removals land and whose additions do not (#677: the edit is not atomic). */
  dropAdds: boolean;
};

export const emptyClaim = (): FakeClaim => ({ unreadable: new Map(), commentsUnreadable: new Map(), dropEdits: false, dropAdds: false });

/** `gh`'s refusal, in the shape `execFileSync` threw it: the message, then stderr, which the claim quotes. */
export function refusal(args: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh ${args}\n${stderr}`), { status: 1, stderr, stdout: "" });
}

/** Whether `repo` names the world's own repository: by name, by `gh`'s own placeholder, or by naming none. */
const isHome = (world: FakeRowsWorld, repo: string | undefined): boolean => [undefined, "", "{owner}/{repo}", world.repo].includes(repo);

/** The row `repo#number`, in this repository's world or among the foreign rows; a row that is not there is the 404 `gh` answers. */
function rowIn(world: FakeRowsWorld, repo: string, number: number): FakeRow {
  const row = isHome(world, repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw refusal(`api repos/${repo}/issues/${number}`, "gh: Not Found (HTTP 404)");
  return row;
}

/** Whether a label exists in the world: created by an operation, or carried by a row. */
export const labelExists = (world: FakeRowsWorld, label: string): boolean => world.labelsCreated.includes(label) || [...world.rows.values()].some((row) => row.labels.includes(label));

/** One REST read of a row: the call is recorded, a row `unreadable` says why, and any other is read into the answer. */
function restRead<Answer>(world: FakeRowsWorld, name: string, { repo, number }: { repo: string; number: number }, unreadable: Map<number, string>, read: (row: FakeRow) => Answer): Answer | { unreadable: string } {
  world.calls.push(`${name} ${repo}#${number}`);
  const row = rowIn(world, repo, number);
  const why = unreadable.get(number);
  return why === undefined ? read(row) : { unreadable: why };
}

export function claimOperations(world: FakeRowsWorld): Pick<CodeHostRows, "ensureLabelArgs" | "readRestRow" | "readRestComments" | "setRowLabels" | "editRowLabels"> {
  return {
    ensureLabelArgs: (label, repo) => ["fake-ensure-label", repo, label],
    readRestRow: ({ repo, number }) => restRead(world, "readRestRow", { repo, number }, world.claim.unreadable, (row) => ({ row: { number, title: row.title, labels: [...row.labels], state: row.state } })),
    readRestComments: ({ repo, number }) => restRead(world, "readRestComments", { repo, number }, world.claim.commentsUnreadable, (row) => ({ comments: row.comments.map((comment) => comment.body).slice(-100) })),
    setRowLabels: ({ repo, number, labels }) => {
      world.calls.push(`setRowLabels ${repo}#${number}`);
      rowIn(world, repo, number).labels = [...labels];
    },
    editRowLabels: ({ repo, number, remove, add }) => {
      world.calls.push(`editRowLabels ${repo}#${number}`);
      const row = rowIn(world, repo, number);
      if (world.claim.dropEdits) return;
      row.labels = row.labels.filter((label) => !remove.includes(label));
      if (world.claim.dropAdds) return;
      const missing = add.filter((label) => !labelExists(world, label));
      if (missing.length > 0) throw refusal(`issue edit ${number} --repo ${repo}`, `could not add label: '${missing[0]}' not found`);
      for (const label of add) if (!row.labels.includes(label)) row.labels.push(label);
    },
  };
}
