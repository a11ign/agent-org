// no-token: gh -- every herdr and git call here is an injected seam, and a PATH probe that logs gh and herdr sees no call
/**
 * agent-org#1392: RETIRING A REVIEWER SEAT ENDS THE RUNS OF ITS CAUSES. A capped cause whose seat is absent is STARTED by the gate, not capped.
 *
 * Done-when 1: a seat is retired while its cause is at the cap, and a RESET line for that cause key is in the ledger afterwards.
 * Done-when 2 (positive control): a capped cause whose seat is absent from the registry (no RESET, as after a hand edit) is offered and
 * STARTED; the same cause with a live seat stays capped.
 *
 * The herdr and git seams are the ones `wake-reviewer-instance.test.ts` uses, copied here for the reviewer start (#2401): nothing touches
 * a disk outside a temporary directory, and no `herdr` or `gh` is run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deliver, deliveryCounts, endFinishedReviewers, endSeatRuns, registerReviewer, reviewerPathsFrom,
} from "./wake.ts";
import { readReviewerRegistry } from "./work-gate.ts";
import { INSIDE } from "./review-trust.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
/** The two standing panes are listed, so a listing that lacks a seat is COMPLETE and its absence is real (#2465). */
const STANDING = { ceo: "working", orchestrator: "idle" };
const ROSTER: string[] = [];
const REVIEW_ROOT = "/reviews-root";
const PRIMARY = "/primary";
const headOf = (pr: number, gen = 1) => `${String(gen).padStart(8, "d")}${String(pr).padStart(32, "0")}`;

const CAUSE = "reviewer-2398/draft-awaiting-verdict/pr-2398/abc12345";
const reviewOrder = () => ({
  session: "reviewer-2398", cause: "draft-awaiting-verdict", causeKey: CAUSE,
  prompt: "Draft #2398 is green with no verdict at its head.", trust: INSIDE,
});

/** A `herdr` that answers a started pane as ready, and records every call in the event log. */
function recordingHerdr(events: string[]) {
  const pane = startedPanes();
  const run = (args: string[]) => {
    events.push(`herdr ${args.join(" ")}`);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run };
}

/** A `git` and a filesystem that behave as the checkout path needs: a set of paths and the head each one is at. */
function fakeCheckout(events: string[]) {
  const trees = new Map<string, string>();
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    events.push(`git ${line}`);
    const pr = Number(/pr-(\d+)/.exec(line)?.[1] ?? 0);
    if (line.includes(" fetch ")) return "";
    if (line.includes("rev-parse --verify")) return `${headOf(pr)}\n`;
    if (line.includes("worktree add")) { trees.set(args[args.length - 2], args[args.length - 1]); return ""; }
    if (line.includes(" checkout ")) { trees.set(args[1], args[args.length - 1]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${trees.get(args[1])}\n`;
    if (line.includes("worktree remove")) { trees.delete(args[args.length - 1]); return ""; }
    if (line.includes("update-ref -d")) return "";
    throw new Error(`unexpected git ${line}`);
  };
  return { git, trees, seams: { git, link: () => null, exists: (path: string) => trees.has(path), root: REVIEW_ROOT, repoRoot: PRIMARY } };
}

/** A ledger that holds `n` deliveries of the cause, as the gate writes them (`<epochMs>\t<causeKey>`). */
function ledgerWithDeliveries(n: number) {
  const dir = tmpDirForFile("seat-retire-reset-");
  const ledger = join(dir, "ledger");
  writeFileSync(ledger, Array.from({ length: n }, (_, i) => `${1000 + i}\t${CAUSE}\n`).join(""));
  return ledger;
}

test("#1392 (1): retiring a seat whose cause is AT THE CAP writes a RESET line for that cause key to the ledger", () => {
  const ledger = ledgerWithDeliveries(6);
  const paths = reviewerPathsFrom(ledger);
  registerReviewer(paths, "reviewer-2398", 1);
  assert.equal(deliveryCounts(ledger).get(CAUSE), 6, "precondition: the cause is at the cap");

  const { ended } = endFinishedReviewers(agents(STANDING), {
    registry: readReviewerRegistry(paths.registry), now: 2, run: () => "{}", prState: () => "merged",
    removeCheckout: () => null, record: () => {}, warn: () => {},
    endRuns: (session) => endSeatRuns(ledger, session),
  });

  assert.deepEqual(ended, ["reviewer-2398"], "the seat is retired");
  const resets = readFileSync(ledger, "utf8").split("\n").filter((line) => line.split("\t")[1] === "RESET");
  assert.equal(resets.length, 1, "one RESET line in the ledger");
  assert.equal(resets[0].split("\t")[2], CAUSE, "and it names the cause key of the retired seat");
  assert.equal(deliveryCounts(ledger).get(CAUSE), 0, "so the cause's run is over: its count is back to zero");
});

test("#1392 (2): a CAPPED cause whose seat is ABSENT from the registry is STARTED by the gate, and its RESET is written before the delivery line", () => {
  const ledger = ledgerWithDeliveries(6);
  const events: string[] = [];
  const herdr = recordingHerdr(events);
  const checkout = fakeCheckout(events);
  const counts = deliveryCounts(ledger);

  const out = deliver([reviewOrder()], agents(STANDING), ROSTER, {
    run: herdr.run, checkout: checkout.seams, counts, registry: () => ({}),
    record: (key) => events.push(`record ${key}`),
    endRun: (key) => events.push(`reset ${key}`),
  });

  assert.equal(out.stuck.length, 0, "not capped");
  assert.equal(out.sent.length, 1, "offered and placed");
  assert.match(out.sent[0], /STARTED/, "as a started seat");
  const order = events.filter((e) => e === `reset ${CAUSE}` || e === `record ${CAUSE}`);
  assert.deepEqual(order, [`reset ${CAUSE}`, `record ${CAUSE}`], "the RESET comes first, so the new run is not counted as the seventh delivery");
});

test("#1392 (2 control): the SAME capped cause with a LIVE seat stays capped, and nothing is reset", () => {
  const ledger = ledgerWithDeliveries(6);
  const events: string[] = [];
  const herdr = recordingHerdr(events);
  const checkout = fakeCheckout(events);
  const counts = deliveryCounts(ledger);
  const resets: string[] = [];

  const out = deliver([reviewOrder()], agents({ ...STANDING, "reviewer-2398": "idle" }), ROSTER, {
    run: herdr.run, checkout: checkout.seams, counts, registry: () => ({ "reviewer-2398": { spawnedAt: 1 } }),
    endRun: (key) => resets.push(key),
  });

  assert.equal(out.sent.length, 0, "not delivered");
  assert.equal(out.stuck.length, 1, "named as capped");
  assert.deepEqual(resets, [], "no run is ended while the seat is live");
});
