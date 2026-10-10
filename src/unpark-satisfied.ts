// @ts-check
// A PARKED ROW WHOSE EVERY CONDITION HAS COME TRUE IS UN-PARKED ON THE TICK (a11ign/a11ign#4050, the chairman's rule 3, 2026-10-08: "nothing sits parked on a satisfied condition").
//
// BEFORE THIS, NOTHING DID IT. The board audit's `wait-already-true` named the row to `product-manager` once a day ("lift it") and then waited for a person, so a row whose date
// passed at 02:00 was still `parked` at 20:00. The tick already reads every declared wait (`waitTickFacts`), so the answer is in hand and costs no call; this is the act that follows it.
//
// WHAT COUNTS AS "EVERY CONDITION": a `Not-before:` that has passed, every `Waiting-for:` line true, every native `blockedBy` edge closed -- and NOTHING else standing, which is
// `waitFieldsOf` returning no field at all (so an `answer:<session>`, a `hold:*`, `blocked`, an open edge or a future `Fleet-hold-until` keeps the row where it is). A condition the
// tick could not READ (a reference past the read cap, `manual`, outside the grammar) is an unknown, and an unknown is never true (`conditionHolds`): the row stays parked and is listed
// as `unread`, so a refused read is not mistaken for a wait that ended.
//
// WHERE IT GOES: the eligibility is the one `ready-label-audit.ts` applies to a `ready` row -- a label that already means "not pickable" (`mutexViolations`), no Region/Acceptance/Open-check
// (`unclaimableReadyRows`, which is `templateFieldsReason`, imported here from the rule module it delegates to) and a merged PR that already closes it (`readyRowsAlreadyMerged`, the #2905 shape:
// promoted on closed edges alone it put a row with nothing to build in front of an engineer) -- and then `row-file --promote` itself, which refuses what the filing rule refuses. A row that
// passes becomes `ready` THROUGH THAT ACT (the Status move, the label set and the read-back are its, not copied here); one that does not becomes `backlog` + `answer:product-manager` with the
// failing check in the comment, so it is never offered half-formed.
//
// WHY NOT IMPORT `ready-label-audit.ts` ITSELF: it reaches `row-claim.ts` (through `close-rows-for-merged-pr.ts`), and `row-claim.ts` imports the gate, so the gate's closure would contain the
// claim (`row-claim-reads-together.test.ts` pins that it never does). The one list restated here, `NOT_PICKABLE_BESIDE_READY`, is pinned equal to that file's `MUTEX_LABELS` by this module's test,
// and the merged-closer check is the conservative form of `readyRowsAlreadyMerged`: ANY merged PR that names the row sends it to `product-manager`, without the reopen history that function adds
// (a row reopened after its merge is a refuted fix, and is exactly what `product-manager` should look at).
//
// THE ORDER IS LOAD-BEARING. `parked` -> `backlog` is written FIRST (one `PUT .../labels`, so no add/remove half to come apart), and only then is the promotion run: a crash between leaves a
// plain `backlog` row, a state the board audit reads, never a `ready` row still carrying `parked` that a claimant could take. The comment is written LAST, once the labels have landed, so a
// row that failed to move has not announced that it did; the comment is one per transition and names each condition with the time it became true.
//
// IDEMPOTENT BY CONSTRUCTION: a transitioned row no longer carries `parked`, so a second tick finds nothing to do and writes nothing. The tick's own row objects are updated to the labels
// the row now has, because the board audit reads the SAME list later in the same tick and would otherwise count the row it has just un-parked as `wait-already-true`.
//
// NOT IN SCOPE: `needs:chairman` is never added here (whether the next act is the chairman's is a judgement a row marks), and a `needs:chairman` row is skipped. A parked row declaring NO
// condition is not touched: it is a different defect (a park with no reason), and un-parking it would hide it. A `lane:<owner>` row is un-parked and not offered to another session.
//
// WHERE THE PROMOTION RUNS (a11ign/a11ign#4202): `row-file` refuses a launch from a checkout whose `.git` is a directory (`launchGate`, #1352: a policy script's writes must not land in a tree
// other sessions share), and the tick's working directory IS the tool's primary checkout, so every promotion was refused and every un-parked row landed on `backlog` + `answer:product-manager`
// (a11ign/a11ign#4159 twice, #4182, #4183). The guard is right and stays as it is; the tick runs the child from `tickWorktree()`, a linked worktree it owns, and the log line says which one.
// The other children the tick starts (`update-primary --drift`, `host-units --json`) carry no launch guard and need none; `unpark-satisfied.test.ts` pins that list from the source.
//
// A LEAF AT LOAD TIME: no import of `work-gate.ts` (which imports this), so the gate's `run` is passed in.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { PARKED_LABEL, conditionHolds, declaredWaitsOf, isItemWait, waitFieldsOf, waitItemOf } from "./wait-condition.ts";
import { notBeforeDate, notBeforeIso } from "./waiting-condition.ts";
import { CLAIM_LABEL, READY_LABEL } from "./claim-labels.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL, BLOCKED_LABEL, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { REPO } from "./project-identity.ts";
import { templateFieldsReason } from "./row-claim/template-fields-rule.ts";

/** The label `work-gate.ts` exports as `PARKED_LABEL`; restated because that file imports this one. `unpark-satisfied.test.ts` pins the two equal. */
export const PARKED = "parked";
/** Who reads a row the gate cannot make ready: `product-manager`, the first reader for rows and process (`org-routing-and-timers.md`). */
export const PRODUCT_MANAGER = "product-manager";
/** The line every comment this module writes starts with, so a reader (and a test) can tell its comment from a person's. */
export const COMMENT_MARKER = "<!-- unpark-satisfied -->";
/** The labels that already mean "not pickable", so `ready` beside one is a contradiction; `ready-label-audit.ts`'s `MUTEX_LABELS`, restated because that file cannot be imported here (see the header) and pinned equal by the test. */
export const NOT_PICKABLE_BESIDE_READY = Object.freeze(["fleet-gated", "disputed", "decision", "awaiting-merge", BLOCKED_LABEL, "review-only"]);
/** What the promotion's report names as the session, since `row-file --promote` takes one. */
const SESSION = "work-gate";
const ROW_FILE_ENTRY = fileURLToPath(new URL("./row-file.ts", import.meta.url));
const ROW_FILE_REFUSED = 1;
/** The tick's own worktree, named the way a session's launch tree is (`role-<session>`, beside the checkout): `prune-worktrees` treats `role-*` as a tree that is moved between runs, never removed. */
export const TICK_WORKTREE = `role-${SESSION}`;
const GIT_TIMEOUT_MS = 30_000;
const NOT_BEFORE_LINE = /^[ \t]*#{0,6}[ \t]*Not-before:/im;

/**
 * A condition the row declared and its time of becoming true, epoch ms; `null` when nothing dated it (a release fact carries no date of its own).
 */
export type Condition = { text: string, since: number | null };
export type Satisfaction = { verdict: "satisfied", conditions: Condition[] } | { verdict: "untouched", reason: string } | { verdict: "unread", reason: string };
export type FreshRow = { labels: string[], state: string };
export type UnparkIo = { readLabels: (number: number) => FreshRow, setLabels: (number: number, labels: string[]) => void, promote: (number: number) => { ok: true } | { ok: false, refusal: string }, mergedClosers: (number: number) => { number: number, mergedAt: string }[], closedAt: (number: number) => number | null, comment: (number: number, body: string) => void };

/** @param {any} row @returns {string[]} */
const labelsOf = (row: any): string[] => (row?.labels ?? []).map((l: any) => String(l?.name ?? l));

/** @param {string} reason @returns {Satisfaction} */
const untouched = (reason: string): Satisfaction => ({ verdict: "untouched", reason });

/** @param {string[]} labels @returns {string | null} why the row is not this module's to touch, or null */
function notOurs(labels: string[]): string | null {
  if (!labels.includes(PARKED)) return "not parked";
  if (labels.includes(NEEDS_CHAIRMAN_LABEL)) return `carries \`${NEEDS_CHAIRMAN_LABEL}\`: whether the next act is the chairman's is a judgement a row marks`;
  if (labels.includes(CLAIM_LABEL)) return `claimed (\`${CLAIM_LABEL}\`): un-parking it would leave \`${READY_LABEL}\` beside a claim`;
  return null;
}

/** @param {any} wait @param {import("./wait-condition.ts").WaitFacts} facts @returns {number | null} when the item the wait names closed, or its label changed (the bound `staleWaits` uses) */
function becameTrueAt(wait: any, facts: import("./wait-condition.ts").WaitFacts): number | null {
  if (!isItemWait(wait)) return null;
  const fact = facts.items[wait.key];
  return wait.state === "labelled" || wait.state === "unlabelled" ? fact.changedAt : fact.resolvedAt;
}

/** @param {any} row @param {number} now @returns {Condition[]} the `Not-before:` the row declares, which `waitFieldsOf` has already shown to be in the past */
function notBeforeConditions(row: any, now: number): Condition[] {
  const declared = notBeforeDate(row.body);
  if (declared === null) return [];
  const at = Date.parse(notBeforeIso(declared));
  return at <= now ? [{ text: `Not-before: ${declared}`, since: at }] : [];
}

/** @param {any} row @param {(number: number) => number | null} closedAt @returns {Condition[]} every native `blockedBy` edge, all closed once `waitFieldsOf` found no open one */
const edgeConditions = (row: any, closedAt: (number: number) => number | null): Condition[] => (row.blockedBy?.nodes ?? [])
  .map((node: any) => ({ text: `blockedBy #${node.number} (closed)`, since: closedAt(Number(node.number)) }));

/**
 * IS EVERY CONDITION THIS PARKED ROW DECLARES TRUE? Pure: the facts are the ones the tick read, and `closedAt` only dates an edge for the comment (an edge carries no close time).
 * @param {any} row @param {import("./wait-condition.ts").WaitFacts} facts @param {number} now @param {(number: number) => number | null} [closedAt]
 * @returns {Satisfaction}
 */
export function readSatisfaction(row: any, facts: import("./wait-condition.ts").WaitFacts, now: number, closedAt: (number: number) => number | null = () => null): Satisfaction {
  const skipped = notOurs(labelsOf(row));
  if (skipped !== null) return untouched(skipped);
  const item = waitItemOf(row, "row");
  // `parked` is itself a wait field since #4230, and it is the one this module exists to lift: only the OTHER fields keep the row where it is.
  const standing = waitFieldsOf(item, now).filter((f) => f.kind !== PARKED_LABEL).map((f) => f.label ?? f.kind);
  if (standing.length > 0) return untouched(`still waiting on ${standing.join(", ")}`);
  if (NOT_BEFORE_LINE.test(String(row.body ?? "")) && notBeforeDate(row.body) === null) return untouched("a `Not-before:` line the gate cannot read");
  const readings = declaredWaitsOf(item).waits.map((wait) => ({ wait, holds: conditionHolds(wait, facts) }));
  const unread = readings.find((r) => r.holds === null && r.wait.state !== "manual" && r.wait.state !== "unreadable");
  if (unread) return { verdict: "unread", reason: `\`Waiting-for: ${unread.wait.text}\` could not be read this tick` };
  const open = readings.find((r) => r.holds !== true);
  if (open) return untouched(`\`Waiting-for: ${open.wait.text}\` is not true`);
  const conditions = [...notBeforeConditions(row, now), ...edgeConditions(row, closedAt),
    ...readings.map((r) => ({ text: `Waiting-for: ${r.wait.text}`, since: becameTrueAt(r.wait, facts) }))];
  return conditions.length === 0 ? untouched("declares no condition (a park with no reason is a different finding)") : { verdict: "satisfied", conditions };
}

/**
 * THE CHECKS A `ready` ROW MUST PASS: the first that fails, in words, or `null`. See the header for where each comes from.
 * @param {any} row @param {string[]} labels the row's labels read fresh @param {UnparkIo["mergedClosers"]} mergedClosers
 * @returns {string | null}
 */
export function ineligibility(row: any, labels: string[], mergedClosers: UnparkIo["mergedClosers"]): string | null {
  const number = Number(row.number);
  const blocking = NOT_PICKABLE_BESIDE_READY.filter((l) => labels.includes(l));
  if (blocking.length > 0) return `it carries ${blocking.map((l) => `\`${l}\``).join(", ")}, which already mean "not pickable" beside \`${READY_LABEL}\``;
  const incomplete = templateFieldsReason(String(row.body ?? ""), number);
  if (incomplete) return incomplete;
  const [merged] = mergedClosers(number);
  return merged ? `PR #${merged.number} (merged ${merged.mergedAt}) already names it, so there may be nothing left to build` : null;
}

/** @param {number | null} at @returns {string} */
const when = (at: number | null): string => (at === null ? "not dated (read true at this tick)" : new Date(at).toISOString());

/** @param {{ to: string, conditions: Condition[], why: string | null, now: number }} input @returns {string} the one comment a transition writes */
export function commentFor({ to, conditions, why, now }: { to: string; conditions: Condition[]; why: string | null; now: number; }): string {
  const lines = conditions.map((c) => `- \`${c.text}\` -- true since ${when(c.since)}`);
  const head = `${COMMENT_MARKER}\n**Un-parked by the tick** (a11ign/a11ign#4050): every condition this row declared is now true, read at ${new Date(now).toISOString()}.\n\n${lines.join("\n")}\n\n`;
  if (to === READY_LABEL) return `${head}It passed the checks a \`${READY_LABEL}\` row must pass, so it is promoted: \`${PARKED}\` -> \`${READY_LABEL}\`.`;
  return `${head}It does NOT pass the check a \`${READY_LABEL}\` row must pass: ${why}\n\nSo it is \`${BACKLOG_LABEL}\` with \`${ANSWER_PREFIX}${PRODUCT_MANAGER}\`, not offered half-formed. Fix that, then promote it (\`row-file --promote=<n>\`) and remove the answer label.`;
}

export type Unparked = { number: number, to: string, why: string | null };
export type UnparkResult = { unparked: Unparked[], unread: { number: number, reason: string }[], errors: { number: number, message: string }[] };

/** @param {any} row @param {string[]} labels the row's tick object now says what the world does, so a later reader of the same list (the board audit) does not count it again */
function reflect(row: any, labels: string[]) {
  row.labels = labels.map((name) => (typeof row.labels?.[0] === "string" ? name : { name }));
}

/**
 * ONE TRANSITION: re-read, decide, write `backlog`, promote or route, comment.
 * @param {any} row @param {Condition[]} conditions @param {UnparkIo} io @param {number} now @returns {Unparked | null} `null` when the row changed under us and is left alone
 */
function transition(row: any, conditions: Condition[], io: UnparkIo, now: number): Unparked | null {
  const number = Number(row.number);
  const fresh = io.readLabels(number);
  if (fresh.state !== "OPEN" || notOurs(fresh.labels) !== null) return null;
  const kept = fresh.labels.filter((l) => l !== PARKED && l !== BACKLOG_LABEL);
  let why = ineligibility(row, fresh.labels, io.mergedClosers);
  io.setLabels(number, [BACKLOG_LABEL, ...kept]);
  let after = [BACKLOG_LABEL, ...kept];
  if (why === null) {
    const promoted = io.promote(number);
    if (promoted.ok) after = [READY_LABEL, ...kept];
    else why = promoted.refusal;
  }
  if (why !== null) {
    after = [BACKLOG_LABEL, `${ANSWER_PREFIX}${PRODUCT_MANAGER}`, ...kept];
    io.setLabels(number, after);
  }
  const to = why === null ? READY_LABEL : BACKLOG_LABEL;
  io.comment(number, commentFor({ to, conditions, why, now }));
  reflect(row, after);
  return { number, to, why };
}

/**
 * UN-PARK EVERY PARKED ROW WHOSE EVERY CONDITION IS TRUE. A failure on one row is an error NAMING that row and the pass goes on: a refused read is never a skipped row nobody hears about,
 * and never stops the others.
 * @param {{ rows: any[], facts: import("./wait-condition.ts").WaitFacts, now: number }} input @param {UnparkIo} io @returns {UnparkResult}
 */
export function unparkSatisfied({ rows, facts, now }: { rows: any[]; facts: import("./wait-condition.ts").WaitFacts; now: number; }, io: UnparkIo): UnparkResult {
  const result: UnparkResult = { unparked: [], unread: [], errors: [] };
  for (const row of rows) {
    const number = Number(row.number);
    const satisfaction = readSatisfaction(row, facts, now, io.closedAt);
    if (satisfaction.verdict === "unread") result.unread.push({ number, reason: satisfaction.reason });
    if (satisfaction.verdict !== "satisfied") continue;
    try {
      const done = transition(row, satisfaction.conditions, io, now);
      if (done) result.unparked.push(done);
    } catch (error) {
      result.errors.push({ number, message: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  return result;
}

/** @param {UnparkResult} result @param {(line: string) => void} log */
export function reportUnpark(result: UnparkResult, log: (line: string) => void) {
  for (const { number, to, why } of result.unparked) log(`DID unpark #${number} -> ${to}${why === null ? "" : ` (answer:${PRODUCT_MANAGER}: ${why.split("\n")[0]})`} -- every condition it declared is true\n`);
  for (const { number, message } of result.errors) log(`COULD NOT unpark #${number}: ${message}\n`);
}

/**
 * THE REAL WORLD, through the gate's own `gh` runner (`(args) => stdout`, which throws on failure, so every failure here is an error NAMING the row in `unparkSatisfied`).
 * @param {(args: string[]) => string} run @param {{ worktree?: () => TickWorktree }} [deps] `worktree` is where the promotion runs from, a seam for a test that builds its own checkout
 * @returns {UnparkIo}
 */
export function githubIo(run: (args: string[]) => string, { worktree = tickWorktree }: { worktree?: () => TickWorktree; } = {}): UnparkIo {
  return {
    readLabels: (number) => {
      const read = JSON.parse(run(["issue", "view", String(number), "--repo", REPO, "--json", "labels,state"]));
      return { labels: (read.labels ?? []).map((l: any) => String(l.name)), state: String(read.state) };
    },
    setLabels: (number, labels) => { run(["api", "--method", "PUT", `repos/${REPO}/issues/${number}/labels`, ...labels.flatMap((l) => ["-f", `labels[]=${l}`])]); },
    promote: (number) => promoteViaModule(number, worktree),
    mergedClosers: (number) => mergedClosersOf(number, run),
    // The close time only dates a line of the comment, so a read that fails says "not dated" there; it is not a reason to leave a row parked.
    closedAt: (number) => {
      try {
        const at = Date.parse(run(["api", `repos/${REPO}/issues/${number}`, "--jq", ".closed_at"]).trim());
        return Number.isFinite(at) ? at : null;
      } catch (cause) {
        process.stderr.write(`unpark-satisfied: could not date the close of #${number} (${cause instanceof Error ? cause.message.split("\n")[0] : cause}); the comment says "not dated"\n`);
        return null;
      }
    },
    comment: (number, body) => { run(["issue", "comment", String(number), "--repo", REPO, "--body", body]); },
  };
}

/**
 * THE MERGED PULL REQUESTS THAT NAME THE ROW (`closedByPullRequestsReferences`, GitHub's own resolution of a `Closes #n`, never a regex over a body). THROWS on a failed call or a shape it does not
 * recognise: an empty answer read off a refused call would say "nothing merged" and offer a row with nothing to build.
 * @param {number} number @param {(args: string[]) => string} run @returns {{ number: number, mergedAt: string }[]}
 */
export function mergedClosersOf(number: number, run: (args: string[]) => string): { number: number; mergedAt: string; }[] {
  const [owner, name] = REPO.split("/");
  const query = `{ repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) { closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } } }`;
  const nodes = JSON.parse(run(["api", "graphql", "-f", `query=${query}`]))?.data?.repository?.issue?.closedByPullRequestsReferences?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`the closing pull requests of #${number} could not be read (an answer with no \`nodes\`)`);
  return nodes.filter((n: any) => n?.state === "MERGED" && n?.mergedAt).map((n: any) => ({ number: Number(n.number), mergedAt: String(n.mergedAt) }));
}

export type GitExec = (args: string[], cwd: string) => { status: number | null, output: string };
export type TickWorktree = { dir: string } | { refusal: string };

const gitExec: GitExec = (args, cwd) => {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv(), timeout: GIT_TIMEOUT_MS });
  return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error?.message ?? ""}`.trim() };
};

/**
 * THE LINKED WORKTREE THE TICK OWNS: `role-work-gate`, beside the checkout the tick's code runs from, detached at that checkout's HEAD so the tree holds the code that is running. Created when absent;
 * moved to HEAD when it is detached and clean (best effort: a tree that cannot move is still a launch directory); a registration whose directory is gone is pruned first, which is what "stale" means
 * here. A directory of that name that is NOT one of this repository's worktrees is refused by name and never removed or reused: it is somebody's.
 * @param {{ git?: GitExec, exists?: (path: string) => boolean, codeDir?: string }} [deps] `codeDir` is where the code runs from, a seam so a test can build its own checkout
 * @returns {TickWorktree}
 */
export function tickWorktree({ git = gitExec, exists = existsSync, codeDir = dirname(fileURLToPath(import.meta.url)) }: { git?: GitExec; exists?: (path: string) => boolean; codeDir?: string; } = {}): TickWorktree {
  const top = git(["rev-parse", "--show-toplevel"], codeDir);
  const head = git(["rev-parse", "HEAD"], codeDir);
  if (top.status !== 0 || head.status !== 0) return { refusal: `the checkout ${codeDir} runs from could not be read (${(top.status !== 0 ? top : head).output.split("\n")[0]})` };
  const checkout = top.output;
  const dir = join(dirname(checkout), TICK_WORKTREE);
  git(["worktree", "prune"], checkout);
  if (!exists(dir)) {
    const made = git(["worktree", "add", "--detach", dir, head.output], checkout);
    return made.status === 0 ? { dir } : { refusal: `could not create ${dir} (${made.output.split("\n")[0]})` };
  }
  const listed = git(["worktree", "list", "--porcelain"], checkout).output.split("\n");
  if (!listed.includes(`worktree ${dir}`)) return { refusal: `${dir} exists and is not a worktree of ${checkout}: left alone, and nothing was run from it` };
  const detached = git(["symbolic-ref", "-q", "HEAD"], dir).status !== 0;
  const clean = git(["status", "--porcelain", "--untracked-files=no"], dir).output === "";
  if (detached && clean) git(["checkout", "--quiet", "--detach", head.output], dir);
  return { dir };
}

/**
 * PROMOTE THROUGH THE ACT THAT OWNS IT, `row-file --promote` (the Status move, the label set, the read-back), as a child process: the module is a CLI whose `main` runs on load. It runs FROM
 * `worktree()` (see the header), and the line saying which tree ran it is written before the child starts. Exit `1` is a REFUSAL with nothing changed, which is the failing check; any other non-zero
 * (`2`: written, unconfirmed) is an error, not a refusal to route. No tree to run from is a refusal too: the row is routed to `product-manager` WITH that reason, not left as a plain `backlog` row.
 * @param {number} number @param {() => TickWorktree} [worktree] @returns {{ ok: true } | { ok: false, refusal: string }}
 */
export function promoteViaModule(number: number, worktree: () => TickWorktree = tickWorktree): { ok: true; } | { ok: false; refusal: string; } {
  const launch = worktree();
  if ("refusal" in launch) return { ok: false, refusal: `the tick has no linked worktree to run \`row-file --promote=${number}\` from: ${launch.refusal}` };
  process.stderr.write(`unpark-satisfied: row-file --promote=${number} runs from the tick's worktree ${launch.dir}\n`);
  const result = spawnSync(process.execPath, [ROW_FILE_ENTRY, `--promote=${number}`, `--session=${SESSION}`], { encoding: "utf8", cwd: launch.dir });
  if (result.status === 0) return { ok: true };
  const said = String(result.stderr).trim();
  if (result.status === ROW_FILE_REFUSED) return { ok: false, refusal: said.replace(/^row-file: REFUSING to promote -- /, "") };
  throw new Error(`\`row-file --promote=${number}\` exited ${result.status}: ${said}`);
}

/**
 * THE TICK'S SEAM: wrap the wait read (`waitTickFacts`) so that the facts it just read are acted on once, before anything else in the tick reads the rows. `null` (a refused read) un-parks nothing.
 * @template T
 * @param {(input: { prsRead: any[] | null, openRowsRead: any[] | null, now: number }) => T | null} readWaits
 * @param {{ run: (args: string[]) => string, log?: (line: string) => void, io?: UnparkIo }} deps
 * @returns {(input: { prsRead: any[] | null, openRowsRead: any[] | null, now: number }) => T | null}
 */
export function unparkingWaits<T>(readWaits: (input: { prsRead: any[] | null; openRowsRead: any[] | null; now: number; }) => T | null, { run, log = (line) => process.stderr.write(line), io = githubIo(run) }: { run: (args: string[]) => string; log?: (line: string) => void; io?: UnparkIo; }): (input: { prsRead: any[] | null; openRowsRead: any[] | null; now: number; }) => T | null {
  return (input) => {
    const waits = readWaits(input);
    if (waits === null || !Array.isArray(input.openRowsRead)) return waits;
    const { facts } = ((waits as unknown) as { facts: import("./wait-condition.ts").WaitFacts });
    reportUnpark(unparkSatisfied({ rows: input.openRowsRead, facts, now: input.now }, io), log);
    return waits;
  };
}
