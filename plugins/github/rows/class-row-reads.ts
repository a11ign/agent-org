// module: the GitHub plugin's reads of the rows that carry a class label, the commits and merged pull requests of `main`, and the open rows of a label (A11-160, step 9; moved from `src/class-repeat.ts`,
// `src/provider-low-confidence.ts`, `src/hand-fix-ledger.ts` and `src/fleet-gated-nightly.ts`)
//
// Each operation builds the argument list its caller built, on the `run` the caller hands it, and reads GitHub's answer as the caller did. A refused call THROWS; an answer that is not the listing asked for is `null`
// where the contract says so. What a caller makes of either (an `unreadable` fact, a stated unknown, a refusal that names the limit) stays in core.
import type { LabelledRead, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ClosedClassRowRead, ClosedRowTitled, CommitLoginRead, LabelledOpenRow, LabelledRowRead, MergedPullRead } from "../../../src/plugins/contracts/code-host-rows-classes.ts";

/** What `gh` is asked to keep of each row: the raw `issues` listing carries every body, which no caller of this file reads. */
const CLOSED_ROW_PROJECTION = "[.[] | {number, state, closed_at, title, pull_request: (.pull_request != null), labels: [.labels[].name]}]";
const TITLED_ROW_PROJECTION = "[.[] | {number, state, pull_request: (.pull_request != null), title, labels: [.labels[].name]}]";
const COMMIT_LOGIN_PROJECTION = '.[] | [.sha, (.author.login // "")] | @tsv';
const LABELLED_ROW_SELECT = "number title state closedAt";
const MERGED_PULL_SELECT = "number title body author{login}";

/** The newest-updated closed rows of `repo`, `perPage` of them, as the issues endpoint lists them (pull requests included); `extra` narrows the listing. */
const closedListingArgs = (repo: string, perPage: number, extra: readonly string[], projection: string): string[] =>
  ["api", "--method", "GET", `repos/${repo}/issues`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", `per_page=${perPage}`, ...extra, "--jq", projection];

const isStrings = (labels: unknown[]): string[] => labels.filter((label): label is string => typeof label === "string");

export function closedClassRowsOf({ repo, classLabel, perPage, run }: { repo: string; classLabel: string | null; perPage: number; run: RowsRun }): ClosedClassRowRead[] | null {
  const text = run(closedListingArgs(repo, perPage, classLabel === null ? [] : ["-f", `labels=${classLabel}`], CLOSED_ROW_PROJECTION));
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  // One entry that is not a row (no number, no labels) makes the whole answer something that is not a listing.
  if (entries.some((entry) => typeof entry?.number !== "number" || !Array.isArray(entry.labels))) return null;
  return entries.filter((entry) => entry.pull_request !== true && entry.state === "closed").map((entry) => {
    const closedAt = Date.parse(entry.closed_at);
    return { number: entry.number, title: entry.title, closedAt: Number.isFinite(closedAt) ? closedAt : null, labels: isStrings(entry.labels) };
  });
}

export function closedRowsTitledOf({ repo, perPage, run }: { repo: string; perPage: number; run: RowsRun }): ClosedRowTitled[] | null {
  const entries = JSON.parse(run(closedListingArgs(repo, perPage, [], TITLED_ROW_PROJECTION)));
  if (!Array.isArray(entries)) return null;
  return entries.filter((entry) => entry?.state === "closed" && entry.pull_request !== true && typeof entry.number === "number" && typeof entry.title === "string" && Array.isArray(entry.labels))
    .map((entry) => ({ number: entry.number, title: entry.title, labels: isStrings(entry.labels) }));
}

/** The rows of `label` in both states, the open ones first, through the plugin's own read of rows by label (`read`). A read that is not a list THROWS there. */
export function labelledRowsOf(read: (ask: LabelledRead) => any[], { repo, label, run }: { repo: string; label: string; run: RowsRun }): LabelledRowRead[] {
  const asked = { label, select: LABELLED_ROW_SELECT, repo, run };
  return [...read({ ...asked, state: "OPEN" }), ...read({ ...asked, state: "CLOSED" })]
    .map((row) => ({ number: row.number, title: row.title, state: row.state, closedAt: row.closedAt ?? null }));
}

export function mainCommitLoginsSince({ repo, since, run }: { repo: string; since: Date; run: RowsRun }): CommitLoginRead[] {
  const raw = run(["api", "--paginate", `repos/${repo}/commits?sha=main&since=${since.toISOString()}&per_page=100`, "--jq", COMMIT_LOGIN_PROJECTION]);
  return raw.split("\n").filter(Boolean).map((line) => {
    const [sha, login] = line.split("\t");
    return { sha, login: login || null };
  });
}

/** The merged pull requests since a day, through the plugin's own read of merged pull requests (`read`): a window longer than `maxPages` pages THROWS there, it is never cut. */
export function mergedPullsSince(read: (request: { repo: string; select: string; run: RowsRun; window: { since: string; maxPages: number } }) => Record<string, unknown>[],
  { repo, since, maxPages, run }: { repo: string; since: Date; maxPages: number; run: RowsRun }): MergedPullRead[] {
  const merged = read({ repo, select: MERGED_PULL_SELECT, run, window: { since: since.toISOString().slice(0, 10), maxPages } }) as unknown as { number: number; author: { login?: string } | null; title: string; body: string }[];
  return merged.map((pull) => ({ number: pull.number, author: pull.author?.login ?? null, title: pull.title, body: pull.body ?? "" }));
}

/**
 * The flags that narrow a listing to one label. THIS LISTING IS A SEARCH-BACKED ONE (`gh issue list --label`), and it is the nightly fleet-gated firing's own: the firing took it from the gate's selector
 * (`FLEET_GATED_SELECTOR.listArgs`) and `no-search-reads.test.ts` names it "its own row" (#5076), so the flags are a spread here as they were there, and the walk that holds every other reader to a connection
 * does not read this one as a regression. Moving it to the connection is that row's work, not this move's: the argument list is the one the firing always sent.
 */
const labelFlags = (label: string): string[] => ["--label", label];

export function openRowsCarryingLabel({ repo, label, limit, run }: { repo: string; label: string; limit: number; run: RowsRun }): LabelledOpenRow[] {
  return JSON.parse(run(["issue", "list", "--repo", repo, "--state", "open", ...labelFlags(label), "--json", "number,comments", "--limit", String(limit)]));
}
