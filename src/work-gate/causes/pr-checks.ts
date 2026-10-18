import { anyChecksRed, mergeCandidates } from "../pr-state.ts";
import { defaultRun } from "../reads/exit.ts";

/**
 * PAID ONLY BY A RED TICK, the condition `requiredWhenNeeded` had before a green draft also asked it (#3448), so a healthy
 * queue pays neither this nor the base-tip read (#2117). Extracted from `main` for `requiredWhenNeeded`'s reason, and
 * exported with a `run` seam so a test can assert a healthy tick makes NO call.
 */
export function baseTipWhenRed(prs: any[], run: (args: string[]) => string = defaultRun): { sha: string; date: string; } | null {
  return anyChecksRed(prs) ? readBaseTip(run) : null;
}

/**
 * ONE SPELLING OF THE ENDPOINT, so the report names what the read actually asks for. A report that
 * quotes a path by hand drifts from the call beside it, and a wrong path in a diagnostic sends the next
 * reader to test something the gate never did.
 *
 * `branches/main`, NOT `branches/main/protection` (#2331). The protection endpoints are repository-ADMIN
 * only, and this gate runs as `a11ign-ai-workers` (`permissions.admin: false`), so it 404'd on every tick
 * for four days (#2106). `branches/main` needs only `pull` and carries the same list.
 */
const BRANCH_ENDPOINT = "branches/main";

/**
 * WHERE THE REQUIRED CHECKS ARE NOW (#5020). On 2026-10-11 classic branch protection was deleted on every repo and
 * each `merge-queue-main` ruleset took over `required_status_checks`, so `BRANCH_ENDPOINT`'s `protection` object
 * answers `{"enabled": false, "contexts": []}` -- a read that "works" and lists nothing. `rules/branches/main`
 * lists every rule that applies to the branch whichever ruleset it comes from, and needs only `pull`.
 * One page is enough: a branch carries a handful of rules, far under the page size.
 */
const RULES_ENDPOINT = "rules/branches/main";

/**
 * The union of the contexts of every `required_status_checks` rule in a `rules/branches/main` answer, or `null`.
 * Filtered HERE and not by a `--jq`, so the rule shapes a branch really carries (`pull_request`, `deletion`,
 * `merge_queue`, ...) are exercised by tests rather than by a jq string nobody runs.
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

function attempt(run: (args: string[]) => string, args: string[]): Attempt {
  try {
    return { answer: run(args) };
  } catch (error) {
    // THE REFUSAL AND THE UNUSABLE ANSWER ARE DIFFERENT FACTS, so the call is separated from the parse.
    // A refusal says nothing about whether `main` is protected, and #2022 forbids reading it as if it did.
    return { refusal: String((error as any)?.message ?? error).split("\n")[0].trim() };
  }
}

/** A non-empty list of names, or `null`: an empty required set is "could not read", never "nothing blocks". */
function usableNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v)) return null;
  return [...new Set<string>(value)];
}

/**
 * The two facts of a `branches/main` answer this gate uses: whether `main` is protected at all (`false` is a trunk fact
 * worth escalating) and the classic list. Quoted in the report instead of the whole body, which carries a commit.
 */
function classicProtection(branch: any): { protected: unknown; contexts: unknown } | null {
  if (branch === null || typeof branch !== "object") return null;
  return { protected: branch.protected, contexts: branch.protection?.required_status_checks?.contexts };
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

/** What `readRequiredContexts` found: the contexts, or `null` and the report of why neither source gave any. */
export type RequiredContexts = { contexts: string[]; diagnosis?: undefined } | { contexts: null; diagnosis: string };

/**
 * THE ONE READER OF "WHICH CHECKS CAN BLOCK A MERGE ON `main`" (#5020), shared by this gate's
 * `requiredCheckNames` and `queue-table.ts`'s `requiredContexts`, which had each carried its own copy of the
 * classic-only read and so went blind together when classic protection was deleted.
 *
 * RULESETS FIRST, CLASSIC ONLY WHEN THE RULESET SOURCE GIVES NOTHING: a repository the rulesets do not cover
 * (or a refused read of them) still answers from `branches/main`'s classic list. Neither -> `null`, which is
 * still UNKNOWN and still fails open at every caller -- never `[]`, which would read as "nothing blocks".
 *
 * `repo` is `owner/name`, or gh's own `{owner}/{repo}` placeholder (the gate's default) which resolves from the
 * working directory. Never throws: a refusal becomes part of `diagnosis`.
 */
export function readRequiredContexts(run: (args: string[]) => string, repo = "{owner}/{repo}"): RequiredContexts {
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

/**
 * The checks that can actually BLOCK A MERGE, or `null` when that could not be read.
 *
 * MEASURED 2026-09-19: `main`'s branch protection requires exactly one check --
 *
 *   required_status_checks: ["gate"]
 *
 * -- and `gate` is an aggregator whose `needs` names the nine jobs that matter. EVERY OTHER JOB IS RED
 * WITHOUT BLOCKING ANYTHING, and the gate woke a session for all of them equally.
 *
 * SINCE 2026-10-11 THE LIST LIVES IN THE RULESETS (#5020), not in classic protection: see `readRequiredContexts`,
 * which reads `rules/branches/main` first and `branches/main` only when that gives nothing.
 *
 * THE WASTED PROMPT THAT FOUND THIS. `sweep` (in `auto-arm.yml`, not in `gate`'s `needs`) went red on
 * #1750 at 14:34Z. The gate woke `worker-capture` with "#1750 at 7a9d8340 has FAILING checks and is
 * blocked... it is yours to fix". #1750 MERGED FOUR MINUTES LATER, at 14:38:46Z. The check was genuinely
 * red and the wake was genuinely useless, because that job could never have held the PR.
 *
 * FAILS OPEN, DELIBERATELY. A refused or malformed read returns `null` and the caller then behaves
 * EXACTLY as it did before this function existed -- every red check counts. The failure this guards is a
 * wasted turn; the failure it must not introduce is a red PR nobody is told about, which is the one
 * `failingChecksOrder` was written for in the first place (#1650, a `changeset` failure that sat while
 * its own session was idle).
 *
 * PAID ONLY WHEN SOMETHING IS RED. `main` calls this only if some open PR has a settled-red check, so a
 * healthy tick still costs the two calls this file's whole design rests on.
 *
 * AND IT SAYS SO WHEN IT FAILS OPEN (#2106). It had failed open on EVERY tick since it shipped, and the
 * only sign was a bare `gh: Not Found (HTTP 404)` on stderr -- `defaultRun` inherits stderr, so `gh`'s own
 * message was the whole report, beside an exit 0. The optimisation was dead in production for four days
 * and nothing said so. A read that fails open must announce it, or "fails open" is indistinguishable from
 * "never worked"; silence is what this repository's diagnostics model exists to refuse.
 *
 * ONCE PER TICK, because `requiredWhenNeeded` is the only caller and calls this at most once.
 */
export function requiredCheckNames(run: (args: string[]) => string = defaultRun, log: (line: string) => void = (line) => process.stderr.write(line)): string[] | null {
  const read = readRequiredContexts(run);
  if (read.contexts === null) log(cannotReadRequiredChecks(read.diagnosis));
  return read.contexts;
}

/** How much of an unusable answer is worth echoing before it becomes the noise it is reporting. */
const ECHOED_ANSWER_CHARS = 200;

/**
 * The answer itself, bounded. `defaultRun` allows a 32MB body, and a diagnostic that pastes one into the
 * tick log replaces a silent failure with an unreadable one.
 */
function quoted(text: string) {
  const trimmed = text.trim();
  return trimmed.length > ECHOED_ANSWER_CHARS
    ? `${trimmed.slice(0, ECHOED_ANSWER_CHARS)}... (${trimmed.length} chars)`
    : trimmed;
}

function parsedOrNull(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The one report, whatever went wrong, ending in what the gate does about it.
 *
 * THE CONSEQUENCE IS PART OF THE REPORT. A reader who sees only "could not read" has to know #1750 to
 * work out whether anything is at risk; saying the fallback out loud is what keeps this line from being
 * read as an outage. Nothing is missed -- the SAVING is.
 */
function cannotReadRequiredChecks(diagnosis: string) {
  return `CANNOT READ the required checks: ${diagnosis} `
    + "Falling back to EVERY check on the head (pre-#1750 behaviour): no red pull request is missed, "
    + "but the wasted prompts #1750 was filed to stop are still being sent.\n";
}

/** Where `main` is now, and the one field of it the prompt needs. */
const BASE_TIP_ENDPOINT = "repos/{owner}/{repo}/commits/main";

/** A commit id, abbreviated or whole. An empty or non-hex `sha` would render as a blank tip in the prompt. */
const HEX_SHA = /^[0-9a-f]{7,40}$/i;

const BASE_TIP_JQ = "{sha: .sha, date: .commit.committer.date}";

/**
 * `main`'s tip commit and its committer date, or `null` (#2117).
 *
 * THIS IS A FACT FOR A PROMPT AND NEVER A PREDICATE. `null` -- refused, malformed, no date -- makes the
 * prompt say "not read", which is different from "has not moved", and changes nothing about whether or to
 * whom the order is sent. The committer date is a reading of when `main` last changed, not the instant of
 * the push: a rebased commit keeps an older date, so the prompt quotes the date and lets a reader `git log`.
 *
 * Refusals are announced on stderr like `requiredCheckNames`': a read that fails silently is
 * indistinguishable from one that never ran.
 */
export function readBaseTip(run: (args: string[]) => string = defaultRun, log: (line: string) => void = (line) => process.stderr.write(line)): { sha: string; date: string; } | null {
  let answer;
  try {
    answer = run(["api", BASE_TIP_ENDPOINT, "--jq", BASE_TIP_JQ]);
  } catch (error) {
    const why = String((error as any)?.message ?? error).split("\n")[0].trim();
    log(`CANNOT READ main's tip: \`gh api ${BASE_TIP_ENDPOINT}\` was REFUSED (${why}). `
      + "pr-checks-failing prompts will call `has main moved` UNKNOWN; no order is withheld for it.\n");
    return null;
  }
  const tip = parsedOrNull(answer);
  return HEX_SHA.test(String(tip?.sha)) && Number.isFinite(Date.parse(tip?.date)) ? tip : null;
}

/**
 * PURE. Which open pull requests LOOK like they should be merging already -- not a draft, not held, and
 * settled GREEN on every check that can actually block them?
 *
 * ANSWERED ENTIRELY FROM THE LIST THE GATE ALREADY HOLDS, which is what makes the queue read below
 * conditional rather than unconditional. `ceo`'s ruling of 2026-09-22 requires exactly that: the merge-
 * queue question is "asked only once a PR already looks green, unheld and unqueued". A healthy tick with
 * every open PR armed still pays one extra call; a tick with no green unheld PR at all pays none.
 *
 * `armabilityOf` IS THE HOLD PREDICATE, IMPORTED. It is the same function `arm-pr.ts` and
 * `auto-arm-sweep.ts` refuse a held PR with -- `pr-hold-state.ts`'s own header records #645, where the
 * predicate was written twice and only one copy was correct. A third copy here would report a
 * deliberately held pull request as a stranded one, and send somebody to arm what a ruling holds.
 *
 * REQUIRED-ONLY, like `failingChecksOrder`. A PR green on `gate` merges whatever else is red, and `gate`
 * is the one required context on `main` (measured 2026-09-19). Counting every check would silence this
 * for any PR carrying a red `sweep` -- which is precisely the check the 2026-09-22 outage turned red on
 * every pull request it stranded.
 *
 *
 * @returns PR numbers, ascending
 */
export function shouldBeMerging(prs: any[], required: string[] | null = null): number[] {
  return mergeCandidates(prs, required).map((pr) => Number(pr.number)).sort((a, b) => a - b);
}
