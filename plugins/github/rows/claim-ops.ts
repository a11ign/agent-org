// module: the GitHub operations of a row's claim (A11-160, step 7; moved from `src/row-claim.ts`)
//
// The claim DECIDES what is read and written and in what order (the labels before the write, the re-read after it, the back-off of a lost race, the record after the win); the command that does it and the reading of
// GitHub's answer are here. Each takes the `run` the claim hands it, builds the argument list the claim built, and THROWS when `gh` refuses: a write that failed is never a write that was done. The two REST reads
// answer `{ unreadable }` for a reply that is not what the claim can read (it is neither a refusal nor a row), with the words the claim says it in, so the claim tells "could not ask" from "asked and got nonsense".
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { RestRowRead, RestCommentsRead } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

/** The arguments that create the label `label` in `repo`, or update it: `--force` makes a second create harmless. The claim hands them to its executor to wait together (`ensureLabelIn` runs the same one by one). */
export function ensureLabelArgs(label: string, repo: string): string[] {
  return ["label", "create", label, "--repo", repo, "--force"];
}

/**
 * A row as REST states it (agent-org#1302: REST, not `gh issue view`, because an exhausted GraphQL pool refused every claim it read): its number, title and the names of its labels, and `state` upper-cased, or absent
 * when REST gave neither `open` nor `closed`. THROWS when `gh` fails; answers `{ unreadable }` for an answer that is not JSON, lacks the number, title or labels, or names a label with no name.
 */
export function readRestRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RestRowRead {
  const raw = run(["api", `repos/${repo}/issues/${number}`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: `row-claim: gh's response for issue #${number} was not JSON -- refusing to guess. First 200 chars: ${raw.slice(0, 200)}` };
  }
  const answer = parsed as { number?: unknown; title?: unknown; labels?: unknown; state?: unknown };
  if (typeof answer?.number !== "number" || typeof answer?.title !== "string" || !Array.isArray(answer?.labels)) {
    return { unreadable: `row-claim: gh's response for issue #${number} is missing number/title/labels -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}` };
  }
  const names: string[] = [];
  for (const label of answer.labels) {
    const name = (label as { name?: unknown })?.name;
    if (typeof name !== "string") return { unreadable: `row-claim: a label on issue #${number} has no name -- refusing to guess. Got: ${JSON.stringify(label)}` };
    names.push(name);
  }
  const state = answer.state === "open" ? "OPEN" : answer.state === "closed" ? "CLOSED" : undefined;
  return { row: { number: answer.number, title: answer.title, labels: names, state } };
}

/**
 * The bodies of a row's last 100 comments, oldest first (agent-org#1302: REST; `--paginate --slurp` joins the pages into one array of pages, which `--paginate` alone does not). A comment with no body reads as an empty one.
 * THROWS when `gh` fails; answers `{ unreadable }` for an answer that is not JSON or not a list of pages.
 */
export function readRestComments({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RestCommentsRead {
  const raw = run(["api", `repos/${repo}/issues/${number}/comments?per_page=100`, "--paginate", "--slurp"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: `row-claim: gh's comment response for issue #${number} was not JSON -- refusing to guess. First 200 chars: ${raw.slice(0, 200)}` };
  }
  const pages = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed : null;
  if (pages === null) return { unreadable: `row-claim: gh's response for issue #${number}'s comments was not a list of pages -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}` };
  return { comments: pages.flat().slice(-100).map((comment: unknown) => {
    const body = (comment as { body?: unknown })?.body;
    return typeof body === "string" ? body : "";
  }) };
}

/**
 * Sets the labels of a row to EXACTLY `labels`, in one `PUT`: a set replacement has no window in which the row carries both `ready` and `in-progress` (#2151), and a failed request leaves the labels untouched. It
 * carries every label the row holds, so the caller computes `labels` from a read taken just before.
 */
export function setRowLabels({ repo, number, labels, run }: { repo: string; number: number; labels: readonly string[]; run: RowsRun }): void {
  run(["api", "--method", "PUT", `repos/${repo}/issues/${number}/labels`, ...labels.flatMap((label) => ["-f", `labels[]=${label}`])]);
}

/** Takes `remove` off a row of `repo` and puts `add` on, in one `gh issue edit` (which is NOT one write when a label to add does not exist: the caller creates them first). */
export function editRowLabels({ repo, number, remove, add, run }: { repo: string; number: number; remove: readonly string[]; add: readonly string[]; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--repo", repo, ...remove.flatMap((label) => ["--remove-label", label]), ...add.flatMap((label) => ["--add-label", label])]);
}
