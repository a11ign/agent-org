// module: the GitHub reads of pull requests, commits, checks and runs that the work gate asks (A11-160, step 6; moved from `src/work-gate/`)
//
// The gate DECIDES (which pull request is stuck, whose check is required, what a failed run means); what it ASKS OF GITHUB and how it reads the answer is here. Each takes the `run` the gate hands it (the contract's
// head says why) and builds the same argument list the gate built, so the tick's memo keys and the ledger's lines are what they were. Each THROWS when `gh` refuses or an answer is not the shape, unless its comment
// says it answers `null`: "could not read" is never an empty list.
import type { RequiredContexts, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

// --- the checks `main` requires ---------------------------------------------------------------------------------------------------------

/**
 * `branches/main`, NOT `branches/main/protection` (#2331). The protection endpoints are repository-ADMIN only, and the gate runs as an account with `permissions.admin: false`, so they 404'd on every tick for four
 * days (#2106). `branches/main` needs only `pull` and carries the same list.
 */
const BRANCH_ENDPOINT = "branches/main";

/**
 * WHERE THE REQUIRED CHECKS ARE NOW (#5020). On 2026-10-11 classic branch protection was deleted on every repo and each `merge-queue-main` ruleset took over `required_status_checks`, so `BRANCH_ENDPOINT`'s
 * `protection` object answers `{"enabled": false, "contexts": []}` -- a read that "works" and lists nothing. `rules/branches/main` lists every rule that applies to the branch whichever ruleset it comes from, and
 * needs only `pull`. One page is enough: a branch carries a handful of rules, far under the page size.
 */
const RULES_ENDPOINT = "rules/branches/main";

/**
 * The union of the contexts of every `required_status_checks` rule in a `rules/branches/main` answer, or `null`. Filtered HERE and not by a `--jq`, so the rule shapes a branch really carries (`pull_request`,
 * `deletion`, `merge_queue`, ...) are exercised by tests rather than by a jq string nobody runs.
 */
function rulesetContexts(rules: unknown): unknown {
  if (!Array.isArray(rules)) return null;
  return rules
    .filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => rule?.parameters?.required_status_checks ?? [])
    .map((check: any) => check?.context);
}

/** One `gh` read: what it answered, or the first line of why it was refused. Never both, never thrown. */
type Attempt = { answer: string; refusal?: undefined } | { refusal: string; answer?: undefined };

function attempt(run: RowsRun, args: string[]): Attempt {
  try {
    return { answer: run(args) };
  } catch (error) {
    // THE REFUSAL AND THE UNUSABLE ANSWER ARE DIFFERENT FACTS, so the call is separated from the parse. A refusal says nothing about whether `main` is protected, and #2022 forbids reading it as if it did.
    return { refusal: String((error as any)?.message ?? error).split("\n")[0].trim() };
  }
}

/** A non-empty list of names, or `null`: an empty required set is "could not read", never "nothing blocks". */
function usableNames(value: unknown): string[] | null {
  const isMalformedList = !Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v);
  if (isMalformedList) return null;
  return [...new Set<string>(value)];
}

/** The two facts of a `branches/main` answer the gate uses: whether `main` is protected at all (`false` is a trunk fact worth escalating) and the classic list. Quoted in the report instead of the whole body, which carries a commit. */
function classicProtection(branch: any): { protected: unknown; contexts: unknown } | null {
  if (branch === null || typeof branch !== "object") return null;
  return { protected: branch.protected, contexts: branch.protection?.required_status_checks?.contexts };
}

/** How much of an unusable answer is worth echoing before it becomes the noise it is reporting. */
const ECHOED_ANSWER_CHARS = 200;

/** The answer itself, bounded: a diagnostic that pastes a 32MB body into the tick log replaces a silent failure with an unreadable one. */
function quoted(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ECHOED_ANSWER_CHARS ? `${trimmed.slice(0, ECHOED_ANSWER_CHARS)}... (${trimmed.length} chars)` : trimmed;
}

function parsedOrNull(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One source's contribution to the "CANNOT READ" report; `shown` replaces the raw answer where one is smaller. */
function describeAttempt(endpoint: string, read: Attempt, shown?: unknown): string {
  if (read.refusal !== undefined) return `\`gh api ${endpoint}\` was REFUSED (${read.refusal})`;
  const answer = shown === undefined || shown === null ? read.answer : JSON.stringify(shown);
  return `\`gh api ${endpoint}\` answered, but with no usable list of contexts: ${quoted(answer)}`;
}

/** A place the required checks may be listed, in the order they are asked. */
type RequiredSource = { path: string; names: (parsed: any) => unknown; shown?: (parsed: any) => unknown };

const REQUIRED_SOURCES: RequiredSource[] = [
  { path: RULES_ENDPOINT, names: rulesetContexts },
  { path: BRANCH_ENDPOINT, names: (branch) => classicProtection(branch)?.contexts, shown: classicProtection },
];

/**
 * THE ONE READER OF "WHICH CHECKS CAN BLOCK A MERGE ON `main`" (#5020), shared by the gate's `requiredCheckNames` and `queue-table.ts`'s `requiredContexts`, which had each carried its own copy of the classic-only read
 * and so went blind together when classic protection was deleted.
 *
 * RULESETS FIRST, CLASSIC ONLY WHEN THE RULESET SOURCE GIVES NOTHING: a repository the rulesets do not cover (or a refused read of them) still answers from `branches/main`'s classic list. Neither -> `null`, which is
 * still UNKNOWN and still fails open at every caller -- never `[]`, which would read as "nothing blocks".
 *
 * `repo` is `owner/name`, or `gh`'s own `{owner}/{repo}` placeholder (the gate's default) which resolves from the working directory. Never throws: a refusal becomes part of `diagnosis`.
 */
export function readRequiredContexts({ run, repo = "{owner}/{repo}" }: { run: RowsRun; repo?: string }): RequiredContexts {
  const reports: string[] = [];
  for (const source of REQUIRED_SOURCES) {
    const endpoint = `repos/${repo}/${source.path}`;
    // ONE CALL SITE for both sources: they differ only in path and parse, and `gh-call-ratchet` counts sites.
    const read = attempt(run, ["api", endpoint]);
    const parsed = read.answer === undefined ? null : parsedOrNull(read.answer);
    const names = usableNames(source.names(parsed));
    if (names) return { contexts: names };
    reports.push(describeAttempt(endpoint, read, source.shown?.(parsed)));
  }
  return { contexts: null, diagnosis: `${reports.join("; ")}.` };
}

/** `main`'s tip commit and its committer date, as GitHub states them (not checked: the gate holds the rule for what a usable tip is). THROWS when the read is refused. */
export function mainTipOf({ run }: { run: RowsRun }): { sha?: unknown; date?: unknown } | null {
  return parsedOrNull(run(["api", "repos/{owner}/{repo}/commits/main", "--jq", "{sha: .sha, date: .commit.committer.date}"]));
}

// --- pull requests ----------------------------------------------------------------------------------------------------------------------

/** Every pull request opened from `branch`, whatever its state (`--state all`: a closed one is the point), at most `limit`. `null` when the answer is not a list. */
export function pullsOfBranch({ branch, limit, run }: { branch: string; limit: number; run: RowsRun }): { number: number; state: string }[] | null {
  const parsed = JSON.parse(run(["pr", "list", "--head", branch, "--state", "all", "--limit", String(limit), "--json", "number,state"]));
  return Array.isArray(parsed) ? parsed.map((pr: { number: number; state: string }) => ({ number: pr.number, state: String(pr.state) })) : null;
}

/** The newest 100 merged pull requests, in `gh pr list --json` shape. `null` when the answer is not a list. THROWS when the read is refused. */
export function newestMergedPulls({ run }: { run: RowsRun }): { number: number; headRefName: string; mergedAt: string; title: string; labels: { name: string }[] }[] | null {
  const parsed = JSON.parse(run(["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,headRefName,mergedAt,title,labels"]));
  return Array.isArray(parsed) ? parsed : null;
}

/** The arguments that list the open pull requests, newest `limit` first, with the JSON fields `fields` names. The gate runs them through its own executor, which folds and memoises by them. */
export const openPullListArgs = (limit: number, fields: string): string[] => ["pr", "list", "--state", "open", "--limit", String(limit), "--json", fields];

/** The file names of a pull request past the 100 its listing carries, all pages. THROWS when the read is refused. */
export function pullFileNamesOf({ number, run }: { number: number; run: RowsRun }): string[] {
  return run(["api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/files?per_page=100`, "--jq", ".[].filename"]).split("\n").filter(Boolean);
}

/** The shas of a pull request's commits, oldest first. REST and not the list call: `commits` on `gh pr list --limit 100` is refused outright by GraphQL ("requesting up to 1,000,000 possible nodes"), and REST returns every commit. */
export function commitShasOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] {
  return run(["api", `repos/${repo}/pulls/${number}/commits`, "--paginate", "--jq", ".[].sha"]).split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * The compare API's diff, `base...head`, as text: `merge-base(base, head)..head`, because the gate holds no checkout. Read as a diff and not the JSON's per-file `patch`, which truncates a file's patch silently
 * and would hash two different changes to one id. THROWS when the read is refused, GitHub's own "diff too large" included.
 */
export function compareDiffOf({ repo, base, head, run }: { repo: string; base: string; head: string; run: RowsRun }): string {
  return run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo}/compare/${base}...${head}`]);
}

/** The names of the check runs that concluded `failure` at `commit` (an abbreviation resolves), without repeats. THROWS when the read is refused. */
export function failingCheckNamesAt({ repo, commit, run }: { repo: string; commit: string; run: RowsRun }): string[] {
  const out = run(["api", `repos/${repo}/commits/${commit}/check-runs?per_page=100`, "--paginate", "--jq", '.check_runs[] | select(.conclusion == "failure") | .name']);
  return [...new Set(out.split("\n").map((line) => line.trim()).filter((line) => line !== ""))];
}

/** The check runs at `commit` with each one's `output.summary`, where a check says what clears it. THROWS when the read is refused. */
export function checkRunSummariesAt({ repo, commit, run }: { repo: string; commit: string; run: RowsRun }): { id: number; name: string; summary: unknown }[] {
  const out = run(["api", `repos/${repo}/commits/${commit}/check-runs?per_page=100`, "--paginate", "--jq", ".check_runs[] | {id, name, summary: .output.summary}"]);
  return out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

// --- the merge queue's runs -------------------------------------------------------------------------------------------------------------

/** The newest 50 `merge_group` runs of `repo`: their id, branch and creation time, and (with `withConclusion`) how each concluded. THROWS when the read is refused. */
export function mergeGroupRunsOf({ repo, withConclusion, run }: { repo: string; withConclusion: boolean; run: RowsRun }): { id: number; head_branch: string; conclusion?: string | null; created_at: string }[] {
  const fields = withConclusion ? "{id, head_branch, conclusion, created_at}" : "{id, head_branch, created_at}";
  return JSON.parse(run(["api", `repos/${repo}/actions/runs?event=merge_group&per_page=50`, "--jq", `[.workflow_runs[] | ${fields}]`]));
}

/** What the gate reads of a job to tell whether it ever got a runner: its conclusion, the runner it ran on and how many steps it ran. */
const JOB_FIELDS = "{conclusion, runner_name, steps: (.steps // [] | length)}";

/** The jobs of workflow run `runId`, each with {@link JOB_FIELDS}. THROWS when the read is refused. */
export function jobsOfMergeGroupRun({ repo, runId, run }: { repo: string; runId: number; run: RowsRun }): { conclusion: string | null; runner_name: string; steps: number }[] {
  return JSON.parse(run(["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, "--jq", `[.jobs[] | ${JOB_FIELDS}]`]));
}

/** One Actions job, with {@link JOB_FIELDS}. THROWS when the read is refused. */
export function actionsJobOf({ repo, jobId, run }: { repo: string; jobId: string; run: RowsRun }): { conclusion: string | null; runner_name: string; steps: number } {
  return JSON.parse(run(["api", `repos/${repo}/actions/jobs/${jobId}`, "--jq", JOB_FIELDS]));
}

// --- the rows' lists ---------------------------------------------------------------------------------------------------------------------

/**
 * The open rows, newest `limit`, with the JSON fields `fields` names. THROWS when the read is refused, and when the answer parses but is not a list (a refusal too, which said nothing for three ticks before it was
 * named).
 */
export function openRowsOf({ limit, fields, run }: { limit: number; fields: string; run: RowsRun }): any[] {
  const answer = run(["issue", "list", "--state", "open", "--limit", String(limit), "--json", fields]);
  const parsed = JSON.parse(answer);
  if (Array.isArray(parsed)) return parsed;
  throw new Error(`the answer was not a list: ${JSON.stringify(String(answer).slice(0, 120))}`);
}

/** The names of the repository's labels that start with `prefix`, or `null` when the answer is not a list. `gh label list --json` prints ZERO BYTES, not `[]`, when nothing matches (#472), which is no label. THROWS when the read is refused. */
export function labelNamesWithPrefix({ prefix, run }: { prefix: string; run: RowsRun }): string[] | null {
  const text = run(["label", "list", "--search", prefix, "--limit", "100", "--json", "name"]);
  if (text.trim() === "") return [];
  const labels = JSON.parse(text);
  if (!Array.isArray(labels)) return null;
  return labels.map((label) => label?.name).filter((name) => typeof name === "string" && name.startsWith(prefix));
}
