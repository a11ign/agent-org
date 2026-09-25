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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { decide, claimStallTick, CAUSES, START_CAUSES, JUDGMENT_CAUSES, GH_READS } from "./work-gate.mjs";
import { profileFor } from "./worker-profile.mjs";
import {
  WAKE_TTL_MS, MAX_DELIVERIES, performRelease, spawnClaimer, spawnedPrompt, deliver, consecutiveClean, drainInForce, isReleaseLine,
  cyclesReport, readLedger, deliveryCounts, readLedgerDeliveries, readDeliveredHandoffs, recoverInterruptedWork, recoverableWork,
  queueHandoff, readHandoffs, handoffBatches, recentlyVoidedKeys, sessionMoved, VOIDED, keptClaimsPath,
} from "./wake.mjs";
import { claimRecordComment, declineRow, claimWithWorktree, worktreeTargetReason, worktreeFlagsReason } from "./row-claim.mjs";
import { CLAIM_RECORD_MARKER } from "./claim-labels.mjs";
import {
  CLAIM_STALLED, STALL_INTERVAL_MS, NUDGE_OFFER_MS, claimRecordOf, commentMove, workAtRisk, fileMove, claimReading,
  claimFactsFrom, readClaim, nextStallState, claimStalledOrders, paneInterrupted, killedDeliveries, readHerdrRestart,
  RESTART_RESEND_WINDOW_MS, INTERRUPTED_TEXT, gitRun, gitInvocation, newestOwnCommit, statMtime, pathExists,
} from "./claim-stall.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { execFileSync } from "node:child_process";

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
type Release = { row: number; session: string; why: string; edges?: number[]; answer?: string; mergedPr?: number };
type Order = { session: string; cause: string; causeKey: string; prompt: string; release?: Release };
type Facts = Parameters<typeof claimReading>[0];
type Stalls = NonNullable<Parameters<typeof decide>[0]["claimStalls"]>;

/** The claim record exactly as `row-claim.mjs` writes it -- the REAL writer, so a change to its format breaks these. */
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
    throw new Error(`unexpected git ${cmd}`);
  };
  const mtimes = new Map(dirty.map((d) => [`${WT}/${d.file}`, ago(d.ago)]));
  return { calls, io: { git, exists: (p: string) => p === WT && w.worktreeExists !== false, mtime: (p: string) => mtimes.get(p) ?? null } };
}

/** A whole tick over one claimed row, with the nudge memory in a map that survives between calls. */
function tickWith(world: World, comments: Comment[], { rows = [row(2407)], memory = {} as Record<string, unknown>, prs = [] as object[],
  merged = null as object[] | null, restartAt = null as number | null, now = NOW, blockedBy = [] as number[] } = {}) {
  const h = host(world, now);
  const log: string[] = [];
  const claimed = rows.map((r) => (r.number === 2407 && blockedBy.length > 0
    ? { ...r, blockedBy: { nodes: blockedBy.map((n) => ({ number: n, state: "OPEN" })) } } : r));
  const orders = claimStallTick({ rows: claimed, claimedComments: claimed.map((r) => ({ number: r.number, comments })), openPrs: prs,
    mergedPrs: merged, io: h.io, repo: REPO, now, restartAt, stateDir: "/state",
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

test("#2470 the nudge is offered for exactly the ledger's window, so it is ONE delivery and never a stream toward MAX_DELIVERIES", () => {
  assert.equal(NUDGE_OFFER_MS, WAKE_TTL_MS, "claim-stall.mjs cannot import wake.mjs, so equality is pinned here");
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

test("#2470 a second reading with nothing moved RELEASES; with something moved it does NOT (the nudge memory carries between ticks)", () => {
  const memory: Record<string, unknown> = {};
  const comments = [claim(N_MIN * 3)];
  const first = tickWith({ commit: null }, comments, { memory });
  assert.equal(first.orders.length, 1, "first reading: the nudge");
  assert.deepEqual(Object.keys(memory), ["2407"], "and it is WRITTEN DOWN, or a released row would carry no memory of it");

  // Inside the grace: the SAME nudge is re-offered (same key, so the ledger drops it) and nothing is released.
  const soon = tickWith({ commit: null }, comments, { memory, now: NOW + 5 * MIN });
  assert.equal(soon.orders.length, 1);
  assert.equal(soon.orders[0].causeKey, first.orders[0].causeKey, "byte-identical, so it is one delivery");
  assert.equal(soon.orders.some((o) => o.release), false);

  // After the offer window the nudge is no longer re-offered, and there is still no release until N after it.
  const quiet = tickWith({ commit: null }, comments, { memory, now: NOW + NUDGE_OFFER_MS + MIN });
  assert.deepEqual(quiet.orders, [], "one nudge, then silence for the rest of the grace");

  // A second reading N after the nudge with nothing moved: the release.
  const later = NOW + STALL_INTERVAL_MS + MIN;
  const second = tickWith({ commit: null }, comments, { memory: { ...memory }, now: later });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].release!.why, "stalled");
  assert.equal(second.orders[0].release!.row, 2407);
  assert.equal(second.orders[0].release!.session, "worker-7");

  // THE CONTROL, one thing changed: a commit AFTER the nudge and the same second reading releases nothing.
  const moved = tickWith({ commit: 60 }, comments, { memory: { ...memory }, now: later });
  assert.deepEqual(moved.orders.filter((o) => o.release), [], "a move after the nudge is not 'nothing moved'");
  assert.deepEqual(Object.keys(moved.memory), [], "and the row's nudge is FORGOTTEN, so a second stall is a first reading and not last week's release");
});

test("#2470 a move just AFTER the nudge, then quiet again for N, is a NEW first reading (a nudge), never a release on the old nudge", () => {
  // The move is old enough that the row is stalled AGAIN, so the cheap "moving" exit does not hide the case: only the reading's own
  // `nudgedAt > lastMoveAt` separates a release from a fresh nudge here.
  const memory = { "2407": { session: "worker-7", nudgedAt: NOW } };
  const later = NOW + STALL_INTERVAL_MS + 5 * MIN;
  const oneMinuteAfterTheNudge = (later - (NOW + MIN)) / MIN;
  const got = tickWith({ commit: oneMinuteAfterTheNudge }, [claim(N_MIN * 4)], { memory: { ...memory }, now: later });
  assert.deepEqual(got.orders.filter((o) => o.release), [], "something moved after the nudge: the old nudge is not a first half of anything");
  assert.equal(got.orders.length, 1, "and the row IS stalled again, so it is nudged afresh");
  assert.match(got.orders[0].causeKey, new RegExp(`nudge-${later}$`), "with a NEW key, one per stall episode");
  const control = tickWith({ commit: null }, [claim(N_MIN * 4)], { memory: { ...memory }, now: later });
  assert.equal(control.orders.filter((o) => o.release).length, 1, "CONTROL: with no move after the nudge it IS the second reading");
});

test("#2470 a comment or a changed file after the nudge also cancels the release, and a nudge from a DIFFERENT holder is not this holder's", () => {
  const memory = { "2407": { session: "worker-7", nudgedAt: NOW } };
  const later = NOW + STALL_INTERVAL_MS + MIN;
  const base = [claim(N_MIN * 3)];
  assert.equal(tickWith({ commit: null }, base, { memory: { ...memory }, now: later }).orders.filter((o) => o.release).length, 1, "control");
  assert.equal(tickWith({ commit: null }, [...base, said(90, "a11ign-ai-workers", "still on it", later)], { memory: { ...memory }, now: later }).orders.length, 0, "a comment");
  assert.equal(tickWith({ dirty: [{ file: "a.mjs", ago: 90 }] }, base, { memory: { ...memory }, now: later }).orders.length, 0, "a file");
  const other = { "2407": { session: "worker-9", nudgedAt: NOW } };
  const fresh = tickWith({ commit: null }, base, { memory: { ...other }, now: later });
  assert.equal(fresh.orders.filter((o) => o.release).length, 0, "another session's nudge on the row is not this one's second reading");
  assert.equal(fresh.orders.length, 1, "it is a FIRST reading: a nudge");
});

test("#2470 a stall release that was not PERFORMED is emitted again as a release, never as a fresh first reading", () => {
  const memory: Record<string, unknown> = { "2407": { session: "worker-7", nudgedAt: ago(130) } };
  const comments = [claim(N_MIN * 3)];
  const first = tickWith({ commit: null }, comments, { memory });
  assert.equal(first.orders[0].release!.why, "stalled");
  assert.deepEqual(Object.keys(memory), ["2407"], "the nudge memory SURVIVES the release order: wake may fail to perform it");
  const second = tickWith({ commit: null }, comments, { memory, now: NOW + 2 * MIN });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].release!.why, "stalled", "the retry is a release again, not a nudge and another two hours");
  // ...and once the release is PERFORMED the row is unclaimed, so it is no longer read and the memory goes.
  const gone = tickWith({ commit: null }, comments, { memory, now: NOW + 4 * MIN, rows: [] });
  assert.deepEqual([gone.orders, Object.keys(memory)], [[], []]);
});

test("#2470 the nudge memory is dropped for a row that is no longer claimed, released or moving -- and only a NUDGE writes it", () => {
  const facts = (n: number) => ({ row: n, session: "worker-7" }) as unknown as Facts;
  const before = { "1": { session: "worker-7", nudgedAt: 5 }, "2": { session: "worker-7", nudgedAt: 6 } };
  const after = nextStallState(before, [
    { facts: facts(1), reading: { kind: "moving", lastMoveAt: 1 } },
    { facts: facts(2), reading: { kind: "nudged", nudgedAt: 6, lastMoveAt: 1 } },
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

// --- the reading, directly ---------------------------------------------------------------------------------------------------------

test("#2470 claimReading is pure in its inputs: a `nudged` row inside the offer window keeps its key, and outside it emits nothing", () => {
  const facts = { row: 1, session: "s", claimedAt: ago(1000), branch: BRANCH, worktree: WT, comment: null, commit: null, push: null,
    file: () => null, work: () => ({ state: "none", dirty: 0, unpushed: 0 }), openPrs: 0, mergedPr: null, waiting: null, blockedBy: [] } as Facts;
  const reading = readClaim(facts, { now: NOW, restartAt: null, nudge: { nudgedAt: NOW - MIN } });
  assert.equal(reading.kind, "nudged");
  assert.equal(claimStalledOrders([{ facts, reading }], NOW).length, 1);
  assert.equal(claimStalledOrders([{ facts, reading }], NOW + NUDGE_OFFER_MS).length, 0);
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
function releaseBoard(labels: string[] = ["in-progress", "session:worker-7", "started", "was-ready"]) {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    return args[1] === "view" ? JSON.stringify({ number: 2416, title: "A row", state: "OPEN", labels: labels.map((name) => ({ name })) }) : "";
  };
  const edits = () => calls.filter((a) => a[1] === "edit").map((a) => ({
    removed: a.flatMap((x, i) => (x === "--remove-label" ? [a[i + 1]] : [])), added: a.flatMap((x, i) => (x === "--add-label" ? [a[i + 1]] : [])) }));
  return { run, calls, edits };
}
const RECORD = [claimRecordComment({ session: "worker-7", branch: BRANCH, worktree: WT })];
const NO_STATUS = () => ({ moved: true }) as const;

test("#2470 (7a) a CLEAN tree with UNPUSHED commits keeps them across the release: `--keep-worktree` removes nothing", () => {
  const board = releaseBoard();
  const removed: string[] = [];
  const kept = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, removeWorktree: ((p: string) => { removed.push(p); return { removed: true }; }) as never });
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

test("#2470 (7a) a DIRTY tree is neither removed nor refused into a stuck claim", () => {
  const dirty = () => ({ removed: false as const, reason: `${WT} has uncommitted change(s) -- refusing to remove it: ?? new-file.mjs`, files: ["?? new-file.mjs"] });
  const stuck = declineRow(2416, "worker-7", { run: releaseBoard().run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    removeWorktree: dirty as never });
  assert.equal(stuck.declined, false, "CONTROL: without the flag a dirty tree refuses the whole decline, so the claim can never be released");
  const board = releaseBoard();
  const freed = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, removeWorktree: dirty as never });
  assert.equal(freed.declined, true, "with it the release goes through and the labels come off");
  assert.ok(board.edits().length === 1);
});

test("#2470 (7b) the respawn's claim ADOPTS the kept tree: nothing is created, nothing is removed, and it is re-stamped to the new instance", () => {
  const order: string[] = [];
  const stamped: [string, string][] = [];
  const claims: { worktree?: string; branch?: string }[] = [];
  const adopt = (over: { owner?: string | null; head?: string; exists?: boolean; claimed?: boolean } = {}) => claimWithWorktree(2416, "worker-2416", {
    branch: BRANCH, worktree: WT, adopt: "worker-7",
    run: ((cmd: string, args: string[]) => { order.push(`${cmd} ${args.join(" ")}`); return args.includes("symbolic-ref") ? `${over.head ?? BRANCH}\n` : ""; }) as never,
    exists: () => over.exists ?? true, owner: () => (over.owner === undefined ? "worker-7" : over.owner),
    stamp: (w: string, sess: string) => { stamped.push([w, sess]); },
    claim: ((_n: number, _s: string, deps: { worktree?: string; branch?: string }) => { claims.push(deps); return over.claimed === false ? { claimed: false, reason: "B2 refused" } : { claimed: true, statusMoved: true }; }) as never });
  const won = adopt();
  assert.equal(won.claimed, true);
  assert.deepEqual(stamped, [[WT, "worker-2416"]], "the tree becomes the new instance's");
  assert.deepEqual(claims.map(({ branch, worktree }) => ({ branch, worktree })), [{ branch: BRANCH, worktree: WT }],
    "the claim RECORDS the existing branch and worktree");
  assert.equal(order.some((c) => /fetch|worktree add|worktree remove/.test(c)), false, "it creates nothing and removes nothing");

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

test("#2470 (10) `decline --answer=<session>` releases to that session's `answer:` label, NOT to `ready`, and refuses to be a finding too", () => {
  const board = releaseBoard();
  const done = declineRow(2416, "worker-7", { run: board.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never,
    keepWorktree: true, answer: "product-manager" });
  assert.equal(done.declined, true);
  assert.deepEqual(board.edits()[0].added, ["answer:product-manager"], "the row was `ready` before the claim, and is NOT returned to the pool: the work merged");
  const control = releaseBoard();
  declineRow(2416, "worker-7", { run: control.run as never, fetchComments: () => RECORD, moveStatus: NO_STATUS as never, keepWorktree: true });
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
  declineStatus?: number } = {}) {
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
      return { status, output: status === 0 ? "DECLINED -- #2407 is unclaimed again and restored to `ready`\n" : "NOT DECLINED: the row is held by someone else\n" };
    }
    return { status: 0, output: "" };
  };
  const deps: ReleaseDeps = {
    run, exec, io: h.io, now: NOW, agents, isSpare: () => o.spare ?? true,
    host: { worktreesDir: "/home/agent/repos", primary: REPO, exists: (p: string) => (p === WT ? o.world?.worktreeExists !== false : true) },
    env: {}, gh: (a: string[]) => { gh.push(a); return ""; }, warn: (l: string) => { warns.push(l); },
    cycle: (c) => { cycles.push(c); }, dropInstance: (r: string) => { dropped.push(r); return { spawnedAt: 1, rows: [2407] }; },
    remember: (row: number, k: unknown) => { if (k === null) delete kept[row]; else kept[row] = k; },
  };
  const decline = () => execs.find((e) => ROW_CLAIM_MJS.test(e.args[0] ?? "") && e.args[1] === "decline");
  return { deps, runs, execs, gh, warns, cycles, kept, dropped, h, decline };
}

test("#2470 (4) a stalled release ENDS the spare's workspace, declines the claim AS THE HOLDER keeping the tree, comments, records and writes ONE line", () => {
  const r = releaseHost({ world: { dirty: [{ file: "a.mjs", ago: 900 }], unpushed: 2 } });
  const got = performRelease(STALL, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  const closeAt = r.runs.findIndex((a) => a.includes("close"));
  assert.deepEqual(r.runs[closeAt], ["--session", "org", "workspace", "close", "w0"], "the instance is ended so a fresh one takes the row");
  const decline = r.decline()!;
  assert.deepEqual(decline.args.slice(1), ["decline", "2407", "--session=worker-7", "--keep-worktree"], "as the holder, and the tree is KEPT");
  assert.match(decline.cwd, /\/role-worker-7$/, "from the holder's own launch worktree, which launchGate accepts");
  assert.ok(r.execs.findIndex((e) => e === decline) > -1 && closeAt > -1, "and the close came first, so nothing the instance does can race the read");
  assert.match(r.gh[0].join(" "), /Claim released by the gate \(#2470\).*`worker-7`.*nothing on this row moved for 250 minutes.*KEPT/s);
  assert.match(r.gh[0].join(" "), /2 commit\(s\) not on any remote/);
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
});

test("#2470 (6) a claim by a role that is NOT a spare is released and NEVER ended: the standing engineers and the decision-holders keep their process", () => {
  const r = releaseHost({ spare: false, agents: [{ label: "worker-capture", status: "working" }], world: { unpushed: 1 } });
  const got = performRelease({ ...STALL, session: "worker-capture" }, r.deps);
  assert.equal(got.released, true);
  assert.equal(r.runs.some((a) => a.includes("close")), false, "no workspace is closed");
  assert.equal(r.cycles.length, 0, "and no cycle line: it is not an instance's ending");
  assert.deepEqual(r.dropped, []);
  assert.ok(r.decline()!.args.includes("--session=worker-capture"), "only the CLAIM is released");
  // THE CONTROL: the same request for a spare closes it.
  const spare = releaseHost({ agents: [{ label: "worker-capture", status: "working" }], world: { unpushed: 1 } });
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
    assert.deepEqual([r.runs.some((a) => a.includes("close")), r.decline(), r.gh.length], [false, undefined, 0], "nothing was changed");
  }
  const stalled = releaseHost({ world: dirty });
  assert.equal(performRelease(STALL, stalled.deps).released, true, "CONTROL: a STALLED release is the one that KEEPS what it finds");
});

test("#2470 (10) a merged release sets the answer at the merge (`--answer`), says which PR merged, and ends the instance", () => {
  const r = releaseHost({ world: {} });
  const got = performRelease({ ...STALL, why: "merged", mergedPr: 2497, answer: "product-manager", idleMinutes: null, nudgedAt: null }, r.deps);
  assert.equal(got.released, true);
  assert.deepEqual(r.decline()!.args.slice(1), ["decline", "2407", "--session=worker-7", "--answer=product-manager"]);
  assert.match(r.gh[0].join(" "), /#2497 MERGED and this row stayed open.*`answer:product-manager` is set/s);
  assert.equal(r.runs.some((a) => a.includes("close")), true);
  assert.equal(r.cycles[0].released, "merged");
});

test("#2470 a release is RECOVERABLE at every step: a workspace that will not close changes nothing, and a decline that fails leaves no line and retries", () => {
  const stuck = releaseHost({ closeFails: true, world: { unpushed: 1 } });
  const first = performRelease(STALL, stuck.deps);
  assert.equal(first.released, false);
  assert.deepEqual([stuck.decline(), stuck.cycles.length, stuck.gh.length], [undefined, 0, 0], "a close that failed aborts with nothing changed");

  // The decline fails AFTER the close: the row is still claimed and there is no process. No line, no comment, no record...
  const declined = releaseHost({ declineStatus: 1, world: { unpushed: 1 } });
  assert.equal(performRelease(STALL, declined.deps).released, false);
  assert.deepEqual([declined.cycles.length, declined.gh.length, Object.keys(declined.kept).length], [0, 0, 0]);
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
  assert.deepEqual(gone.forgotten, [], "and the stale record is not 'used'");
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
    const lines = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW, restartAt: null, moved: () => true, log: () => {},
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
    const again = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW + 2 * MIN, restartAt: null, moved: () => true, log: () => {},
      run: herdrReading({ "worker-7": pane(INTERRUPTED_LINE) }) });
    assert.deepEqual(again, [], "a pane that stays interrupted is not re-prompted on every tick");
    const later = recoverInterruptedWork({ agents, ledgerPath: ledger, now: NOW + WAKE_TTL_MS + MIN, restartAt: null, moved: () => true, log: () => {},
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
    const args = { agents: [{ label: "worker-9", status: "idle" }], ledgerPath: ledger, now: RESTART + 90_000, restartAt: RESTART, log: () => {},
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
      restartAt: RESTART, log: () => {}, run: herdrReading({ "worker-9": pane("● Done.") }) } };
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

test("#2470 (11) a restart noticed LATE is not acted on if it is older than the horizon, and a session that has since acted is left alone", () => {
  const facts = (over: object) => recoverableWork({ now: RESTART + 90_000, restartAt: RESTART, actedRestart: null, agents: [], paneText: () => null,
    deliveries: () => [delivery(68)], moved: () => false, resentAt: {}, ...over });
  assert.equal(facts({}).killed.length, 1, "control");
  assert.equal(facts({ now: RESTART + 25 * 3_600_000 }).killed.length, 0, "a day-old restart is history, not an outage to recover from");
  assert.equal(facts({ actedRestart: RESTART }).killed.length, 0, "the last restart acted on is not acted on twice");
  assert.equal(facts({ restartAt: null }).killed.length, 0, "a restart that could not be read is not guessed");
  assert.equal(facts({ moved: (_s: string, _from: number, to: number) => to > RESTART + 60_000 }).killed.length, 0, "a session that acted AFTER the restart, before the tick noticed");
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
