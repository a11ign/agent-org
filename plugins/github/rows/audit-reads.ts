// module: the GitHub plugin's reads and writes of the audit section (A11-160, step 9; moved from `src/ready-label-audit.ts`, `src/unwaited-stock-rows.ts`, `src/unpark-satisfied.ts` and `src/work-tick.ts`)
//
// Each operation builds the argument list its caller built, in the same order, and reads GitHub's answer as the caller did. A refused `run` THROWS: what a caller does with a refusal stays in core. An answer that is not
// the shape the operation reads is `{ unreadable }` with the words the caller refuses in, where its caller refused in its own words (the audit's "refusing to guess" lines); the audit's own prefix is the caller's.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type {
  AuditUnreadable, ClosingReference, ListedIssue, ListedIssueField, ListedPage, ListedPull, ListedPullField, MergedCloser, StockTimelineEvent,
} from "../../../src/plugins/contracts/code-host-rows-audit.ts";

const unreadable = (words: string): AuditUnreadable => ({ unreadable: words });

/** The lines `gh api --jq` printed, one JSON object per line. */
const jsonLines = (out: string): any[] => out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

export function reportedOpenIssueNumbersOf({ repo, run }: { repo: string; run: RowsRun }): { numbers: number[] } | AuditUnreadable {
  const raw = run(["api", `search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open`)}`, "--paginate", "--jq", ".items[].number"]);
  const numbers: number[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const n = Number(line.trim());
    if (!Number.isFinite(n)) return unreadable(`GitHub's reported open-issue numbers included a non-number line -- refusing to guess. Got: ${line.slice(0, 200)}`);
    numbers.push(n);
  }
  return { numbers };
}

/** The entries of a `--json` list read: the parsed list, or the words for an answer that is not JSON or not a list. */
function entriesOf(raw: string, what: string): { entries: unknown[] } | AuditUnreadable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable(`gh's ${what} response was not JSON -- refusing to guess. First 200 chars: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) return unreadable(`gh's ${what} response was not a list -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  return { entries: parsed };
}

/** The names of a row's labels, or the words for a label that has none. */
function labelNamesOf(number: unknown, labels: unknown[]): string[] | AuditUnreadable {
  const names: string[] = [];
  for (const label of labels) {
    const name = (label as { name?: unknown })?.name;
    if (typeof name !== "string") return unreadable(`issue #${number} has a label with no name -- refusing to guess. Got: ${JSON.stringify(label)}`);
    names.push(name);
  }
  return names;
}

/** The fields asked for that the entry carries, each as it gave it; the labels as their names. */
function listedIssueOf(entry: unknown, fields: readonly ListedIssueField[]): ListedIssue | AuditUnreadable {
  const raw = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  const listed: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in raw)) continue;
    if (field !== "labels") {
      listed[field] = raw[field];
      continue;
    }
    if (!Array.isArray(raw.labels)) continue;
    const names = labelNamesOf(raw.number, raw.labels);
    if (!Array.isArray(names)) return names;
    listed.labels = names;
  }
  return listed as ListedIssue;
}

export function issueListingOf({ repo, state, limit, fields, milestone, what, run }: {
  repo: string; state: "open" | "closed" | "all"; limit: number; fields: readonly ListedIssueField[]; milestone?: string; what: string; run: RowsRun;
}): ListedPage<ListedIssue> {
  const read = entriesOf(run(["issue", "list", "--repo", repo, "--state", state, "--limit", String(limit), "--json", fields.join(","), ...(milestone === undefined ? [] : ["--milestone", milestone])]), what);
  if (!("entries" in read)) return read;
  const rows: ListedIssue[] = [];
  for (const entry of read.entries) {
    const listed = listedIssueOf(entry, fields);
    if ("unreadable" in listed) return listed;
    rows.push(listed);
  }
  return { rows };
}

export function pullListingOf({ repo, state, limit, fields, what, run }: {
  repo: string; state: "open" | "closed"; limit: number; fields: readonly ListedPullField[]; what: string; run: RowsRun;
}): ListedPage<ListedPull> {
  const read = entriesOf(run(["pr", "list", "--repo", repo, "--state", state, "--limit", String(limit), "--json", fields.join(",")]), what);
  if (!("entries" in read)) return read;
  return { rows: read.entries.map((entry) => carried(entry, fields) as ListedPull) };
}

/** The fields asked for that the entry carries, each as it gave it. */
function carried(entry: unknown, fields: readonly string[]): Record<string, unknown> {
  const raw = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => field in raw).map((field) => [field, raw[field]]));
}

/**
 * One GraphQL round trip for a list of aliased sub-queries against `repo`: each number becomes the alias `<alias><i>` in the query, and `readNodes` reads the answers back out of the repository node. No number makes no call,
 * since an empty alias list is not valid GraphQL. `response` names the answer in the words an unreadable one is refused in.
 */
function aliasedRepoNodes<Value>({ repo, alias, numbers, select, response, run, readNodes }: {
  repo: string; alias: string; numbers: number[]; select: (n: number) => string; response: string; run: RowsRun;
  readNodes: (node: Record<string, any>, index: number) => Value | AuditUnreadable;
}): { values: Map<number, Value> } | AuditUnreadable {
  if (numbers.length === 0) return { values: new Map() };
  const [owner, name] = repo.split("/");
  const fields = numbers.map((n, i) => `${alias}${i}: ${select(n)}`).join(" ");
  const raw = run(["api", "graphql", "-f", `query={ repository(owner: "${owner}", name: "${name}") { ${fields} } }`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable(`gh's ${response} response was not JSON -- refusing to guess. First 200 chars: ${raw.slice(0, 200)}`);
  }
  const node = (parsed as any)?.data?.repository;
  if (!node || typeof node !== "object") return unreadable(`gh's ${response} response had no repository -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  const values = new Map<number, Value>();
  for (let i = 0; i < numbers.length; i++) {
    const read = node[`${alias}${i}`];
    if (!read || typeof read.number !== "number") return unreadable(`${alias === "p" ? "PR" : "issue"} #${numbers[i]} is missing from the ${response} response -- refusing to guess. Got: ${JSON.stringify(read ?? null).slice(0, 300)}`);
    values.set(read.number, readNodes(read, i) as Value);
  }
  return { values };
}

export function closingReferencesOf({ repo, numbers, run }: { repo: string; numbers: number[]; run: RowsRun }): { references: Map<number, ClosingReference[]> } | AuditUnreadable {
  const read = aliasedRepoNodes<ClosingReference[]>({ repo, alias: "i", numbers, response: "closing-references", run,
    select: (n) => `issue(number: ${n}) { number closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } }`,
    readNodes: (issue) => {
      const nodes = issue.closedByPullRequestsReferences?.nodes;
      return Array.isArray(nodes) ? nodes.map((r: any) => ({ number: r.number, state: r.state, mergedAt: r.mergedAt ?? null })) : [];
    } });
  return "values" in read ? { references: read.values } : read;
}

export function latestReopenedAtOf({ repo, numbers, run }: { repo: string; numbers: number[]; run: RowsRun }): { reopenedAt: Map<number, string | null> } | AuditUnreadable {
  const read = aliasedRepoNodes<string | null>({ repo, alias: "i", numbers, response: "reopen-history", run,
    select: (n) => `issue(number: ${n}) { number timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } }`,
    readNodes: (issue) => {
      const nodes = issue.timelineItems?.nodes;
      return Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1]?.createdAt ?? null : null;
    } });
  return "values" in read ? { reopenedAt: read.values } : read;
}

export function closingIssueReferencesOf({ repo, numbers, run }: { repo: string; numbers: number[]; run: RowsRun }): { references: Map<number, number[]> } | AuditUnreadable {
  const read = aliasedRepoNodes<number[]>({ repo, alias: "p", numbers, response: "closing-issue-references", run,
    select: (n) => `pullRequest(number: ${n}) { number closingIssuesReferences(first: 20) { nodes { number } } }`,
    readNodes: (pull) => {
      const nodes = pull.closingIssuesReferences?.nodes;
      return Array.isArray(nodes) ? nodes.map((r: any) => r.number).filter((n: unknown) => typeof n === "number") : [];
    } });
  return "values" in read ? { references: read.values } : read;
}

/** The time `jq` printed, or `null` for none: an empty selection prints the text `null` (and nothing at all for an empty answer), which is no time. */
const timeOrNull = (printed: string): string | null => {
  const text = printed.trim();
  return text === "" || text === "null" ? null : text;
};

export function newestLabeledAtOf({ repo, number, label, run }: { repo: string; number: number; label: string; run: RowsRun }): string | null {
  return timeOrNull(run(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate", "--jq", `[.[]|select(.event=="labeled" and .label.name=="${label}")]|last|.created_at`]));
}

export function newestCommentAtOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string | null {
  return timeOrNull(run(["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", "[.[].created_at]|last"]));
}

export function milestoneDescriptionOf({ repo, title, run }: { repo: string; title: string; run: RowsRun }): string | null {
  const milestones = JSON.parse(run(["api", `repos/${repo}/milestones?state=all`, "--jq", "[.[]|{title,description}]"]));
  return milestones.find((m: { title: string }) => m.title === title)?.description ?? null;
}

export function blockedByAddedAtOf({ repo, holder, blocker, run }: { repo: string; holder: number; blocker: number; run: RowsRun }): string | null {
  const events = JSON.parse(run(["api", `repos/${repo}/issues/${holder}/timeline`, "--paginate", "--slurp"])).flat();
  const added = events.filter((e: any) => e.event === "blocked_by_added" && e.blocked_by?.number === blocker).map((e: any) => String(e.created_at));
  return added.length === 0 ? null : added.sort().at(-1) ?? "";
}

export function stockTimelineEventsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): StockTimelineEvent[] {
  return jsonLines(run(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate", "--jq", ".[] | {event, created_at, label: (.label // null)}"]));
}

export function rowLabelsAndStateOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { labels: string[]; state: string } {
  const read = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels,state"]));
  return { labels: (read.labels ?? []).map((l: any) => String(l.name)), state: String(read.state) };
}

export function mergedClosersOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): MergedCloser[] {
  const [owner, name] = repo.split("/");
  const query = `{ repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) { closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } } }`;
  const nodes = JSON.parse(run(["api", "graphql", "-f", `query=${query}`]))?.data?.repository?.issue?.closedByPullRequestsReferences?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`the closing pull requests of #${number} could not be read (an answer with no \`nodes\`)`);
  return nodes.filter((n: any) => n?.state === "MERGED" && n?.mergedAt).map((n: any) => ({ number: Number(n.number), mergedAt: String(n.mergedAt) }));
}

export function closedAtOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): number | null {
  const at = Date.parse(run(["api", `repos/${repo}/issues/${number}`, "--jq", ".closed_at"]).trim());
  return Number.isFinite(at) ? at : null;
}

export function writeHeartbeatVariable({ repo, variable, value, run }: { repo: string; variable: string; value: string; run: RowsRun }): void {
  run(["api", "-X", "PATCH", `repos/${repo}/actions/variables/${variable}`, "-f", `value=${value}`]);
}
