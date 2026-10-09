// no-token: gh -- every `gh`, `git`, `systemctl`, `herdr` and `row-claim` call here is an injected seam, and the state files are an in-memory map; nothing imported reaches the real one
/**
 * #2470: A CLAIM THAT DOES NOT MOVE, AND NOTHING THAT SAID SO.
 *
 * `worker-7` held three rows and worked another while `../wt-2407` held 215 lines uncommitted, unpushed, no PR, last file change seven
 * hours before. The gate had no cause for a claim going unmoved, and the one nudge that worked was a `ceo` turn spent reading a pane.
 *
 * THE POSITIVE CONTROL FOR EVERY "NOTHING FIRES" ASSERTION IS THE SAME FIXTURE WITH ONE THING CHANGED. A row with a commit inside N
 * yields no order only because the row with the SAME clock and NO commit yields one; and a second reading with a move after the nudge
 * releases nothing only because the same second reading with none releases. Nothing here is asserted against an empty population.
 */
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import assert from "node:assert/strict";
import { decide, claimStallTick, claimStallsNow, readElsewherePrs, CAUSES, START_CAUSES, JUDGMENT_CAUSES, GH_READS } from "./work-gate.ts";
import { profileFor } from "./worker-profile.ts";
import {
  WAKE_TTL_MS, MAX_DELIVERIES, performRelease, spawnClaimer, spawnedPrompt, deliver, consecutiveClean, drainInForce, isReleaseLine,
  cyclesReport, readLedger, deliveryCounts, readLedgerDeliveries, readDeliveredHandoffs, recoverInterruptedWork, recoverableWork,
  queueHandoff, readHandoffs, handoffBatches, recentlyVoidedKeys, sessionMoved, VOIDED, keptClaimsPath, ledgerLine, thrashEscalationPrompt,
  pruneGoneKeptClaims, readKeptClaims, writeKeptClaims, PRIMARY_CHECKOUT,
} from "./wake.ts";
import {
  claimRecordComment, claimRow, declineRow, claimWithWorktree, worktreeTargetReason, worktreeFlagsReason,
  implicitAdoptSession, worktreeCleanliness, predecessorLivenessUnknown, predecessorGoneReading, recordPredecessorGone, adoptFor, ROW_CLAIM_FLAGS,
} from "./row-claim.ts";
import { unknownFlags } from "./lib/cli-flags.mjs";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import {
  CLAIM_STALLED, STALL_INTERVAL_MS, STALL_UNTOLD_RELEASE_MS, INTERRUPTED_SETTLE_MS, GONE_CONFIRM_MS, nudgeKey, nudgeDeliveredAt, claimRecordOf, commentMove, workAtRisk, fileMove, claimReading,
  claimFactsFrom, readClaim, nextStallState, claimStalledOrders, paneInterrupted, paneThrashed, killedDeliveries, readHerdrRestart,
  RESTART_RESEND_WINDOW_MS, INTERRUPTED_TEXT, THRASH_TEXT, gitRun, gitInvocation, newestOwnCommit, statMtime, pathExists,
} from "./claim-stall.ts";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIN = 60_000;
const NOW = Date.parse("2026-09-25T16:00:00Z");
const N_MIN = STALL_INTERVAL_MS / MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => NOW - minutes * MIN;

const BRANCH = "agent/one-instance-one-row-2407";
const WORKTREE = "../wt-2407";
const REPO = "/home/agent/repos/a11y-witness";
const WT = "/home/agent/repos/wt-2407";

type Comment = { body: string; createdAt: string; author: { login: string } };
type Release = { row: number; session: string; why: string; idleMinutes?: number | null; edges?: number[]; answer?: string; mergedPr?: number;
  openPrs?: number[] };
type Order = { session: string; cause: string; causeKey: string; prompt: string; release?: Release; resume?: boolean };
type Facts = Parameters<typeof claimReading>[0];
type Stalls = NonNullable<Parameters<typeof decide>[0]["claimStalls"]>;

/** The claim record exactly as `row-claim.ts` writes it -- the REAL writer, so a change to its format breaks these. */
const claim = (minutesAgo: number, { session = "worker-7", author = "a11ign-ai-workers" } = {}): Comment => ({
  body: claimRecordComment({ session, branch: BRANCH, worktree: WORKTREE }), createdAt: iso(ago(minutesAgo)), author: { login: author },
});
const said = (minutesAgo: number, author = "a11ign-ai-workers", body = "built the first half", ref = NOW): Comment => ({
  body, createdAt: iso(ref - minutesAgo * MIN), author: { login: author } });

const row = (number: number, labels: string[] = ["in-progress", "session:worker-7"], extra: object = {}) => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: "", blockedBy: { nodes: [] }, ...extra });

interface World {
  /** Minutes ago of the newest own commit on the branch / on origin's copy, or `null` for none. */
  commit?: number | null; push?: number | null;
  /** `git status` lines (each `" M file"`) and the mtime of each file, in minutes ago. */
  dirty?: { file: string; ago: number }[]; unpushed?: number; worktreeExists?: boolean; refExists?: boolean;
  /** Whether `refs/remotes/origin/<branch>` exists (a pushed branch), as opposed to the local one. */
  originRef?: boolean;
  /** A git command that exits with this status, whatever it is asked. */
  broken?: number | null;
}

/** A fake host: a tiny `git` and a filesystem, both answering from one `World`. */
function host(w: World = {}, ref = NOW) {
  const dirty = w.dirty ?? [];
  const ago = (minutes: number) => ref - minutes * MIN;
  const calls: string[] = [];
  const git = (dir: string, args: string[]) => {
    const cmd = args.join(" ");
    calls.push(`${dir}: ${cmd}`);
    if (w.broken !== undefined && w.broken !== null) return { status: w.broken, out: "" };
    if (args[0] === "rev-parse") {
      const remote = String(args.at(-1)).startsWith("refs/remotes/");
      return { status: (remote ? w.originRef === true : w.refExists !== false) ? 0 : 1, out: "" };
    }
    if (args[0] === "log") {
      const minutes = args.at(-1)!.includes("origin/main..origin/") ? w.push : w.commit;
      return { status: 0, out: minutes === null || minutes === undefined ? "" : `${Math.floor(ago(minutes) / 1000)}\n` };
    }
    if (args[0] === "status") return { status: 0, out: args.includes("-z") ? dirty.map((d) => ` M ${d.file}\0`).join("") : dirty.map((d) => ` M ${d.file}\n`).join("") };
    if (args[0] === "rev-list") return { status: 0, out: `${w.unpushed ?? 0}\n` };
    // #3453: a merged release in ANOTHER repository lists that clone's worktrees; this world's clone holds none of the holder's.
    if (args[0] === "worktree") return { status: 0, out: "" };
    throw new Error(`unexpected git ${cmd}`);
  };
  const mtimes = new Map(dirty.map((d) => [`${WT}/${d.file}`, ago(d.ago)]));
  return { calls, io: { git, exists: (p: string) => p === WT && w.worktreeExists !== false, mtime: (p: string) => mtimes.get(p) ?? null,
    cloneOf: (key: string) => ({ clone: `/home/agent/repos/${key}` }) } };
}

/** The wake ledger's line for the nudge `worker-7` was sent at `nudgedAt`, recorded as delivered at `deliveredAt` -- the REAL writer's format. */
const nudgeDelivered = (nudgedAt: number, deliveredAt: number, session = "worker-7") =>
  ledgerLine(deliveredAt, nudgeKey(session, 2407, nudgedAt));

type Agent = { label: string; status: string };

/** A whole tick over one claimed row, with the nudge memory in a map that survives between calls. */
function tickWith(world: World, comments: Comment[], { rows = [row(2407)], memory = {} as Record<string, unknown>, prs = [] as object[],
  merged = null as object[] | null, restartAt = null as number | null, now = NOW, blockedBy = [] as number[], ledger = "",
  // #3075: the OTHER tracked code repository's lists. Absent is a project with ONE code repository, which is every test above this line.
  elsewhere = undefined as import("./claim-stall.ts").ElsewherePrs | undefined,
  // `null` by default, same as `restartAt`: the gate is asked about the row's SESSION only when a test gives a listing,
  // never against the real `herdr` on whatever host runs the suite (`agentsFor`'s own doc says why -- CI must not depend on it).
  agents = null as Agent[] | null } = {}) {
  const h = host(world, now);
  const log: string[] = [];
  const claimed = rows.map((r) => (r.number === 2407 && blockedBy.length > 0
    ? { ...r, blockedBy: { nodes: blockedBy.map((n) => ({ number: n, state: "OPEN" })) } } : r));
  const orders = claimStallTick({ rows: claimed, claimedComments: claimed.map((r) => ({ number: r.number, comments })), openPrs: prs,
    mergedPrs: merged, ...(elsewhere === undefined ? {} : { elsewhere }), io: h.io, repo: REPO, now, restartAt, agents, stateDir: "/state", ledger: () => ledger,
    log: (l: string) => log.push(l), read: () => JSON.parse(JSON.stringify(memory)), write: (_p: string, s: object) => {
      for (const k of Object.keys(memory)) delete memory[k];
      Object.assign(memory, s);
    } });
  return { orders: orders as Order[], log, memory, h };
}

// --- Done-when 1 & Acceptance 3: the cause exists, is classified, and has a profile ------------------------------------------------

test("#2470 the cause is in CAUSES, is FINISH (not START), is an ACTION cause (not JUDGMENT), and has a profile", () => {
  assert.ok(CAUSES.includes("claim-stalled"));
  assert.ok(!START_CAUSES.includes("claim-stalled"), "a stalled claim is work in flight: a drain must not withhold the nudge");
  assert.ok(!JUDGMENT_CAUSES.includes("claim-stalled"), "the answer is a nudge or a release, not a question -- so it is not on the judgment window");
  assert.equal("refusal" in profileFor("claim-stalled"), false);
  assert.equal(CLAIM_STALLED, "claim-stalled", "the orders spell it as a literal for worker-profile.test.ts's scan; this is the pin that the two agree");
});

test("#2470 the read the gate adds is counted in GH_READS, and it is conditional on a claimed row", () => {
  assert.match(GH_READS.conditionalOnClaimedBranches, /pr list --state merged/);
});

test("#2470 the nudge key has ONE spelling, and the ledger's delivery of it is read back through the REAL writer's format", () => {
  const key = nudgeKey("worker-7", 2407, 123);
  assert.equal(key, "worker-7/claim-stalled/row-2407/nudge-123");
  assert.equal(nudgeDeliveredAt(ledgerLine(456, key), key), 456, "wake's ledgerLine is what nudgeDeliveredAt reads: a change of format breaks THIS, not the release");
  assert.equal(nudgeDeliveredAt(ledgerLine(456, `${key}x`), key), null, "another key is not this one");
  assert.equal(nudgeDeliveredAt("", key), null);
  const voided = `${ledgerLine(456, key)}${NOW}\t${VOIDED}\t${key}\t456\n`;
  assert.equal(nudgeDeliveredAt(voided, key), null, "a delivery a restart killed was NOT delivered");
  assert.equal(nudgeDeliveredAt(`${ledgerLine(100, key)}${voided}`, key), 100, "and it takes back ONE delivery, the one it names");
  assert.equal(nudgeDeliveredAt(`${ledgerLine(456, key, "worker-9")}`, key), 456, "a recorded recipient does not hide the key");
});

// --- the claim record, read ---------------------------------------------------------------------------------------------------

test("#2470 the claim record round-trips through the REAL writer, and a RELEASE record is not a claim", () => {
  const record = claimRecordOf([said(500), claim(300)]);
  assert.deepEqual([record?.branch, record?.worktree, record?.author], [BRANCH, WORKTREE, "a11ign-ai-workers"]);
  assert.equal(record?.at, ago(300));
  const released = { body: claimRecordComment({ session: "worker-7", released: true }), createdAt: iso(ago(10)), author: { login: "x" } };
  assert.equal(claimRecordOf([claim(300), released]), null, "the NEWEST record is a release, so nobody holds it -- the older claim must not be read");
  assert.equal(claimRecordOf([said(5)]), null, "no record at all (a dispatch, or a claim that named neither): cannot say when it was claimed");
});

test("#2470 a row comment counts only from the claim's OWN account and only after the claim; a claim record is not a comment", () => {
  const record = claimRecordOf([claim(300)])!;
  assert.equal(commentMove([claim(300), said(200)], record), ago(200));
  assert.equal(commentMove([claim(300), said(200, "a11ign-ai-leads")], record), null, "product-manager's audit is not the holder moving (#2416's '0h')");
  assert.equal(commentMove([said(400), claim(300)], record), null, "a comment BEFORE the claim is not a move on it");
  const second = { body: `${CLAIM_RECORD_MARKER}\n**Claim record** -- claimed by \`x\`.`, createdAt: iso(ago(100)), author: { login: "a11ign-ai-workers" } };
  assert.equal(commentMove([claim(300), second], record), null);
});

// --- Done-when 3 & Acceptance 1: the nudge fires on a claimed, unmoved row and NOT on one with a commit inside N ---------------------

test("#2470 a claimed row with nothing moved for N minutes yields ONE nudge, naming the row and the interval", () => {
  const { orders } = tickWith({ commit: null, push: null }, [claim(N_MIN + 30)]);
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.session, "worker-7");
  assert.equal(order.cause, "claim-stalled");
  assert.match(order.prompt, /#2407 IS YOURS AND NOTHING ON IT HAS MOVED FOR 150 MINUTES/);
  assert.match(order.prompt, new RegExp(`interval is ${N_MIN}`), "the order names the interval, as Acceptance 1 says");
  assert.match(order.prompt, /KEPT/, "and says the work is kept, so the nudge is not read as a threat to what is built");
  assert.match(order.causeKey, /^worker-7\/claim-stalled\/row-2407\/nudge-\d+$/);
});

test("#2470 POSITIVE CONTROL: the SAME row with a commit inside N yields nothing, and so does a row one minute short of N", () => {
  assert.deepEqual(tickWith({ commit: N_MIN - 1 }, [claim(N_MIN + 300)]).orders, [], "a commit inside N is a move");
  assert.deepEqual(tickWith({ commit: null }, [claim(N_MIN - 1)]).orders, [], "the claim itself is the first move: one minute short of N");
  assert.equal(tickWith({ commit: null }, [claim(N_MIN)]).orders.length, 1, "and exactly N is the boundary the rows above are on the near side of");
});

test("#2470 each of the five signals is a move on its own, and a signal older than N is not", () => {
  const old = claim(N_MIN + 600);
  assert.equal(tickWith({ commit: null }, [old, said(N_MIN - 1)]).orders.length, 0, "a row comment by the claimant");
  assert.equal(tickWith({ commit: null, push: N_MIN - 1 }, [old]).orders.length, 0, "a push (a commit on origin's copy of the branch)");
  assert.equal(tickWith({ commit: N_MIN - 1 }, [old]).orders.length, 0, "a commit");
  assert.equal(tickWith({ dirty: [{ file: "a.mjs", ago: N_MIN - 1 }] }, [old]).orders.length, 0, "a file change in the claimed worktree");
  assert.equal(tickWith({ commit: N_MIN + 5, push: N_MIN + 5, dirty: [{ file: "a.mjs", ago: N_MIN + 5 }] }, [old, said(N_MIN + 5)]).orders.length, 1,
    "every signal older than N leaves the row stalled -- the same fixture as the four above");
  const open = tickWith({ commit: null }, [old], { prs: [{ number: 9, headRefName: BRANCH }] });
  assert.deepEqual(open.orders, [], "a pull request is a move, and from there the PR-stage causes own the wait");
});

test("#2470 the file-change signal is read ONLY for a row that is otherwise quiet, so a moving row costs no `git status`", () => {
  const moving = tickWith({ commit: 5 }, [claim(N_MIN + 300)]);
  assert.equal(moving.h.calls.some((c) => c.includes("status")), false, "a commit inside N is enough: no worktree read");
  const quiet = tickWith({ commit: null }, [claim(N_MIN + 300)]);
  assert.equal(quiet.h.calls.some((c) => c.includes("status")), true,
    "a quiet row asks (WITHOUT taking the index lock: `gitInvocation` puts `--no-optional-locks` on every read, pinned against real git below)");
});

test("#2470 THE SESSION'S OWN STATUS IS NOT AN INPUT: a BUSY holder of an unmoved row is nudged (worker-7's shape, #2407)", () => {
  // The reading has no status parameter at all, so this is pinned structurally: the facts and the context that `claimReading` is given
  // carry nothing about the session but its name, and the same fixture yields the nudge for any session.
  for (const session of ["worker-7", "worker-capture", "product-manager"]) {
    const { orders } = tickWith({ commit: null }, [claim(N_MIN + 200, { session })],
      { rows: [row(2407, ["in-progress", `session:${session}`])] });
    assert.equal(orders.length, 1, `${session} holds an unmoved row and is nudged whatever it is doing`);
    assert.equal(orders[0].session, session);
  }
  // ...and holding ANOTHER row, in motion, does not shield this one: the signal is per ROW.
  const two = tickWith({ commit: null }, [claim(N_MIN + 200)],
    { rows: [row(2407), row(2500, ["in-progress", "session:worker-7"])] });
  assert.equal(two.orders.filter((o) => o.causeKey.includes("row-2407")).length, 1);
});

test("#2470 `answer:<the holder>` is NOT a wait of the holder's (the row waits on IT); `answer:<another session>` is", () => {
  const old = claim(N_MIN + 300);
  const ownAnswer = tickWith({ commit: null }, [old], { rows: [row(2407, ["in-progress", "session:worker-7", "answer:worker-7"])] });
  assert.equal(ownAnswer.orders.length, 1, "a session owing the answer on ITS OWN row is the case this cause is for");
  const rulingOwed = tickWith({ commit: null }, [old], { rows: [row(2407, ["in-progress", "session:worker-7", "answer:product-manager"])] });
  assert.deepEqual(rulingOwed.orders, [], "CONTROL: waiting on someone else's ruling is a declared wait");
});

test("#2470 a row that DECLARES its wait is not stalled, and a row with no claim record is not evaluated (and says so)", () => {
  const old = claim(N_MIN + 300);
  for (const labels of [["in-progress", "session:worker-7", "answer:product-manager"], ["in-progress", "session:worker-7", "needs:chairman"]]) {
    assert.deepEqual(tickWith({ commit: null }, [old], { rows: [row(2407, labels)] }).orders, [], labels.join(","));
  }
  assert.equal(tickWith({ commit: null }, [old], { rows: [row(2407, ["in-progress", "session:worker-7"], { body: "Not-before: 2099-01-01" })] }).orders.length, 0);
  const unrecorded = tickWith({ commit: null }, [said(N_MIN + 300)]);
  assert.deepEqual(unrecorded.orders, []);
  assert.match(unrecorded.log.join(""), /#2407 carries session:worker-7 but no claim record.*not evaluated/,
    "silence about a claim that could not be read would look like a claim that was fine");
});

test("#2470 a git that will not answer is NOT 'no commits': the row is skipped by name and nothing is nudged or released", () => {
  const broken = tickWith({ broken: 128 }, [claim(N_MIN + 300)]);
  assert.deepEqual(broken.orders, []);
  assert.match(broken.log.join(""), /#2407: git .* exited 128 -- not evaluated/);
  assert.equal(tickWith({ commit: null }, [claim(N_MIN + 300)]).orders.length, 1, "control: the same row with a working git IS nudged");
});

test("#2470 a REFUSED comments read evaluates NOTHING, because a row read without its comments looks stalled when it may not be", () => {
  const h = host({ commit: null });
  const log: string[] = [];
  const orders = claimStallTick({ rows: [row(2407)], claimedComments: null, openPrs: [], mergedPrs: null, io: h.io, repo: REPO, now: NOW,
    restartAt: null, stateDir: "/s", log: (l: string) => log.push(l), read: () => ({}), write: () => {} });
  assert.deepEqual(orders, []);
  assert.match(log.join(""), /comments on the claimed rows could not be read -- NO claim was evaluated/);
});

// --- Done-when 4 & Acceptance 2: the second reading ---------------------------------------------------------------------------------

// --- #3407: a claim that names no branch or worktree has its OWN record, so the stall check can read it -----------------------------

/** A claim that names no git object (a host act, a hand-claim), exactly as `postClaimRecord` writes it -- the REAL writer. */
const claimNothing = (minutesAgo: number, { session = "worker-7", author = "a11ign-ai-workers" } = {}): Comment => ({
  body: claimRecordComment({ session, nothing: "the claim named no branch and no worktree" }), createdAt: iso(ago(minutesAgo)), author: { login: author },
});
const released = (minutesAgo: number): Comment => ({ body: claimRecordComment({ session: "worker-7", released: true }), createdAt: iso(ago(minutesAgo)), author: { login: "x" } });

test("#3407 (1) a nothing-claim round-trips through the REAL writer as a CLAIM with a null branch and worktree; a release is still `null`", () => {
  const record = claimRecordOf([claimNothing(300)]);
  assert.notEqual(record, null);
  assert.deepEqual([record?.branch, record?.worktree, record?.nothing, record?.at, record?.author], [null, null, true, ago(300), "a11ign-ai-workers"]);
  assert.equal(claimRecordOf([claimNothing(300), released(10)]), null, "CONTROL: the release spelling is not a claim, so the two spellings stay distinct");
  assert.equal(claimRecordOf([claim(300)])?.nothing, false, "CONTROL: a claim that names a branch is not a nothing-claim");
});

test("#3407 (1) `claimRow` with no branch and no worktree POSTS the nothing-claim, and a claim naming a branch posts the one it always did", () => {
  const post = (opts: { branch?: string; worktree?: string }) => {
    const bodies: string[] = [];
    let reads = 0;
    const run = (_cmd: string, args: string[]): string => {
      if (args[1] === "comment") bodies.push(args[args.indexOf("--body") + 1]);
      if (args[1] === "view" && args.includes("number,title,labels,state")) {
        reads += 1;
        const labels = reads === 1 ? ["ready"] : ["session:worker-3407", "in-progress", "started", "was-ready"];
        return JSON.stringify({ number: 3407, title: "A row", state: "OPEN", labels: labels.map((name) => ({ name })) });
      }
      if (args[1] === "view") throw new Error("simulated: no body and no blockedBy");
      return "[]";
    };
    const got = claimRow(3407, "worker-3407", { run, moveStatus: () => ({ moved: true }), instance: { spare: false, rows: [] }, ...opts });
    assert.equal(got.claimed, true);
    return bodies.filter((b) => b.includes(CLAIM_RECORD_MARKER));
  };
  const [none] = post({});
  assert.match(none, /claimed by `worker-3407`/);
  assert.match(none, /^Claimed-nothing: .+$/m);
  assert.equal(claimRecordOf([{ body: none, createdAt: iso(ago(5)) }])?.nothing, true, "what the writer posts, the reader reads as a nothing-claim");
  const [named] = post({ branch: BRANCH, worktree: WORKTREE });
  assert.doesNotMatch(named, /Claimed-nothing/);
  assert.match(named, new RegExp(`^Claimed-branch: ${BRANCH}$`, "m"));
});

test("#3407 (2) a row whose only record is a RELEASE followed by a nothing-claim is EVALUATED, not skipped -- and the release alone still is", () => {
  const evaluated = tickWith({ commit: null }, [claim(N_MIN * 5), released(N_MIN * 4), claimNothing(N_MIN + 30)]);
  assert.equal(evaluated.log.join("").includes("not evaluated"), false, "nothing is skipped: the nothing-claim is the newest record and is a claim");
  assert.equal(evaluated.orders.length, 1, "and the clock reads it: past the interval, with no move, it is nudged");
  const skipped = tickWith({ commit: null }, [claim(N_MIN * 5), released(N_MIN * 4)]);
  assert.match(skipped.log.join(""), /no claim record names when or where.*not evaluated/, "CONTROL: the release alone is the skip it was");
  assert.deepEqual(tickWith({ commit: null }, [claimNothing(N_MIN - 1)]).orders, [], "CONTROL: inside the interval the same claim is moving, and nothing is sent");
  assert.deepEqual(tickWith({ commit: null }, [claimNothing(N_MIN + 30), said(N_MIN - 1)]).orders, [], "CONTROL: a comment by the claimant is a move for it too");
});

test("#3407 (3) an evaluated nothing-claim past the interval gets the NUDGE and is NEVER released, however long it stays quiet", () => {
  const memory: Record<string, unknown> = {};
  const comments = [claimNothing(N_MIN * 3)];
  const first = tickWith({ commit: null }, comments, { memory });
  assert.equal(first.orders.length, 1);
  assert.equal(first.orders[0].cause, "claim-stalled");
  assert.equal(first.orders[0].release, undefined, "the first reading is the nudge");
  const nudgedAt = (memory["2407"] as { nudgedAt: number }).nudgedAt;
  const delivered = nudgeDelivered(nudgedAt, NOW + 5 * MIN);
  // The very shapes that RELEASE a branch claim: N after the nudge was delivered, and 2N after one that never was.
  for (const [minutes, ledger] of [[5 + N_MIN, delivered], [N_MIN * 10, delivered], [N_MIN * 10, ""]] as [number, string][]) {
    const later = tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + minutes * MIN, ledger });
    assert.deepEqual(later.orders.filter((o) => o.release), [], `no release at +${minutes} minutes (ledger ${ledger === "" ? "empty" : "delivered"})`);
    assert.deepEqual(Object.keys(later.memory), ["2407"], "and the nudge stays remembered, so it is not sent a second time as a fresh first reading");
  }
  // POSITIVE CONTROL: the SAME fixture claiming a branch is released at the first of those times.
  const branchMemory: Record<string, unknown> = {};
  tickWith({ commit: null }, [claim(N_MIN * 3)], { memory: branchMemory });
  const branchNudgedAt = (branchMemory["2407"] as { nudgedAt: number }).nudgedAt;
  const branchRelease = tickWith({ commit: null }, [claim(N_MIN * 3)], { memory: { ...branchMemory }, now: NOW + (5 + N_MIN) * MIN,
    ledger: nudgeDelivered(branchNudgedAt, NOW + 5 * MIN) });
  assert.equal(branchRelease.orders[0]?.release?.why, "stalled", "CONTROL: a claim naming a branch releases on exactly this clock");
});

test("#3407 (3) the OTHER releases do not reach a nothing-claim either: a blockedBy edge, and a holder gone from herdr's listing", () => {
  const blocked = tickWith({ commit: null }, [claimNothing(10)], { blockedBy: [99] });
  assert.deepEqual(blocked.orders, [], "(8) holds nothing built is NOT said of a claim whose work is not a commit");
  assert.equal(tickWith({ commit: null }, [claim(10)], { blockedBy: [99] }).orders[0]?.release?.why, "blocked", "CONTROL: a branch claim is released on the same edge");
  const memory: Record<string, unknown> = { "2407": { session: "worker-7", goneSince: NOW - GONE_CONFIRM_MS - MIN } };
  const gone = tickWith({ commit: null }, [claimNothing(10)], { memory: { ...memory }, agents: GONE_LISTING });
  assert.deepEqual(gone.orders.filter((o) => o.release), [], "a gone holder's nothing-claim is not released by the gone clock");
  assert.equal(tickWith({ commit: null }, [claim(10)], { memory: { ...memory }, agents: GONE_LISTING }).orders[0]?.release?.why, "gone",
    "CONTROL: the same listing releases a branch claim");
});

test("#2470 a second reading with nothing moved RELEASES -- N after the nudge was DELIVERED; with something moved it does NOT", () => {
  const memory: Record<string, unknown> = {};
  const comments = [claim(N_MIN * 3)];
  const first = tickWith({ commit: null }, comments, { memory });
  assert.equal(first.orders.length, 1, "first reading: the nudge");
  assert.deepEqual(Object.keys(memory), ["2407"], "and it is WRITTEN DOWN, or a released row would carry no memory of it");
  const nudgedAt = (memory["2407"] as { nudgedAt: number }).nudgedAt;

  // UNDELIVERED (a holder that is `working`): the SAME nudge is offered on every tick, however long -- and nothing is released.
  for (const minutes of [5, 30, 90]) {
    const offered = tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + minutes * MIN });
    assert.deepEqual(offered.orders.map((o) => o.causeKey), [first.orders[0].causeKey], `still offered ${minutes} minutes on, byte-identical so it is one delivery`);
  }

  // DELIVERED at +5 minutes: never offered again (the ledger holds a delivered key for one window only, so a longer offer would send it twice)...
  const delivered = nudgeDelivered(nudgedAt, NOW + 5 * MIN);
  assert.deepEqual(tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + 6 * MIN, ledger: delivered }).orders, [], "delivered: silence");
  // ...and the grace runs from the DELIVERY: one minute short of N after it there is no release, and N after it there is.
  const justShort = tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + 5 * MIN + STALL_INTERVAL_MS - MIN, ledger: delivered });
  assert.deepEqual(justShort.orders, [], "N after the NUDGE is not N after it was TOLD");
  const later = NOW + 5 * MIN + STALL_INTERVAL_MS;
  const second = tickWith({ commit: null }, comments, { memory: { ...memory }, now: later, ledger: delivered });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].release!.why, "stalled");
  assert.equal(second.orders[0].release!.row, 2407);
  assert.equal(second.orders[0].release!.session, "worker-7");

  // THE CONTROL, one thing changed: a commit AFTER the nudge and the same second reading releases nothing.
  const moved = tickWith({ commit: 60 }, comments, { memory: { ...memory }, now: later, ledger: delivered });
  assert.deepEqual(moved.orders.filter((o) => o.release), [], "a move after the nudge is not 'nothing moved'");
  assert.deepEqual(Object.keys(moved.memory), [], "and the row's nudge is FORGOTTEN, so a second stall is a first reading and not last week's release");
});

test("#2470 a nudge that NEVER reached its holder (busy, out of allowance, gone) releases at 2N from the nudge, and never at N", () => {
  const memory = { "2407": { session: "worker-7", nudgedAt: NOW } };
  const comments = [claim(N_MIN * 5)];
  const atN = tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + STALL_INTERVAL_MS + MIN });
  assert.equal(atN.orders.filter((o) => o.release).length, 0, "N after an UNDELIVERED nudge: the holder has not been told, so it is not released");
  assert.equal(atN.orders.length, 1, "and the nudge is still being offered");
  const atTwoN = tickWith({ commit: null }, comments, { memory: { ...memory }, now: NOW + STALL_UNTOLD_RELEASE_MS });
  assert.equal(atTwoN.orders.filter((o) => o.release).length, 1, "2N: a holder that cannot be told for that long is not working on the row either -- the work is kept");
  assert.equal(STALL_UNTOLD_RELEASE_MS, 2 * STALL_INTERVAL_MS);
});

test("#2470 a move just AFTER the nudge, then quiet again for N, is a NEW first reading (a nudge), never a release on the old nudge", () => {
  // The move is old enough that the row is stalled AGAIN, so the cheap "moving" exit does not hide the case: only the reading's own
  // `nudgedAt > lastMoveAt` separates a release from a fresh nudge here.
  const memory = { "2407": { session: "worker-7", nudgedAt: NOW } };
  const later = NOW + STALL_INTERVAL_MS + 5 * MIN;
  const oneMinuteAfterTheNudge = (later - (NOW + MIN)) / MIN;
  const got = tickWith({ commit: oneMinuteAfterTheNudge }, [claim(N_MIN * 4)], { memory: { ...memory }, now: later, ledger: nudgeDelivered(NOW, NOW + MIN) });
  assert.deepEqual(got.orders.filter((o) => o.release), [], "something moved after the nudge: the old nudge is not a first half of anything");
  assert.equal(got.orders.length, 1, "and the row IS stalled again, so it is nudged afresh");
  assert.match(got.orders[0].causeKey, new RegExp(`nudge-${later}$`), "with a NEW key, one per stall episode");
  const control = tickWith({ commit: null }, [claim(N_MIN * 4)], { memory: { ...memory }, now: later, ledger: nudgeDelivered(NOW, NOW + MIN) });
  assert.equal(control.orders.filter((o) => o.release).length, 1, "CONTROL: with no move after the nudge (and the nudge delivered) it IS the second reading");
});

test("#2470 a comment or a changed file after the nudge also cancels the release, and a nudge from a DIFFERENT holder is not this holder's", () => {
  const memory = { "2407": { session: "worker-7", nudgedAt: NOW } };
  const later = NOW + STALL_INTERVAL_MS + MIN;
  const base = [claim(N_MIN * 3)];
  const ledger = nudgeDelivered(NOW, NOW + MIN);
  assert.equal(tickWith({ commit: null }, base, { memory: { ...memory }, now: later, ledger }).orders.filter((o) => o.release).length, 1, "control");
  assert.equal(tickWith({ commit: null }, [...base, said(90, "a11ign-ai-workers", "still on it", later)], { memory: { ...memory }, now: later, ledger }).orders.length, 0, "a comment");
  assert.equal(tickWith({ dirty: [{ file: "a.mjs", ago: 90 }] }, base, { memory: { ...memory }, now: later, ledger }).orders.length, 0, "a file");
  const other = { "2407": { session: "worker-9", nudgedAt: NOW } };
  const fresh = tickWith({ commit: null }, base, { memory: { ...other }, now: later, ledger });
  assert.equal(fresh.orders.filter((o) => o.release).length, 0, "another session's nudge on the row is not this one's second reading");
  assert.equal(fresh.orders.length, 1, "it is a FIRST reading: a nudge");
});

test("#2470 a stall release that was not PERFORMED is emitted again as a release, never as a fresh first reading", () => {
  const memory: Record<string, unknown> = { "2407": { session: "worker-7", nudgedAt: ago(130) } };
  const comments = [claim(N_MIN * 3)];
  const ledger = nudgeDelivered(ago(130), ago(125));
  const first = tickWith({ commit: null }, comments, { memory, ledger });
  assert.equal(first.orders[0].release!.why, "stalled");
  assert.deepEqual(Object.keys(memory), ["2407"], "the nudge memory SURVIVES the release order: wake may fail to perform it");
  const second = tickWith({ commit: null }, comments, { memory, now: NOW + 2 * MIN, ledger });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].release!.why, "stalled", "the retry is a release again, not a nudge and another two hours");
  // ...and once the release is PERFORMED the row is unclaimed, so it is no longer read and the memory goes.
  const gone = tickWith({ commit: null }, comments, { memory, now: NOW + 4 * MIN, rows: [], ledger });
  assert.deepEqual([gone.orders, Object.keys(memory)], [[], []]);
});

test("#2470 the nudge memory is dropped for a row that is no longer claimed, released or moving -- and only a NUDGE writes it", () => {
  const facts = (n: number) => ({ row: n, session: "worker-7" }) as unknown as Facts;
  const before = { "1": { session: "worker-7", nudgedAt: 5 }, "2": { session: "worker-7", nudgedAt: 6 } };
  const after = nextStallState(before, [
    { facts: facts(1), reading: { kind: "moving", lastMoveAt: 1 } },
    { facts: facts(2), reading: { kind: "nudged", nudgedAt: 6, deliveredAt: null, lastMoveAt: 1 } },
    { facts: facts(3), reading: { kind: "nudge", lastMoveAt: 1, idleMs: 1 } },
  ], 99);
  assert.deepEqual(after, { "2": { session: "worker-7", nudgedAt: 6 }, "3": { session: "worker-7", nudgedAt: 99 } });
  assert.equal(nextStallState({}, [{ facts: facts(1), reading: { kind: "moving", lastMoveAt: 1 } }], 9).constructor, Object);
});

// --- Done-when 11(f): the clock never starts before the restart --------------------------------------------------------------------

test("#2470 (11f) the no-progress clock starts no earlier than the restart: a session the outage silenced is not nudged, and not released", () => {
  const old = [claim(N_MIN * 4)];
  assert.equal(tickWith({ commit: null }, old).orders.length, 1, "control: with no restart in view the row IS nudged");
  const restarted = tickWith({ commit: null }, old, { restartAt: ago(10) });
  assert.deepEqual(restarted.orders, [], "10 minutes after the restart there is nothing to nudge: the gate itself caused the silence");
  // A nudge already sent BEFORE the restart is not a first half of anything: the restart is a move after it.
  const memory = { "2407": { session: "worker-7", nudgedAt: ago(N_MIN * 2) } };
  const afterRestart = tickWith({ commit: null }, old, { memory: { ...memory }, restartAt: ago(30) });
  assert.deepEqual(afterRestart.orders.filter((o) => o.release), [], "released 0 times inside the first N minutes after the restart");
  const wellAfter = tickWith({ commit: null }, old, { memory: { ...memory }, restartAt: ago(N_MIN + 5) });
  assert.equal(wellAfter.orders.length, 1, "and N minutes after the restart with nothing moved it is a first reading again (a nudge), never a release on the old nudge");
  assert.equal(wellAfter.orders.some((o) => o.release), false);
});

// --- Done-when 8: a BLOCKED claim with no unpushed work is released; one with unpushed work is not ---------------------------------

test("#2470 (8) a claim whose row has an OPEN blockedBy edge and whose holder holds nothing is released at once, naming the edge", () => {
  const blocked = tickWith({ commit: null, refExists: false, worktreeExists: false }, [claim(20)], { blockedBy: [2258] });
  assert.equal(blocked.orders.length, 1);
  assert.equal(blocked.orders[0].release!.why, "blocked");
  assert.deepEqual(blocked.orders[0].release!.edges, [2258]);
  assert.match(blocked.orders[0].prompt, /blocked by #2258/);
});

test("#2470 (8) POSITIVE CONTROLS: the same row with UNPUSHED work, with a DIRTY tree, or with an unreadable one is NOT released", () => {
  const args = { blockedBy: [2258] };
  assert.equal(tickWith({ unpushed: 2 }, [claim(20)], args).orders.length, 0, "unpushed commits");
  assert.equal(tickWith({ dirty: [{ file: "a.mjs", ago: 3000 }] }, [claim(20)], args).orders.length, 0, "a dirty file");
  assert.equal(tickWith({ broken: 128 }, [claim(20)], args).orders.length, 0, "git that will not answer");
  assert.equal(tickWith({}, [claim(20)], args).orders.length, 1, "control: a clean, pushed tree IS released");
});

test("#2470 (8) a row whose edge has CLEARED is not a candidate, and a holder BUSY elsewhere is still released from THIS row", () => {
  const closed = row(2407, ["in-progress", "session:worker-7"], { blockedBy: { nodes: [{ number: 2258, state: "CLOSED" }] } });
  assert.deepEqual(tickWith({}, [claim(20)], { rows: [closed] }).orders, [], "a closed edge is no edge, and the row is 20 minutes old");
  const busy = tickWith({}, [claim(20)], { blockedBy: [2258], rows: [row(2407), row(2600, ["in-progress", "session:worker-7"])] });
  assert.equal(busy.orders.filter((o) => o.release?.row === 2407).length, 1, "the signal is the row, as everywhere in this row");
});

// --- Done-when 10: a merged pull request ends its instance and asks product-manager ---------------------------------------------------

test("#2470 (10) a MERGED `Closes: none` pull request on the claimed branch releases the claim and asks product-manager", () => {
  const merged = [{ number: 2497, headRefName: BRANCH, mergedAt: iso(ago(30)) }];
  const { orders } = tickWith({ commit: 40, push: 40 }, [claim(600)], { merged });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].release!.why, "merged");
  assert.equal(orders[0].release!.answer, "product-manager", "the gate sets the answer at the merge, not by hand");
  assert.equal(orders[0].release!.mergedPr, 2497);
});

test("#2470 (10) POSITIVE CONTROLS: a second open PR, unpushed work, a PR merged BEFORE the claim, or a different branch's do not release", () => {
  const merged = [{ number: 2497, headRefName: BRANCH, mergedAt: iso(ago(30)) }];
  assert.equal(tickWith({}, [claim(600)], { merged, prs: [{ number: 9, headRefName: `${BRANCH}b-2407` }] }).orders.length, 0, "a second open PR for the row");
  assert.equal(tickWith({ unpushed: 1 }, [claim(600)], { merged }).orders.filter((o) => o.release).length, 0, "unpushed work");
  assert.equal(tickWith({}, [claim(600)], { merged: [{ ...merged[0], mergedAt: iso(ago(700)) }] }).orders.filter((o) => o.release).length, 0, "merged before this claim");
  assert.equal(tickWith({}, [claim(600)], { merged: [{ ...merged[0], headRefName: "agent/other-1" }] }).orders.filter((o) => o.release).length, 0, "another branch's PR");
  assert.equal(tickWith({}, [claim(600)], { merged }).orders.filter((o) => o.release).length, 1, "control: the same fixture, clean, IS released");
});

// --- Done-when 1 & 3 (#2747): the session's EXISTENCE, read from herdr's own listing, as a fact the gate needs ---------------------------

const CEO_ORCH = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }];
/** A COMPLETE listing (both standing panes) that does NOT carry `worker-7`: the #2747 fixture -- a closed workspace. */
const GONE_LISTING = [...CEO_ORCH];
/** The same listing, `worker-7` present: the ordinary case, unaffected. */
const PRESENT_LISTING = [...CEO_ORCH, { label: "worker-7", status: "working" }];
/** A PARTIAL listing (missing `orchestrator`): proves nothing about who else it left out (#2465). */
const PARTIAL_LISTING = [{ label: "ceo", status: "idle" }];

test("#2747 a session PRESENT in the listing is read exactly as if herdr were never asked: the same nudge, at the same clock", () => {
  const asked = tickWith({ commit: null }, [claim(N_MIN + 10)], { agents: PRESENT_LISTING });
  const unasked = tickWith({ commit: null }, [claim(N_MIN + 10)], { agents: null });
  assert.equal(asked.orders.length, 1);
  assert.deepEqual(asked.orders[0].prompt, unasked.orders[0].prompt, "presence changes nothing about the ordinary reading");
  assert.deepEqual(asked.memory, unasked.memory, "the memory this tick writes (the nudge, not a goneSince) is identical either way");
});

test("#2747 a session ABSENT from a COMPLETE listing, first tick: no order yet, but the tick IS a claimed row -- and remembers when it first saw this", () => {
  const first = tickWith({}, [claim(20)], { agents: GONE_LISTING });
  assert.deepEqual(first.orders, [], "not yet -- GONE_CONFIRM_MS has not elapsed since NOW, the first tick that noticed");
  assert.deepEqual(first.memory[2407], { session: "worker-7", goneSince: NOW }, "the FIRST tick's own clock is what gets carried forward");
});

test("#2747 still absent on a LATER tick, inside the confirm window: no order, and the ORIGINAL goneSince is kept, not bumped to now", () => {
  const memory = { 2407: { session: "worker-7", goneSince: ago(9) } };
  const still = tickWith({}, [claim(20)], { agents: GONE_LISTING, memory, now: NOW });
  assert.deepEqual(still.orders, [], "9 minutes of 10 (GONE_CONFIRM_MS)");
  assert.deepEqual(still.memory[2407], { session: "worker-7", goneSince: ago(9) }, "unchanged: this is not a fresh sighting");
});

test(`#2747 the GONE_CONFIRM_MS boundary: just under is still waiting, at or over releases (GONE_CONFIRM_MS = ${GONE_CONFIRM_MS}ms)`, () => {
  const justUnder = tickWith({}, [claim(20)], { agents: GONE_LISTING, memory: { 2407: { session: "worker-7", goneSince: NOW - GONE_CONFIRM_MS + 1 } } });
  assert.deepEqual(justUnder.orders, [], "one millisecond short");
  const atBoundary = tickWith({}, [claim(20)], { agents: GONE_LISTING, memory: { 2407: { session: "worker-7", goneSince: NOW - GONE_CONFIRM_MS } } });
  assert.equal(atBoundary.orders.length, 1);
  assert.equal(atBoundary.orders[0].release!.why, "gone");
  assert.equal(atBoundary.orders[0].release!.idleMinutes, null, "gone is not a measure of idleness: there is no one to idle");
  assert.match(atBoundary.orders[0].prompt, /RELEASE the claim on #2407 held by worker-7: worker-7 no longer exists in herdr's own listing/);
});

test("#2747 a PARTIAL listing neither STARTS the confirm clock nor RESETS it, and never confirms a release no matter how stale the memory is", () => {
  const noMemoryYet = tickWith({}, [claim(20)], { agents: PARTIAL_LISTING });
  assert.deepEqual(noMemoryYet.orders, [], "a plain moving row, same as an unasked herdr");
  assert.equal(noMemoryYet.memory[2407], undefined, "a partial listing writes nothing -- there is nothing to hold onto yet");
  const staleMemory = { 2407: { session: "worker-7", goneSince: ago(999) } };
  const stillPartial = tickWith({}, [claim(20)], { agents: PARTIAL_LISTING, memory: staleMemory });
  assert.deepEqual(stillPartial.orders, [], "999 minutes past GONE_CONFIRM_MS, and STILL not released: a partial listing cannot confirm anything");
  assert.deepEqual(stillPartial.memory[2407], { session: "worker-7", goneSince: ago(999) }, "carried forward untouched, not reset to now either");
});

test("#2747 the session REAPPEARING clears the memory: a complete listing that shows it again is definitive, whatever the stale goneSince said", () => {
  const memory = { 2407: { session: "worker-7", goneSince: ago(5) } };
  const back = tickWith({ commit: null }, [claim(20)], { agents: PRESENT_LISTING, memory });
  assert.deepEqual(back.orders, [], "an ordinary moving row again");
  assert.equal(back.memory[2407], undefined, "the goneSince memory is dropped: a stall (or a fresh disappearance) is a first reading again");
});

// --- (#2863) a holder LISTED but holding no agent reads as absent ---------------------------------------------------------------------

/** A COMPLETE listing in which `worker-7`'s workspace survives its agent: herdr's `unknown` is "no agent detected". */
const AGENTLESS_LISTING = [...CEO_ORCH, { label: "worker-7", status: "unknown" }];

test("#2863 a holder listed with status `unknown` reads as absent: vacating on the first tick, released as gone after GONE_CONFIRM_MS", () => {
  const first = tickWith({}, [claim(300)], { agents: AGENTLESS_LISTING });
  assert.deepEqual(first.orders, [], "not yet -- the clock starts now");
  assert.deepEqual(first.memory[2407], { session: "worker-7", goneSince: NOW }, "the same memory a closed workspace writes");
  const memory = { 2407: { session: "worker-7", goneSince: NOW - GONE_CONFIRM_MS } };
  const matured = tickWith({}, [claim(300)], { agents: AGENTLESS_LISTING, memory });
  assert.equal(matured.orders.length, 1);
  assert.equal(matured.orders[0].release!.why, "gone");
});

test("#2863 POSITIVE CONTROL: the same fixture with the holder idle/working/done stays a nudge, never gone", () => {
  for (const status of ["idle", "working", "done"]) {
    const memory = { 2407: { session: "worker-7", goneSince: NOW - GONE_CONFIRM_MS } };
    const live = tickWith({ commit: null }, [claim(N_MIN + 10)], { agents: [...CEO_ORCH, { label: "worker-7", status }], memory });
    assert.equal(live.orders.length, 1, status);
    assert.equal(live.orders[0].release, undefined, `${status}: a live session is nudged, not released`);
    assert.equal((live.memory[2407] as { goneSince?: number } | undefined)?.goneSince, undefined, `${status}: reappearing with an agent drops the clock`);
  }
});

test("#2863 a holder that goes `unknown` and then returns to a live status resets the clock", () => {
  const memory = { 2407: { session: "worker-7", goneSince: ago(9) } };
  const back = tickWith({}, [claim(20)], { agents: [...CEO_ORCH, { label: "worker-7", status: "working" }], memory });
  assert.deepEqual(back.orders, []);
  assert.equal(back.memory[2407], undefined, "the goneSince is dropped");
  const again = tickWith({}, [claim(20)], { agents: AGENTLESS_LISTING, memory: back.memory });
  assert.deepEqual(again.memory[2407], { session: "worker-7", goneSince: NOW }, "a fresh first sighting, not the old clock");
});

test("#2863 a PARTIAL listing with the holder agentless still proves nothing: listingIsComplete is asked first", () => {
  const partial = [{ label: "ceo", status: "idle" }, { label: "worker-7", status: "unknown" }];
  const none = tickWith({}, [claim(20)], { agents: partial });
  assert.deepEqual(none.orders, []);
  assert.equal(none.memory[2407], undefined, "nothing started");
  const stale = tickWith({}, [claim(20)], { agents: partial, memory: { 2407: { session: "worker-7", goneSince: ago(999) } } });
  assert.deepEqual(stale.orders, [], "and nothing confirmed either");
});

// --- (#3048) a GONE holder with an OPEN pull request: released, and HELD for `product-manager`, never returned to the pool --------------------

const OPEN_PR = { number: 9, headRefName: BRANCH };
const goneFor = (minutes: number) => ({ 2407: { session: "worker-7", goneSince: ago(minutes) } });
/** `claimReading`'s facts for a row with ONE open pull request of its own and nothing else going on. */
const withOpenPr = (): Facts => ({ row: 2407, session: "worker-7", claimedAt: ago(1000), branch: BRANCH, worktree: WT, comment: null, commit: null,
  push: null, file: () => null, work: () => ({ state: "none", dirty: 0, unpushed: 0 }), openPrs: 1, ownPrs: [OPEN_PR], mergedPr: null, waiting: null,
  blockedBy: [] } as Facts);
const readWith = (agents: Agent[], goneSince: number | null) => claimReading(withOpenPr(),
  { now: NOW, restartAt: null, nudge: null, agents, goneSince });

test("#3048 a holder GONE from a COMPLETE listing for GONE_CONFIRM_MS, with an open PR and no merge, is a `gone` release that NAMES the PR", () => {
  const reading = readWith(GONE_LISTING, NOW - GONE_CONFIRM_MS);
  assert.deepEqual(reading, { kind: "release", why: "gone", lastMoveAt: null, idleMs: null, nudgedAt: null, since: NOW - GONE_CONFIRM_MS, openPrs: [9] });
});

test("#3048 POSITIVE CONTROLS: a PRESENT holder (any live status) is still `pr-owned`; an INCOMPLETE listing and a short absence do not release", () => {
  for (const status of ["idle", "working", "done", "blocked"]) {
    const present = [...CEO_ORCH, { label: "worker-7", status }];
    // `idle` is the #2999 overlay's own business (an `idle-watch`), which is why this asks "not gone" rather than "exactly `pr-owned`".
    assert.ok(!["release", "vacating"].includes(readWith(present, NOW - GONE_CONFIRM_MS).kind), `${status}: presence is positive evidence, whatever goneSince says`);
  }
  assert.equal(readWith([...CEO_ORCH, { label: "worker-7", status: "working" }], NOW - GONE_CONFIRM_MS).kind, "pr-owned");
  assert.equal(readWith(PARTIAL_LISTING, null).kind, "pr-owned", "partial listing, nothing remembered: nothing learned");
  assert.notEqual(readWith(PARTIAL_LISTING, NOW - 999 * MIN).kind, "release", "partial listing, however stale the memory: never confirms");
  assert.deepEqual(readWith(GONE_LISTING, NOW - GONE_CONFIRM_MS + 1), { kind: "vacating", since: NOW - GONE_CONFIRM_MS + 1 }, "one millisecond short");
  assert.deepEqual(readWith(GONE_LISTING, null), { kind: "vacating", since: NOW }, "first sighting starts the clock");
  assert.equal(readWith(null as unknown as Agent[], NOW - GONE_CONFIRM_MS).kind, "pr-owned", "herdr could not be asked: silence is never gone");
});

test("#3048 a gone holder with NO open PR releases exactly as #2747 pinned: no `openPrs` on the reading, no answer on the order", () => {
  const none = { ...withOpenPr(), openPrs: 0, ownPrs: [] } as Facts;
  const reading = claimReading(none, { now: NOW, restartAt: null, nudge: null, agents: GONE_LISTING, goneSince: NOW - GONE_CONFIRM_MS });
  assert.deepEqual(reading, { kind: "release", why: "gone", lastMoveAt: null, idleMs: null, nudgedAt: null, since: NOW - GONE_CONFIRM_MS });
  const [order] = claimStalledOrders([{ facts: none, reading }], NOW);
  assert.equal(order.release!.answer, undefined, "it goes back to the pool by the ordinary decline");
  assert.equal("openPrs" in order.release!, false);
});

test("#3048 the tick: the order carries the PR and the ANSWER, and the claim is remembered as gone until it lands", () => {
  const memory = () => goneFor(GONE_CONFIRM_MS / MIN); // `tickWith` rewrites the memory it is given, so each call gets its own
  const tick = tickWith({}, [claim(600)], { agents: GONE_LISTING, memory: memory(), prs: [OPEN_PR] });
  assert.equal(tick.orders.length, 1, "released, not `pr-owned`");
  assert.deepEqual([tick.orders[0].release!.why, tick.orders[0].release!.answer, tick.orders[0].release!.openPrs], ["gone", "product-manager", [9]]);
  assert.match(tick.orders[0].prompt, /RELEASE the claim on #2407 held by worker-7: worker-7 no longer exists in herdr's own listing, and #9 is still open/);
  assert.deepEqual(tick.memory[2407], { session: "worker-7", goneSince: ago(GONE_CONFIRM_MS / MIN) }, "the clock is carried, as for any gone claim");
  const present = tickWith({}, [claim(600)], { agents: PRESENT_LISTING, memory: memory(), prs: [OPEN_PR] });
  assert.deepEqual(present.orders, [], "CONTROL: the same fixture with the holder listed is `pr-owned`, and says nothing");
  const noPr = tickWith({}, [claim(600)], { agents: GONE_LISTING, memory: memory() });
  assert.equal(noPr.orders[0].release!.answer, undefined, "CONTROL: the same fixture with no PR is the pool release");
});

// --- the reading, directly ---------------------------------------------------------------------------------------------------------

test("#2470 claimReading is pure in its inputs: an UNDELIVERED `nudged` row keeps offering its key, a delivered one goes quiet", () => {
  const facts = { row: 1, session: "s", claimedAt: ago(1000), branch: BRANCH, worktree: WT, comment: null, commit: null, push: null,
    file: () => null, work: () => ({ state: "none", dirty: 0, unpushed: 0 }), openPrs: 0, mergedPr: null, waiting: null, blockedBy: [] } as Facts;
  const undelivered = readClaim(facts, { now: NOW, restartAt: null, nudge: { nudgedAt: NOW - MIN, deliveredAt: null } });
  assert.equal(undelivered.kind, "nudged");
  assert.equal(claimStalledOrders([{ facts, reading: undelivered }], NOW).length, 1);
  assert.equal(claimStalledOrders([{ facts, reading: undelivered }], NOW + 90 * MIN).length, 1, "however long it has been offered");
  const delivered = readClaim(facts, { now: NOW, restartAt: null, nudge: { nudgedAt: NOW - MIN, deliveredAt: NOW - MIN } });
  assert.equal(delivered.kind, "nudged");
  assert.equal(claimStalledOrders([{ facts, reading: delivered }], NOW).length, 0, "delivered: it is not sent a second time");
  assert.equal(claimReading({ ...facts, openPrs: 1 }, { now: NOW, restartAt: null, nudge: null }).kind, "pr-owned");
  assert.equal(claimStalledOrders(undefined, NOW).length, 0, "omitted readings mean none");
});

test("#2470 decide() carries the orders, keeps them through a drain, and an OMITTED `claimStalls` changes nothing", () => {
  const { orders } = tickWith({ commit: null }, [claim(N_MIN + 200)]);
  const base = decide({ prs: [], readyRows: [] });
  const withStall = decide({ prs: [], readyRows: [], claimStalls: orders as unknown as Stalls });
  assert.equal(withStall.length, base.length + 1);
  assert.ok(withStall.some((o: { cause: string }) => o.cause === "claim-stalled"));
  const drained = decide({ prs: [], readyRows: [], claimStalls: orders as unknown as Stalls, drain: true });
  assert.ok(drained.some((o: { cause: string }) => o.cause === "claim-stalled"), "a drain does not withhold work in flight");
});

// --- git-level facts ------------------------------------------------------------------------------------------------------------------

test("#2470 workAtRisk: dirty and unpushed are each enough, `none` needs both zero, and unreadable is its own answer", () => {
  const at = (w: World) => workAtRisk(host(w).io, { worktree: WT, branch: BRANCH, repo: REPO });
  assert.equal(at({}).state, "none");
  assert.equal(at({ unpushed: 1 }).state, "at-risk");
  assert.equal(at({ dirty: [{ file: "a", ago: 1 }] }).state, "at-risk");
  assert.equal(at({ broken: 1 }).state, "unknown", "a git that fails is not a clean tree");
  const noTree = workAtRisk(host({ worktreeExists: false, refExists: false }).io, { worktree: WT, branch: BRANCH, repo: REPO });
  assert.equal(noTree.state, "none", "no worktree and no branch on this host: nothing to lose");
  const ghost = workAtRisk(host({ worktreeExists: false, unpushed: 3 }).io, { worktree: WT, branch: BRANCH, repo: REPO });
  assert.deepEqual([ghost.state, ghost.unpushed], ["at-risk", 3], "no worktree but a local branch holding unpushed commits");
});

test("#2470 fileMove reads the newest changed file's mtime, skips a deleted one, and never lists an unbounded tree", () => {
  const h = host({ dirty: [{ file: "a.mjs", ago: 50 }, { file: "b.mjs", ago: 20 }] });
  assert.equal(fileMove(h.io, WT), ago(20));
  assert.equal(fileMove(host({}).io, WT), null, "a clean tree has no changed file");
  const deleted = { git: () => ({ status: 0, out: " D gone.mjs\0R  new.mjs\0old.mjs\0" }), exists: () => true, mtime: () => null };
  assert.equal(fileMove(deleted, WT), null, "a deleted file has no mtime, and a rename's old name is not read as a path");
});

test("#2470 claimFactsFrom reports a row it cannot evaluate rather than throwing, and resolves the recorded worktree against the repo", () => {
  const h = host({ commit: null });
  const input = { row: 2407, session: "worker-7", waiting: null, blockedBy: [], comments: [claim(50)], openPrs: [], mergedPrs: null, repo: REPO };
  const facts = claimFactsFrom(input, h.io) as { worktree: string };
  assert.equal(facts.worktree, WT, "`../wt-2407` resolved against the checkout the gate runs from");
  assert.ok("skip" in claimFactsFrom({ ...input, comments: [] }, h.io));
});

// --- Done-when 7: a release KEEPS the work, and the next instance starts in it -----------------------------------------------------
//
// THE THREE POSITIVE CONTROLS the row names, each beside the CONTROL that shows its fixture would have caught the defect: the same
// release WITHOUT `keepWorktree` removes the clean tree and refuses over the dirty one, which is exactly what the row measured.

/** A board fake for `declineRow`: the row's labels, and a recording `run`. */
/**
 * #2746: REACTIVE, not a fixed response -- `writeDeclineLabels` re-reads the row after its edit to verify
 * the write landed, so a `view` fake that always answers the PRE-decline labels would fail that verify on
 * every one of these releases, which is a real write followed by a real re-read on the live board.
 */
function releaseBoard(labels: string[] = ["in-progress", "session:worker-7", "started", "was-ready"]) {
  const calls: string[][] = [];
  const board = { labels: [...labels] };
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "edit") {
      const changed = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
      board.labels = [...board.labels.filter((l) => !changed("--remove-label").includes(l)), ...changed("--add-label")];
      return "";
    }
    return args[1] === "view" ? JSON.stringify({ number: 2416, title: "A row", state: "OPEN", labels: board.labels.map((name) => ({ name })) }) : "";
  };
  const edits = () => calls.filter((a) => a[1] === "edit").map((a) => ({
    removed: a.flatMap((x, i) => (x === "--remove-label" ? [a[i + 1]] : [])), added: a.flatMap((x, i) => (x === "--add-label" ? [a[i + 1]] : [])) }));
  return { run, calls, edits, board };
}
const RECORD = [claimRecordComment({ session: "worker-7", branch: BRANCH, worktree: WT })];
const NO_STATUS = () => ({ moved: true }) as const;
// #2748: `declineRow`'s default `recordGone` writes a real file; every decline test but this row's own
// stays on the no-token contract above by injecting this no-op instead.
const NOOP_RECORD_GONE = () => {};

test("#2470 (7a) a CLEAN tree with UNPUSHED commits keeps them across the release: `--keep-worktree` removes nothing", () => {
  const board = releaseBoard();
  const removed: string[] = [];
  const kept = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, removeWorktree: ((p: string) => { removed.push(p); return { removed: true }; }) as never,
    recordGone: NOOP_RECORD_GONE });
  assert.equal(kept.declined, true);
  assert.deepEqual(removed, [], "the recorded worktree is not removed, so the commits that live only there survive");
  assert.equal(board.calls.some((a) => a.includes("worktree") && a.includes("remove")), false, "and no `git worktree remove` ran at all");
  assert.deepEqual(board.edits()[0].added, ["ready"], "the row goes back to the pool (it was ready before the claim)");
  assert.ok(board.edits()[0].removed.includes("session:worker-7"), "and the holder's labels come off, which is what makes it a release");
  assert.ok(board.calls.some((a) => a[1] === "comment" && a.join(" ").includes("released by")), "and the release is RECORDED, so `check` stops naming the tree");

  // THE CONTROL: the same release without the flag calls the remover -- which, on a clean tree, deletes it.
  const control: string[] = [];
  declineRow(2416, "worker-7", { run: releaseBoard().run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    removeWorktree: ((p: string) => { control.push(p); return { removed: true }; }) as never });
  assert.deepEqual(control, [WT], "without `keepWorktree` the tree IS removed -- the defect this clause is about");
});

test("#3407 releasing a nothing-claim POSTS the release record, so a later claim that wrote nothing cannot inherit the old one's time", () => {
  const release = (comments: string[]) => {
    const board = releaseBoard();
    const got = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => comments, moveStatus: NO_STATUS as never, recordGone: NOOP_RECORD_GONE });
    assert.equal(got.declined, true);
    return board.calls.filter((a) => a[1] === "comment" && a.join(" ").includes("released by"));
  };
  assert.equal(release([claimRecordComment({ session: "worker-7", nothing: "the claim named no branch and no worktree" })]).length, 1);
  assert.deepEqual(release([]), [], "CONTROL: a row that recorded nothing at all still has no record to supersede, and none is posted");
});

test("#2470 (7a) a DIRTY tree is neither removed nor refused into a stuck claim", () => {
  const dirty = () => ({ removed: false as const, reason: `${WT} has uncommitted change(s) -- refusing to remove it: ?? new-file.mjs`, files: ["?? new-file.mjs"] });
  const stuck = declineRow(2416, "worker-7", { run: releaseBoard().run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    removeWorktree: dirty as never });
  assert.equal(stuck.declined, false, "CONTROL: without the flag a dirty tree refuses the whole decline, so the claim can never be released");
  const board = releaseBoard();
  const freed = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, removeWorktree: dirty as never, recordGone: NOOP_RECORD_GONE });
  assert.equal(freed.declined, true, "with it the release goes through and the labels come off");
  assert.ok(board.edits().length === 1);
});

test("#2470 (7b) the respawn's claim ADOPTS the kept tree: nothing is created, nothing is removed, and it is re-stamped to the new instance", () => {
  const order: string[] = [];
  const stamped: [string, string][] = [];
  const claims: { worktree?: string; branch?: string; adoptedBranch?: string }[] = [];
  const adopt = (over: { owner?: string | null; head?: string; exists?: boolean; claimed?: boolean } = {}) => claimWithWorktree(2416, "worker-2416", {
    branch: BRANCH, worktree: WT, adopt: "worker-7",
    run: ((cmd: string, args: string[]) => { order.push(`${cmd} ${args.join(" ")}`); return args.includes("symbolic-ref") ? `${over.head ?? BRANCH}\n` : ""; }) as never,
    exists: () => over.exists ?? true, owner: () => (over.owner === undefined ? "worker-7" : over.owner),
    stamp: (w: string, sess: string) => { stamped.push([w, sess]); },
    claim: ((_n: number, _s: string, deps: { worktree?: string; branch?: string; adoptedBranch?: string }) => { claims.push(deps); return over.claimed === false ? { claimed: false, reason: "B2 refused" } : { claimed: true, statusMoved: true }; }) as never });
  const won = adopt();
  assert.equal(won.claimed, true);
  assert.deepEqual(stamped, [[WT, "worker-2416"]], "the tree becomes the new instance's");
  assert.deepEqual(claims.map(({ branch, worktree }) => ({ branch, worktree })), [{ branch: BRANCH, worktree: WT }],
    "the claim RECORDS the existing branch and worktree");
  assert.equal(order.some((c) => /fetch|worktree add|worktree remove/.test(c)), false, "it creates nothing and removes nothing");
  assert.deepEqual(claims.map((c) => c.adoptedBranch), [BRANCH], "#2769: the adopted branch reaches the claim, so B4 can tell its own PR");

  // A claim that LOSES leaves the tree exactly where it was, re-stamped to its previous owner: it holds another instance's work.
  order.length = 0; stamped.length = 0;
  const lost = adopt({ claimed: false });
  assert.equal(lost.claimed, false);
  assert.match((lost as { reason: string }).reason, /left in place, with its work, and re-stamped `worker-7`/);
  assert.deepEqual(stamped, [[WT, "worker-2416"], [WT, "worker-7"]]);
  assert.equal(order.some((c) => /worktree remove|branch -D/.test(c)), false, "unlike a tree the claim just made, this one is never torn down on a lost race");
});

test("#2470 (7b) a worktree stamped by a DIFFERENT session -- or by nobody, or on another branch -- is STILL REFUSED (the #1432 guard stays)", () => {
  const reason = (over: { owner?: string | null; exists?: boolean; head?: string | null }) => worktreeTargetReason(
    { branch: BRANCH, worktree: WT, issueNumber: 2416, adopt: "worker-7" },
    { exists: () => over.exists ?? true, owner: () => (over.owner === undefined ? "worker-7" : over.owner),
      run: (() => { if (over.head === null) throw new Error("detached"); return `${over.head ?? BRANCH}\n`; }) as never });
  assert.equal(reason({}), null, "CONTROL: the previous holder's own tree, on its branch, is adopted");
  assert.match(String(reason({ owner: "worker-9" })), /stamped by `worker-9`, not `worker-7`/);
  assert.match(String(reason({ owner: null })), /UNSTAMPED/);
  assert.match(String(reason({ head: "agent/other-1" })), /not --branch=agent\/one-instance-one-row-2407/);
  assert.match(String(reason({ head: null })), /no branch \(detached\)/);
  assert.match(String(reason({ exists: false })), /does not exist -- there is nothing to adopt/);
  // ...and the ordinary claim over a tree it finds is refused exactly as before: `adopt` is the ONLY way in.
  const plain = worktreeTargetReason({ branch: BRANCH, worktree: WT, issueNumber: 2416 },
    { exists: () => true, owner: () => "worker-7", run: (() => "") as never });
  assert.match(String(plain), /ALREADY EXISTS, stamped by `worker-7`/);
});

test("#2470 (7b) `--adopt` is refused without both --branch and --worktree, and is not a way to name one only", () => {
  assert.match(String(worktreeFlagsReason({ adopt: "worker-7" })), /--adopt needs --branch and --worktree/);
  assert.match(String(worktreeFlagsReason({ adopt: "worker-7", branch: BRANCH })), /--adopt needs --branch and --worktree/);
  assert.equal(worktreeFlagsReason({ adopt: "worker-7", branch: BRANCH, worktree: WT }), null);
  assert.equal(worktreeFlagsReason({}), null, "and a claim naming neither is unchanged");
});

// --- #2748: re-claiming a row under the SAME session name -- the ordinary claim command, not `--adopt=`,
// hitting its own predecessor's stamped tree ------------------------------------------------------------

test("#2748 `implicitAdoptSession` -- the ruling: fires ONLY for the claimant's own tree AND a CONFIRMED-gone predecessor", () => {
  const rule = (over: { exists?: boolean; owner?: string | null; gone?: boolean | null } = {}) => implicitAdoptSession({
    worktree: WT, mySession: "worker-2623",
    exists: () => over.exists ?? true,
    owner: () => (over.owner === undefined ? "worker-2623" : over.owner),
    predecessorGone: () => (over.gone === undefined ? true : over.gone),
  });
  assert.equal(rule(), "worker-2623", "CONTROL: the claimant's own stamped tree, predecessor confirmed gone -- implicit adopt fires");
  assert.equal(rule({ exists: false }), undefined, "no tree, nothing to adopt");
  assert.equal(rule({ owner: "worker-9" }), undefined, "a DIFFERENT session's tree is never auto-adopted -- #1432 stays");
  assert.equal(rule({ owner: null }), undefined, "an UNSTAMPED tree is never auto-adopted either");
  assert.equal(rule({ gone: false }), undefined, "predecessor confirmed STILL ALIVE -- refuses (a genuine collision, not a stale stamp)");
  assert.equal(rule({ gone: null }), undefined,
    "Done-when 2: liveness CANNOT be confirmed (herdr read unavailable / #2747 not yet wired in) -- the refusal stays");
});

test("#2748 `predecessorLivenessUnknown` -- the pure stub answers \"cannot tell\", for tests and any caller with no ledger to read", () => {
  assert.equal(predecessorLivenessUnknown(), null);
  assert.equal(implicitAdoptSession({ worktree: WT, mySession: "worker-2623", exists: () => true, owner: () => "worker-2623",
    predecessorGone: predecessorLivenessUnknown }), undefined, "a caller that never learns anything never fires the implicit adopt");
});

test("#2748 `predecessorGoneReading`/`recordPredecessorGone`: what actually makes production reachable, not #2747 -- reviewer-2754's blocker", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2748-"));
  const ledgerPath = join(dir, "wake-ledger");
  try {
    assert.equal(predecessorGoneReading("worker-2623", { ledgerPath }), null,
      "CONTROL: nothing recorded yet -- cannot tell, same answer as the pure stub");
    recordPredecessorGone("worker-2623", { ledgerPath });
    assert.equal(predecessorGoneReading("worker-2623", { ledgerPath }), true,
      "a decline that recorded it IS the confirmation -- now the ordinary claim can find it");
    assert.equal(predecessorGoneReading("worker-9", { ledgerPath }), null,
      "a DIFFERENT session's record answers nothing for this one -- still cannot tell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2748 a `--keep-worktree` decline writes the record `adoptFor` reads back -- the real path, end to end, not a fake `predecessorGone`", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2748-decline-"));
  const ledgerPath = join(dir, "wake-ledger");
  try {
    const board = releaseBoard(["in-progress", "session:worker-2623", "started", "was-ready"]);
    const declined = declineRow(2416, "worker-2623", {
      run: board.run as never, moveStatus: NO_STATUS as never,
      fetchComments: () => [claimRecordComment({ session: "worker-2623", branch: BRANCH, worktree: WT })],
      keepWorktree: true, predecessorGone: true,
      removeWorktree: (() => { throw new Error("must not be called with keepWorktree"); }) as never,
      recordGone: (session: string) => recordPredecessorGone(session, { ledgerPath }),
    });
    assert.equal(declined.declined, true);
    const adopt = implicitAdoptSession({ worktree: WT, mySession: "worker-2623", exists: () => true, owner: () => "worker-2623",
      predecessorGone: (session: string) => predecessorGoneReading(session, { ledgerPath }) });
    assert.equal(adopt, "worker-2623",
      "the ordinary respawn's implicit adopt fires from the RECORD the manual decline actually wrote, not a test double");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2748 reviewer-2754's second verdict: a `--keep-worktree` decline WITHOUT `--predecessor-gone` never writes the record -- a live session's own release is not proof of death", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2748-live-decline-"));
  const ledgerPath = join(dir, "wake-ledger");
  try {
    const board = releaseBoard(["in-progress", "session:worker-2623", "started", "was-ready"]);
    const declined = declineRow(2416, "worker-2623", {
      run: board.run as never, moveStatus: NO_STATUS as never,
      fetchComments: () => [claimRecordComment({ session: "worker-2623", branch: BRANCH, worktree: WT })],
      keepWorktree: true, // no predecessorGone: true -- e.g. a still-running standing engineer releasing its own stalled claim
      removeWorktree: (() => { throw new Error("must not be called with keepWorktree"); }) as never,
      recordGone: (session: string) => recordPredecessorGone(session, { ledgerPath }),
    });
    assert.equal(declined.declined, true, "the release itself still lands -- only the attestation is withheld");
    assert.equal(predecessorGoneReading("worker-2623", { ledgerPath }), null,
      "CONFIRMED: nothing was recorded, so a same-name respawn cannot implicitly adopt a tree its still-live predecessor may still be using");
    const adopt = implicitAdoptSession({ worktree: WT, mySession: "worker-2623", exists: () => true, owner: () => "worker-2623",
      predecessorGone: (session: string) => predecessorGoneReading(session, { ledgerPath }) });
    assert.equal(adopt, undefined, "the ordinary respawn's implicit adopt does NOT fire -- reviewer-2754's exact failure scenario, closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2748 reproduces the #2623 incident: a same-session-name reclaim of a stamped, gone predecessor's tree REUSES it -- and stays refused otherwise", () => {
  const claimAs = (gone: boolean | null, claimed = true) => {
    const stamped: [string, string][] = [];
    const order: string[] = [];
    const adopt = implicitAdoptSession({ worktree: WT, mySession: "worker-2623", exists: () => true, owner: () => "worker-2623",
      predecessorGone: () => gone });
    const result = claimWithWorktree(2416, "worker-2623", {
      branch: BRANCH, worktree: WT, adopt,
      run: ((cmd: string, args: string[]) => { order.push(`${cmd} ${args.join(" ")}`); return args.includes("symbolic-ref") ? `${BRANCH}\n` : ""; }) as never,
      exists: () => true, owner: () => "worker-2623",
      stamp: (w: string, sess: string) => { stamped.push([w, sess]); },
      claim: (() => (claimed ? { claimed: true, statusMoved: true } : { claimed: false, reason: "B2 refused" })) as never,
    });
    return { result, stamped, order };
  };
  const reused = claimAs(true);
  assert.equal(reused.result.claimed, true, "CONTROL: confirmed-gone predecessor -- the respawn's own claim succeeds");
  assert.deepEqual(reused.stamped, [[WT, "worker-2623"]], "re-stamped to the new instance, same name");
  assert.equal(reused.order.some((c) => /fetch|worktree add|worktree remove|branch -D/.test(c)), false,
    "nothing created, nothing removed -- the tree and its uncommitted work are reused in place, exactly as #2470's `--adopt` does");

  for (const gone of [false, null] as const) {
    const refused = claimAs(gone);
    assert.equal(refused.result.claimed, false, `liveness=${gone}: the ordinary #1432 refusal stays`);
    assert.match((refused.result as { reason: string }).reason, /ALREADY EXISTS, stamped by `worker-2623`/,
      "the incident's own refusal text -- unchanged when the predecessor is not CONFIRMED gone");
  }
});

test("#2748 `adoptFor` (CLI wiring): an explicit `--adopt=` always wins, and the implicit ruling is asked ONLY for `claim` given both --branch and --worktree", () => {
  const NOWHERE = "/home/agent/repos/does-not-exist-2748";
  assert.equal(adoptFor("claim", "worker-2623", { adoptFlag: "worker-9", branch: BRANCH, worktree: NOWHERE }), "worker-9",
    "an explicit flag is never overridden by the implicit ruling");
  assert.equal(adoptFor("dispatch", "worker-2623", { branch: BRANCH, worktree: NOWHERE }), undefined,
    "dispatch precedes any tree existing -- the implicit ruling is never asked");
  assert.equal(adoptFor("claim", "worker-2623", { worktree: NOWHERE }), undefined, "no --branch -- never asked");
  assert.equal(adoptFor("claim", "worker-2623", { branch: BRANCH }), undefined, "no --worktree -- never asked");
  assert.equal(adoptFor("claim", "worker-2623", { branch: BRANCH, worktree: NOWHERE }), undefined,
    "asked, but the tree does not exist on disk -- the real `existsSync` answers false, same as `implicitAdoptSession`'s own control");
});

// --- #2842: the SAME-NAME respawn over its predecessor's CLEAN tree needs no predecessor-gone record --------------------------------
// REAL git on a scratch origin + clone + worktree, because a clean-check that reads only one of the four ways is exactly what a fake
// `run` cannot catch: each way below is broken alone, and each must be refused for ITS OWN named reason and no other.

const CLEAN_BRANCH = "agent/clean-respawn-2842";

/** real git, but only ever pointed at the scratch tree; injected so no call reaches a live default seam (#1401) */
const scratchRun = (cmd: string, args: string[]) => execFileSync(cmd, args, { env: sandboxGitEnv(), encoding: "utf8" });

function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), "a11y-clean-tree-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: sandboxGitEnv(), encoding: "utf8" });
  git(root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "--quiet", "origin.git", "main-clone");
  const clone = join(root, "main-clone");
  git(clone, "config", "user.email", "t@example.invalid");
  git(clone, "config", "user.name", "t");
  writeFileSync(join(clone, "tracked.txt"), "one\n");
  git(clone, "add", "tracked.txt");
  git(clone, "commit", "--quiet", "-m", "base");
  git(clone, "push", "--quiet", "origin", "HEAD:main");
  git(clone, "fetch", "--quiet", "origin");
  const tree = join(root, "wt-2842");
  git(clone, "worktree", "add", "--quiet", "-b", CLEAN_BRANCH, tree, "origin/main");
  writeFileSync(join(tree, ".a11y-owner"), "worker-2842\n");
  return { root, tree, git: (...args: string[]) => git(tree, ...args) };
}

test("#2842 `worktreeCleanliness` reads FOUR ways, and each one alone is refused under its own name (a one-way check is caught)", () => {
  const fx = scratchTree();
  try {
    assert.deepEqual(worktreeCleanliness({ worktree: fx.tree, branch: CLEAN_BRANCH }), { clean: true },
      "CONTROL: a fresh tree at origin/main, stamped, is clean -- the stamp is this tree's marker (the scratch repo has no .gitignore for it) and is not dirt");
    const why = () => (worktreeCleanliness({ worktree: fx.tree, branch: CLEAN_BRANCH }) as { why?: string }).why;

    writeFileSync(join(fx.tree, "tracked.txt"), "two\n");
    assert.match(String(why()), /uncommitted changes to tracked files \(.*tracked\.txt/, "way 1: a tracked file modified");
    fx.git("checkout", "--quiet", "--", "tracked.txt");

    writeFileSync(join(fx.tree, "new.txt"), "x\n");
    assert.match(String(why()), /untracked files \(\?\? new\.txt/, "way 2: an untracked file");
    rmSync(join(fx.tree, "new.txt"));
    assert.equal(why(), undefined, "CONTROL: both dirt readings clear when the dirt does");

    writeFileSync(join(fx.tree, "tracked.txt"), "three\n");
    fx.git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "--quiet", "-am", "unpushed");
    assert.match(String(why()), /HEAD is 1 commit\(s\) ahead of origin\/main/, "way 3: a commit ahead of origin/main");

    // way 4 ALONE: HEAD detached back at origin/main (not ahead), the branch still holding the unpushed commit.
    fx.git("checkout", "--quiet", "--detach", "origin/main");
    assert.match(String(why()), /branch `agent\/clean-respawn-2842`'s tip is not an ancestor of origin\/main/,
      "way 4: a HEAD-only reading calls this tree clean; the branch tip says otherwise");
    // and with NO branch to name, the same tree reads clean: the fourth reading is the branch's, not HEAD's.
    assert.deepEqual(worktreeCleanliness({ worktree: fx.tree }), { clean: true }, "no branch named and none attached -- nothing to read");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("#2842 `worktreeCleanliness` -- a git that cannot answer is NOT clean, and says so", () => {
  const out = worktreeCleanliness({ worktree: "/nonexistent/wt" }, { run: (() => { throw new Error("fatal: cannot change to '/nonexistent/wt'"); }) as never });
  assert.equal(out.clean, false);
  assert.match((out as { why: string }).why, /git could not answer \(fatal: cannot change.*"could not ask" is not "clean"/);
});

test("#2842 `implicitAdoptSession`: a CLEAN own tree is adopted with NO predecessor-gone record; a dirty one, a stranger's, and a live predecessor are not", () => {
  const rule = (over: { clean?: boolean; gone?: boolean | null; owner?: string | null } = {}) => implicitAdoptSession({
    worktree: WT, mySession: "worker-2842", exists: () => true,
    owner: () => (over.owner === undefined ? "worker-2842" : over.owner),
    predecessorGone: () => (over.gone === undefined ? null : over.gone),
    clean: () => over.clean ?? true,
  });
  assert.equal(rule(), "worker-2842", "the row's Open-check: own stamped tree, clean, NO record (gone is null) -- adopted");
  assert.equal(rule({ clean: false }), undefined, "CONTROL: the same tree dirty and no record -- refused as before");
  assert.equal(rule({ clean: false, gone: true }), "worker-2842", "CONTROL: dirty with the record is #2748's path, unchanged");
  assert.equal(rule({ owner: "worker-9" }), undefined, "a clean tree stamped by someone else is never adopted");
  assert.equal(rule({ owner: null }), undefined, "nor an unstamped one");
  assert.equal(rule({ gone: false }), undefined, "a reading that the predecessor is ALIVE outranks a clean tree");
});

test("#2842 through `claimWithWorktree` over a real scratch tree: clean proceeds with no record and creates nothing; each dirt is refused, naming it", () => {
  const fx = scratchTree();
  try {
    const claims: string[] = [];
    const claim = (() => { claims.push("claimed"); return { claimed: true, statusMoved: true }; }) as never;
    const ledgerPath = join(fx.root, "wake-ledger");
    const attempt = () => {
      const adopt = implicitAdoptSession({ worktree: fx.tree, mySession: "worker-2842", exists: existsSync, owner: (w) => readFileSync(join(w, ".a11y-owner"), "utf8").trim(),
        predecessorGone: (s: string) => predecessorGoneReading(s, { ledgerPath }), clean: (w) => worktreeCleanliness({ worktree: w, branch: CLEAN_BRANCH }).clean });
      return claimWithWorktree(2842, "worker-2842", { branch: CLEAN_BRANCH, worktree: fx.tree, adopt, claim, run: scratchRun });
    };
    assert.equal(predecessorGoneReading("worker-2842", { ledgerPath }), null, "no predecessor-gone record exists, and the claim must not need one");
    assert.equal(attempt().claimed, true, "the clean tree is adopted");
    assert.deepEqual(claims, ["claimed"]);
    assert.equal(existsSync(join(fx.tree, "tracked.txt")), true, "and nothing was removed or recreated");

    writeFileSync(join(fx.tree, "new.txt"), "x\n");
    const refused = attempt() as { claimed: false; reason: string };
    assert.equal(refused.claimed, false);
    assert.match(refused.reason, /ALREADY EXISTS, stamped by `worker-2842`/);
    assert.match(refused.reason, /YOUR OWN tree.*because it has untracked files \(\?\? new\.txt\).*--adopt=worker-2842/,
      "the refusal names the reading that failed and the exit, instead of only ALREADY EXISTS");
    assert.deepEqual(claims, ["claimed"], "and no claim was written for the refused one");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("#2470 (10) `decline --answer=<session>` releases to that session's `answer:` label, NOT to `ready`, and refuses to be a finding too", () => {
  const board = releaseBoard();
  const done = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, answer: "product-manager", recordGone: NOOP_RECORD_GONE });
  assert.equal(done.declined, true);
  // #3942: `backlog` goes WITH the answer label -- `answer:` is not a state, and removing it (the answerer's act) left fourteen rows in none.
  assert.deepEqual(board.edits()[0].added, ["answer:product-manager", "backlog"], "the row was `ready` before the claim, and is NOT returned to the pool: the work merged");
  const control = releaseBoard();
  declineRow(2416, "worker-7", { run: control.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never, keepWorktree: true,
    recordGone: NOOP_RECORD_GONE });
  assert.deepEqual(control.edits()[0].added, ["ready"], "CONTROL: the same release without --answer restores `ready`");
  const both = declineRow(2416, "worker-7", { run: releaseBoard().run as never, fetchComments: () => RECORD, blockedReason: "x", answer: "product-manager" });
  assert.equal(both.declined, false);
});

// --- Done-when 4, 5, 6, 8, 10: the release, PERFORMED -----------------------------------------------------------------------------------

type ReleaseRequest = Parameters<typeof performRelease>[0];
type ReleaseDeps = Parameters<typeof performRelease>[1];
const STALL: ReleaseRequest = { row: 2407, session: "worker-7", why: "stalled", branch: BRANCH, worktree: WT, idleMinutes: 250, nudgedAt: ago(130) };
const ROW_CLAIM_MJS = /row-claim\.mjs$/;

/** A release host: every seam a release reaches, recording. `herdr` lists worker-7 and can refuse a close; `row-claim decline` can fail. */
function releaseHost(o: { world?: World; spare?: boolean; agents?: { label: string; status: string }[]; closeFails?: boolean;
  declineStatus?: number; labels?: string[] | null; wasNotReady?: boolean } = {}) {
  const runs: string[][] = [];
  const execs: { cmd: string; args: string[]; cwd: string }[] = [];
  const gh: string[][] = [];
  const warns: string[] = [];
  const cycles: Parameters<ReleaseDeps["cycle"]>[0][] = [];
  const kept: Record<number, unknown> = {};
  const dropped: string[] = [];
  const h = host(o.world ?? {});
  const agents = o.agents ?? [{ label: "worker-7", status: "idle" }];
  const run = (args: string[]) => {
    runs.push(args);
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: agents.map((a, i) => ({ label: a.label, workspace_id: `w${i}`, agent_status: a.status })) } });
    if (o.closeFails && args.includes("close")) throw new Error("herdr: refused");
    return "";
  };
  const exec = (cmd: string, args: string[], opts: { cwd: string }) => {
    execs.push({ cmd, args, cwd: opts.cwd });
    if (ROW_CLAIM_MJS.test(args[0] ?? "") && args[1] === "decline") {
      const status = o.declineStatus ?? 0;
      const answer = args.find((a) => a.startsWith("--answer="))?.slice("--answer=".length);
      return { status, output: status === 0
        ? `DECLINED -- #2407 is unclaimed again ${answer ? `and labelled \`answer:${answer}\` (NOT returned to \`ready\`)`
          : o.wasNotReady ? "(was not `ready` before the claim -- not restored)" : "and restored to `ready`"}\n`
        : "NOT DECLINED: the row is held by someone else\n" };
    }
    return { status: 0, output: "" };
  };
  const deps: ReleaseDeps = {
    run, exec, io: h.io, now: NOW, agents, isSpare: () => o.spare ?? true,
    host: { worktreesDir: "/home/agent/repos", primary: REPO, exists: (p: string) => (p === WT ? o.world?.worktreeExists !== false : true) },
    env: {}, warn: (l: string) => { warns.push(l); },
    gh: (a: string[]) => {
      gh.push(a);
      if (a[1] !== "view") return "";
      if (o.labels === null) throw new Error("gh: refused");
      return JSON.stringify({ labels: (o.labels ?? ["in-progress", "session:worker-7"]).map((name) => ({ name })) });
    },
    cycle: (c) => { cycles.push(c); }, dropInstance: (r: string) => { dropped.push(r); return { spawnedAt: 1, rows: [2407] }; },
    keepInstance: (_r: string, row: number) => ({ spawnedAt: 1, rows: [row] }),
    remember: (row: number, k: unknown) => { if (k === null) delete kept[row]; else kept[row] = k; },
  };
  const decline = () => execs.find((e) => ROW_CLAIM_MJS.test(e.args[0] ?? "") && e.args[1] === "decline");
  /** What was WRITTEN to the row (a label READ is not a change). */
  const comments = () => gh.filter((a) => a[1] === "comment");
  const comment = () => comments()[0]?.join(" ") ?? "";
  return { deps, runs, execs, gh, comments, comment, warns, cycles, kept, dropped, h, decline };
}

test("#2470 (4) a stalled release ENDS the spare's workspace, declines the claim AS THE HOLDER keeping the tree, comments, records and writes ONE line", () => {
  const r = releaseHost({ world: { dirty: [{ file: "a.mjs", ago: 900 }], unpushed: 2 } });
  const got = performRelease(STALL, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.equal(got.gone, true, "#3568: and it SAYS the workspace is closed, so the tick does not send an order to the seat it just ended");
  const closeAt = r.runs.findIndex((a) => a.includes("close"));
  assert.deepEqual(r.runs[closeAt], ["--session", "org", "workspace", "close", "w0"], "the instance is ended so a fresh one takes the row");
  const decline = r.decline()!;
  assert.deepEqual(decline.args.slice(1), ["decline", "2407", "--session=worker-7", "--keep-worktree", "--predecessor-gone"],
    "as the holder, and the tree is KEPT; #2748: the workspace was actually CLOSED above, so the release may attest the predecessor gone");
  assert.match(decline.cwd, /\/role-worker-7$/, "from the holder's own launch worktree, which launchGate accepts");
  assert.ok(r.execs.findIndex((e) => e === decline) > -1 && closeAt > -1, "and the close came first, so nothing the instance does can race the read");
  assert.match(r.comment(), /Claim released by the gate \(#2470\).*`worker-7`.*nothing on this row moved for 250 minutes.*KEPT/s);
  assert.match(r.comment(), /2 commit\(s\) not on any remote/);
  assert.deepEqual(r.kept[2407], { worktree: WT, branch: BRANCH, from: "worker-7", at: NOW, why: "stalled", dirty: 1, unpushed: 2 });
  assert.equal(r.cycles.length, 1);
  assert.deepEqual([r.cycles[0].role, r.cycles[0].row, r.cycles[0].released, r.cycles[0].clean], ["worker-7", 2407, "stalled", false]);
  assert.deepEqual(r.dropped, ["worker-7"], "and the registry entry goes, so the next spawn for the address is not read as one that left without the teardown");
});

test("#2470 (7) a tree with NOTHING in it is not kept (and its empty branch is deleted, or the respawn's claim would refuse over it)", () => {
  const r = releaseHost({ world: {} });
  assert.equal(performRelease(STALL, r.deps).released, true);
  assert.deepEqual(r.decline()!.args.slice(1), ["decline", "2407", "--session=worker-7"], "no --keep-worktree: `decline` removes the empty tree itself");
  assert.equal(r.kept[2407], undefined);
  assert.ok(r.h.calls.some((c) => c.endsWith(`branch -d ${BRANCH}`)), "`-d`, never `-D`");
  assert.equal(r.h.calls.some((c) => c.includes("branch -D")), false);
  // ...and a branch already on ORIGIN keeps the tree even when it is clean and pushed: the respawn's claim would refuse over that branch.
  const pushed = releaseHost({ world: { originRef: true } });
  performRelease(STALL, pushed.deps);
  assert.ok(pushed.decline()!.args.includes("--keep-worktree"));
  assert.ok(pushed.kept[2407] !== undefined);
  assert.match(pushed.comment(), /row-branch-unshipped.*holds it for `product-manager`/s, "and the comment says the row is HELD, not simply back in the pool");
  assert.match(r.comment(), /back in the pool, and a fresh instance takes it/, "CONTROL: a local-only tree is offered at once");
});

test("#2470 (6) a claim by a role that is NOT a spare is released and NEVER ended: the standing engineers and the decision-holders keep their process", () => {
  const holdsRow = ["in-progress", "session:worker-capture"];
  const r = releaseHost({ spare: false, agents: [{ label: "worker-capture", status: "working" }], world: { unpushed: 1 }, labels: holdsRow });
  const got = performRelease({ ...STALL, session: "worker-capture" }, r.deps);
  assert.equal(got.released, true);
  assert.equal(got.gone, false, "#3568: nothing was closed, so the seat is still one an order may be sent to");
  assert.equal(r.runs.some((a) => a.includes("close")), false, "no workspace is closed");
  assert.equal(r.cycles.length, 0, "and no cycle line: it is not an instance's ending");
  assert.deepEqual(r.dropped, []);
  assert.ok(r.decline()!.args.includes("--session=worker-capture"), "only the CLAIM is released");
  assert.equal(r.decline()!.args.includes("--predecessor-gone"), false,
    "#2748 (reviewer-2754's second verdict): worker-capture's process was never closed, so this release must NOT attest it is gone");
  // THE CONTROL: the same request for a spare closes it.
  const spare = releaseHost({ agents: [{ label: "worker-capture", status: "working" }], world: { unpushed: 1 }, labels: holdsRow });
  performRelease({ ...STALL, session: "worker-capture" }, spare.deps);
  assert.equal(spare.runs.some((a) => a.includes("close")), true, "a spare IS ended, whatever it is doing -- its claim is gone and nothing it does now matters");
});

test("#2470 (5) a stall release does NOT lift the #2324 drain, and neither counts toward nor resets #1950's run: decided, and pinned", () => {
  const clean = { role: "a", row: 1, at: 1, clean: true, rows: [1], why: "closed" };
  const release = { role: "b", row: 2, at: 2, clean: false, rows: [2], why: "released", released: "stalled" as const };
  const failure = { role: "c", row: 3, at: 3, clean: false, rows: [3], why: "left work behind" };
  assert.equal(isReleaseLine(release), true);
  assert.equal(drainInForce([clean, release]), true, "the standing engineers do NOT resume claiming because one instance stalled");
  assert.equal(drainInForce([clean, failure]), false, "CONTROL: a real failed cycle DOES lift it, by the rule that always did");
  assert.equal(drainInForce([clean, failure, release]), false, "a release after a failure does not put the drain back either: the newest CYCLE decides");
  assert.equal(drainInForce([release]), true, "a ledger of only releases is a ledger where nothing has failed");
  assert.equal(consecutiveClean([clean, release, clean]).run, 2, "a release neither ends the run nor is one of it");
  assert.equal(consecutiveClean([clean, failure, clean]).run, 1, "CONTROL: a failure does end it");
  assert.match(cyclesReport([clean, release], []).stdout, /release lines counted for nothing \(claims the gate took back, #2470\): 1/);
  // ...and the line the performer WRITES is one of these, not a lookalike.
  const r = releaseHost({ world: { unpushed: 1 } });
  performRelease(STALL, r.deps);
  assert.equal(isReleaseLine(r.cycles[0]), true);
});

test("#2470 (8/10) a blocked or merged release is REFUSED, before any write, when the holder now holds work; a stalled one keeps it", () => {
  const dirty: World = { dirty: [{ file: "a.mjs", ago: 1 }] };
  for (const why of ["blocked", "merged"] as const) {
    const r = releaseHost({ world: dirty });
    const got = performRelease({ ...STALL, why, edges: [2258], mergedPr: 2497, answer: "product-manager" }, r.deps);
    assert.equal(got.released, false, why);
    assert.match(got.why, /holds work/);
    assert.deepEqual([r.runs.some((a) => a.includes("close")), r.decline(), r.comments().length], [false, undefined, 0], "nothing was changed");
  }
  const stalled = releaseHost({ world: dirty });
  assert.equal(performRelease(STALL, stalled.deps).released, true, "CONTROL: a STALLED release is the one that KEEPS what it finds");
});

test("#2747 a GONE release is NOT refused when the holder holds work -- unlike blocked/merged, it behaves exactly like stalled -- and its workspace is already absent so nothing is closed", () => {
  const dirty: World = { dirty: [{ file: "a.mjs", ago: 1 }] };
  const r = releaseHost({ world: dirty, agents: [] });
  const got = performRelease({ ...STALL, why: "gone", idleMinutes: null, nudgedAt: null }, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.equal(r.runs.some((a) => a.includes("close")), false, "already absent from herdr's own listing (that is the whole reason) -- nothing left to close");
  assert.deepEqual(r.decline()!.args.slice(1), ["decline", "2407", "--session=worker-7", "--keep-worktree", "--predecessor-gone"],
    "dirty work is KEPT, exactly like a stalled release; #2748: herdr's own listing has no record of the session at all, which is "
    + "the strongest of the two confirmed-gone readings, so the release may attest it");
  assert.match(r.comment(), /worker-7` no longer exists in herdr's own workspace listing \(#2747\), not merely quiet/);
});

test("#3048 a GONE release with an open PR is HELD for `product-manager`: `--answer` rides the decline, NOT `ready`, and the comment names the PR", () => {
  const r = releaseHost({ world: { unpushed: 2 }, agents: [] });
  const got = performRelease({ ...STALL, why: "gone", idleMinutes: null, nudgedAt: null, openPrs: [3044], answer: "product-manager" }, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.deepEqual(r.decline()!.args.slice(1), ["decline", "2407", "--session=worker-7", "--keep-worktree", "--predecessor-gone", "--answer=product-manager"],
    "the claim labels come off, the worktree stays, and the row goes to `answer:product-manager` -- `decline` then does not restore `ready`");
  assert.match(r.comment(), /#3044 is OPEN/);
  assert.match(r.comment(), /NOT back in the pool.*`answer:product-manager` is set.*adopt it.*close it and re-promote/s);
  assert.doesNotMatch(r.comment(), /was NOT `ready` before it was claimed/, "a row that WAS ready must not be told it was not");
  assert.doesNotMatch(r.comment(), /fresh instance takes it/);
  const control = releaseHost({ world: { unpushed: 2 }, agents: [] });
  performRelease({ ...STALL, why: "gone", idleMinutes: null, nudgedAt: null }, control.deps);
  assert.equal(control.decline()!.args.some((a) => a.startsWith("--answer")), false, "CONTROL: a gone claim with no PR is declined WITHOUT it, and goes back to the pool");
  assert.match(control.comment(), /back in the pool/);
});

test("#2470 (10) a merged release sets the answer at the merge (`--answer`), says which PR merged, and ends the instance", () => {
  const r = releaseHost({ world: {} });
  const got = performRelease({ ...STALL, why: "merged", mergedPr: 2497, answer: "product-manager", idleMinutes: null, nudgedAt: null }, r.deps);
  assert.equal(got.released, true);
  assert.deepEqual(r.decline()!.args.slice(1), ["decline", "2407", "--session=worker-7", "--answer=product-manager"]);
  assert.match(r.comment(), /#2497 MERGED and this row stayed open.*`answer:product-manager` is set/s);
  assert.equal(r.runs.some((a) => a.includes("close")), true);
  assert.equal(r.cycles[0].released, "merged");
});

test("#2470 a release is RECOVERABLE at every step: a workspace that will not close changes nothing, and a decline that fails leaves no line and retries", () => {
  const stuck = releaseHost({ closeFails: true, world: { unpushed: 1 } });
  const first = performRelease(STALL, stuck.deps);
  assert.equal(first.released, false);
  assert.deepEqual([stuck.decline(), stuck.cycles.length, stuck.comments().length], [undefined, 0, 0], "a close that failed aborts with nothing changed");

  // The decline fails AFTER the close: the row is still claimed and there is no process. No line, no comment, no record...
  const declined = releaseHost({ declineStatus: 1, world: { unpushed: 1 } });
  assert.equal(performRelease(STALL, declined.deps).released, false);
  assert.deepEqual([declined.cycles.length, declined.comments().length, Object.keys(declined.kept).length], [0, 0, 0]);
  // ...and the retry on the next tick finds the workspace ABSENT, closes nothing and declines: exactly ONE line for the whole release.
  const retry = releaseHost({ agents: [], world: { unpushed: 1 } });
  assert.equal(performRelease(STALL, retry.deps).released, true);
  assert.equal(retry.runs.some((a) => a.includes("close")), false, "already gone");
  assert.equal(retry.cycles.length, 1);
});

// --- Done-when 7 (b): the respawn STARTS in the kept tree ----------------------------------------------------------------------------------

const KEPT = { worktree: WT, branch: BRANCH, from: "worker-7", at: NOW, why: "stalled", dirty: 3, unpushed: 2 };
const SPAWN_ORDER = { session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2407",
  title: "One instance one row", prompt: "Ready row #2407 is unclaimed." };

/** A spawn over a fake host: `row-claim claim` succeeds and creates the row directory only when it is asked to CREATE (no --adopt). */
function spawnHost(o: { kept?: typeof KEPT | null; claimStatus?: number; treeGone?: boolean; vanish?: boolean } = {}) {
  const execs: { args: string[]; cwd: string }[] = [];
  const fs = new Set<string>(o.kept && !o.treeGone ? [o.kept.worktree] : []);
  const forgotten: number[] = [];
  const exec = (cmd: string, args: string[], { cwd }: { cwd: string }) => {
    execs.push({ args: cmd === "git" ? ["git", ...args] : args, cwd });
    if (cmd === "git" && args[0] === "worktree") fs.add(args[3]);
    if (cmd === "node" && args[1] === "claim") {
      const status = o.claimStatus ?? 0;
      if (status === 0 && !args.some((a) => a.startsWith("--adopt="))) fs.add(`/home/agent/repos/wt-2407`);
      if (o.vanish) { fs.delete(WT); fs.delete("/home/agent/repos/wt-2407"); }
      return { status, output: status === 0 ? "STARTED -- #2407 is now in-progress\n" : "NOT CLAIMED: refused\n" };
    }
    return { status: 0, output: "" };
  };
  const claimer = spawnClaimer({ exec, exists: (p: string) => fs.has(p), kept: () => o.kept ?? null, forget: (r: number) => { forgotten.push(r); } });
  return { execs, forgotten, claimer, claimArgs: () => execs.find((e) => e.args[1] === "claim")!.args.slice(1) };
}

test("#2470 (7b) the respawn's claim ADOPTS the kept tree: it names the holder, the branch and the path, and the tree is where the pane starts", () => {
  const h = spawnHost({ kept: KEPT });
  const got = h.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.ok(!("refusal" in got), JSON.stringify(got));
  assert.deepEqual(h.claimArgs(), ["claim", "2407", "--session=worker-2407", `--branch=${BRANCH}`, `--worktree=${WT}`, "--adopt=worker-7"]);
  assert.equal((got as { worktree: string }).worktree, WT, "the pane opens in the kept tree, not in a fresh `wt-2407`");
  assert.deepEqual(h.forgotten, [2407], "and the record is dropped once it has been used");
  assert.equal(h.execs.some((e) => e.args.join(" ").includes("worktree add") && e.args[3]?.endsWith("wt-2407")), false, "it created NOTHING");
  // THE CONTROL: with no kept record the spawner is exactly what it was -- a fresh tree, fresh branch, no --adopt.
  const fresh = spawnHost({ kept: null });
  fresh.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.deepEqual(fresh.claimArgs(), ["claim", "2407", "--session=worker-2407", "--branch=agent/one-instance-one-row-2407", "--worktree=../wt-2407"]);
  assert.deepEqual(fresh.forgotten, []);
});

test("#2470 (7b) a kept record whose tree is GONE falls back to a fresh claim, and a refused adoption is a refusal that keeps the tree", () => {
  const gone = spawnHost({ kept: KEPT, treeGone: true });
  gone.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.deepEqual(gone.claimArgs(), ["claim", "2407", "--session=worker-2407", "--branch=agent/one-instance-one-row-2407", "--worktree=../wt-2407"],
    "a record naming a path that no longer exists must not send the claim to adopt nothing");
  assert.deepEqual(gone.forgotten, [2407], "and the stale record is DROPPED (#2864), not left to be read again next tick");
  const refused = spawnHost({ kept: KEPT, claimStatus: 1 });
  const got = refused.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.ok("refusal" in got);
  assert.equal(refused.execs.some((e) => e.args[1] === "decline"), false, "a claim that did not land has nothing to undo, and so removes nothing");
  // A claim that LANDED and then did not leave the tree is undone with `--keep-worktree`: an adopted tree is never removed by the undo.
  const vanishes = spawnHost({ kept: KEPT, vanish: true });
  assert.ok("refusal" in vanishes.claimer.claim(SPAWN_ORDER, "worker-2407", {}));
  const undo = vanishes.execs.find((e) => e.args[1] === "decline");
  assert.ok(undo !== undefined && undo.args.includes("--keep-worktree"), "the undo of an ADOPTED claim keeps the tree");
  // CONTROL: the same undo for a claim that created its own tree is the plain decline, which removes it -- as it always did.
  const own = spawnHost({ kept: null, vanish: true });
  own.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.deepEqual(own.execs.find((e) => e.args[1] === "decline")?.args.slice(1), ["decline", "2407", "--session=worker-2407"]);
});

test("#2470 (7b) the prompt a respawn into a kept tree gets says the tree is NOT empty, and by whose work; a fresh spawn's prompt is unchanged", () => {
  const adopted = spawnedPrompt({ title: "t" }, { row: 2407, branch: BRANCH, worktree: WT, launchDir: "/x", adopted: { from: "worker-7", dirty: 3, unpushed: 2 } });
  assert.match(adopted, /THIS WORKTREE IS NOT EMPTY.*`worker-7`'s.*3 changed file\(s\) and 2 commit\(s\) that exist nowhere else/s);
  assert.match(adopted, /git log origin\/main\.\.HEAD/);
  const fresh = spawnedPrompt({ title: "t" }, { row: 2407, branch: BRANCH, worktree: WT, launchDir: "/x" });
  assert.equal(fresh.includes("NOT EMPTY"), false, "the control: without an adoption the sentence is not there");
  assert.equal(adopted.startsWith(fresh), true, "and it is an ADDITION to the ordinary prompt, not a replacement of it");
});

// --- Done-when 9: an INTERRUPTED pane is a stall the gate can see ---------------------------------------------------------------------------
//
// HOW A PANE'S LAST LINE IS OBTAINED, said first because the row asked for it before anything else: `herdr --session org agent read <name>
// --source recent --lines 40` -- the agent's own recent terminal OUTPUT, addressed by label, one process per idle session, ~5 ms. NOT
// `agent list`'s `agent_status` (which reports `idle` for an interrupted pane, the very thing this exists for) and NOT `--source detection`
// (herdr's classifier's excerpt). The pane's bottom is Claude Code's input box (a rule, `❯`, a rule) and a status footer, so "the last line"
// is the last non-empty line ABOVE the box. NOT SEEN LIVE: no pane was interrupted while this was written, so the needle is the row's own
// quotation (`INTERRUPTED_TEXT`), pinned here against a layout copied from a real idle pane read at 2026-09-25T15:5xZ.

const BOX = "─".repeat(120);
const pane = (...content: string[]) => [...content, "", BOX, "❯", BOX,
  "  Week ━━╸─────── 21% used (resets Thu 08:00) | Sonnet 5 · high", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"].join("\n");
const INTERRUPTED_LINE = `  ⎿  ${INTERRUPTED_TEXT}`;

test("#2470 (9) a pane whose LAST line is `Interrupted` is read as interrupted; an ordinary idle pane is not", () => {
  assert.equal(paneInterrupted(pane("● Reading the row", INTERRUPTED_LINE)), true);
  assert.equal(paneInterrupted(pane("● Done.", "", "✻ Cooked for 1m 52s · done 15:56")), false, "CONTROL: a finished turn's pane");
  assert.equal(paneInterrupted(pane("※ recap: Goal: land draft PR #2497", "new task? /clear to save 142.9k tokens")), false, "CONTROL: worker-9's real idle pane");
  assert.equal(paneInterrupted(null), false);
  assert.equal(paneInterrupted(""), false);
});

test("#2470 (9) the needle is anchored to the LAST line: a session that QUOTES the sentence, or has moved on since, is not resumed", () => {
  assert.equal(paneInterrupted(pane(INTERRUPTED_LINE, "● Resumed. Reading the row again.")), false, "an old interruption with output after it");
  assert.equal(paneInterrupted(pane(`● The row says "${INTERRUPTED_TEXT}" is what a killed pane prints`, "● Done.")), false, "a quotation earlier in the output");
  assert.equal(paneInterrupted(`${INTERRUPTED_LINE}\n\n`), true, "a pane with NO input box is read from its own last line");
  // A DRAFT TYPED INTO THE BOX does not hide it: the last line is read ABOVE the top rule, not from the bottom of the pane.
  const typing = [INTERRUPTED_LINE, "", BOX, "❯ some half-typed prompt", BOX, "  status"].join("\n");
  assert.equal(paneInterrupted(typing), true);
});

/** A scratch state directory, removed by the test that made it. */
function withState<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claim-stall-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** A herdr that answers `agent read` from a map of label -> pane text. */
const herdrReading = (panes: Record<string, string>) => (args: string[]) => {
  if (args.includes("read")) return panes[args[args.indexOf("read") + 1]] ?? "";
  throw new Error(`unexpected herdr ${args.join(" ")}`);
};

test("#2470 (9) an interrupted pane yields a RESUME order -- a plain prompt, queued -- and an ordinary idle pane yields none", () => {
  withState((dir) => {
    const ledger = join(dir, "wake-ledger");
    const agents = [{ label: "worker-7", status: "idle" }, { label: "worker-9", status: "idle" }, { label: "worker-4", status: "working" }, { label: "ceo", status: "done" }];
    const lines = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-7": pane(INTERRUPTED_LINE), "worker-9": pane("● Done."), "worker-4": pane(INTERRUPTED_LINE), ceo: pane("✻ Cooked for 1m") }) });
    assert.deepEqual(lines.filter((l) => l.startsWith("RESUMING")), ["RESUMING worker-7: its pane's last line reads Interrupted"],
      "only the idle interrupted pane: a `working` session is mid-turn (not woken) and an ordinary idle one has nothing to resume");
    const queued = readHandoffs(join(dir, "prompt-session-handoffs"));
    assert.deepEqual(queued.map((h) => h.session), ["worker-7"]);
    assert.equal((queued[0] as { resume?: boolean }).resume, true, "queued as a RESUME: delivered plain");
    assert.match(queued[0].prompt, /NOTHING WAS CLEARED/);
    assert.match(queued[0].prompt, new RegExp(INTERRUPTED_TEXT));
    assert.equal((handoffBatches(queued)[0] as { resume?: boolean }).resume, true, "and the delivery order carries the flag to `deliver`");

    // IDEMPOTENT: the same pane one tick later is not resumed again inside a wake window, and IS once the window has passed.
    const again = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW + 2 * MIN, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-7": pane(INTERRUPTED_LINE) }) });
    assert.deepEqual(again, [], "a pane that stays interrupted is not re-prompted on every tick");
    const later = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW + WAKE_TTL_MS + MIN, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-7": pane(INTERRUPTED_LINE) }) });
    assert.equal(later.filter((l) => l.startsWith("RESUMING")).length, 1);
  });
});

test("#2470 (9) a RESUME is never behind a `/clear`, even to a standing seat; the same order without the flag IS cleared", () => {
  const sent: string[][] = [];
  const run = (args: string[]) => { sent.push(args); return ""; };
  const order = { session: "worker-capture", causeKey: "handoff/worker-capture/ab", prompt: "You were interrupted." };
  deliver([{ ...order, resume: true }], [{ label: "worker-capture", status: "idle" }], ["worker-capture"], { run });
  assert.equal(sent.some((a) => a.includes("/clear")), false, "the resume goes straight in: the context is what it is for");
  assert.equal(sent.filter((a) => a.includes("prompt")).length, 1);
});

// --- #2745: a Claude Code thrash-guard stop reaches the gate as a DISTINCT signal, and is never answered with the same order ----------------

// THE MESSAGE WRAPS (it is long enough that a single-line needle, as `INTERRUPTED_TEXT` uses, would never match any one rendered line), so
// the fixture is built the way Claude Code actually wraps it rather than as one line -- and `THRASH_TEXT` is only the opening clause.
const THRASH_MESSAGE = [
  "● Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a",
  "  row. A file being read or a tool output is likely too large for the context window. Try reading in smaller",
  "  chunks, or use /clear to start fresh.",
].join("\n");

test("#2745 (1,2) a pane whose last TURN ended in the thrash guard is read as thrashed; an ordinary idle pane is not", () => {
  assert.equal(paneThrashed(pane(THRASH_MESSAGE, "✻ Baked for 7s · done 9:56")), true);
  assert.equal(paneThrashed(pane("● Done.", "", "✻ Cooked for 1m 52s · done 15:56")), false, "CONTROL: a finished turn's pane");
  assert.equal(paneThrashed(pane("※ recap: Goal: land draft PR #2497", "new task? /clear to save 142.9k tokens")), false, "CONTROL: an ordinary idle pane");
  assert.equal(paneThrashed(pane(INTERRUPTED_LINE)), false, "CONTROL: an interrupted pane is not a thrashed one");
  assert.equal(paneThrashed(null), false);
  assert.equal(paneThrashed(""), false);
});

test("#2745 (2) the needle is anchored to the LAST paragraph, past Claude Code's own completion footer, not the last line", () => {
  // NO FOOTER: a pane with no input box (or one whose process ended before printing its own footer) is read from its own last paragraph.
  assert.equal(paneThrashed(THRASH_MESSAGE), true, "a pane with NO input box, and no footer, is read from its own last paragraph");
  assert.equal(paneThrashed(`${THRASH_MESSAGE}\n\n`), true, "trailing blank lines are not the paragraph");
  // A SESSION DISCUSSING THIS ROW (this very file, read into its own pane) is not resumed for it: the quotation is not the FINAL paragraph
  // once real commentary follows it, exactly the shape `paneInterrupted`'s own equivalent test guards.
  assert.equal(paneThrashed(pane(`● The row says \`${THRASH_TEXT}\` is what the guard prints`, "", "● Done.")), false, "a quotation earlier in the output");
  // A DRAFT TYPED INTO THE BOX does not hide it: the last paragraph is read ABOVE the top rule, not from the bottom of the pane.
  const typing = [THRASH_MESSAGE, "", BOX, "❯ some half-typed prompt", BOX, "  status"].join("\n");
  assert.equal(paneThrashed(typing), true);
});

test("#2745 (3,4) a thrashed pane is NEVER answered with the same order it just got: it is not resumed, and `product-manager` is told instead", () => {
  withState((dir) => {
    const ledger = join(dir, "wake-ledger");
    const agents = [{ label: "worker-2623", status: "idle" }, { label: "worker-7", status: "idle" }, { label: "worker-9", status: "idle" }];
    const lines = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-2623": pane(THRASH_MESSAGE, "✻ Baked for 5h 24m · done 07:46"), "worker-7": pane(INTERRUPTED_LINE), "worker-9": pane("● Done.") }) });
    assert.deepEqual(lines.filter((l) => l.startsWith("ESCALATING")),
      ["ESCALATING worker-2623 to product-manager: its last turn ended in the autocompact thrash guard"]);
    assert.equal(lines.some((l) => l.includes("RESUMING worker-2623")), false, "NOT a resume: the defect this exists to stop, not repeat");
    // worker-7's ordinary interrupted-pane handling is unaffected: both readings share one pane fetch per session (`texts`), not two.
    assert.deepEqual(lines.filter((l) => l.startsWith("RESUMING")), ["RESUMING worker-7: its pane's last line reads Interrupted"]);

    const queued = readHandoffs(join(dir, "prompt-session-handoffs"));
    const escalation = queued.find((h) => h.session === "product-manager");
    assert.ok(escalation !== undefined);
    assert.equal((escalation as { resume?: boolean }).resume, undefined, "an order to `product-manager`, not a resume of `worker-2623`");
    assert.match(escalation!.prompt, /worker-2623/);
    assert.match(escalation!.prompt, new RegExp(THRASH_TEXT.replace(/[:.]/g, "\\$&")));
    assert.match(escalation!.prompt, /NOT RESUMED/);
    assert.equal(queued.some((h) => h.session === "worker-2623"), false, "worker-2623 itself gets nothing");
    assert.equal(escalation!.prompt, thrashEscalationPrompt("worker-2623"));

    // IDEMPOTENT, exactly like the interrupted-pane case: not escalated again inside a wake window, and is once it has passed.
    const again = recoverInterruptedWork({ agents: [agents[0]], ledgerPath: ledger, now: NOW + 2 * MIN, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-2623": pane(THRASH_MESSAGE, "✻ Baked for 5h 24m · done 07:46") }) });
    assert.deepEqual(again, [], "a pane that stays on the thrash message is not re-escalated on every tick");
    const later = recoverInterruptedWork({ agents: [agents[0]], ledgerPath: ledger, now: NOW + WAKE_TTL_MS + MIN, restartAt: null, moved: () => true, lastActive: () => NOW - 30 * MIN, log: () => {},
      run: herdrReading({ "worker-2623": pane(THRASH_MESSAGE, "✻ Baked for 5h 24m · done 07:46") }) });
    assert.equal(later.filter((l) => l.startsWith("ESCALATING")).length, 1);
  });
});

// --- Done-when 11: a delivery a restart killed is UNDELIVERED, and is re-sent ------------------------------------------------------------------

test("#2470 (11a) the restart is READ through a seam: a UTC timestamp, and anything that is not one is `null`, never a time", () => {
  const read = (out: string) => readHerdrRestart(() => out);
  assert.equal(read("ActiveEnterTimestamp=Fri 2026-09-25 12:01:57 UTC\n"), Date.UTC(2026, 8, 25, 12, 1, 57));
  assert.equal(read("ActiveEnterTimestamp=\n"), null, "an inactive unit has no start");
  assert.equal(read("ActiveEnterTimestamp=Fri 2026-09-25 13:01:57 BST\n"), null, "a zone abbreviation is not read as UTC -- that is why the call asks for `--timestamp=utc`");
  assert.equal(readHerdrRestart(() => { throw new Error("systemctl: no bus"); }), null);
  const asked: string[][] = [];
  readHerdrRestart((a) => { asked.push(a); return ""; });
  assert.deepEqual(asked[0], ["--user", "show", "herdr.service", "-p", "ActiveEnterTimestamp", "--timestamp=utc"]);
});

const RESTART = Date.parse("2026-09-25T12:01:53Z");
const delivery = (secondsBefore: number, session = "worker-9") => ({ session, at: RESTART - secondsBefore * 1000, key: `${session}/answer-owed/row-1/x` });

test("#2470 (11b) POSITIVE CONTROLS: inside the window with no move is killed; before it, after a move, or after the restart is not", () => {
  const never = () => false;
  assert.deepEqual(killedDeliveries({ deliveries: [delivery(68)], at: RESTART, moved: never }).length, 1, "the 68-second case that started this row");
  assert.deepEqual(killedDeliveries({ deliveries: [delivery(RESTART_RESEND_WINDOW_MS / 1000 + 60)], at: RESTART, moved: never }), [], "BEFORE the window");
  assert.deepEqual(killedDeliveries({ deliveries: [delivery(68)], at: RESTART, moved: () => true }), [], "followed by a move");
  assert.deepEqual(killedDeliveries({ deliveries: [{ session: "s", at: RESTART + 1000, key: "k" }], at: RESTART, moved: never }), [], "the re-send itself is stamped AFTER the restart");
  const asked: number[][] = [];
  killedDeliveries({ deliveries: [delivery(68)], at: RESTART, until: RESTART + 5 * 3_600_000, moved: (_s, from, to) => { asked.push([from, to]); return false; } });
  assert.deepEqual(asked, [[RESTART - 68_000, RESTART + 5 * 3_600_000]], "asked from the delivery to `until`: late notice reads through to now");
});

const ledgerOf = (...lines: string[]) => `${lines.join("\n")}\n`;
const key = "worker-9/answer-owed/row-1/x";

test("#2470 (11d) a VOIDED delivery is not live and does not spend MAX_DELIVERIES: the re-send REPLACES it in the run", () => {
  // An action cause is re-offered no more than once per window, so the deliveries are 25 minutes apart, the last one the killed one.
  const killedAt = NOW - 60_000;
  const fired = Array.from({ length: MAX_DELIVERIES }, (_v, i) => `${killedAt - (MAX_DELIVERIES - 1 - i) * 25 * 60_000}\t${key}`);
  const before = ledgerOf(...fired);
  const read = (text: string) => readLedger("/l", (() => text) as never, NOW, new Set());
  assert.equal(read(before).has(key), true, "delivered, so the ordinary path would drop the gate's order for the window");
  assert.equal(deliveryCounts("/l", (() => before) as never).get(key), MAX_DELIVERIES, "and the run is AT the cap");
  const voided = ledgerOf(...fired, `${NOW}\t${VOIDED}\t${key}\t${killedAt}`);
  assert.equal(read(voided).has(key), false, "voided: offered again");
  assert.equal(deliveryCounts("/l", (() => voided) as never).get(key), MAX_DELIVERIES - 1, "and the count is where it was before the killed delivery");
  // Through `deliver`, the whole point: at the cap the order is STUCK; after the void it is SENT.
  const agents = [{ label: "worker-9", status: "idle" }];
  const order = { session: "worker-9", causeKey: key, prompt: "p", resume: true };
  const stuck = deliver([order], agents, ["worker-9"], { run: () => "", counts: deliveryCounts("/l", (() => before) as never) });
  assert.deepEqual([stuck.sent.length, stuck.stuck.length], [0, 1], "control: without the void the breaker holds it");
  const freed = deliver([order], agents, ["worker-9"], { run: () => "", counts: deliveryCounts("/l", (() => voided) as never) });
  assert.deepEqual([freed.sent.length, freed.stuck.length], [1, 0], "with it the order goes out");
  // A VOIDED line takes back ONE delivery and only the one it names: an earlier live delivery still holds the key.
  const two = ledgerOf(`${NOW - 30 * 60_000}\t${key}`, `${NOW - 60_000}\t${key}`, `${NOW}\t${VOIDED}\t${key}\t${NOW - 60_000}`);
  assert.equal(read(two).has(key), false, "the older one is past its window, so it is not live either");
});

test("#2470 (11) a killed CAUSE delivery is re-sent once, as a resume, and the recent VOIDED keys are what mark it", () => {
  withState((dir) => {
    const ledger = join(dir, "wake-ledger");
    writeFileSync(ledger, ledgerOf(`${RESTART - 68_000}\t${key}`, `${RESTART - 3 * 3_600_000}\t${key}old`));
    const args = { agents: [{ label: "worker-9", status: "idle" }], ledgerPath: ledger, now: RESTART + 90_000, restartAt: RESTART, lastActive: () => null, log: () => {},
      run: herdrReading({ "worker-9": pane("● Done.") }) };
    const first = recoverInterruptedWork({ ...args, moved: () => false });
    assert.deepEqual(first, [`RE-SENDING ${key} to worker-9: delivered 2026-09-25T12:00:45.000Z and the target made no move before the interruption (VOIDED on the ledger)`]);
    assert.equal(readLedger(ledger, readFileSync as never, args.now, new Set()).has(key), false, "no longer live: the gate's order is offered again");
    assert.deepEqual([...recentlyVoidedKeys(ledger, args.now - WAKE_TTL_MS)], [key], "and wake marks exactly that key as a resume");
    assert.equal(readLedgerDeliveries(ledger).some((d) => d.key === key), false, "a voided delivery is not a delivery");
    // ONCE PER RESTART: the same restart, one tick later, re-sends nothing -- and so does a re-run that finds the ledger already voided.
    assert.deepEqual(recoverInterruptedWork({ ...args, now: args.now + 2 * MIN, moved: () => false }), []);
    assert.equal(readFileSync(ledger, "utf8").split("\n").filter((l) => l.includes(VOIDED)).length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "restart-resends.json"), "utf8")).restartAt, RESTART, "the restart acted on is remembered");
  });
});

test("#2470 (11b) an AUTHORED order is re-sent from its retained text as a fresh live line, and only when its target made no move", () => {
  /** A queue holding one order DELIVERED 68 seconds before the restart, and the args a tick that notices it 90 seconds after would pass. */
  const setup = (dir: string) => {
    const queue = join(dir, "prompt-session-handoffs");
    queueHandoff(queue, { session: "worker-9", prompt: "Please close out #2220.", decision: true, now: RESTART - 300_000 });
    writeFileSync(queue, `${JSON.stringify({ delivered: readHandoffs(queue)[0].id, at: RESTART - 68_000 })}\n`, { flag: "a" });
    return { queue, args: { agents: [{ label: "worker-9", status: "idle" }], ledgerPath: join(dir, "wake-ledger"), now: RESTART + 90_000,
      restartAt: RESTART, lastActive: () => null, log: () => {}, run: herdrReading({ "worker-9": pane("● Done.") }) } };
  };
  withState((dir) => {
    const { queue, args } = setup(dir);
    assert.deepEqual(readHandoffs(queue), [], "delivered: retired from the live queue");
    assert.deepEqual(readDeliveredHandoffs(queue).map((h) => [h.session, h.prompt, h.decision, h.at]), [["worker-9", "Please close out #2220.", true, RESTART - 68_000]]);
    // A target that did not move: the SAME text is live again, carrying the flag that spares it the clear.
    assert.equal(recoverInterruptedWork({ ...args, moved: () => false }).length, 1);
    const live = readHandoffs(queue);
    assert.deepEqual(live.map((h) => [h.session, h.prompt]), [["worker-9", "Please close out #2220."]]);
    assert.equal((live[0] as { resume?: boolean }).resume, true);
    assert.equal((handoffBatches(live)[0] as { resume?: boolean }).resume, true);
  });
  // THE CONTROL, one thing changed: a target that MOVED is left alone, and nothing is queued for it.
  withState((dir) => {
    const { queue, args } = setup(dir);
    assert.deepEqual(recoverInterruptedWork({ ...args, moved: () => true }), []);
    assert.deepEqual(readHandoffs(queue), [], "nothing was queued for a session that acted");
  });
});

test("#2470 (11b) an INTERRUPTED pane with NO restart in view marks its own recent deliveries as killed, and only its own", () => {
  withState((dir) => {
    const ledger = join(dir, "wake-ledger");
    const mine = `worker-7/claimed-row-amended/row-1/x`;
    writeFileSync(ledger, ledgerOf(`${NOW - 10 * MIN}\t${mine}`, `${NOW - 3 * 3_600_000}\t${mine}old`, `${NOW - 10 * MIN}\tworker-9/answer-owed/row-2/y`));
    const agents = [{ label: "worker-7", status: "idle" }, { label: "worker-9", status: "idle" }];
    const run = herdrReading({ "worker-7": pane(INTERRUPTED_LINE), "worker-9": pane("● Done.") });
    const lines = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW, restartAt: null, moved: () => false, lastActive: () => NOW - 30 * MIN, log: () => {}, run });
    assert.deepEqual(lines.filter((l) => l.startsWith("RE-SENDING")).map((l) => l.split(" ")[1]), [mine],
      "the interrupted session's delivery inside the window is voided; an older one is not, and neither is the ordinary idle session's");
    assert.equal(readLedger(ledger, readFileSync as never, NOW, new Set()).has(mine), false, "so the gate's order is offered again");
    assert.equal(readLedger(ledger, readFileSync as never, NOW, new Set()).has("worker-9/answer-owed/row-2/y"), true, "and the other session's delivery still holds");
    assert.ok(lines.some((l) => l.startsWith("RESUMING worker-7")), "and it is resumed as well");
  });
});

test("#2470 (11) a restart noticed LATE is not acted on if it is older than the horizon, and a session that has since acted is left alone", () => {
  const facts = (over: object) => recoverableWork({ now: RESTART + 90_000, restartAt: RESTART, actedRestart: null, agents: [], paneText: () => null, lastActive: () => null,
    deliveries: () => [delivery(68)], moved: () => false, resentAt: {}, ...over });
  assert.equal(facts({}).killed.length, 1, "control");
  assert.equal(facts({ now: RESTART + 25 * 3_600_000 }).killed.length, 0, "a day-old restart is history, not an outage to recover from");
  assert.equal(facts({ actedRestart: RESTART }).killed.length, 0, "the last restart acted on is not acted on twice");
  assert.equal(facts({ restartAt: null }).killed.length, 0, "a restart that could not be read is not guessed");
  assert.equal(facts({ moved: (_s: string, _from: number, to: number) => to > RESTART + 60_000 }).killed.length, 0, "a session that acted AFTER the restart, before the tick noticed");
});

test("#2470 the common tick reads NEITHER ledger: with no fresh restart and no interrupted pane the deliveries are never asked for", () => {
  const explode = () => { throw new Error("the ledgers were read on a tick with nothing to recover"); };
  const quiet = recoverableWork({ now: RESTART + 90_000, restartAt: RESTART - 3 * 24 * 3_600_000, actedRestart: null, agents: [{ label: "worker-9", status: "idle" }],
    paneText: () => pane("● Done."), lastActive: () => null, deliveries: explode, moved: () => false, resentAt: {} });
  assert.deepEqual([quiet.killed, quiet.interrupted, quiet.restartActed], [[], [], null]);
  assert.throws(() => recoverableWork({ now: RESTART + 90_000, restartAt: RESTART, actedRestart: null, agents: [], paneText: () => null, lastActive: () => null,
    deliveries: explode, moved: () => false, resentAt: {} }), /ledgers were read/, "CONTROL: a fresh restart DOES ask");
});

test("#2470 (11) `sessionMoved` says `moved` for anything it cannot establish: absence of evidence is not evidence a delivery was killed", () => {
  assert.equal(sessionMoved(() => null)("worker-9", 1, 2), true);
  assert.equal(sessionMoved(() => [])("worker-9", 1, 2), false, "a readable transcript with no assistant entry in the interval: no move");
  assert.equal(sessionMoved(() => [1.5])("worker-9", 1, 2), true);
  assert.equal(sessionMoved(() => [1, 2])("worker-9", 1, 2), false, "strictly between: the delivery's own entry and the restart itself are not moves");
});

test("#2470 the kept-worktree file is beside the wake ledger, with the org's other state", () => {
  assert.equal(keptClaimsPath("/state/wake-ledger"), "/state/kept-claims.json");
  assert.equal(existsSync("/nonexistent-2470"), false);
});

// --- the REAL git and filesystem: the fakes above answer any argv, which is how an invalid one shipped once ------------------------------------

test("#2470 the git argv is VALID for real git: `--no-optional-locks` is a GLOBAL option, so `status` is not given it (the first live run exited 129)", () => {
  const invocation = gitInvocation("/x", ["status", "--porcelain"]);
  assert.deepEqual(invocation, ["-C", "/x", "--no-optional-locks", "status", "--porcelain"], "global option before the subcommand");
  const dir = mkdtempSync(join(tmpdir(), "claim-stall-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: sandboxGitEnv(), encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "-b", "agent/x-1");
    const io = { git: gitRun, exists: pathExists, mtime: statMtime };
    assert.equal(gitRun(dir, ["status", "--porcelain", "--untracked-files=all", "-z"]).status, 0, "real git accepts the argv every reader here builds");
    assert.deepEqual(workAtRisk(io, { worktree: dir, branch: "agent/x-1", repo: dir }), { state: "none", dirty: 0, unpushed: 0 }, "clean, and nothing ahead");
    assert.equal(newestOwnCommit(gitRun, dir, "agent/x-1"), null, "a branch not ahead of main has NO commit of its own: its tip's date is main's");
    assert.equal(newestOwnCommit(gitRun, dir, "origin/agent/x-1"), null, "a ref that does not exist is `null`, not a failure");
    writeFileSync(join(dir, "b.txt"), "two\n");
    const moved = fileMove(io, dir);
    assert.ok(moved !== null && Math.abs(moved - Date.now()) < 60_000, `an untracked file is a move at its mtime, read ${moved}`);
    assert.equal(workAtRisk(io, { worktree: dir, branch: "agent/x-1", repo: dir }).state, "at-risk", "untracked work is at risk");
    git("add", "b.txt");
    git("commit", "-q", "-m", "own");
    const own = newestOwnCommit(gitRun, dir, "agent/x-1");
    assert.ok(own !== null && Math.abs(own - Date.now()) < 60_000, "a commit ahead of main is a move");
    assert.deepEqual(workAtRisk(io, { worktree: dir, branch: "agent/x-1", repo: dir }), { state: "at-risk", dirty: 0, unpushed: 1 }, "committed, and on no remote");
    git("update-ref", "refs/remotes/origin/agent/x-1", "HEAD");
    assert.equal(workAtRisk(io, { worktree: dir, branch: "agent/x-1", repo: dir }).state, "none", "pushed: it exists elsewhere, so it is not at risk");
    assert.equal(gitRun(join(dir, "missing"), ["status"]).status === 0, false, "a directory that is not a repository is a failure, which every caller reads as UNREADABLE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the tick, driven through its ENTRY: a release that does not land is not a quiet tick --------------------------------------------------

const WAKE_ENTRY = fileURLToPath(new URL("./wake.ts", import.meta.url));

test("#2470 the wake ENTRY performs the gate's release order, and one that does NOT land is an ATTENTION exit with a line, never a quiet tick", () => {
  const dir = mkdtempSync(join(tmpdir(), "claim-stall-tick-"));
  try {
    const stub = join(dir, "herdr");
    writeFileSync(stub, `#!/bin/sh
case "$*" in
  *"workspace list"*) echo '{"result":{"workspaces":[{"label":"worker-7","workspace_id":"w1","agent_status":"idle"}]}}';;
  *"workspace close"*) echo "herdr: refused" >&2; exit 1;;
  *) echo '{}';;
esac
`);
    chmodSync(stub, 0o755);
    // `gh` is a STUB too: the release reads the row's labels before it closes anything, and nothing here may reach the real one.
    const ghStub = join(dir, "gh");
    writeFileSync(ghStub, `#!/bin/sh
echo '{"labels":[{"name":"in-progress"},{"name":"session:worker-7"}]}'
`);
    chmodSync(ghStub, 0o755);
    const release = { session: "worker-7", cause: "claim-stalled", subject: "row-2407", discriminator: "release-stalled", prompt: "RELEASE",
      causeKey: "worker-7/claim-stalled/row-2407/release-stalled",
      release: { row: 2407, session: "worker-7", why: "stalled", branch: null, worktree: null, idleMinutes: 250, nudgedAt: 1 } };
    const tick = (stdin: string) => spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`, `--worktrees-dir=${dir}`], {
      input: stdin, encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const ran = tick(`${JSON.stringify(release)}\n`);
    assert.match(ran.stdout, /NOT RELEASED worker-7's workspace could not be closed/, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /UNDELIVERED claim release not done -- worker-7's workspace could not be closed -- nothing was changed/);
    assert.equal(ran.status, 1, "the release did not land: ATTENTION, the same exit an order with nowhere to go gets");
    // THE CONTROL: with nothing to deliver at all the same entry is QUIET, so the exit above is the release's doing.
    const quiet = tick("");
    assert.deepEqual([quiet.status, quiet.stdout], [0, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the review's findings, each pinned ------------------------------------------------------------------------------------------------------

test("#2470 a release is REFUSED, before anything is closed, when the row no longer carries the holder's label (or the labels cannot be read)", () => {
  const gone = releaseHost({ labels: ["in-progress", "session:worker-9"], world: { unpushed: 1 } });
  const got = performRelease(STALL, gone.deps);
  assert.equal(got.released, false);
  assert.match(got.why, /`session:worker-7` is no longer on #2407 -- a stale order/);
  assert.deepEqual([gone.runs.some((a) => a.includes("close")), gone.decline(), gone.comments().length], [false, undefined, 0],
    "a stale order must not end whatever now runs under a REUSED address, and must not touch the row");
  const unreadable = releaseHost({ labels: null, world: { unpushed: 1 } });
  assert.match(performRelease(STALL, unreadable.deps).why, /could not read #2407's labels -- not released, retried next tick/);
  assert.equal(unreadable.runs.some((a) => a.includes("close")), false);
  assert.equal(performRelease(STALL, releaseHost({ world: { unpushed: 1 } }).deps).released, true, "CONTROL: the holder still holds it");
});

test("#2470 the release comment says the truth about the pool: a row that was NOT `ready` before the claim is not back in it", () => {
  const notReady = releaseHost({ wasNotReady: true, world: { unpushed: 1 } });
  assert.equal(performRelease(STALL, notReady.deps).released, true);
  assert.match(notReady.comment(), /NOT `ready` before it was claimed, so it is NOT back in the pool: `product-manager` promotes it again/);
  assert.equal(/back in the pool, and a fresh instance takes it/.test(notReady.comment()), false);
  const ready = releaseHost({ world: { unpushed: 1 } });
  performRelease(STALL, ready.deps);
  assert.match(ready.comment(), /back in the pool, and a fresh instance takes it/, "CONTROL: a row that was `ready` is");
});

test("#2470 a NUDGE is a plain prompt: it carries `resume`, and a standing seat is not `/clear`ed before it", () => {
  const { orders } = tickWith({ commit: null }, [claim(N_MIN + 200, { session: "worker-capture" })], { rows: [row(2407, ["in-progress", "session:worker-capture"])] });
  assert.equal(orders[0].resume, true);
  const sent: string[][] = [];
  deliver([orders[0] as never], [{ label: "worker-capture", status: "idle" }], ["worker-capture"], { run: (args: string[]) => { sent.push(args); return ""; } });
  assert.equal(sent.some((a) => a.includes("/clear")), false, "a standing seat mid-build keeps the context the nudge is ABOUT");
  assert.equal(sent.filter((a) => a.includes("prompt")).length, 1);
});

test("#2470 with the open ROWS or the open PULL REQUESTS unread, NOTHING is evaluated and nothing is written (a refusal is not 'none open')", () => {
  const calls: string[] = [];
  const log: string[] = [];
  const deps = { tick: (() => { calls.push("tick"); return []; }) as never, merged: (() => { calls.push("merged"); return null; }) as never,
    elsewhere: (() => { calls.push("elsewhere"); return undefined; }) as never, log: (l: string) => log.push(l) };
  assert.deepEqual(claimStallsNow(null, [], [], deps), []);
  assert.deepEqual(claimStallsNow([row(2407)], [], null, deps), []);
  assert.deepEqual(calls, [], "neither the tick nor the merged-PR read ran");
  assert.match(log.join(""), /open rows could not be read.*open pull requests could not be read/s);
  claimStallsNow([row(2407)], [], [], deps);
  assert.deepEqual(calls, ["merged", "elsewhere", "tick"], "CONTROL: with both read, a claimed row asks for the merged list and the other repository's, and runs the tick");
  calls.length = 0;
  claimStallsNow([{ number: 1, labels: [] }], [], [], deps);
  assert.deepEqual(calls, ["tick"], "and a tick with nothing claimed pays for neither the merged-PR read nor the other repository's");
});

test("#2470 an EXPECTED hold (a blocked holder with work) is not said every tick; a read that could not be made is", () => {
  const expected = tickWith({ unpushed: 2 }, [claim(20)], { blockedBy: [2258] });
  assert.deepEqual(expected.orders, []);
  assert.equal(/HELD/.test(expected.log.join("")), false, "expected: silent");
  const unreadable = tickWith({ broken: 128 }, [claim(20)], { blockedBy: [2258] });
  assert.equal(/not evaluated/.test(unreadable.log.join("")), true, "CONTROL: an unreadable worktree is said");
});

test("#2470 (9) a pane interrupted for LESS than the settle time is left alone (a person who pressed Esc is about to type); a settled one is resumed", () => {
  const agents = [{ label: "worker-7", status: "idle" }];
  const seen = (lastActive: number | null) => recoverableWork({ now: NOW, restartAt: null, actedRestart: null, agents, paneText: () => pane(INTERRUPTED_LINE),
    lastActive: () => lastActive, deliveries: () => [], moved: () => false, resentAt: {} }).interrupted;
  assert.deepEqual(seen(NOW - 2 * MIN), [], "silent for 2 minutes: a person may be typing");
  assert.deepEqual(seen(NOW - INTERRUPTED_SETTLE_MS + 1), [], "one millisecond short");
  assert.deepEqual(seen(NOW - INTERRUPTED_SETTLE_MS), ["worker-7"], "settled: resumed");
  assert.deepEqual(seen(null), [], "a session whose last activity cannot be established is left alone");
  assert.match(readFileSync(new URL("./wake.ts", import.meta.url), "utf8"), /if you were stopped on purpose, say so on the row and stop/,
    "and the prompt itself tells a deliberately stopped session what to do");
});

test("#2841 every argv wake.ts sends to row-claim.ts passes row-claim's REAL flag guard, and the guard refuses one flag short of that", () => {
  // Callers covered: `performRelease` (decline: --keep-worktree, --predecessor-gone, --answer=), `spawnClaimer.claim` (claim: fresh and --adopt=),
  // and `releaseClaim`'s undo (decline, plain and --keep-worktree). Those are every `ROW_CLAIM` spawn in wake.ts; no other src/ file spawns it.
  const argvs: { from: string; args: string[] }[] = [];
  const release = (o: { answer?: string; spare?: boolean }, from: string) => {
    const r = releaseHost({ world: { dirty: [{ file: "a.mjs", ago: 900 }], unpushed: 2 } });
    performRelease({ ...STALL, ...(o.answer === undefined ? {} : { answer: o.answer }) }, r.deps);
    argvs.push({ from, args: r.decline()!.args.slice(1) });
  };
  release({}, "performRelease, gone worker, tree kept");
  release({ answer: "product-manager" }, "performRelease with --answer=");
  const adopt = spawnHost({ kept: KEPT });
  adopt.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  argvs.push({ from: "spawnClaimer.claim --adopt=", args: adopt.claimArgs() });
  const fresh = spawnHost({ kept: null });
  fresh.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  argvs.push({ from: "spawnClaimer.claim fresh", args: fresh.claimArgs() });
  const undone = spawnHost({ kept: KEPT, vanish: true });
  undone.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  argvs.push({ from: "releaseClaim undo, adopted", args: undone.execs.find((e) => e.args[1] === "decline")!.args.slice(1) });

  assert.ok(argvs.some((a) => a.args.includes("--predecessor-gone")), "the population includes the flag this row is about");
  for (const { from, args } of argvs) {
    assert.deepEqual(unknownFlags(args.slice(1), ROW_CLAIM_FLAGS), [], `${from}: ${args.join(" ")}`);
  }
  // THE POSITIVE CONTROL: the same argv against the list WITHOUT `--predecessor-gone` is refused, as it was on main since #2748.
  const without = ROW_CLAIM_FLAGS.filter((f: string) => f !== "--predecessor-gone");
  const gone = argvs.find((a) => a.args.includes("--predecessor-gone"))!;
  assert.deepEqual(unknownFlags(gone.args.slice(1), without), ["--predecessor-gone"]);
});

// --- #2864: a kept record whose tree was later removed is dropped, and a merged leftover branch with it ---------------------------------

test("#2864 the claim DROPS a kept record whose tree is gone and deletes its leftover branch with `-d` BEFORE claiming; a record whose tree exists is untouched", () => {
  const gone = spawnHost({ kept: KEPT, treeGone: true });
  gone.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  const deletes = gone.execs.filter((e) => e.args[0] === "git" && e.args[1] === "branch");
  assert.deepEqual(deletes.map((e) => e.args), [["git", "branch", "-d", BRANCH]], "`-d`, never `-D`, on the recorded branch");
  assert.ok(gone.execs.indexOf(deletes[0]) < gone.execs.findIndex((e) => e.args[1] === "claim"), "before the claim that would refuse over it");
  // THE CONTROL: the tree exists, so the record is adopted and nothing is deleted.
  const kept = spawnHost({ kept: KEPT });
  kept.claimer.claim(SPAWN_ORDER, "worker-2407", {});
  assert.equal(kept.execs.some((e) => e.args[0] === "git" && e.args[1] === "branch"), false);
});

/** A scratch `origin`/primary pair: `main` published, plus one local branch that is MERGED into main and one holding a commit nowhere else. */
function keptScratch() {
  const root = mkdtempSync(join(tmpdir(), "a11y-2864-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: sandboxGitEnv(), encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("branch", "agent/merged-9");
  git("checkout", "-q", "-b", "agent/unmerged-8");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work only here");
  git("checkout", "-q", "main");
  const keptPath = join(root, "kept-claims.json");
  const record = (branch: string, worktree: string) => ({ worktree, branch, from: "worker-1", at: NOW, why: "merged", dirty: 0, unpushed: 0 });
  const branches = () => git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);
  return { root, keptPath, git, record, branches };
}

test("#2864 pruneGoneKeptClaims over a REAL repo: a gone tree's record goes and its MERGED branch with it; an UNMERGED branch stays and is named; an existing tree's record is untouched", () => {
  const s = keptScratch();
  try {
    const live = join(s.root, "live-tree");
    writeFileSync(s.keptPath, JSON.stringify({
      9: s.record("agent/merged-9", join(s.root, "gone-a")),
      8: s.record("agent/unmerged-8", join(s.root, "gone-b")),
      7: s.record("agent/live-7", live),
    }));
    // The kept tree for #7 exists on disk; the other two were removed.
    execFileSync("mkdir", [live]);
    const lines = pruneGoneKeptClaims(s.keptPath, { primary: s.root, env: {} });
    assert.deepEqual(Object.keys(readKeptClaims(s.keptPath)), ["7"], "exactly the records whose trees are gone are dropped");
    assert.deepEqual(s.branches().sort(), ["agent/unmerged-8", "main"], "the merged branch is deleted; the unmerged one is NEVER deleted");
    assert.equal(lines.length, 2);
    assert.match(lines.find((l) => l.includes("#9")) ?? "", /deleted its merged branch agent\/merged-9/);
    assert.match(lines.find((l) => l.includes("#8")) ?? "", /left the branch agent\/unmerged-8/);
    // IDEMPOTENT: the second tick has nothing left to say.
    assert.deepEqual(pruneGoneKeptClaims(s.keptPath, { primary: s.root, env: {} }), []);
    assert.deepEqual(Object.keys(readKeptClaims(s.keptPath)), ["7"]);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("#2864 a record is dropped even when git REFUSES the branch, so the refusal that follows is the claim's own and names the branch", () => {
  const s = keptScratch();
  try {
    writeKeptClaims(s.keptPath, { 8: s.record("agent/unmerged-8", join(s.root, "gone")) });
    pruneGoneKeptClaims(s.keptPath, { primary: s.root, env: {} });
    assert.deepEqual(readKeptClaims(s.keptPath), {});
    assert.ok(s.branches().includes("agent/unmerged-8"));
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("#2864 the wake ENTRY prunes a gone tree's kept record on a QUIET tick -- empty stdin, nothing queued -- and a record whose tree exists survives it", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2864-tick-"));
  try {
    // The tick's primary under `--worktrees-dir=<dir>` is `<dir>/<basename of the real primary>`: make THAT a real repo with a merged branch.
    const primary = join(dir, basename(PRIMARY_CHECKOUT));
    execFileSync("mkdir", [primary]);
    const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args], { env: sandboxGitEnv(), encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    git("branch", "agent/merged-9");
    const live = join(dir, "live-tree");
    execFileSync("mkdir", [live]);
    const record = (branch: string, worktree: string) => ({ worktree, branch, from: "worker-1", at: NOW, why: "merged", dirty: 0, unpushed: 0 });
    writeFileSync(join(dir, "kept-claims.json"), JSON.stringify({ 9: record("agent/merged-9", join(dir, "gone")), 7: record("agent/live-7", live) }));
    const tick = () => spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`, `--worktrees-dir=${dir}`], {
      input: "", encoding: "utf8", env: { ...process.env, HOME: dir, PATH: process.env.PATH ?? "" } });
    const ran = tick();
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /DROPPED the kept record .*deleted its merged branch agent\/merged-9 \(#9\)/);
    assert.deepEqual(Object.keys(readKeptClaims(join(dir, "kept-claims.json"))), ["7"]);
    assert.equal(git("branch", "--list", "agent/merged-9").trim(), "", "the merged leftover branch went with it");
    // A SECOND quiet tick has nothing to say: the exit is the same and the output is empty.
    const again = tick();
    assert.deepEqual([again.status, again.stdout], [0, ""]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- #3075: a claim whose pull request is open in ANOTHER tracked repository is not one that holds nothing built -----------------------------------

/** `a11ign/agent-org`'s #38 for #3039: the row is in one repository, the work and its pull request in the other. */
const ELSEWHERE_PR = { number: 38, headRefName: BRANCH, repoKey: "agent-org", repo: "a11ign/agent-org", reviewDecision: "APPROVED" };
const CLEAN = { commit: null, refExists: false, worktreeExists: false } as const;

test("#3075 (8) an OPEN edge and an empty home list do NOT release a claim whose branch has an open PR in the OTHER repository: it reads `pr-owned`", () => {
  const held = tickWith(CLEAN, [claim(20)], { blockedBy: [2258], elsewhere: { open: [ELSEWHERE_PR], merged: [] } });
  assert.deepEqual(held.orders, []);
  const facts = claimFactsFrom({ row: 2407, session: "worker-7", waiting: null, blockedBy: [2258], comments: [claim(20)], openPrs: [], mergedPrs: [],
    elsewhere: { open: [ELSEWHERE_PR], merged: [] }, repo: REPO }, host(CLEAN).io) as Facts;
  assert.equal(readClaim(facts, { now: NOW, restartAt: null, nudge: null }).kind, "pr-owned");
  assert.deepEqual(facts.ownPrs, [ELSEWHERE_PR], "the idle-claimant overlay is handed the pull request too, whichever repository it is in");
});

test("#3075 (8) POSITIVE CONTROLS: no PR in either repository IS still released; a PR in THIS repository is unchanged; another row's PR over there is nobody's", () => {
  const none = tickWith(CLEAN, [claim(20)], { blockedBy: [2258], elsewhere: { open: [], merged: [] } });
  assert.equal(none.orders[0].release!.why, "blocked", "the rule keeps firing for its real subject");
  assert.deepEqual(none.orders[0].release!.edges, [2258]);
  const home = { number: 9, headRefName: BRANCH };
  assert.deepEqual(tickWith(CLEAN, [claim(20)], { blockedBy: [2258], prs: [home], elsewhere: { open: [], merged: [] } }).orders, [], "home PR, other repo empty");
  assert.deepEqual(tickWith(CLEAN, [claim(20)], { blockedBy: [2258], prs: [home] }).orders, [], "home PR, a project with one code repository: exactly as before");
  const other = { ...ELSEWHERE_PR, headRefName: "agent/some-other-row-2500" };
  assert.equal(tickWith(CLEAN, [claim(20)], { blockedBy: [2258], elsewhere: { open: [other], merged: [] } }).orders[0].release!.why, "blocked");
  assert.equal(tickWith(CLEAN, [claim(20)], { blockedBy: [2258] }).orders[0].release!.why, "blocked", "no `elsewhere` at all: the single-repository project");
});

test("#3075 an OTHER repository whose open list could not be read SKIPS the claim with a reason, and never releases it", () => {
  const unread = tickWith(CLEAN, [claim(20)], { blockedBy: [2258], elsewhere: { open: null, merged: [] } });
  assert.deepEqual(unread.orders, []);
  assert.match(unread.log.join(""), /#2407: the other tracked repository's open pull requests could not be read.* -- not evaluated\./);
  assert.equal(tickWith(CLEAN, [claim(20)], { blockedBy: [2258], elsewhere: { open: [], merged: [] } }).orders.length, 1,
    "CONTROL: the same claim with the list read as empty IS released, so the skip is the unread list's and nothing else's");
  const stalled = tickWith({ commit: 40, push: 40 }, [claim(600)], { elsewhere: { open: null, merged: null } });
  assert.deepEqual(stalled.orders, [], "and a quiet claim is not nudged on a list it could not read either");
});

test("#3075 (10) a PR MERGED in the other repository releases like a home one, and an unread merged list there costs a release, never causes one", () => {
  const merged = [{ number: 38, headRefName: BRANCH, mergedAt: iso(ago(30)), repoKey: "agent-org", repo: "a11ign/agent-org" }];
  const { orders } = tickWith({ commit: 40, push: 40 }, [claim(600)], { merged: [], elsewhere: { open: [], merged } });
  assert.equal(orders[0].release!.why, "merged");
  assert.equal(orders[0].release!.mergedPr, 38);
  assert.equal(tickWith({ commit: 40, push: 40 }, [claim(600)], { merged: [], elsewhere: { open: [ELSEWHERE_PR], merged } }).orders.length, 0,
    "CONTROL: with a second open PR for the row over there it is not released, as for a home one");
  assert.equal(tickWith({ commit: 40, push: 40 }, [claim(600)], { merged: [], elsewhere: { open: [], merged: null } }).orders.length, 0, "unread: no release");
  const homeMerged = [{ number: 2497, headRefName: BRANCH, mergedAt: iso(ago(30)) }];
  assert.equal(tickWith({ commit: 40, push: 40 }, [claim(600)], { merged: homeMerged, elsewhere: { open: [], merged: null } }).orders[0].release!.mergedPr, 2497,
    "and the home list that WAS read still counts when the other one was not");
});

// --- #3076: a release names a pull request in another tracked repository by its KEY and number ------------------------------------------------

/** A key is the repository's, and `#38` alone is read as the HOME repository's: `agent-org#38` has `#38` inside it, so the bare form is "not preceded by a key". */
const BARE = (n: number) => new RegExp(`(^|[^\\w-])#${n}\\b`);
const MERGED_ELSEWHERE = [{ number: 38, headRefName: BRANCH, mergedAt: iso(ago(30)), repoKey: "agent-org", repo: "a11ign/agent-org" }];
const goneWith = (ownPrs: object[]) => {
  const facts = { ...withOpenPr(), openPrs: ownPrs.length, ownPrs } as Facts;
  const reading = claimReading(facts, { now: NOW, restartAt: null, nudge: null, agents: GONE_LISTING, goneSince: NOW - GONE_CONFIRM_MS });
  return claimStalledOrders([{ facts, reading }], NOW)[0];
};

test("#3076 a MERGED release for a pull request in another repository reads `agent-org#38` in the order's prompt, and the number stays a number", () => {
  const { orders } = tickWith({ commit: 40, push: 40 }, [claim(600)], { merged: [], elsewhere: { open: [], merged: MERGED_ELSEWHERE } });
  assert.match(orders[0].prompt, /agent-org#38 merged and the row stayed open/);
  assert.doesNotMatch(orders[0].prompt, BARE(38), "no bare `#38`, which is a pull request of the HOME repository");
  assert.equal(orders[0].release!.mergedPr, 38);
});

test("#3076 CONTROL: a MERGED release for a HOME pull request is byte-identical to today's, with no repository field on it", () => {
  const merged = [{ number: 2497, headRefName: BRANCH, mergedAt: iso(ago(30)) }];
  const { orders } = tickWith({ commit: 40, push: 40 }, [claim(600)], { merged, elsewhere: { open: [], merged: [] } });
  assert.match(orders[0].prompt, /held by worker-7: #2497 merged and the row stayed open\.$/);
  assert.equal("mergedPrRepoKey" in orders[0].release!, false);
  assert.deepEqual(orders[0].release!.mergedPr, 2497);
});

test("#3076 a GONE release with open pull requests names each by its key, a home one as it always was, and `openPrs` stays numbers", () => {
  const elsewhere = { number: 38, headRefName: BRANCH, repoKey: "agent-org", repo: "a11ign/agent-org" };
  const only = goneWith([elsewhere]);
  assert.match(only.prompt, /agent-org#38 is still open/);
  assert.doesNotMatch(only.prompt, BARE(38));
  assert.deepEqual(only.release!.openPrs, [38]);
  const both = goneWith([OPEN_PR, elsewhere]);
  assert.match(both.prompt, /#9, agent-org#38 is still open/, "the home number keeps its bare spelling beside the qualified one");
  assert.deepEqual(both.release!.openPrs, [9, 38]);
  const home = goneWith([OPEN_PR]);
  assert.match(home.prompt, /and #9 is still open/);
  assert.equal("openPrRepoKeys" in home.release!, false, "CONTROL: a home-only release carries no key field, so it is today's order");
});

test("#3076 the release COMMENT wake.ts writes carries the key for a merged and for an open pull request elsewhere, and is today's for a home one", () => {
  const merged = releaseHost();
  performRelease({ ...STALL, why: "merged", mergedPr: 38, mergedPrRepoKey: "agent-org", answer: "product-manager" }, merged.deps);
  assert.match(merged.comment(), /agent-org#38 MERGED and this row stayed open/);
  assert.doesNotMatch(merged.comment(), BARE(38));
  const home = releaseHost();
  performRelease({ ...STALL, why: "merged", mergedPr: 2497, answer: "product-manager" }, home.deps);
  assert.match(home.comment(), /and #2497 MERGED and this row stayed open/);
  const open = releaseHost({ labels: ["in-progress", "session:worker-7"], wasNotReady: true });
  performRelease({ ...STALL, why: "gone", idleMinutes: null, nudgedAt: null, openPrs: [9, 38], openPrRepoKeys: [undefined, "agent-org"], answer: "product-manager" }, open.deps);
  assert.match(open.comment(), /#9, agent-org#38 is OPEN/);
  assert.doesNotMatch(open.comment(), BARE(38));
});

test("#3075 the gate reads the other repositories ONCE, by the scope enumeration's own readers, tagged with the key, and `null` when one was refused", () => {
  const scopes = [{ key: "", code: { repo: "a11ign/a11ign" }, tracker: { repo: "a11ign/a11ign" } }, { key: "agent-org", code: { repo: "a11ign/agent-org" }, tracker: null }];
  const asked: (string | undefined)[] = [];
  const run = (args: string[], repo?: string) => {
    asked.push(repo);
    return args.includes("merged") ? JSON.stringify([{ number: 7, headRefName: "agent/x-1", mergedAt: iso(NOW) }]) : JSON.stringify([{ number: 38, headRefName: BRANCH }]);
  };
  const read = readElsewherePrs(scopes, run as never)!;
  assert.deepEqual(asked, ["a11ign/agent-org", "a11ign/agent-org"], "only the OTHER repository is asked, once per list");
  assert.deepEqual(read.open, [{ number: 38, headRefName: BRANCH, repoKey: "agent-org", repo: "a11ign/agent-org" }]);
  assert.equal(read.merged![0].repoKey, "agent-org");
  assert.equal(readElsewherePrs([scopes[0]], run as never), undefined, "CONTROL: a project with one code repository has no `elsewhere`, and asks nothing");
  const refused = readElsewherePrs(scopes, (() => { throw new Error("HTTP 403"); }) as never)!;
  assert.deepEqual([refused.open, refused.merged], [null, null], "a refusal is `null`, never `[]`");
});

// --- (#4017) an idle holder whose OWN pull request is younger than the clock's interval is waiting on the review the org owes --------------

/**
 * THE FIVE `claim-stalled` NUDGES #4017 MEASURED, each typed while a pull request closing the row was open (read 2026-10-07): the pull request's age in whole
 * minutes at the nudge (`created_at` from `gh api repos/<repo>/pulls/<n>`, the nudge time from the wake ledger's `nudge-<ms>` key), and its repository.
 * None had a reviewer seat yet (the gate woke `reviewer-<n>` 14 to 160 minutes AFTER the nudge) and none carried a hold or `awaiting-evidence`, so the #2999
 * overlay read each as an idle holder with no wait the org can read. A reading at a moment: the ages are the ones the nudge times gave.
 */
const NUDGED_WITH_A_PR_OPEN = [
  { row: 3560, pr: 210, repoKey: "agent-org", ageMin: 54 }, { row: 3591, pr: 211, repoKey: "agent-org", ageMin: 53 },
  { row: 3719, pr: 3721, repoKey: undefined, ageMin: 74 }, { row: 3787, pr: 3802, repoKey: undefined, ageMin: 59 },
  { row: 3993, pr: 3997, repoKey: undefined, ageMin: 52 },
];
const IDLE_HOLDER = [...CEO_ORCH, { label: "worker-7", status: "idle" }];
const IDLE_FOR_N = { now: NOW, restartAt: null, nudge: null, agents: IDLE_HOLDER, goneSince: null, idleSince: ago(50) } as Parameters<typeof claimReading>[1];
/** An open pull request of the holder's: green, no review asked of anybody, nothing held -- the shape every one of the five had. */
const unreviewedPr = (ageMs: number | undefined, over: object = {}) => ({ number: 9, headRefName: BRANCH, reviewDecision: "REVIEW_REQUIRED", labels: [{ name: "session:worker-7" }],
  checksPending: false, ...(ageMs === undefined ? {} : { createdAt: iso(NOW - ageMs) }), ...over });
const holderWith = (pr: object | null): Facts => ({ ...withOpenPr(), openPrs: pr === null ? 0 : 1, ownPrs: pr === null ? [] : [pr],
  comment: ago(60), commit: ago(60), push: ago(60) } as Facts);

test("#4017 each of the five measured shapes -- an idle holder, a pull request of its own opened under an hour ago, no reviewer yet -- reads `pr-owned`, never a nudge", () => {
  for (const { row, pr, repoKey, ageMin } of NUDGED_WITH_A_PR_OPEN) {
    const shape = holderWith(unreviewedPr(ageMin * MIN, { number: pr, ...(repoKey === undefined ? {} : { repoKey }) }));
    assert.deepEqual(claimReading(shape, IDLE_FOR_N), { kind: "pr-owned" }, `#${row}: ${repoKey ?? "a11ign"}#${pr}, ${ageMin} minutes old`);
  }
});

test("#4017 CONTROLS: the same holder is still nudged when its pull request is older than the interval, has no age on record, or there is none", () => {
  const nudged = (facts: Facts) => claimReading(facts, IDLE_FOR_N);
  const stood = nudged(holderWith(unreviewedPr(STALL_INTERVAL_MS)));
  assert.deepEqual([stood.kind, (stood as { idle?: boolean }).idle], ["nudge", true], "AT the interval it is no longer young: #2968 sat 171 minutes behind `pr-owned`");
  assert.equal(nudged(holderWith(unreviewedPr(STALL_INTERVAL_MS - 1))).kind, "pr-owned", "one millisecond short of it is still young");
  assert.equal(nudged(holderWith(unreviewedPr(undefined))).kind, "nudge", "an age the list did not carry is not a young pull request: absence is not proof");
  assert.equal(nudged(holderWith(unreviewedPr(undefined, { createdAt: "not a date" }))).kind, "nudge", "nor is one that does not parse");
  const none = nudged(holderWith(null));
  assert.deepEqual([none.kind, (none as { idle?: boolean }).idle], ["nudge", true], "NO open pull request and no wait is nudged, as before");
  const oldAndNew = nudged({ ...holderWith(unreviewedPr(STALL_INTERVAL_MS + MIN)), openPrs: 2,
    ownPrs: [unreviewedPr(STALL_INTERVAL_MS + MIN), unreviewedPr(10 * MIN, { number: 10 })] } as Facts);
  assert.equal(oldAndNew.kind, "pr-owned", "a holder that opened a second pull request ten minutes ago has just MOVED");
});

test("#4017 the tick: a young pull request of an idle holder sends nothing, and the same one aged past the interval sends the idle nudge", () => {
  const memory = () => ({ 2407: { session: "worker-7", idleSince: ago(50) } });
  const young = tickWith({}, [claim(600)], { agents: IDLE_HOLDER, memory: memory(), prs: [{ ...OPEN_PR, createdAt: iso(ago(54)) }] });
  assert.deepEqual(young.orders, [], "a pull request opened 54 minutes ago is the review the org owes, not the holder stalling");
  const aged = tickWith({}, [claim(600)], { agents: IDLE_HOLDER, memory: memory(), prs: [{ ...OPEN_PR, createdAt: iso(ago(N_MIN + 1)) }] });
  assert.equal(aged.orders.length, 1, "CONTROL: the same fixture a minute past the interval still reaches the holder");
  assert.match(aged.orders[0].prompt, /IDLE FOR \d+ MINUTES WITH NO WAIT THE ORG CAN READ/);
});
