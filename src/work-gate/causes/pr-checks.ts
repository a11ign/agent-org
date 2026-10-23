import { anyChecksRed, mergeCandidates } from "../pr-state.ts";
import { defaultRun } from "../reads/read-memo-and-exit.ts";
import { rows } from "../../plugins/rows.ts";

/**
 * PAID ONLY BY A RED TICK, the condition `requiredWhenNeeded` had before a green draft also asked it (#3448), so a healthy
 * queue pays neither this nor the base-tip read (#2117). Extracted from `main` for `requiredWhenNeeded`'s reason, and
 * exported with a `run` seam so a test can assert a healthy tick makes NO call.
 */
export function baseTipWhenRed(prs: any[], run: (args: string[]) => string = defaultRun): { sha: string; date: string; } | null {
  return anyChecksRed(prs) ? readBaseTip(run) : null;
}

/** What `readRequiredContexts` found: the contexts, or `null` and the report of why neither source gave any. */
export type RequiredContexts = import("../../plugins/contracts/code-host-rows.ts").RequiredContexts;

/**
 * THE ONE READER OF "WHICH CHECKS CAN BLOCK A MERGE ON `main`" (#5020), shared by this gate's `requiredCheckNames` and `queue-table.ts`'s `requiredContexts`. It is the code host's: rulesets first, classic branch
 * protection only when they give nothing (`plugins/github/rows/gate-pull-reads.ts`). Neither -> `null`, which is still UNKNOWN and still fails open at every caller -- never `[]`, which would read as "nothing blocks".
 *
 * `repo` is `owner/name`, or gh's own `{owner}/{repo}` placeholder (the gate's default). Never throws: a refusal becomes part of `diagnosis`.
 */
export function readRequiredContexts(run: (args: string[]) => string, repo = "{owner}/{repo}"): RequiredContexts {
  return rows().readRequiredContexts({ run, repo });
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

/** A commit id, abbreviated or whole. An empty or non-hex `sha` would render as a blank tip in the prompt. */
const HEX_SHA = /^[0-9a-f]{7,40}$/i;

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
  let tip;
  try {
    tip = rows().mainTipOf({ run });
  } catch (error) {
    const why = String((error as any)?.message ?? error).split("\n")[0].trim();
    log(`CANNOT READ main's tip: the read of the repository's main commit was REFUSED (${why}). `
      + "pr-checks-failing prompts will call `has main moved` UNKNOWN; no order is withheld for it.\n");
    return null;
  }
  return HEX_SHA.test(String(tip?.sha)) && Number.isFinite(Date.parse(String(tip?.date))) ? tip as { sha: string; date: string; } : null;
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
