// module: the GitHub plugin's rows for wake (A11-160, step 7; moved from `src/wake.ts`, `src/wake/*` and `src/wakes-per-row.ts`)
//
// The wake DECIDES what it reads of a row and what a read means (a claim that cannot be read is no claim, a pull request that GitHub will not describe is not ended); the command that reads or writes it is here. Each takes the `run` the wake
// hands it, builds the argument list the wake built, and THROWS when `gh` refuses, unless its name says `null`: a read that could not be made is never an empty answer.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { LabelEvent, MarkedComment, TierFacts } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { RowsRunners } from "./index.ts";

/** The title and the comments of row `number` of `repo`; a missing list of comments is an empty one. */
export function titleAndCommentsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { title: string; comments: any[] } {
  const read = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "title,comments"]));
  return { title: String(read.title ?? ""), comments: Array.isArray(read.comments) ? read.comments : [] };
}

/** The names of the labels on row `number` of `repo`, or `null` when the answer carries no list of labels. */
export function labelNamesOfRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] | null {
  const labels = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels"]))?.labels;
  return Array.isArray(labels) ? labels.map((label: any) => label?.name) : null;
}

/** GitHub's word for the state of row `number` of `repo`, or of the repository the call is aimed at when `repo` is absent. */
export function rowStateOf({ number, repo, run }: { number: number; repo?: string; run: RowsRun }): string {
  return String(JSON.parse(run(["issue", "view", String(number), ...(repo === undefined ? [] : ["--repo", repo]), "--json", "state"])).state);
}

/** The labels, body and title of row `number` of `repo`. */
export function labelsBodyTitleOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): TierFacts {
  const read = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels,body,title"]));
  return { labels: (read.labels as { name: string }[]).map((label) => label.name), body: String(read.body ?? ""), title: String(read.title ?? "") };
}

/** Closes row `number` of the repository the call is aimed at, leaving `comment` on it. */
export function closeHomeRowWithComment({ number, comment, run }: { number: number; comment: string; run: RowsRun }): void {
  run(["issue", "close", String(number), "--comment", comment]);
}

/** Files a row carrying every one of `labels` and answers what `gh` printed. */
export function fileRowWithLabels({ title, body, labels, run }: { title: string; body: string; labels: readonly string[]; run: RowsRun }): string {
  return run(["issue", "create", "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])]);
}

/** The last event that put `label` on row `number` or took it off, or `null` when it never had one. */
export function lastLabelEventOf({ number, label, run }: { number: number; label: string; run: RowsRun }): LabelEvent | null {
  const events = run(["api", "--paginate", `repos/{owner}/{repo}/issues/${number}/events`, "--jq",
    `.[] | select(.label.name == ${JSON.stringify(label)}) | [.event, .actor.login, .created_at] | @json`]);
  const last = events.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)).pop();
  return last === undefined ? null : { event: String(last[0]), at: Date.parse(last[2]), by: String(last[1]) };
}

/** Every comment on row `number` as `{ id, login, at, marked }`, `marked` being "carries `marker`". */
export function markedCommentsOf({ number, marker, run }: { number: number; marker: string; run: RowsRun }): MarkedComment[] {
  const lines = run(["api", "--paginate", `repos/{owner}/{repo}/issues/${number}/comments`, "--jq",
    `.[] | [.id, .user.login, .created_at, (.body | contains(${JSON.stringify(marker)}))] | @json`]);
  return lines.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [id, login, at, marked] = JSON.parse(line);
    return { id, login, at: Date.parse(at), marked };
  });
}

/** Whether pull request `number` of `repo` sits in the merge queue: one GraphQL read of its `mergeQueueEntry` (`gh pr view --json` has no such field). */
export function isPullQueued({ repo, number, run }: { repo: string; number: number; run: RowsRun }): boolean {
  const [owner, name] = repo.split("/");
  const query = `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){mergeQueueEntry{position}}}}`;
  return run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.pullRequest.mergeQueueEntry != null"]).trim() === "true";
}

/** `open`, `closed` (a merged pull request is closed too) or `null` for any other word, read through REST so the lookup spends the CORE pool. */
export function pullStateWordOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): "open" | "closed" | null {
  const state = run(["api", `repos/${repo}/pulls/${number}`, "--jq", ".state"]).trim();
  return state === "open" || state === "closed" ? state : null;
}

/**
 * Whether issue or pull request `number` of `repo` is open, and its labels, from GitHub's REST issue read (which answers for both and spends the CORE pool). A reference that does not exist (HTTP 404) is `null`: the
 * caller reads it as closed and held by nobody. Any other refusal THROWS.
 */
export function issueStateAndLabelsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { open: boolean; labels: string[] } | null {
  try {
    const read = JSON.parse(run(["api", `repos/${repo}/issues/${number}`, "--jq", "{state, labels: [.labels[].name]}"]));
    return { open: read.state === "open", labels: read.labels as string[] };
  } catch (err) {
    if (/HTTP 404|Not Found/.test(String((err as any)?.stderr ?? (err as any)?.message))) return null;
    throw err;
  }
}

/** When the first comment of row `number` of `repo` whose body starts with `prefix` was made, as GitHub gives it, or `null` when none was. */
export function firstCommentTimeStartingWith({ repo, number, prefix, pageSize, run }: { repo: string; number: number; prefix: string; pageSize: number; run: RowsRun }): string | null {
  const out = run(["api", "--paginate", `repos/${repo}/issues/${number}/comments?per_page=${pageSize}`, "--jq", `.[] | select(.body | startswith("${prefix}")) | .created_at`]);
  return out.split("\n").find(Boolean) ?? null;
}

/** The answer of `gh api <args>`, parsed as JSON: the REST read a reader that has not moved (the trace's) builds the arguments of. */
export function readRestJson({ args, run }: { args: string[]; run: RowsRun }): any {
  return JSON.parse(run(["api", ...args]));
}

/** The operations wake reaches without a runner of its own. */
export const wakeRows = {
  titleAndCommentsOf, labelNamesOfRow, rowStateOf, labelsBodyTitleOf, closeHomeRowWithComment, fileRowWithLabels, lastLabelEventOf, markedCommentsOf, isPullQueued, pullStateWordOf, issueStateAndLabelsOf,
  firstCommentTimeStartingWith, readRestJson,
};

/** `gh` as the process's own account, cut at the bound the caller names: the plugin's runner for a caller that hands one on to a reader that has not moved. Absent, the operation is refused. */
export function wakeRunnersOf(runners: RowsRunners): { ownRunWithin(timeoutMs: number, options?: { withoutGitEnv?: boolean }): RowsRun } {
  return {
    ownRunWithin: (timeoutMs, options) => {
      if (runners.within === undefined) throw new Error("this code host's rows were built with no runner of their own, so a runner with a bound cannot be made");
      return runners.within(timeoutMs, options);
    },
  };
}
