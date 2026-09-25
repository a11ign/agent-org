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
import assert from "node:assert/strict";
import { decide, claimStallTick, CAUSES, START_CAUSES, JUDGMENT_CAUSES, GH_READS } from "./work-gate.mjs";
import { profileFor } from "./worker-profile.mjs";
import { WAKE_TTL_MS } from "./wake.mjs";
import { claimRecordComment, declineRow, claimWithWorktree, worktreeTargetReason, worktreeFlagsReason } from "./row-claim.mjs";
import { CLAIM_RECORD_MARKER } from "./claim-labels.mjs";
import {
  CLAIM_STALLED, STALL_INTERVAL_MS, NUDGE_OFFER_MS, claimRecordOf, commentMove, workAtRisk, fileMove, claimReading,
  claimFactsFrom, readClaim, nextStallState, claimStalledOrders,
} from "./claim-stall.mjs";

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
    if (args[0] === "rev-parse") return { status: w.refExists === false ? 1 : 0, out: "" };
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
  assert.equal(quiet.h.calls.some((c) => c.includes("status") && c.includes("--no-optional-locks")), true,
    "a quiet row asks, and asks WITHOUT taking the index lock -- a plain status would touch the index and manufacture the move it looks for");
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
  assert.equal(second.orders[0].release.why, "stalled");
  assert.equal(second.orders[0].release.row, 2407);
  assert.equal(second.orders[0].release.session, "worker-7");

  // THE CONTROL, one thing changed: a commit AFTER the nudge and the same second reading releases nothing.
  const moved = tickWith({ commit: 60 }, comments, { memory: { ...memory }, now: later });
  assert.deepEqual(moved.orders.filter((o) => o.release), [], "a move after the nudge is not 'nothing moved'");
  assert.deepEqual(Object.keys(moved.memory), [], "and the row's nudge is FORGOTTEN, so a second stall is a first reading and not last week's release");
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
  assert.equal(blocked.orders[0].release.why, "blocked");
  assert.deepEqual(blocked.orders[0].release.edges, [2258]);
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
  assert.equal(orders[0].release.why, "merged");
  assert.equal(orders[0].release.answer, "product-manager", "the gate sets the answer at the merge, not by hand");
  assert.equal(orders[0].release.mergedPr, 2497);
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
