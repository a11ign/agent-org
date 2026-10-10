#!/usr/bin/env node
// @ts-check
// command: count the hand fixes on `main` -- changes the org should have made itself and a human-side session made
//
// THE HAND-FIX LEDGER (#2939, chairman 2026-10-01: "why isn't the agent org self healing and doing the boy scout
// rule?"). Every fix of the week -- #2841, #2842, #2845, #2847, #2853, #2882/#2912 -- began with the chairman's session
// going looking, and the target is ZERO, so a number has to exist before anybody can say whether it is falling.
//
// TWO MECHANISMS, because one reading is a guess:
//   DERIVED  a change with a ACTOR (its pull request's author, or the author of any non-merge commit it carries) that
//            is neither an org identity nor automation. What this FINDS is every human-side change; what it WRONGLY
//            CATCHES is the part that was never a fault -- a decision, a credential, a publish (see NOT_A_HAND_FIX).
//   DECLARED a `Hand-fix: <what the org should have done> — <which gate or brief would have done it>` line in the PR
//            body, which `pr-open.ts` accepts and refuses malformed. It exists because the author field cannot see
//            a hand fix made THROUGH an org account: the session acting as `a11ign-ai-leads` is, to GitHub, the org.
// A change is counted ONCE however many commits it carries and however many mechanisms see it (`via: "both"`).
//
// WHAT IS NEVER READ AS EVIDENCE
//   - The MERGER. The merge queue and `gh pr merge --auto` act as whoever armed the PR, so `mergedBy` is DanBeckDev on
//     193 of 671 PRs the org itself authored (measured 2026-10-01, `gh pr list --state merged`, merged since 2026-09-17).
//     A merger arms; it does not author the fix. Merge commits are skipped for the same reason.
//   - The git author NAME or EMAIL, which is the committer's local config (the worktree of the session writing this
//     says `github-actions[bot]`). The login is read from GitHub's commits API, which resolves the email to an account.
//
// ABSENCE IS NOT ZERO (`.agent-org/roles/engineer.md`). A read that is refused gives `count: null`, "unknown", and a
// change whose only actor GitHub could not resolve to an account is `unread`, never counted and never clean.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { lastRun, markRun, recordFailures, type FailureEvent } from "./failure-ledger.ts";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { HOME_CHECKOUT } from "./project-config.ts";
import { REPO } from "./project-identity.ts";

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 14;

/**
 * THE MOST A WINDOW MAY LEAVE UNREAD BEFORE ITS COUNT IS NOT A READING (#3096). An unread change is neither counted nor
 * clean, so the true count lies between `count` and `count + unread`: at this share of everything examined, the unread
 * part alone can move the number by a tenth of the population, which is more than the day-to-day movement the report
 * compares it with. Above it the count is a figure for whatever happened to resolve, and it is `unknown`.
 * It is a judgment between two measured readings that a sound bound must separate: 18 of 650 (2.8%, the host's read at
 * 2026-10-03T00:02Z) and 280 of 305 (91.8%, the retrospective that ran at the same `now`, which printed `25` anyway).
 */
export const UNREAD_SHARE_BOUND = 0.1;

/**
 * The org's own accounts (the three the row names), by login. NOT read off `gh-identity.ts`: that module answers
 * which account THE CURRENT PROCESS acts as and deliberately names none, and a ledger over history needs the names of
 * accounts that are not the current one. A renamed account reads as a human until this list moves, which RAISES the
 * count, so the failure is loud and not a silent zero.
 */
export const ORG_LOGINS = Object.freeze(["a11ign-ai-workers", "a11ign-ai-leads", "a11ign-bot"]);

/**
 * Automation and agent commit identities that are not a person: the merge queue's committer, the Actions bot, and
 * `claude`, the account GitHub resolves `noreply@anthropic.com` to -- the identity a worker session's own commits carry.
 * Measured on the first run (2026-10-01): 16 of 226 derived hits were `claude`, every one inside an org-authored PR.
 * Counting these would make the ledger a measure of how often CI and the workers run.
 */
export const AUTOMATION_LOGINS = Object.freeze(["a11ign-ci", "github-actions[bot]", "claude"]);

/**
 * Logins that name NOBODY: GitHub's own committer for a change made in its web UI (a suggested-change commit, the
 * Update branch button). Who clicked is not in the author field, so it is `unknown`, not `human` and not clean.
 */
const UNATTRIBUTABLE_LOGINS = Object.freeze(["web-flow"]);

/** What a human-side change can be WITHOUT being a hand fix, each ruled out by the row ("not in this row"). */
export const NOT_A_HAND_FIX = Object.freeze(["decision", "credential", "publish"]);

const HAND_FIX_LINE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?Hand-fix:(?:\*\*|__)?\s*(.*)$/i;
const NOT_A_HAND_FIX_LINE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?Not-a-hand-fix:(?:\*\*|__)?\s*(.*)$/i;
/** `<what the org should have done> — <which gate or brief would have done it>`: an EM DASH, and both halves. */
const HAND_FIX_SHAPE = /^(\S.*?)\s+—\s+(\S.*)$/;
/** `<decision|credential|publish> — <reason>`. */
const NOT_A_HAND_FIX_SHAPE = new RegExp(`^(${NOT_A_HAND_FIX.join("|")})\\s+—\\s+(\\S.*)$`);

/** The one-line spelling both refusals print, so an author learns the format from the first refusal. */
export const HAND_FIX_FORMAT = "Hand-fix: <what the org should have done> — <which gate or brief would have done it>";
export const NOT_A_HAND_FIX_FORMAT = `Not-a-hand-fix: <${NOT_A_HAND_FIX.join("|")}> — <reason>`;

/**
 * Every `Hand-fix:` and `Not-a-hand-fix:` line in a body. `malformed` keeps the lines that NAME a declaration and miss
 * its shape (a hyphen, one half missing), so a refusal can quote them and a count never silently drops one.
 * @param {string | null | undefined} body
 * @returns {{ handFixes: { did: string, gate: string }[], notHandFixes: { kind: string, reason: string }[],
 *   malformed: string[] }}
 */
export function declarationsIn(body: string | null | undefined): {
    handFixes: { did: string; gate: string; }[]; notHandFixes: { kind: string; reason: string; }[];
    malformed: string[];
} {
  const handFixes: { did: string; gate: string; }[] = [];
  const notHandFixes: { kind: string; reason: string; }[] = [];
  const malformed: string[] = [];
  for (const line of String(body ?? "").split(/\r\n|\r|\n/)) {
    const hand = HAND_FIX_LINE.exec(line);
    const not = NOT_A_HAND_FIX_LINE.exec(line);
    const shape = hand ? HAND_FIX_SHAPE.exec(hand[1].trim()) : not ? NOT_A_HAND_FIX_SHAPE.exec(not[1].trim()) : null;
    if (!hand && !not) continue;
    if (!shape) malformed.push(line.trim());
    else if (hand) handFixes.push({ did: shape[1].trim(), gate: shape[2].trim() });
    else notHandFixes.push({ kind: shape[1], reason: shape[2].trim() });
  }
  return { handFixes, notHandFixes, malformed };
}

/**
 * The refusal `pr-open.ts` prints for a malformed declaration, or null when the body has none.
 * @param {string} body
 * @returns {string | null}
 */
export function declarationRefusal(body: string): string | null {
  const { malformed } = declarationsIn(body);
  if (malformed.length === 0) return null;
  return `pr-open: REFUSED -- ${malformed.length} hand-fix declaration(s) miss the format (an em dash and both halves `
    + `are required; a hyphen does not clear it), so the ledger would silently not count them:\n`
    + malformed.map((line) => `  IGNORED: ${line}`).join("\n")
    + `\nThe formats:\n  ${HAND_FIX_FORMAT}\n  ${NOT_A_HAND_FIX_FORMAT}\nNothing was sent to GitHub (#2939).`;
}

/**
 * Whose is a login: the org's, automation, a human-side account, or unknown (GitHub resolved the commit to no account).
 * Unknown is a FOURTH state and shares a value with none of the others.
 * @param {string | null | undefined} login
 * @param {{ org?: readonly string[], automation?: readonly string[] }} [lists]
 * @returns {"org" | "automation" | "human" | "unknown"}
 */
export function classifyLogin(login: string | null | undefined, { org = ORG_LOGINS, automation = AUTOMATION_LOGINS }: { org?: readonly string[]; automation?: readonly string[]; } = {}): "org" | "automation" | "human" | "unknown" {
  if (!login || UNATTRIBUTABLE_LOGINS.includes(login)) return "unknown";
  if (org.includes(login)) return "org";
  if (automation.includes(login)) return "automation";
  return "human";
}

/**
 * one unit of work that reached `main`: a pull request with the commits it carried, or a commit nothing groups.
 */
export type Change = { key: string; number: number | null; title: string; at: string; author: string | null; actors: (string | null)[]; body: string | null };

export type LedgerEntry = { key: string; number: number | null; title: string; at: string; humanAuthored: boolean; via: "derived" | "declared" | "both"; humans: string[]; declared: { did: string, gate: string }[] };

/**
 * ONE CHANGE, AS THE LEDGER SEES IT: counted (and by which mechanism), excluded (and why), unread, or clean.
 * @param {Change} change
 * @param {{ org?: readonly string[], automation?: readonly string[] }} [lists]
 * @returns {{ verdict: "counted", entry: LedgerEntry } | { verdict: "excluded", key: string, kind: string, reason: string }
 *   | { verdict: "unread", key: string, why: string } | { verdict: "clean" }}
 */
export function judgeChange(change: Change, lists?: { org?: readonly string[]; automation?: readonly string[]; }): { verdict: "counted"; entry: LedgerEntry; } | { verdict: "excluded"; key: string; kind: string; reason: string; } |
{ verdict: "unread"; key: string; why: string; } | { verdict: "clean"; } {
  const humans = [...new Set(change.actors.filter((a) => classifyLogin(a, lists) === "human"))].map(String);
  const { handFixes, notHandFixes } = declarationsIn(change.body);
  if (humans.length > 0 && handFixes.length === 0 && notHandFixes.length > 0) {
    const [first] = notHandFixes;
    return { verdict: "excluded", key: change.key, kind: first.kind, reason: first.reason };
  }
  if (humans.length > 0 || handFixes.length > 0) {
    const via = humans.length > 0 ? (handFixes.length > 0 ? "both" : "derived") : "declared";
    return { verdict: "counted", entry: { key: change.key, number: change.number, title: change.title, at: change.at,
      humanAuthored: classifyLogin(change.author, lists) === "human", via, humans, declared: handFixes } };
  }
  if (change.actors.some((a) => classifyLogin(a, lists) === "unknown") || change.actors.length === 0) {
    return { verdict: "unread", key: change.key, why: "a commit of this change has an author GitHub resolves to no account (an unlinked email, or `web-flow`)" };
  }
  return { verdict: "clean" };
}

/**
 * THE COUNT over a set of changes. A change is counted once, keyed by `key`, whatever carried it in.
 * @param {Change[]} changes
 * @param {{ org?: readonly string[], automation?: readonly string[] }} [lists]
 */
export function buildLedger(changes: Change[], lists?: { org?: readonly string[]; automation?: readonly string[]; }) {
  const counted: Map<string, LedgerEntry> = new Map();
  const excluded: { key: string; kind: string; reason: string; }[] = [];
  const unread: { key: string; why: string; }[] = [];
  for (const change of changes) {
    const judged = judgeChange(change, lists);
    if (judged.verdict === "counted") counted.set(judged.entry.key, judged.entry);
    else if (judged.verdict === "excluded") excluded.push(judged);
    else if (judged.verdict === "unread") unread.push(judged);
  }
  const entries = [...counted.values()];
  const via = (kind: string) => entries.filter((e) => e.via === kind).length;
  const latest = entries.map((e) => e.at).sort().at(-1) ?? null;
  return { count: entries.length, derived: via("derived"), declared: via("declared"), both: via("both"),
    humanAuthored: entries.filter((e) => e.humanAuthored).length, latest, entries, excluded, unread,
    examined: changes.length };
}

/**
 * Keep the changes that reached `main` in `[from, to)`.
 * @param {Change[]} changes
 * @param {{ from: Date, to: Date }} window
 * @returns {Change[]}
 */
export function inWindow(changes: Change[], { from, to }: { from: Date; to: Date; }): Change[] {
  return changes.filter((c) => new Date(c.at) >= from && new Date(c.at) < to);
}

/**
 * @param {number | null} previous @param {number | null} current
 * @returns {"falling" | "flat" | "rising" | "unknown"}
 */
export function trendOf(previous: number | null, current: number | null): "falling" | "flat" | "rising" | "unknown" {
  if (previous === null || current === null) return "unknown";
  return current < previous ? "falling" : current > previous ? "rising" : "flat";
}

/**
 * The refusal for a window that left too much unread, or null when its count can be stood behind.
 * @param {ReturnType<typeof buildLedger>} ledger @param {string} which the window, named so the report says which one
 * @returns {string | null}
 */
function unreadRefusal(ledger: ReturnType<typeof buildLedger>, which: string): string | null {
  if (ledger.unread.length <= UNREAD_SHARE_BOUND * ledger.examined) return null;
  const share = (100 * ledger.unread.length / ledger.examined).toFixed(1);
  return `${ledger.unread.length} of ${ledger.examined} changes (${share}%) in the ${which} window are UNREAD (an author resolves `
    + `to no account), above the ${100 * UNREAD_SHARE_BOUND}% bound, so no count is printed`;
}

/**
 * THE READING: this window's count and the window before it, or `unknown` with the reason when the read was refused.
 * `read` is the seam -- a function from a time range to the changes in it -- so a refusal is a thrown error here, and
 * reaches the report as "unknown", never as a zero.
 * @param {{ read: (range: { from: Date, to: Date }) => Change[], now?: Date, days?: number,
 *   lists?: { org?: readonly string[], automation?: readonly string[] } }} deps
 */
export function readLedger({ read, now = new Date(), days = WINDOW_DAYS, lists }: {
        read: (range: { from: Date; to: Date; }) => Change[]; now?: Date; days?: number;
        lists?: { org?: readonly string[]; automation?: readonly string[]; };
    }) {
  const to = now;
  const mid = new Date(now.getTime() - days * DAY_MS);
  const from = new Date(mid.getTime() - days * DAY_MS);
  let changes: Change[];
  try {
    changes = read({ from, to });
  } catch (cause) {
    return { status: ("unknown" as const), count: null, previous: null, trend: ("unknown" as const),
      why: String((cause as Error).message ?? cause).split("\n")[0], days, current: null };
  }
  const current = buildLedger(inWindow(changes, { from: mid, to }), lists);
  const before = buildLedger(inWindow(changes, { from, to: mid }), lists);
  // BOTH windows: the trend compares them, so a count beside a previous one that cannot be read is no comparison either.
  const untrusted = unreadRefusal(current, "current") ?? unreadRefusal(before, "previous");
  if (untrusted !== null) {
    return { status: ("unknown" as const), count: null, previous: null, trend: ("unknown" as const),
      why: untrusted, days, current: null };
  }
  return { status: ("read" as const), count: current.count, previous: before.count,
    trend: trendOf(before.count, current.count), why: null, days, current };
}

/**
 * The line a state reading and the daily retrospective carry. Names the counts by mechanism, what was left out and
 * why, and the trend -- a bare number is a reading with no way to tell whether it is falling.
 * @param {ReturnType<typeof readLedger>} reading
 * @returns {string}
 */
export function ledgerLine(reading: ReturnType<typeof readLedger>): string {
  if (reading.status === "unknown" || reading.current === null) {
    return `HAND FIXES (last ${reading.days}d, target 0): UNKNOWN -- the read was refused (${reading.why}). `
      + "This is not zero.";
  }
  const c = reading.current;
  const unread = c.unread.length > 0 ? `; ${c.unread.length} change(s) UNREAD (an author resolves to no account)` : "";
  const excluded = c.excluded.length > 0 ? `; ${c.excluded.length} excluded as ${NOT_A_HAND_FIX.join("/")}` : "";
  return `HAND FIXES (last ${reading.days}d, target 0): ${c.count} (${c.derived} derived, ${c.declared} declared, `
    + `${c.both} both) of ${c.examined} changes, ${c.humanAuthored} of them PRs a human account authored; latest `
    + `${c.latest?.slice(0, 10) ?? "none"}; previous ${reading.days}d: ${reading.previous}, ${reading.trend}`
    + `${excluded}${unread}.`;
}

// --- the gathering: the only part that reaches GitHub or git, behind two seams ------------------------------------

export type Run = (args: string[]) => string;

/**
 * `git` run IN `cwd`, which the caller must name (#3363). The tick's working directory is the TOOL's checkout, so a `git` with no `cwd`
 * answered about `a11ign/agent-org` while `gh` answered about the project: two repositories, one count, and a refusal on every tick.
 * @param {string} cwd
 * @returns {Run}
 */
const gitIn = (cwd: string): Run => (args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: sandboxGitEnv() });
const defaultGh: Run = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * Every commit on `main`'s first-parent line since `since`, with its parents, so a merge is told from a commit.
 * @param {Run} git @param {string} base @param {Date} since
 * @returns {{ sha: string, parents: string[], subject: string, at: string }[]}
 */
function firstParentLine(git: Run, base: string, since: Date): { sha: string; parents: string[]; subject: string; at: string; }[] {
  const raw = git(["log", base, "--first-parent", `--since=${since.toISOString()}`, "--format=%H%x09%P%x09%cI%x09%s"]);
  return raw.split("\n").filter(Boolean).map((row) => {
    const [sha, parents, at, ...subject] = row.split("\t");
    return { sha, parents: parents.split(" ").filter(Boolean), at, subject: subject.join("\t") };
  });
}

/**
 * sha -> GitHub login for every commit on `main` since `since`; an unmatched email gives an EMPTY login, kept as null.
 * @param {Run} runGh @param {string} repo @param {Date} since
 * @returns {Map<string, string | null>}
 */
function loginsBySha(runGh: Run, repo: string, since: Date): Map<string, string | null> {
  const raw = runGh(["api", "--paginate", `repos/${repo}/commits?sha=main&since=${since.toISOString()}&per_page=100`,
    "--jq", '.[] | [.sha, (.author.login // "")] | @tsv']);
  return new Map(raw.split("\n").filter(Boolean).map((row) => {
    const [sha, login] = row.split("\t");
    return [sha, login || null];
  }));
}

/**
 * Merged pull requests since `since`: author, title and body. No `commits` connection -- GraphQL refuses it at this
 * page size (measured 2026-10-01: 1,000,000 nodes against a 500,000 limit).
 * @param {Run} runGh @param {string} repo @param {Date} since
 * @returns {Map<number, { author: string | null, title: string, body: string }>}
 */
function mergedPullRequests(runGh: Run, repo: string, since: Date): Map<number, { author: string | null; title: string; body: string; }> {
  const raw = runGh(["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${since.toISOString().slice(0, 10)}`,
    "--limit", "5000", "--json", "number,author,title,body"]);
  const rows: { number: number; author: { login?: string; } | null; title: string; body: string; }[] = JSON.parse(raw);
  return new Map(rows.map((r) => [r.number, { author: r.author?.login ?? null, title: r.title, body: r.body ?? "" }]));
}

const MERGE_SUBJECT = /^Merge pull request #(\d+)\b/;
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/;

/**
 * The branch commits a first-parent commit stands for. A merge the PR subject names carries its branch's commits; any
 * other commit (a squash, a direct push, a manual merge) stands for itself, so its own login is an actor and is never
 * silently dropped.
 * @param {Run} git @param {{ sha: string, parents: string[], subject: string }} commit
 * @returns {string[]}
 */
function carriedShas(git: Run, commit: { sha: string; parents: string[]; subject: string; }): string[] {
  if (!MERGE_SUBJECT.test(commit.subject) || commit.parents.length !== 2) return [commit.sha];
  return git(["log", `${commit.parents[0]}..${commit.parents[1]}`, "--no-merges", "--format=%H"]).split("\n").filter(Boolean);
}

/**
 * The pull request a first-parent commit belongs to: a merge's `#N`, or a single-parent commit's `(#N)` suffix.
 * @param {{ subject: string, parents: string[] }} commit
 * @returns {number | null}
 */
function pullRequestNumber({ subject, parents }: { subject: string; parents: string[]; }): number | null {
  const merge = MERGE_SUBJECT.exec(subject);
  const squash = parents.length < 2 ? SQUASH_SUBJECT.exec(subject) : null;
  const named = merge ?? squash;
  return named ? Number(named[1]) : null;
}

/**
 * Whether a remote URL names `repo` (`https://github.com/o/r.git`, `git@github.com:o/r`): the LAST two path segments, so `o/r-fork` and
 * `x/o/r` are other repositories.
 * @param {string} url @param {string} repo
 */
function namesRepository(url: string, repo: string) {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[/:])${escaped}(?:\\.git)?/?$`, "i").test(url.trim());
}

/**
 * WHY a base is not main's head, which is two different facts with two different remedies (#3363): the checkout is the
 * project's and BEHIND (update it), or it is ANOTHER REPOSITORY's (point the read at the project's). Told apart by the
 * checkout's `origin`; one that cannot be read says so and claims neither.
 * @param {{ git: Run, repo: string, base: string, local: string, live: string }} facts
 * @returns {string}
 */
function whyNotLive({ git, repo, base, local, live }: { git: Run; repo: string; base: string; local: string; live: string; }): string {
  const seen = `the base ref ${base} is ${local} but main is ${live} on GitHub`;
  let origin;
  try {
    origin = git(["remote", "get-url", "origin"]).trim();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return `${seen}: this checkout is stale, or it is not ${repo}'s (its origin could not be read: ${reason}), so the log it reads is not main's`;
  }
  if (!namesRepository(origin, repo)) {
    return `${seen}: the checkout this read ran git in is ${origin}, not ${repo}, so the log it reads is another repository's. It is not stale; it is the wrong checkout`;
  }
  return `${seen}: this checkout is stale, so the log it reads is not main's`;
}

/**
 * A READ AGAINST A STALE BASE IS NOT A READING (#3096). `base` is a ref in the checkout that ran the gate, and the tick's
 * `primary:update` is `ExecStartPre=-`, so a failed update is ignored and the log is read as of whenever it last worked,
 * while the logins come live. Throws, naming both shas, when `base` is not the head `main` has now -- and says whether the
 * checkout is behind or is not the project's at all (#3363: the tick ran git in the tool's checkout, and "stale" was false).
 * @param {{ git: Run, gh: Run, repo: string, base: string }} where
 */
export function assertBaseIsLive({ git, gh: runGh, repo, base }: { git: Run; gh: Run; repo: string; base: string; }) {
  const local = git(["rev-parse", base]).trim();
  const live = runGh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]).trim();
  if (local !== live) throw new Error(whyNotLive({ git, repo, base, local, live }));
}

/**
 * THE READ over git and GitHub: one Change per merged pull request (its author plus every non-merge commit it carried)
 * and one per commit that no merge groups. The commits a merge carries are `<first parent>..<second parent>`, read
 * locally; their LOGINS come from the commits API.
 * `git` runs in `checkout`, the PROJECT's (`HOME_CHECKOUT`), whatever directory the process works in (#3363).
 * @param {{ checkout?: string, git?: Run, gh?: Run, repo?: string, base?: string }} [seams]
 * @returns {(range: { from: Date, to: Date }) => Change[]}
 */
export function gatherChanges({ checkout = HOME_CHECKOUT, git = gitIn(checkout), gh: runGh = defaultGh, repo = REPO, base = "origin/main" }: { checkout?: string; git?: Run; gh?: Run; repo?: string; base?: string; } = {}): (range: { from: Date; to: Date; }) => Change[] {
  return ({ from }) => {
    assertBaseIsLive({ git, gh: runGh, repo, base });
    const prs = mergedPullRequests(runGh, repo, from);
    const logins = loginsBySha(runGh, repo, from);
    const changes: Map<string, Change> = new Map();
    for (const commit of firstParentLine(git, base, from)) {
      const number = pullRequestNumber(commit);
      const pr = number === null ? undefined : prs.get(number);
      const key = number === null ? `commit:${commit.sha}` : `pr:${number}`;
      const change = changes.get(key) ?? { key, number, title: pr?.title ?? commit.subject, at: commit.at,
        author: pr ? pr.author : null, actors: pr ? [pr.author] : [], body: pr ? pr.body : null };
      for (const sha of carriedShas(git, commit)) change.actors.push(logins.get(sha) ?? null);
      changes.set(key, change);
    }
    return [...changes.values()];
  };
}

/**
 * `hand-reroute` events (#4450): one per counted hand fix, REFED BY THE CHANGE and DATED BY IT, so a change read on two days is one event.
 * @param {ReturnType<typeof readLedger>} reading `unknown` gives none: an unread window is not a quiet one
 */
export function handRerouteEvents(reading: ReturnType<typeof readLedger>): FailureEvent[] {
  return (reading.current?.entries ?? []).map((entry) => ({ classKey: "hand-reroute", ref: entry.key, at: Date.parse(entry.at) })).filter((event) => !Number.isNaN(event.at));
}

/** The hand-fix read is a git walk and a page of `gh` calls, so the tick makes it at most this often. */
export const HAND_REROUTE_READ_EVERY_MS = DAY_MS;

/**
 * Record the hand fixes of the window into the failure ledger, at most once per `HAND_REROUTE_READ_EVERY_MS` (`markerPath` holds when it last ran, and is written even when the read was refused, so a refusal is not retried on every tick).
 * NEVER THROWS INTO THE TICK: a refused read or write is reported through `report`.
 * @param {{ logPath: string, markerPath: string, now: number, read?: ReturnType<typeof gatherChanges>, report?: (line: string) => void }} tick
 * @returns {number} how many events were appended
 */
export function recordHandReroutes({ logPath, markerPath, now, read = gatherChanges(), report = (line) => process.stderr.write(`${line}\n`) }: { logPath: string; markerPath: string; now: number; read?: ReturnType<typeof gatherChanges>; report?: (line: string) => void; }): number {
  try {
    if (now - lastRun(markerPath) < HAND_REROUTE_READ_EVERY_MS) return 0;
    markRun(markerPath, now);
    const reading = readLedger({ read, now: new Date(now) });
    if (reading.status !== "read") report(`failure-ledger: hand fixes not read (${reading.why})`);
    return recordFailures({ logPath, events: handRerouteEvents(reading), now, report }).appended;
  } catch (cause) {
    report(`failure-ledger: hand-reroute recorder failed: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`);
    return 0;
  }
}

/**
 * Parse `--days N`, `--json` and `--list`; the rest is refused rather than ignored.
 * @param {string[]} argv
 */
function parseArgs(argv: string[]) {
  const days = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : WINDOW_DAYS;
  const unknown = argv.filter((a, i) => !["--days", "--json", "--list"].includes(a) && argv[i - 1] !== "--days");
  if (!Number.isInteger(days) || days < 1 || unknown.length > 0) {
    throw new Error(`usage: hand-fix-ledger.ts [--days N] [--json] [--list]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  }
  return { days, json: argv.includes("--json"), list: argv.includes("--list") };
}

/**
 * The CLI: print the line (`--list` adds one row per counted change, `--json` the whole reading). Exit 0 when the read succeeded, 1 when it was refused --
 * the count is "unknown", and a caller must be able to tell.
 * @param {string[]} [argv]
 * @param {{ read?: ReturnType<typeof gatherChanges>, now?: Date, out?: (s: string) => void }} [deps]
 * @returns {number}
 */
export function main(argv: string[] = process.argv.slice(2), { read = gatherChanges(), now = new Date(), out = console.log }: { read?: ReturnType<typeof gatherChanges>; now?: Date; out?: (s: string) => void; } = {}): number {
  const { days, json, list } = parseArgs(argv);
  const reading = readLedger({ read, now, days });
  out(json ? JSON.stringify(reading, null, 2) : ledgerLine(reading));
  if (list && !json && reading.current) {
    for (const e of reading.current.entries) out(`  ${e.key} [${e.via}] ${e.humans.join(",")} ${e.title.slice(0, 70)}`);
  }
  return reading.status === "read" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  process.exitCode = main();
}
