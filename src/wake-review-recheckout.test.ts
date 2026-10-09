// no-token: gh -- every `gh` and `herdr` here is a stub or an injected seam, and `git` is a fake: nothing imported reaches a real one
/**
 * `packages/agent-org/src/wake.mjs` and `prompt-session.mjs`, #2771: A REVIEWER INSTANCE ALREADY AWAITING ITS VERDICT
 * IS RE-POINTED ON EVERY PUSH, NOT ONLY WHEN IT IS SPAWNED.
 *
 * `reviewerTarget` prepares a checkout for an order the tick generates, and that order's cause key names the head it was
 * made at, so it is offered once per pull request. `reviewer-2754`'s tree stayed at the first head across two more pushes, and
 * the re-prompt the routing rule prescribes (`prompt:session`) carried prose only. THE CHOICE PINNED HERE: the re-point lives in
 * the DELIVERY to a reviewer instance (`repointedForReviewer`), reached from `targetFor` (the tick) and
 * `promptOrQueue` (a direct prompt), rather than in a cause per head -- a per-head cause would re-order a review the ledger
 * already counts as awaiting, and would still leave the author's own re-prompt as prose.
 *
 * Its own file because the row's Region names it. No real git, no real pane, per the no-token contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, deliverHandoffs, handoffId, repointedForReviewer } from "./wake.ts";
import { promptOrQueue, STANCE, EXIT } from "./prompt-session.ts";
import { startedPanes } from "./packaging/started-pane.ts";

const REVIEW_ROOT = "/reviews-root";
const PRIMARY = "/primary";
/** A head for pull request `pr` -- a 40-hex string, `gen` being which push it is. */
const headOf = (pr: number, gen = 1) => `${String(gen).padStart(8, "d")}${String(pr).padStart(32, "0")}`;
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));

/** A `git` that keeps the head each tree is at, and the head each pull request is at (`push` moves it). */
function fakeCheckout({ failFetch = false } = {}) {
  const trees = new Map<string, string>();
  const gen = new Map<number, number>();
  const events: string[] = [];
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    events.push(`git ${line}`);
    const pr = Number(/pr-(\d+)/.exec(line)?.[1] ?? 0);
    if (line.includes(" fetch ")) {
      if (failFetch) throw new Error("fatal: couldn't find remote ref\nmore");
      return "";
    }
    if (line.includes("rev-parse --verify")) return `${headOf(pr, gen.get(pr) ?? 1)}\n`;
    if (line.includes("worktree add")) { trees.set(args[args.length - 2], args[args.length - 1]); return ""; }
    if (line.includes(" checkout ")) { trees.set(args[1], args[args.length - 1]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${trees.get(args[1])}\n`;
    throw new Error(`unexpected git ${line}`);
  };
  const link = ({ path }: { path: string }) => { events.push(`link ${path}`); return null; };
  return { trees, events, push: (pr: number) => gen.set(pr, (gen.get(pr) ?? 1) + 1),
    seams: { git, link, exists: (path: string) => trees.has(path), root: REVIEW_ROOT, repoRoot: PRIMARY } };
}

/** The tree `reviewer-<n>` holds, as the head it is detached at. */
const treeOf = (co: ReturnType<typeof fakeCheckout>, pr: number) => co.trees.get(`${REVIEW_ROOT}/reviewer-${pr}`);

/** The first order, as the tick generates it, brings the instance up at the FIRST head. */
function reviewerAtFirstHead(pr: number, co: ReturnType<typeof fakeCheckout>) {
  const sent: string[][] = [];
  const pane = startedPanes();
  const out = deliver([{ session: `reviewer-${pr}`, cause: "draft-awaiting-verdict",
    causeKey: `reviewer-${pr}/draft-awaiting-verdict/pr-${pr}/abc12345`, prompt: `Draft #${pr} is green.` }],
    agents({}), [], { run: (args) => { sent.push(args); return pane(args) ?? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" },
      workspace: { workspace_id: "wB" } } }); }, checkout: co.seams, reviewerEnv: {}, registerReviewer: () => {} });
  assert.equal(out.refused.length, 0, out.refused.join(";"));
  assert.equal(treeOf(co, pr), headOf(pr, 1), "the spawn is the one path that already pointed the tree");
}

test("#2771 (1a): a tick-delivered order about an ALREADY-LIVE reviewer's own pull request (a cause that is not a reviewer cause) "
  + "re-points its tree to the CURRENT head, on every push and not only the first", () => {
  const co = fakeCheckout();
  reviewerAtFirstHead(2754, co);
  const prompts: string[] = [];
  for (const push of [2, 3]) {
    co.push(2754);
    const out = deliver([{ session: "reviewer-2754", cause: "pr-checks-failing", causeKey: `reviewer-2754/pr-checks-failing/pr-2754/push${push}`,
      prompt: "Re-review at the new head." }], agents({ "reviewer-2754": "idle" }), [],
      { run: (args) => { prompts.push(args[args.length - 1]); return "{}"; }, checkout: co.seams });
    assert.deepEqual(out.refused, []);
    assert.equal(treeOf(co, 2754), headOf(2754, push), `after push ${push} the tree is at that head, not the first`);
  }
  assert.match(prompts[1], new RegExp(`re-pointed to the pull request's current head \`${headOf(2754, 3).slice(0, 8)}\``));
  assert.match(prompts[1], /Re-review at the new head\./, "the author's own words still go");
});

test("#2771 (1c) / #3031: a direct prompt that is QUEUED (the reviewer is mid-turn) moves no tree then; the tick delivers it once the "
  + "reviewer is idle, re-pointing first", () => {
  const co = fakeCheckout();
  reviewerAtFirstHead(2754, co);
  co.push(2754);
  const before = co.events.length;
  const dir = mkdtempSync(join(tmpdir(), "recheckout-"));
  try {
    const code = promptOrQueue({ run: () => "{}", label: "reviewer-2754", text: "Pushed a fix.", agents: agents({ "reviewer-2754": "working" }),
      path: join(dir, "queue"), stance: STANCE.UNDECLARED, sender: null, sleep: () => {}, checkout: co.seams });
    assert.equal(code, EXIT.QUEUED);
    assert.deepEqual(co.events.slice(before), [], "no git call while it is mid-turn: a running Acceptance keeps its files");
    assert.equal(treeOf(co, 2754), headOf(2754, 1));
    const typed: string[] = [];
    const id = handoffId("reviewer-2754", "Pushed a fix.");
    const tick = deliverHandoffs([{ id, session: "reviewer-2754", prompt: "Pushed a fix.", queuedAt: Date.now() }],
      agents({ "reviewer-2754": "idle" }), [], { run: (args) => { typed.push(args[args.length - 1]); return "{}"; }, sleep: () => {}, checkout: co.seams });
    assert.deepEqual(tick.refused, []);
    assert.deepEqual(tick.ids, [id]);
    assert.equal(treeOf(co, 2754), headOf(2754, 2), "delivered, and the tree is at the head the pull request is now at");
    assert.match(typed[typed.length - 1], /re-pointed to the pull request's current head/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#2771 (1b): a DIRECT `prompt:session` to an idle reviewer re-points BEFORE the prompt is typed, so the text and the tree agree", () => {
  const co = fakeCheckout();
  reviewerAtFirstHead(2754, co);
  co.push(2754);
  const typed: string[] = [];
  const run = (args: string[]) => { co.events.push(`herdr ${args.slice(2, 4).join(" ")}`); typed.push(args[args.length - 1]); return "{}"; };
  const dir = mkdtempSync(join(tmpdir(), "recheckout-"));
  try {
    const code = promptOrQueue({ run, label: "reviewer-2754", text: "Pushed a fix.", agents: agents({ "reviewer-2754": "idle" }),
      path: join(dir, "queue"), stance: STANCE.UNDECLARED, sender: null, sleep: () => {}, checkout: co.seams });
    assert.equal(code, EXIT.OK);
    assert.equal(treeOf(co, 2754), headOf(2754, 2));
    assert.ok(co.events.findIndex((e) => e.startsWith("git") && e.includes(" checkout ")) < co.events.findIndex((e) => e === "herdr agent prompt"),
      `the checkout precedes the prompt: ${co.events.join(" | ")}`);
    assert.match(typed[typed.length - 1], /re-pointed to the pull request's current head/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#2771 (1d): a refused re-point does NOT swallow the order -- it goes with a warning that the tree may be stale", () => {
  const co = fakeCheckout({ failFetch: true });
  const { prompt } = repointedForReviewer({ session: "reviewer-2754", prompt: "Pushed a fix." }, co.seams);
  assert.match(prompt, /^Pushed a fix\./);
  assert.match(prompt, /YOUR CHECKOUT WAS NOT RE-POINTED .*couldn't find remote ref/);
  assert.match(prompt, /git rev-parse HEAD/);
  assert.deepEqual([...co.trees.keys()], [], "nothing was made");
});

test("#2771 (2): NEGATIVE CONTROL -- an order for another pull request's reviewer, or for a session that is no reviewer, touches "
  + "no tree", () => {
  const co = fakeCheckout();
  reviewerAtFirstHead(2754, co);
  co.push(2754);
  const before = co.events.length;
  // reviewer-2754 is asked about PR 2755: refused, and the refusal is BEFORE any git.
  const out = deliver([{ session: "reviewer-2754", cause: "draft-awaiting-verdict", causeKey: "reviewer-2754/draft-awaiting-verdict/pr-2755/abc12345",
    prompt: "wrong PR" }], agents({ "reviewer-2754": "idle" }), [], { run: () => "{}", checkout: co.seams });
  assert.equal(out.refused.length, 1);
  // a non-reviewer session and a reviewer of a repository the project does NOT declare never reach `prepareReviewCheckout` (#2991: a
  // DECLARED key now does, and `keyed-repo-review.test.ts` pins that; the undeclared key is the positive control that this still holds).
  assert.deepEqual(repointedForReviewer({ session: "ceo", prompt: "p" }, co.seams), { prompt: "p" });
  assert.deepEqual(repointedForReviewer({ session: "reviewer-undeclared-9", prompt: "p" }, co.seams), { prompt: "p" });
  assert.deepEqual(co.events.slice(before), []);
  assert.equal(treeOf(co, 2754), headOf(2754, 1), "PR 2754's tree did not move for another pull request's order");
  // and prompting reviewer-2755 re-points 2755 only.
  repointedForReviewer({ session: "reviewer-2755", prompt: "p" }, co.seams);
  assert.equal(treeOf(co, 2755), headOf(2755, 1));
  assert.equal(treeOf(co, 2754), headOf(2754, 1));
});
