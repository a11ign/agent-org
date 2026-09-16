#!/usr/bin/env node
// @ts-check
// command: print the pipeline's sections -- trunk, open PRs, stalled work, red checks on merged PRs,
// this host, and (#790) branch prefixes
/**
 * THE HOURLY TABLE, AS A COMMAND RATHER THAN A HABIT -- ceo's ruling, 2026-09-08.
 *
 *   node packages/agent-org/src/queue-table.mjs [--json]
 *
 * ## Why this exists at all
 *
 * The table was a thing `dispatcher` typed. On 2026-09-08 the 19:17Z edition was missed, the merge of a
 * PR was not relayed for an hour, and a red `audit` check sat on seven merged PRs for ninety minutes --
 * found by the chairman, reading the PR list, before anyone in the org read the same view. Each has a
 * reason on its own; together they are a lane not being read. **A missed table produced by a habit is
 * invisible; a missed table produced by a script is a missing paste**, which is the whole of the fix.
 *
 * ## SECTION 4 IS FIRST FOR A REASON
 *
 * "Non-success checks on the last ten merged PR heads, by check name" is the view the chairman actually
 * looks at, and nothing in this org was looking at it. It is printed last, because a reader scans down --
 * but it is the section this file was written for, and a change that drops it has removed the point.
 *
 * ## Every number is COUNTED, never read off a status word
 *
 * `mergeStateStatus` reads `BLOCKED` for a stale base and for a failing required check identically --
 * measured 2026-09-09, when `dispatcher` reported a PR as BEHIND that was zero commits behind and merely
 * red. So "behind" here is `git rev-list --count <head>..<base>`, the countable fact, reusing
 * `behindByCount` from `queue-stalled.mjs` rather than spelling it a second time. The status word is
 * printed too, as a label, never as the measurement.
 *
 * ## It reports what it could not ask
 *
 * A failed lookup prints as `?` with the section marked INCOMPLETE, and the exit code says so. A table
 * that quietly omits the PR it could not read is worse than no table: the reader counts what is there.
 */
import { execFileSync } from "node:child_process";
import { loadavg } from "node:os";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { behindByCount } from "./queue-stalled.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { newestPerName } from "./newest-check-run.mjs";
import { holdersOf } from "./pr-hold-state.mjs";

export const EXIT = { EXAMINED: 0, INCOMPLETE: 2 };

/**
 * Conclusions that are NOT a red check, stated ONCE because this list existed twice and the copies were
 * about to drift -- section 2's open-PR reds and section 4's tally each carried their own.
 *
 * SUCCESS/SKIPPED/NEUTRAL: `gate`'s own loop treats skipped as success and so must this, or every
 * path-filtered job reads as a failure on every PR that did not touch its paths.
 *
 * CANCELLED: a run superseded by `ci.yml`'s `concurrency: cancel-in-progress: true`, which fires every
 * time a new run starts on the same ref. It is not a verdict about the commit. This was counted as red
 * for an hour and reported to the chairman: measured on ten main commits, `audit` read 6 of 10 of which
 * SIX were cancelled and TWO were real, and `check` read 3 of 10, ALL cancelled. A PR HEAD stops moving
 * and rarely carries one; a MERGE COMMIT on a fast main carries them constantly -- and section 4's
 * population became merge commits an hour before this fix, so the change that made it see everything is
 * the change that made it over-count.
 *
 * "": no conclusion yet -- in flight, and not a verdict either.
 *
 * The failure is in the ALARMING direction, which is the direction that gets acted on.
 */
export const NOT_RED = ["SUCCESS", "SKIPPED", "NEUTRAL", "CANCELLED", ""];

/** @param {{conclusion?: string | null}} check */
export function isRed(check) {
  return !NOT_RED.includes((check.conclusion ?? "").toUpperCase());
}

/** How many commits on main section 4 examines. Ten is what the chairman's own list shows. */
export const MERGED_HEADS_EXAMINED = 10;

/** A PR whose head has not moved in this long, while it is behind, is stalled rather than waiting. */
export const STALL_MINUTES = 90;

/** Every `gh` call this process has made. The table reports its own cost, so the budget has a consumer
 *  attached rather than only a level -- "4200 left" and "4200 left, and this table spent 40" are
 *  different facts, and only the second says whether we are the reason. */
let ghCalls = 0;

/** @returns {number} */
export function ghCallsMade() { return ghCalls; }

const gh = (/** @type {string[]} */ args) => {
  // `rate_limit` is the one gh call that does not count against the limit, so it must not count here
  // either -- a meter that includes reading the meter reports its own observation as consumption.
  if (!(args[0] === "api" && args[1] === "rate_limit")) ghCalls += 1;
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const git = (/** @type {string[]} */ args) => {
  try {
    return { status: 0, stdout: execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() }) };
  } catch {
    return { status: 1, stdout: "" };
  }
};

/** @template T @param {() => T} fn @returns {T | null} */
const ask = (fn) => { try { return fn(); } catch { return null; } };

/**
 * #790: THROWS on failure, unlike the local `git` above -- that one folds a failed command into `status:
 * 1` because a queue-table row degrading to `?` is this file's whole design, but a completeness statement
 * that swallowed its own read would report "OK, 0 of 0 checked" having asked nothing. Same discipline as
 * `ready-label-audit.mjs`'s `defaultRun`.
 * @type {(args: string[]) => string}
 */
const defaultRunGit = (args) => execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * #790: every remote branch's SHORT name (no `origin/`), examined against an INDEPENDENT second read of
 * the same remote -- `git ls-remote --heads` talks to the network, `for-each-ref` reads this checkout's
 * own ref database, and a `fetch` that ran a while ago can leave the second stale without either command
 * failing. Same shape as `ready-label-audit.mjs`'s `fetchOpenIssuesChecked` (#788): THROWS on a mismatch
 * rather than reporting a population that may have moved between the two reads.
 *
 * The measured anomaly this exists for: a branch pushed to `origin` literally named `origin` -- one path
 * segment, same as `main`, but not the trunk -- invisible to any check that only ever asks "what is this
 * branch's prefix" and never "does it have one at all".
 *
 * @param {{ run?: typeof defaultRunGit }} [deps]
 * @returns {{ branches: string[], remoteCount: number }}
 */
export function fetchRemoteBranchesChecked({ run = defaultRunGit } = {}) {
  /** @type {string} */
  let localRaw;
  try {
    // `%(symref)` is EMPTY for a real branch and non-empty for a symbolic ref -- `refs/remotes/origin/HEAD`
    // is the one guaranteed member of this remote-tracking tree, and it is not a branch: it is a pointer
    // to whichever branch the remote calls its default (`origin/main` here). Read by symref rather than
    // by name, because `%(refname:short)` COLLAPSES `origin/HEAD` to the bare string `origin` -- one path
    // segment, indistinguishable in NAME from the exact anomaly this census exists to catch (a real
    // branch pushed with no owner prefix). tracker-auditor measured this against #878's own build:
    // treating it as a branch would have made this census flag `origin` as a stray on every single run,
    // a false finding baked into the tool by its own first version.
    localRaw = run(["for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/remotes/origin"]);
  } catch (cause) {
    throw new Error(`queue-table: could not list remote-tracking branches -- refusing to census. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  const branches = localRaw.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([, symref]) => !symref)
    .map(([name]) => name.replace(/^origin\//, ""));
  /** @type {string} */
  let remoteRaw;
  try {
    remoteRaw = run(["ls-remote", "--heads", "origin"]);
  } catch (cause) {
    throw new Error(`queue-table: could not ask the remote for its own branch count -- refusing to `
      + `census a population it cannot vouch for. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  const remoteCount = remoteRaw.split("\n").map((l) => l.trim()).filter(Boolean).length;
  if (branches.length !== remoteCount) {
    throw new Error(`queue-table: examined ${branches.length} branch(es) from the local mirror but the `
      + `remote reports ${remoteCount} -- refusing to census a population that may have moved between `
      + `the two reads. Run \`git fetch --prune origin\` and retry.`);
  }
  return { branches, remoteCount };
}

/**
 * PURE. #790: which of these branch names carry NO owner prefix at all -- the presence/absence question,
 * never which prefix is the "right" one (that is a judgement this row deliberately does not make; see its
 * own "What this row is NOT"). `main` is the one name this project's own convention allows without one --
 * it is the trunk, not an unattributed stray -- so it is the sole accepted exception rather than a second
 * unnamed rule living beside the real one.
 *
 * @param {string[]} branchNames
 * @returns {{ total: number, noPrefix: string[] }}
 */
export function branchPrefixCensus(branchNames) {
  const noPrefix = branchNames.filter((name) => name !== "main" && !name.includes("/"));
  return { total: branchNames.length, noPrefix };
}

/**
 * @param {{ branches: string[], remoteCount: number } | null} census
 * @returns {{ lines: string[], incomplete: boolean }}
 */
export function renderBranchPrefixes(census) {
  // NOT `incomplete: true` -- unlike a section this table's own job is to examine every run (trunk, open
  // PRs), a branch has no owner to page over a red result, so a read that failed once is worth a line,
  // never worth failing the whole table's exit code over. `withBudget`'s own comment states the identical
  // trade for section 5's API-cost footer.
  if (!census) return { lines: ["   ? could not census remote branches"], incomplete: false };
  const { total, noPrefix } = branchPrefixCensus(census.branches);
  if (noPrefix.length === 0) {
    return {
      lines: [`   OK  ${total} of ${census.remoteCount} remote branch(es) checked (symbolic refs `
        + "excluded), every one but `main` carries an owner prefix"],
      incomplete: false,
    };
  }
  return {
    lines: noPrefix.map((name) => `   NO PREFIX  ${name} -- not attributable to any session by name`),
    incomplete: false,
  };
}

/**
 * PURE. One PR's row, from facts already gathered -- so every shape is exercisable without a network.
 *
 * `mergeStateStatus` IS GONE, and this row is what it was for. It is GraphQL-only, it reads BLOCKED for
 * a stale base and for a failing required check identically (see this file's header), and section 2's own
 * heading says behind is COUNTED rather than read off it. Everything the row prints -- how far behind,
 * whether armed, which checks are red -- now comes from git and from `check-runs`, neither of which can
 * be rate-limited out from under the table.
 *
 * @param {{number: number, headRefName: string, headRefOid: string,
 *   armed: boolean, holders?: string[], updatedAt: string, redChecks: string[] | null,
 *   draft?: boolean | null}} pr
 * @param {number | null} behind
 * @param {Date} now
 */
export function prRow(pr, behind, now) {
  const owner = pr.headRefName.includes("/") ? pr.headRefName.split("/")[0] : "(no prefix)";
  const idleMinutes = Math.round((now.getTime() - new Date(pr.updatedAt).getTime()) / 60000);
  return {
    number: pr.number,
    owner,
    behind,
    armed: pr.armed,
    holders: pr.holders ?? [],
    idleMinutes,
    // CARRIED THROUGH, because `openPRs()` reading the field is not the same as a caller being able to
    // see it: everything downstream reads THIS row, so a field added there and dropped here is a field
    // nobody has. ABSENT IS `null`, NEVER `false` -- a payload that did not carry the flag is a read this
    // row could not make, and answering "not a draft" for it would be wrong in the reassuring direction
    // (it reads as armed-and-ready work rather than as an unanswered question), which is the direction
    // this file's own `armed` note says is the only one that matters in a table people scan.
    draft: pr.draft ?? null,
    // A PR can be stalled by being behind and untouched, which is the state `update-branch` skips
    // because it only carries GREEN PRs -- so a red PR that nobody pushes is invisible to the train.
    stalled: (behind ?? 0) > 0 && idleMinutes >= STALL_MINUTES,
    // ABSORBED (#600) IS A DIFFERENT STATE AND THE PREDICATE ABOVE CANNOT SEE IT. `update-branch` carries
    // only GREEN PRs, so a PR that is behind AND red cannot be carried at all -- it falls further behind
    // while its owner fixes the red, and the train will not touch it BECAUSE it is red. An owner actively
    // pushing fixes keeps `updatedAt` fresh, so such a PR is never "untouched" and never reads as stalled,
    // while being the one that can least escape. Measured 2026-09-09: #564 was carried to zero behind at
    // 07:30:30Z and read 14 behind eight minutes and seven merges later.
    //
    // AND THE OLD PREDICATE'S FALSE NEGATIVES WERE CONCENTRATED WHERE THE EFFORT WAS -- product-manager's
    // sentence, and it is the reason this is a defect rather than a gap: "behind AND untouched for 90
    // minutes" encodes an assumption that an unattended PR is the one in trouble. An absorbed PR is the
    // opposite; its owner is attending to it constantly, which is exactly what keeps it out of the table.
    // A predicate whose false negatives sit in the cases with the most human effort behind them is worse
    // than no predicate, because it converts effort into invisibility.
    absorbed: (behind ?? 0) > 0 && (pr.redChecks?.length ?? 0) > 0,
    red: pr.redChecks,
  };
}

/**
 * PURE. Section 4's tally: which check names were non-success on these merged PRs' heads.
 *
 * Counted BY NAME rather than by PR, because the question is "which check is red on the list" -- one
 * check red on ten PRs and ten checks red on one PR are different faults and must not print the same.
 *
 * A commit's `number` is NULL when nothing merged it -- a direct push to main is a real thing and its red
 * check is exactly the kind this section exists to surface, so it is carried rather than dropped.
 *
 * @param {{number: number | null, sha?: string, checks: {name: string, conclusion: string}[] | null}[]} merged
 * @returns {{byName: Map<string, (number | null)[]>, unreadable: (number | null)[]}}
 */
export function nonSuccessByName(merged) {
  const byName = new Map();
  const unreadable = [];
  for (const pr of merged) {
    if (pr.checks === null) { unreadable.push(pr.number); continue; }
    for (const check of pr.checks) {
      if (!isRed(check)) continue;  // NOT_RED above states why, once, for both readers.
      if (!byName.has(check.name)) byName.set(check.name, []);
      byName.get(check.name).push(pr.number);
    }
  }
  return { byName, unreadable };
}

/** @returns {{sha: string, runId: string, conclusion: string, status: string} | null} */
export function trunkState() {
  const sha = ask(() => gh(["api", `repos/${REPO}/commits/main`, "--jq", ".sha"]).trim());
  if (!sha) return null;
  const runs = ask(() => JSON.parse(gh(["run", "list", "--workflow=trunk.yml", "--limit", "20",
    "--json", "headSha,conclusion,status,databaseId"])));
  if (!Array.isArray(runs)) return { sha, runId: "?", conclusion: "?", status: "?" };
  const mine = runs.find((/** @type {{headSha: string}} */ r) => r.headSha === sha);
  return mine
    ? { sha, runId: String(mine.databaseId), conclusion: mine.conclusion || "(none yet)", status: mine.status }
    : { sha, runId: "(no run)", conclusion: "(none)", status: "(none)" };
}

/**
 * Every open PR, with its red check names. `null` red list means the lookup failed for that PR.
 *
 * REST, NOT `gh pr list`. On 2026-09-09 the shared GraphQL pool reached 5000 of 5000 and every
 * `gh pr list`, `gh pr view` and `gh pr checks` in every session failed for twenty-two minutes -- and
 * `auto-arm` with them, so nothing could be armed account-wide. **This table opened with a `gh pr list`,
 * so it could not run during the outage it exists to report.** The hand form through
 * `gh api repos/.../pulls` and `check-runs` produced the whole table on 19 core calls and zero GraphQL.
 *
 * AND THE ONE FIELD THAT FORCED GRAPHQL IS THE ONE THIS TABLE ALREADY REFUSES TO TRUST.
 * `mergeStateStatus` is GraphQL-only, and section 2's own heading reads "behind is COUNTED, never read
 * off mergeStateStatus" -- it is counted from git, which costs nothing and cannot be rate-limited. So the
 * field is gone rather than fetched per-PR: dropping it removes a GraphQL dependency AND a number the
 * table was already declining to believe.
 *
 * `auto_merge` and `updated_at` come back on the REST list; check conclusions come from `check-runs`,
 * which is core and kept working throughout.
 *
 * PROVEN AGAINST AN ARMED PR, 2026-09-09 15:06Z. When this was written every open PR read
 * `auto_merge: null`, which was CORRECT -- all of them opened after 14:41Z with a failing `arm` job, so
 * none was armed. Consistent with the known state is not the same as proven, and the difference matters
 * here because a false "UNARMED" is wrong in the reassuring direction: it reads as work still to do
 * rather than as a table that has stopped seeing. So it was left stated as unproven until it could be
 * read non-null.
 *
 * It now is, and against a SECOND API rather than a re-read of the same one: REST `auto_merge` and
 * GraphQL `autoMergeRequest` agree on #805 (armed/MERGE), #799 (armed/MERGE) and #742 (null/null, a
 * draft nothing armed). The negative case is the half that matters -- two APIs agreeing on a positive
 * would not distinguish a field that is always truthy.
 *
 * If this regresses, `armed` silently becomes always-false and NO TEST ON A FIXTURE CAN SEE IT, because
 * the fixtures supply the field. The check is a live one or it is nothing.
 */
export function openPRs() {
  const prs = ask(() => JSON.parse(gh(["api", `repos/${REPO}/pulls?state=open&per_page=100`])));
  if (!Array.isArray(prs)) return null;
  return prs.map((/** @type {any} */ pr) => ({
    number: pr.number,
    headRefName: pr.head?.ref ?? "?",
    headRefOid: pr.head?.sha ?? "",
    updatedAt: pr.updated_at,
    armed: Boolean(pr.auto_merge),
    // THE DRAFT FLAG COMES BACK ON THE SAME PAYLOAD, so reading it costs nothing -- the same reason
    // `holders` is read below. It was dropped here until #912's gate needed it: "every open pull request
    // that is a draft and has no verdict at its current head" is the reviewer's whole lane
    // (docs/roles/reviewer.md), and with this field absent NO script in the tree could answer it, so the
    // two reviewer sessions polled `gh pr list` on a clock to ask a question this payload already knew.
    // `?? null`, NOT `Boolean()`: absent must stay distinguishable from false, for the reason `prRow`
    // states where it carries this field on.
    draft: pr.draft ?? null,
    // THE HOLD LABEL COMES BACK ON THE SAME PAYLOAD, so reading it costs nothing. It has to be read,
    // because a held PR is DISARMED ON PURPOSE (`pr-hold.mjs` disarms as part of taking the hold) and
    // "UNARMED" for a held PR is a true word for the wrong reason -- it reads as nobody has got to it
    // yet, when somebody has decided it must not merge. #819 sat in section 2 as UNARMED at 15:37Z while
    // ceo held it pending a gate stage. Wrong in the reassuring direction, which is the only direction
    // that matters in a table people scan.
    // `holdersOf`, THE PREDICATE THE ARM PATH ITSELF USES -- never this file's own copy of the prefix.
    //
    // This read is what found the collision it now has to survive. Written against `session:`, it printed
    // #820 as HELD+ARMED; the answer was that `session:` meant OWNERSHIP -- twelve PRs carried it that
    // day to say whose they were -- and holds moved to `hold:` within the hour. A table carrying its own
    // literal would have gone on reporting every owned PR as held, which is a table lying about the exact
    // thing it just found. Importing the predicate means this row follows the rename by construction
    // rather than by somebody remembering, and it agrees with `arm-pr`/`auto-arm-sweep` at every instant
    // including the one where main has the rename and this branch has not been carried yet.
    holders: holdersOf((pr.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? ""))),
    redChecks: checksOnSha(pr.head?.sha ?? "")?.filter(isRed).map((c) => c.name) ?? null,
  }));
}


/**
 * The last N merged PRs, each head's checks, and WHEN THE OLDEST OF THEM MERGED.
 *
 * The window is not decoration. A bare "10" tells a reader nothing about whether that is ten of ten or
 * ten of two hundred, or whether it covers an hour or a fortnight -- product-manager's requirement, and
 * they are right that a count without its denominator and its window is not a measurement. It is the
 * difference between "a check has been red all morning" and "a check was red once, months ago".
 */
export function recentlyMerged(limit = MERGED_HEADS_EXAMINED) {
  const commits = mergeCommitsOnMain(limit);
  if (commits === null) return null;
  return commits.map((commit) => ({
    number: commit.pr,
    sha: commit.sha,
    mergedAt: commit.date,
    checks: checksOnSha(commit.sha),
  }));
}

/**
 * The last N commits on `main`'s FIRST-PARENT chain, with the PR each merge names.
 *
 * THIS USED TO READ `gh pr list --state merged --json statusCheckRollup`, WHICH IS A DIFFERENT
 * POPULATION AND ANSWERS A DIFFERENT QUESTION. A merged PR's `headRefOid` is the BRANCH TIP BEFORE THE
 * MERGE; the merge commit is a different sha. So the section reported "did this PR's own CI pass before
 * it merged" while its heading -- and the chairman reading it -- asked "what is red on main".
 *
 * Measured 2026-09-09: `ready-label-audit` failed on five merged heads from 12:11Z and section 4 printed
 * NONE for three consecutive tables. It runs on the `issues` event against main's tip, so its check-runs
 * attach to MERGE COMMITS (861ffbb7, bdf9c0ba) -- and `gh pr list --json headRefOid` matches neither.
 * **It was not missed; it was structurally unreachable.** Every post-merge workflow, every scheduled run
 * pinned to a sha, and every non-code event was equally invisible, which is the entire class of check
 * that CAN be red on main without blocking anything -- the class this section exists to surface.
 *
 * @param {number} limit
 * @returns {{sha: string, pr: number | null, date: string | null}[] | null}
 */
export function mergeCommitsOnMain(limit, { run = defaultGitLog } = {}) {
  const log = ask(() => run(limit));
  if (log === null) return null;
  return log.trim().split("\n").filter(Boolean).map((line) => {
    const [sha, date, subject] = line.split("\t");
    const named = /Merge pull request #(\d+)/.exec(subject ?? "");
    return { sha, date: date ?? null, pr: named ? Number(named[1]) : null };
  });
}

/** @param {number} limit */
function defaultGitLog(limit) {
  return execFileSync("git",
    ["log", "--first-parent", "-n", String(limit), "--format=%H%x09%cI%x09%s", "origin/main"],
    { encoding: "utf8", env: sandboxGitEnv() });
}

/**
 * Every check-run on one sha, newest per name. `null` when the lookup fails, never an empty list -- an
 * unreadable sha and a sha with no checks are different facts and the caller reports them differently.
 *
 * @param {string} sha
 * @returns {{name: string, conclusion: string}[] | null}
 */
export function checksOnSha(sha) {
  const raw = ask(() => gh(["api", `repos/${REPO}/commits/${sha}/check-runs`, "--paginate",
    "--jq", ".check_runs[] | {name, conclusion, completedAt: .completed_at}"]));
  if (raw === null) return null;
  const runs = raw.trim().split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return newestPerName(runs).map((c) => ({ name: c.name, conclusion: c.conclusion ?? "" }));
}

/**
 * The required status-check contexts on `main`, or `null` if the lookup failed.
 *
 * A check that is NOT in this list blocks nothing, and that is the whole reason a red one is tolerable
 * and therefore the reason it goes unread for ninety minutes. Saying so on the line turns "a red check on
 * every merge" into "one specific NON-BLOCKING check on every merge" -- different sentences, and only the
 * second is true. `null` prints as unknown rather than as "not required", because guessing in that
 * direction understates the problem.
 */
export function requiredContexts() {
  return ask(() => {
    const contexts = JSON.parse(gh(["api", `repos/${REPO}/branches/main/protection`,
      "--jq", ".required_status_checks.contexts"]));
    return Array.isArray(contexts) ? contexts : null;
  });
}

/**
 * ONE RENDERER PER SECTION, and not for tidiness -- `render` reached a complexity of 18 against this
 * repository's limit of 15, which is the Stepdown Rule's own signal that it had stopped doing one thing.
 * Each returns its lines and whether it had to report an unknown, so "could not ask" propagates to the
 * exit code from wherever it happened rather than being remembered by the caller.
 *
 * @param {any} trunk @returns {{lines: string[], incomplete: boolean}}
 */
export function renderTrunk(trunk) {
  if (!trunk) return { lines: ["   ? could not read main's tip"], incomplete: true };
  const lines = [`   main ${trunk.sha.slice(0, 8)}  run ${trunk.runId}  ${trunk.status}/${trunk.conclusion}`];
  // STILL RUNNING IS NOT RED, and collapsing them is this repository's oldest defect wearing a table's
  // clothes -- "nothing has said it is green yet" and "it said it is not" need opposite responses, and a
  // table that shouts on every in-flight run is one people stop reading by lunchtime.
  if (trunk.status !== "completed") lines.push("   (still running -- not a verdict either way yet)");
  else if (trunk.conclusion !== "success") lines.push("   ^ NOT GREEN -- this is the first line to act on");
  return { lines, incomplete: false };
}

/** @param {any[] | null} prs @returns {{lines: string[], incomplete: boolean}} */
export function renderOpenPRs(prs) {
  if (!prs) return { lines: ["   ? could not list open PRs"], incomplete: true };
  if (prs.length === 0) return { lines: ["   none open"], incomplete: false };
  const lines = prs.map((row) => {
    const behind = row.behind === null ? "?" : String(row.behind);
    const red = row.red === null ? " red:?" : row.red.length ? ` red: ${row.red.join(" ")}` : "";
    // HELD OUTRANKS UNARMED, because a held PR is unarmed BY DECISION. Held-and-armed is printed as
    // its own word rather than folded into either: it is `pr-hold`'s failure state (#645) -- the label
    // says stop and auto-merge says go -- and a table that renders it as plain "HELD" hides exactly the
    // pair the hold exists to prevent.
    const arm = row.holders.length
      ? (row.armed ? `HELD+ARMED(${row.holders.join(",")})` : `HELD(${row.holders.join(",")})`)
      : (row.armed ? "armed  " : "UNARMED");
    return `   #${row.number}  ${row.owner.padEnd(11)} behind=${behind.padEnd(3)} ${arm}${red}`;
  });
  return { lines, incomplete: prs.some((r) => r.behind === null || r.red === null) };
}

/** @param {any[]} prs @returns {string[]} */
export function renderStalled(prs) {
  const lines = [
    ...prs.filter((r) => r.absorbed).map((r) =>
      `   #${r.number}  ${r.owner}  behind=${r.behind}  ABSORBED (behind AND red -- the train will not `
      + `carry it, #600). red: ${r.red.join(" ")}`),
    ...prs.filter((r) => r.stalled && !r.absorbed).map((r) =>
      `   #${r.number}  ${r.owner}  behind=${r.behind}  idle ${r.idleMinutes}m`),
  ];
  return lines.length ? lines : ["   none"];
}

/**
 * The window these merged PRs span: the oldest merge time among them.
 * @param {{mergedAt?: string | null}[]} merged
 */
export function windowOf(merged) {
  const stamps = merged.map((pr) => pr.mergedAt).filter((/** @type {any} */ t) => typeof t === "string");
  return stamps.length === 0 ? null : stamps.sort()[0];
}

/**
 * @param {any[] | null} merged @param {string[] | null} required
 * @returns {{lines: string[], incomplete: boolean}}
 */
export function renderMergedChecks(merged, required) {
  if (!merged) return { lines: ["   ? could not list merged PRs"], incomplete: true };
  // AN EMPTY LIST AND UNREADABLE TIMES ARE DIFFERENT ANSWERS. Nothing merged is a legitimate state on a
  // quiet repository and needs no window; PRs that merged whose times could not be read is a lookup that
  // failed, and only the second may make the table INCOMPLETE. Collapsing them would report a quiet hour
  // as a broken one, which is the "could not ask" versus "asked and got nothing" distinction this
  // repository treats as its oldest defect.
  const since = windowOf(merged);
  const timesMissing = merged.length > 0 && since === null;
  const header = merged.length === 0
    ? "   (no merged PRs in range)"
    : `   since ${since ?? "(merge times unreadable)"}`;
  const { byName, unreadable } = nonSuccessByName(merged);
  const blocking = (/** @type {string} */ name) => (required === null
    ? "  (required? unknown)"
    : required.includes(name) ? "  ** REQUIRED -- this one blocks **" : "  (non-blocking)");
  const lines = [header, ...(byName.size === 0 ? ["   none"] : [...byName.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, prsWith]) => `   ${name.padEnd(18)} ${prsWith.length} of ${merged.length}  `
      + `(#${prsWith.slice(0, 6).join(", #")}${prsWith.length > 6 ? ", ..." : ""})${blocking(name)}`))];
  if (unreadable.length > 0) lines.push(`   ? checks unreadable on #${unreadable.join(", #")}`);
  return { lines, incomplete: unreadable.length > 0 || timesMissing || required === null };
}

/**
 * THE HOST ITSELF, because on 2026-09-09 it was the bottleneck and nothing said so.
 *
 * At 08:57Z this machine had four PRs reading as "not carried by their owners" for twenty minutes. Every
 * one of those carries is a `git merge` plus a pre-push gate running lint and typecheck, and there were
 * 58 concurrent git processes on one repository and 164 worktrees for Spotlight to index. The table named
 * four idle owners and the truth was one contended machine -- **attributing a machine fault to people,
 * which is the worst thing a status table can do.**
 *
 * WHICH NUMBER, AND THIS TOOK TWO WRONG ANSWERS TO SETTLE.
 *
 * NOT `free`. macOS keeps it small by design and inactive pages are reclaimable, so a low free figure is
 * the normal state of a working machine. The first version of this section keyed its threshold on free --
 * quoting CLAUDE.md's warning not to trust it, in the same comment.
 *
 * AND `Pages occupied by compressor` IS FOUR WORDS BEFORE ITS NUMBER. An awk taking `$3` gets the word
 * "by" and prints 0, which reads as "no memory pressure at all" on a host holding 12 GB compressed. Two
 * sessions measured this host minutes apart and got 0 MB and 12,344 MB; the difference was the field
 * index. **A parse error in a metric is indistinguishable from good news** -- so this counts pages by a
 * labelled regex and multiplies by the page size `vm_stat` itself reports, never by a hard-coded 4096 or
 * a positional field.
 *
 * THE THRESHOLD KEYS ON LOAD AND THE GIT COUNT, not on memory. Both are unambiguous, neither needs a
 * baseline, and they are what actually made the carries slow: git contention on one repository, and a
 * load average of 15 on 14 cores. The compressor is REPORTED beside them because 12 GB of it is a real
 * finding, and it becomes a threshold only once its delta has a baseline -- CLAUDE.md's own rule that
 * paging must be read as a delta, since the counters are since-boot and 6.6 GB left from an incident
 * hours ago is indistinguishable from a host swapping right now.
 *
 * @typedef {{compressedMb: number, inactiveMb: number, freeMb: number, pageouts: number,
 *   load: number | null, gitProcesses: number | null, worktrees: number,
 *   topConsumers?: {pid: string, cpu: number, command: string}[] | null}} HostState
 *
 * `load` and `gitProcesses` are declared NULLABLE even though `os.loadavg()` cannot fail today. The
 * type is what stops the next reader writing `host.load > LOAD_CEILING` and getting `false` from a
 * missing reading -- the exact expression this commit removes. A type that forbids the absent case is
 * how the absent case stops being handled.
 *
 * @returns {HostState | null}
 */
/**
 * Concurrent `git` processes, or null when `pgrep` could not be ASKED -- and the two are told apart by
 * pgrep's own exit status rather than by a second probe.
 *
 * `pgrep` exits 1 for "no process matched" and 2+ (or ENOENT) for "I could not look", so a plain
 * try/catch folds a real count of none into a failure, and `?? 0` folds a failure into a count of none.
 * The first draft of this asked a control question instead -- `pgrep -x <a name nothing has>` -- which
 * has the identical exit status as the real query and so answered nothing at all. **A control that
 * shares the failure mode of the thing it controls for is not a control**, which is the same shape as a
 * verification sharing a failure mode with its action (#645).
 *
 * @returns {number | null}
 */
function gitProcessCount() {
  try {
    return execFileSync("pgrep", ["-x", "git"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).length;
  } catch (err) {
    // Exit 1 is pgrep's documented "nothing matched" -- a real measurement of zero.
    return /** @type {{status?: number}} */ (err).status === 1 ? 0 : null;
  }
}

/**
 * The API budget this table is spending, and what is left.
 *
 * On 2026-09-09 the GraphQL limit reached 0 of 5000 and every `gh` call in one session failed, with the
 * cause given as nine sessions polling one account. **Measured from this session at the same moment:
 * 5000 remaining, 0 used, on every resource — and a reset time forty minutes later than the exhausted
 * one.** Two reset times are two windows, and a rate-limit window is per TOKEN rather than per account.
 *
 * So the interesting number is not only "how much is left" but **whether it falls when this session is
 * idle** — a shared window does, a private one does not. Printing it every table answers that by
 * measurement, in an hour, instead of by asking nine sessions what their environment holds.
 *
 * `gh api rate_limit` DOES NOT COUNT against the limit, which is the only reason this is free to print.
 *
 * `run` is REQUIRED (#1405). It was a plain `execFileSync("gh", ...)` and `render()` called this on every table
 * it drew, so each of `queue-table.test.ts`'s twelve renders made two live calls -- 24 per local run, spending the
 * shared pools this line reports. A defaulted `run` would be those two calls again, so none is given; `collect()`
 * hands in `ghHeaders`, and a test hands in its own.
 *
 * @param {{run?: (args: string[]) => string}} [deps] `run` returns a `gh ... -i` call's raw output, and throws with
 *   the response on `error.stdout` when gh exits non-zero, as `execFileSync` does
 * @returns {{core: Pool | null, graphql: Pool | null} | null}
 */
export function apiBudget({ run } = {}) {
  if (typeof run !== "function") {
    throw new Error("apiBudget: no run given -- it is required, because a defaulted one is two live gh calls "
      + "(#1405: render() reached them on every run of queue-table.test.ts, 24 calls a run).");
  }
  // TWO POOLS, BOTH SHARED, AND ONLY THE HEADERS TELL THE TRUTH.
  //
  // `gh api rate_limit` reports zero used, always, for these tokens. Measured 2026-09-09: after five real
  // calls it still read `core used 0, remaining 5000` on every resource while the same call's headers read
  // `X-Ratelimit-Used: 2109`. The first version of this function used that endpoint and would have printed
  // `5000/5000` on every table while the budget ran to zero -- a meter reading full as the tank empties,
  // the exact failure it was written to catch.
  //
  // CORE AND GRAPHQL ARE SEPARATE POOLS WITH SEPARATE RESETS, and both are shared across every session
  // authenticating as the same user. `gh pr list`, `gh issue list` and `gh pr view` spend GRAPHQL; `gh api`
  // spends CORE. On 2026-09-09 graphql reached 0 of 5000 while core sat at 2110 -- so a table reading only
  // one pool reports a healthy budget during an outage of the other. Comparing one pool's reset against the
  // other's is what produced "our windows are separate", which was wrong: they are separate POOLS, not
  // separate windows, and the counter is shared within each.
  //
  // Each read costs one call of its own kind, which is the cheapest honest price: the headers come back on
  // a request that has to be made to learn anything at all.
  const core = poolFromHeaders(["api", `repos/${REPO}`, "-i", "--jq", ".name"], run);
  const graphql = poolFromHeaders(["api", "graphql", "-f", "query=query { viewer { login } }", "-i"], run);
  return core === null && graphql === null ? null : { core, graphql };
}

/**
 * The live `run` that `collect()` hands `apiBudget`. Not counted in `ghCalls`, as it never was: the table's own
 * cost is what it spent learning the queue, and reading the meter is reported beside it, not inside it.
 *
 * @param {string[]} args
 * @returns {string}
 */
export const ghHeaders = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * One pool, read from the `X-Ratelimit-*` headers of a real call. `null` when the call or the parse fails
 * -- never a zero, because "I could not ask" and "nothing is left" are the two states this whole line
 * exists to keep apart.
 *
 * @param {string[]} args
 * @param {(args: string[]) => string} run
 * @returns {Pool | null}
 */
function poolFromHeaders(args, run) {
  // THE HEADERS COME BACK ON THE 403, AND THE CALL FAILS EXACTLY WHEN THE POOL IS EXHAUSTED. Measured
  // 2026-09-09: with graphql at 0 of 5000, `gh api graphql -i` exits non-zero -- so a plain `ask()` here
  // returned null and the line read `graphql UNREADABLE` during the one outage it exists to report.
  //
  // An instrument that fails precisely when its subject fails reports the alarming state as no state.
  // `execFileSync` puts the response on the thrown error's `stdout`, and GitHub sends `X-Ratelimit-*` on
  // a rate-limited response like any other, so the answer is there either way.
  let raw;
  try {
    raw = run(args);
  } catch (error) {
    raw = /** @type {{stdout?: string}} */ (error).stdout ?? "";
  }
  if (!raw) return null;
  const read = (/** @type {string} */ name) => {
    const m = new RegExp(`^${name}:\\s*(\\d+)`, "im").exec(raw);
    return m ? Number(m[1]) : null;
  };
  const remaining = read("X-Ratelimit-Remaining");
  const limit = read("X-Ratelimit-Limit");
  const reset = read("X-Ratelimit-Reset");
  if (remaining === null || limit === null) return null;
  return {
    remaining, limit, used: limit - remaining,
    resetInMinutes: reset === null ? null : Math.max(0, Math.round((reset * 1000 - Date.now()) / 60000)),
  };
}

/**
 * How the budget line reads. A remaining count with no window is not a measurement -- 4000 left with
 * fifty minutes to go and 4000 left with two are different states -- so the reset is always beside it.
 *
 * @typedef {{remaining: number, limit: number, used: number, resetInMinutes: number | null}} Pool
 * @param {{core: Pool | null, graphql: Pool | null} | null} budget
 * @param {number} spent how many `gh` calls this table itself made
 * @returns {string}
 */
export function renderBudget(budget, spent) {
  if (budget === null) return `   api budget: could not read either pool (this table spent ${spent} call(s))`;
  /** @param {string} name @param {ReturnType<typeof poolFromHeaders>} p */
  // EVERY NUMBER CARRIES ITS WORD, AND A BARE FRACTION IS BANNED HERE.
  //
  // This line read `core 4961/5000` until 2026-09-09 17:2xZ, and I read my own line as used-of-limit --
  // declared an account-wide exhaustion that was not happening, froze eight sessions, cancelled two
  // scheduled passes and asked every session to hunt a loop that did not exist. 4961 was REMAINING; 39
  // was used. ceo read the same pair of headers in the opposite direction a quarter of an hour earlier.
  //
  // `4961/5000` is the natural spelling of a budget SPENT, which is what a reader arrives expecting, and
  // nothing in the glyphs says otherwise. It was believable because it agreed with the day: there HAD
  // been a real exhaustion at 14:41Z and a figure that fits the story gets less scrutiny than one that
  // does not. So the words go beside the numbers, and the reset says `resets in`, so it cannot be read
  // as budget either.
  const line = (name, p) => p === null
    ? `${name} UNREADABLE`
    : `${name} ${p.used} used, ${p.remaining} remaining of ${p.limit}`
      + (p.resetInMinutes === null ? "" : ` (resets in ${p.resetInMinutes}m)`);
  const lines = [`   api budget: ${line("core", budget.core)}   ${line("graphql", budget.graphql)}`
    + `   this table spent ${spent}`];
  // EXHAUSTED IS ITS OWN LINE, not a small number in a row of numbers. graphql reaching 0 takes out every
  // `gh pr list` and `gh issue list` -- which is most of this table -- while core still reads healthy.
  /** @type {[string, Pool | null][]} */
  const pools = [["core", budget.core], ["graphql", budget.graphql]];
  for (const [name, p] of pools) {
    if (p === null) continue;
    if (p.remaining === 0) {
      lines.push(`   ^ ${name.toUpperCase()} IS EXHAUSTED. `
        + (name === "graphql" ? "`gh pr list`/`gh issue list`/`gh pr view` all fail until it resets."
          : "`gh api` calls all fail until it resets.")
        + " The pool is SHARED across every session on this account.");
    } else if (p.remaining < p.limit / 10) {
      lines.push(`   ^ ${name} under 10% -- read state once per action, and let git answer what git can.`);
    }
  }
  return lines.join("\n");
}

export function hostState() {
  const stat = ask(() => execFileSync("vm_stat", [], { encoding: "utf8" }));
  if (stat === null) return null;
  const pageSize = Number((/page size of (\d+)/.exec(stat) ?? [])[1] ?? 16384);
  // LABELLED, never positional: the compressor's label is four words long and a positional read of it
  // returns the word "by" as a number, which is 0, which reads as good news.
  const mb = (/** @type {string} */ label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(stat);
    return m ? Math.round((Number(m[1]) * pageSize) / 1048576) : 0;
  };
  const count = (/** @type {string} */ label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(stat);
    return m ? Number(m[1]) : 0;
  };
  return {
    compressedMb: mb("Pages occupied by compressor"),
    inactiveMb: mb("Pages inactive"),
    freeMb: mb("Pages free"),
    pageouts: count("Pageouts"),
    // NO SUBPROCESS FOR THE LOAD. This asked `sysctl`, which lives in /usr/sbin -- not on the PATH a
    // node script inherits from a shell that exported a minimal one. It returned null for ninety
    // minutes on a host whose real load was 15.08 against a ceiling of 12, and the table printed
    // `load ?` beside "the host is fine". `os.loadavg()` is the same number from the same kernel with
    // nothing between, so there is no failure mode left to swallow.
    load: loadavg()[0],
    // UNREADABLE IS NOT ZERO. `pgrep` exits 1 when nothing matches AND when it cannot run, so `?? 0`
    // folded "I could not ask" into "there are none" -- and none is the reassuring answer. Kept
    // separate, and `hostContention` below refuses to call a host uncontended on a count it does not
    // have.
    gitProcesses: gitProcessCount(),
    worktrees: ask(() => execFileSync("git", ["worktree", "list"],
      { encoding: "utf8", env: sandboxGitEnv() }).trim().split("\n").length) ?? 0,
    topConsumers: topConsumers(),
  };
}

/** How many processes to name. Enough to see a pattern, few enough to read in a table. */
const CONSUMERS_SHOWN = 5;

/**
 * The five processes actually using the CPU, because **"contended" without the consumer is a verdict
 * without a cause** -- and the remedy differs completely depending on the answer. Nine sessions running
 * `npm test` at once is fixed by serialising pushes; Spotlight indexing 107 worktrees is fixed by pruning
 * and an exclusion file, and serialising pushes would do nothing at all.
 *
 * `ps -r`, NOT `top -l 1`. A single `top` sample has no interval to measure a percentage against, so it
 * reports `0.0` for every process on a host at load 35 -- measured 2026-09-09T11:07Z, five processes all
 * reading 0.0% while `ps` put `mds_stores` at 52%. That is this file's own defect class arriving through
 * a sampling window instead of a missing PATH: **an unmeasurable value printed as a small number reads as
 * good news.** `top -l 2` and discarding the first sample works, and costs a second of wall clock for a
 * number `ps` already has.
 *
 * @returns {{pid: string, cpu: number, command: string}[] | null}
 */
export function topConsumers() {
  const out = ask(() => execFileSync("ps", ["-Ao", "pid,pcpu,comm", "-r"], { encoding: "utf8" }));
  if (out === null) return null;
  return out.split("\n").slice(1, CONSUMERS_SHOWN + 1).flatMap((line) => {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    // The command is a full path; the basename is what a reader recognises, and `mds_stores` says more
    // than the 96 characters of framework path in front of it.
    return m ? [{ pid: m[1], cpu: Number(m[2]), command: m[3].split("/").pop() ?? m[3] }] : [];
  });
}

/** Concurrent git processes above which a carry is contending rather than working. */
export const GIT_PROCESS_CEILING = 10;

/** Load average above which the gate is slow because the host is, not because anything is wrong. */
export const LOAD_CEILING = 12;

/** Processes that are this org's own work, so the relief advice can tell ours from everyone else's. */
const OURS = /^(node|npm|git|tsc|tsx|esbuild|Claude|claude)/;

/** A user application whose presence means a person is USING this machine, not just sharing it. */
const A_PERSON_IS_USING_THIS_MACHINE = /^(zoom\.us|Google Chrome|Safari|Firefox|Slack|Teams|obs|QuickTime)/i;

/**
 * WHAT TO ACTUALLY DO, derived from WHO IS USING THE CPU -- because the remedies are disjoint and
 * picking the wrong one costs the whole cycle. Nine sessions running `npm test` at once is fixed by
 * serialising pushes. `mds_stores` indexing 106 worktrees is fixed by pruning, and serialising pushes
 * would do nothing whatever. A virtual machine somebody else started is not ours to fix at all.
 *
 * Measured 2026-09-09T11:30Z, which is why this stopped being one fixed paragraph: the table said
 * "stop running `npm test` locally" while the top five were Docker's VM at 134%, Spotlight at 61%,
 * WindowServer at 51% and Zoom at 39% -- **not one of them ours**. Advice that names the wrong cause is
 * worse than none, because sessions act on it and the load does not move.
 *
 * @param {{command: string, cpu: number}[] | null} consumers
 * @returns {string[]}
 */
export function reliefFor(consumers) {
  if (consumers === null) return ["     No CPU reading, so no cause -- do not guess at a remedy."];
  const ours = consumers.filter((c) => OURS.test(c.command));
  const person = consumers.filter((c) => A_PERSON_IS_USING_THIS_MACHINE.test(c.command));
  const spotlight = consumers.filter((c) => c.command.startsWith("mds"));
  const lines = [];
  if (person.length > 0) {
    lines.push(`     THROTTLED -- SOMEBODY IS USING THIS MACHINE (${person.map((c) => c.command).join(", ")}).`,
      "     Our load is competing with their session, not just with itself: carries serialise,",
      "     one push at a time across all sessions, no parallel suites from any session, sweeps",
      "     paused -- until this line is gone. The word is here so a reader can SEE the state.");
  }
  if (spotlight.length > 0) {
    // THE MARKER DOES NOT WORK, MEASURED. This line used to recommend `.metadata_never_index` in a
    // worktree root. Placed on all 68 worktrees at 12:47Z and verified present; `mds_stores` read 54.8%
    // at 12:45Z and 80% at 12:52Z. On current macOS it is honoured at a VOLUME ROOT only, and
    // per-directory exclusion is the Spotlight Privacy list -- a machine-owner action. #734 corrected
    // that claim in `.gitignore` and `scripts/spotlight-exclude.mjs` and MISSED THIS COPY AND
    // `docs/pipeline.md`'s, which are the two a reader actually reaches. Four copies of one fact.
    lines.push("     Spotlight is indexing the worktrees. Prune every one whose PR has merged. The",
      "     `.metadata_never_index` marker does NOT help -- measured, no effect; it is honoured at a",
      "     volume root only, and per-directory exclusion is the Privacy list, a machine-owner action.");
  }
  if (ours.length > 0) {
    lines.push(`     Ours, and stoppable now: ${ours.map((c) => `${c.command} ${c.cpu.toFixed(0)}%`)
      .join(", ")}. A full local suite belongs in CI -- the pre-push gate is enough.`);
  } else {
    lines.push("     NONE of the top five is ours. Serialising our own work will not move this load;",
      "     the cost is being paid by something we do not control, so wait rather than throttle harder.");
  }
  return lines;
}

/**
 * Whether the host is contended, and -- the part a boolean alone destroys -- WHICH readings are missing.
 *
 * THE ABSENCE OF A MEASUREMENT IS NOT THE MEASUREMENT ZERO. This was `(host.load ?? 0) > LOAD_CEILING`,
 * which answers "is the load above 12" with "no" when the load could not be read at all -- and `no`
 * here means "the host is fine", printed under a heading that exists because this host was the
 * bottleneck and nothing said so. A metric that fails into the reassuring answer is worse than no
 * metric, because it is believed.
 *
 * @param {{load: number | null, gitProcesses: number | null}} host
 * @returns {{contended: boolean, unknown: string[]}}
 */
export function hostContention(host) {
  const unknown = [];
  if (host.load === null || Number.isNaN(host.load)) unknown.push("load");
  if (host.gitProcesses === null) unknown.push("git process count");
  const contended = (host.load !== null && !Number.isNaN(host.load) && host.load > LOAD_CEILING)
    || (host.gitProcesses !== null && host.gitProcesses > GIT_PROCESS_CEILING);
  return { contended, unknown };
}

/**
 * @param {HostState | null} host
 * @param {number | null} previousPageouts a prior table's reading, so paging reads as a DELTA
 * @returns {{lines: string[], incomplete: boolean}}
 */
export function renderHost(host, previousPageouts = null) {
  if (!host) return { lines: ["   ? could not read the host"], incomplete: true };
  const delta = previousPageouts === null
    ? "(no baseline yet)"
    : `+${host.pageouts - previousPageouts} since the last table`;
  const lines = [
    `   compressed ${host.compressedMb} MB   inactive ${host.inactiveMb} MB   free ${host.freeMb} MB`,
    `   pageouts ${delta}   load ${host.load === null ? "?" : host.load.toFixed(2)}   `
      + `git ${host.gitProcesses ?? "?"}   `
      + `worktrees ${host.worktrees}`,
  ];
  const consumers = host.topConsumers ?? null;
  if (consumers === null) {
    lines.push("   ? could not read the CPU consumers -- contention below is a verdict without a cause");
  } else if (consumers.length > 0) {
    lines.push("   using the CPU: "
      + consumers.map((c) => `${c.command} ${c.cpu.toFixed(0)}%`).join("   "));
  }
  const { contended, unknown } = hostContention(host);
  if (unknown.length > 0) {
    lines.push(`   ^ COULD NOT READ: ${unknown.join(", ")} -- not a reading of zero, and not a`,
      "     verdict that the host is fine. Every threshold below is answered on what was read.");
  }
  if (contended) {
    lines.push("   ^ THE HOST IS CONTENDED. A carry is a merge plus a pre-push gate running lint and",
      "     typecheck; at this load those are minutes rather than seconds. A PR that is not carried",
      "     right now is a busy machine, NOT an idle owner -- do not name people for it.");
    lines.push(...reliefFor(consumers));
  }
  return { lines, incomplete: false };
}

/**
 * Section 5's own lines plus the API budget, appended LAST so it reads as a footer on the host section
 * rather than as another host metric -- it is a fact about this table's cost, not about the machine.
 *
 * Its `incomplete` is section 5's unchanged: a budget we could not read is reported in the line itself
 * and does not make the host section incomplete, because the host was read fine.
 *
 * The budget is HANDED in, never read here (#1405): `collect()` reads it, so drawing a table calls no `gh`.
 *
 * @param {{lines: string[], incomplete: boolean}} host
 * @param {ReturnType<typeof apiBudget>} budget
 * @param {number} spent
 * @returns {{lines: string[], incomplete: boolean}}
 */
function withBudget(host, budget, spent) {
  return { lines: [...host.lines, renderBudget(budget, spent)], incomplete: host.incomplete };
}

/** @param {{trunk: any, prs: any[] | null, merged: any[] | null, now: Date, fetched?: boolean,
 *   required?: string[] | null, host?: ReturnType<typeof hostState> | null,
 *   branchCensus?: { branches: string[], remoteCount: number } | null,
 *   budget?: ReturnType<typeof apiBudget>, spent?: number}} data */
export function render({ trunk, prs, merged, now, fetched = true, required = null, host = null,
  branchCensus = null, budget = null, spent = 0 }) {
  const sections = [
    { heading: "1. TRUNK", body: renderTrunk(trunk) },
    { heading: "2. OPEN PRs  (behind is COUNTED, never read off mergeStateStatus)", body: renderOpenPRs(prs) },
    {
      heading: `3. STALLED OR ABSORBED  (behind and untouched for ${STALL_MINUTES}+ minutes, OR behind`
        + " and red -- the train carries only green PRs, so a red one can never catch up however hard its"
        + " owner pushes, #600)",
      body: { lines: renderStalled(prs ?? []), incomplete: false },
    },
    {
      heading: [`4. NON-SUCCESS CHECKS ON THE LAST ${MERGED_HEADS_EXAMINED} COMMITS ON MAIN, BY NAME`,
        "   (the view the chairman reads. A check red here blocks nothing and is therefore the red people",
        "    stop reading -- which is exactly how one sat on seven merged PRs for ninety minutes.)"].join("\n"),
      body: renderMergedChecks(merged, required),
    },
    {
      heading: "5. THIS HOST  (it was the bottleneck on 2026-09-09 and nothing said so)",
      body: withBudget(renderHost(host), budget, spent),
    },
    {
      heading: "6. BRANCH PREFIXES  (#790 -- a REAL branch can exist with no owner prefix at all, and only "
        + "naming it, never assuming one, tells it apart from a normal role branch. `origin/HEAD`, a "
        + "symbolic ref rather than a branch, is excluded by `%(symref)`, not by name -- its short form "
        + "collapses to the bare string `origin`, which would otherwise read exactly like the anomaly "
        + "this section exists to catch)",
      body: renderBranchPrefixes(branchCensus),
    },
  ];
  // EVERY SECTION IS PRINTED, including the empty ones. A section that vanishes when it has nothing to
  // say is indistinguishable from one that was dropped, and this table exists because a missing thing was
  // invisible.
  const header = [`QUEUE TABLE  ${now.toISOString()}`];
  if (!fetched) header.push("   ! git fetch FAILED -- every 'behind' below is unknown, not zero");
  const text = [...header, "",
    ...sections.flatMap((s) => [s.heading, ...s.body.lines, ""])].join("\n").trimEnd();
  const incomplete = !fetched || sections.some((s) => s.body.incomplete);
  return { text, code: incomplete ? EXIT.INCOMPLETE : EXIT.EXAMINED };
}

/**
 * FETCH FIRST, or every count is `?`. Found by running it: the checkout this command happens to be in has
 * no objects for a sha pushed one minute ago, so `git rev-list --count <head>..<base>` exits 128 with
 * `Invalid revision range` and every row reports unknown. The API knows what the shas ARE; only the local
 * repository can say how far apart they are, and it can only do that for objects it holds.
 *
 * It is the local repository as a source bounded to a window nobody chose -- the same shape as reading a
 * journal with no bound, or a check-run rollup that unions superseded runs. Ask the source, and first
 * make sure it has been told.
 *
 * @param {(args: string[]) => {status: number, stdout: string}} runGit
 * @returns {boolean} whether the fetch succeeded; a failed fetch is reported, never silently tolerated
 */
export function fetchRefs(runGit) {
  return runGit(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"]).status === 0;
}

export function collect(now = new Date()) {
  const fetched = fetchRefs(git);
  const trunk = trunkState();
  const raw = openPRs();
  const base = trunk?.sha ?? "origin/main";
  const prs = raw === null ? null : raw.map((pr) => {
    const behind = git(["rev-list", "--count", `${pr.headRefOid}..${base}`]).status === 0
      ? behindByCount(base, pr.headRefOid, git)
      : null;
    return prRow(pr, behind, now);
  });
  const data = { trunk, prs, merged: recentlyMerged(), now, fetched, required: requiredContexts(),
    host: hostState(), branchCensus: ask(() => fetchRemoteBranchesChecked()) };
  // The budget is read LAST, so `spent` counts every call above it -- as it did when render() read it.
  return { ...data, budget: apiBudget({ run: ghHeaders }), spent: ghCallsMade() };
}

function main() {
  refuseUnknownFlags(["--json"], { entry: import.meta.url, command: "node packages/agent-org/src/queue-table.mjs" });
  const data = collect();
  if (flagValue(process.argv, "json") !== undefined || process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      trunk: data.trunk, prs: data.prs,
      merged: data.merged && [...nonSuccessByName(data.merged).byName.entries()]
        .map(([name, prs]) => ({ name, prs })),
    }, null, 2)}\n`);
    process.exit(data.prs && data.merged && data.trunk ? EXIT.EXAMINED : EXIT.INCOMPLETE);
  }
  const { text, code } = render(data);
  process.stdout.write(`${text}\n`);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

/** Re-exported so `queue-table.test.ts` keeps its import; the definition lives in one place (#634). */
export { newestPerName };
