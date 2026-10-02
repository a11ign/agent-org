// no-token: gh -- every `gh` read here is an injected `run` seam (precedent: wake-drain.test.ts); nothing imported reaches the real one
/**
 * #2416: THE `awaiting-evidence` PR LABEL -- no verdict order, no author prompt and a stale-wait order.
 *
 * ITS OWN FILE, and not a block in `work-gate.test.ts`, for #2324's reason: that file reaches `gh`, so the
 * token-less acceptance job refuses it and would verify nothing. Every read here is handed a seam.
 *
 * BOTH DIRECTIONS ARE PINNED. A `decide` that returned `[]` for a labelled draft satisfies every "no order"
 * assertion below, so each is beside its positive control: the SAME draft without the label still wakes its
 * reviewer, a red labelled one still wakes its author, a labelled one with a hand-posted verdict still has
 * that verdict read, and a labelled one quiet for 48h still reaches `product-manager`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, CAUSES, JUDGMENT_CAUSES, START_CAUSES, GH_READS, withPatchIds, reviewBlocked,
  readEvidenceLabelledAt, withEvidenceLabelAges, awaitingEvidenceStaleOrders, AWAITING_EVIDENCE_LABEL,
  AWAITING_EVIDENCE_QUIET_MS } from "../work-gate.mjs";
import { PROFILES } from "../worker-profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = join(HERE, "../../../../.claude/rules/org-routing-and-timers.md");

const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const HEAD = "abc12345deadbeefcafe000011112222";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-25T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

/** A draft; `labelled` puts the label on it. */
function draft(n: number, rollup: unknown[], opts: { labelled?: boolean; comments?: Record<string, unknown>[] } = {}) {
  return { number: n, isDraft: true, headRefOid: HEAD, statusCheckRollup: rollup,
    author: { login: "worker-judge" }, comments: opts.comments ?? [],
    labels: opts.labelled ? [{ name: AWAITING_EVIDENCE_LABEL }] : [] };
}

/** A labelled pull request whose label age has been read, as `withEvidenceLabelAges` would leave it. */
function labelled(n: number, labelAgeHours: number, comments: Record<string, unknown>[] = []) {
  return { ...draft(n, GREEN, { labelled: true, comments }), awaitingSince: ago(labelAgeHours) };
}

const causes = (orders: { cause: string }[]) => orders.map((o) => o.cause);

test("#2416 done-when 1: a settled draft carrying the label yields no verdict order; the same draft without it still does", () => {
  // THE POSITIVE CONTROL, first: without it the negative is satisfied by a gate that never emits anything.
  const control = decide({ prs: [draft(7, GREEN)], readyRows: [] });
  assert.deepEqual(causes(control), ["draft-awaiting-verdict"]);
  assert.equal(control[0].session, "reviewer-7");

  const orders = decide({ prs: [draft(7, GREEN, { labelled: true })], readyRows: [] });
  assert.deepEqual(orders, [], "a PR waiting on an external run is not asked for a verdict");
});

test("#2416: a READY pull request carrying the label is not asked for a verdict either", () => {
  // `draftOrder` asks the review question of every green PR, draft or not (#2176), so the label must bind both.
  const ready = { ...draft(8, GREEN), isDraft: false };
  assert.deepEqual(causes(decide({ prs: [ready], readyRows: [] })), ["draft-awaiting-verdict"]);
  assert.deepEqual(decide({ prs: [{ ...ready, labels: [{ name: AWAITING_EVIDENCE_LABEL }] }], readyRows: [] }), []);
});

test("#2416: only the exact label counts -- a look-alike does not silence the reviewer", () => {
  for (const name of ["awaiting-evidence-x", "awaiting-merge", "evidence", "Awaiting-Evidence"]) {
    const pr = { ...draft(9, GREEN), labels: [{ name }] };
    assert.deepEqual(causes(decide({ prs: [pr], readyRows: [] })), ["draft-awaiting-verdict"],
      `\`${name}\` is not the label`);
  }
});

test("#2416: the label removes the MACHINERY's order and nothing else -- red, and a hand-posted verdict, still act", () => {
  // A red build is the author's work whether or not evidence is pending.
  const red = decide({ prs: [draft(3, RED, { labelled: true })], readyRows: [] });
  assert.deepEqual(causes(red), ["pr-checks-failing"]);

  // Done-when 5: a reviewer prompted by hand still answers, and the answer is read.
  const convinced = draft(4, GREEN, { labelled: true,
    comments: [{ body: `Review of #4 at \`${HEAD.slice(0, 8)}\`, by \`reviewer\`: convinced.` }] });
  assert.deepEqual(causes(decide({ prs: [convinced], readyRows: [] })), ["draft-convinced-not-ready"]);
  const refused = draft(5, GREEN, { labelled: true,
    comments: [{ body: `Review of #5 at \`${HEAD.slice(0, 8)}\`, by \`reviewer\`: not convinced.` }] });
  assert.deepEqual(causes(decide({ prs: [refused], readyRows: [] })), ["verdict-not-convinced"]);
});

test("#2416: a labelled pull request costs no patch read; an unlabelled one still does", () => {
  const seen: string[][] = [];
  const run = (args: string[]) => { seen.push(args); return ""; };
  withPatchIds([draft(1, GREEN, { labelled: true })], run);
  assert.equal(seen.length, 0, "the patch is read to key a verdict order that will never be made");
  withPatchIds([draft(2, GREEN)], run);
  assert.equal(seen.length, 1, "the control: the same draft unlabelled pays its one call");
  assert.match(seen[0].join(" "), /compare\/main\.\.\./);
});

/** A green, unheld, ready pull request GitHub's review requirement is holding. */
function readyAwaitingReview(n: number, labelNames: string[], decision = "REVIEW_REQUIRED") {
  return { number: n, isDraft: false, headRefOid: HEAD, reviewDecision: decision,
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "a11ign-ai-workers" }, comments: [], labels: labelNames.map((name) => ({ name })) };
}

test("#2416: `pr-review-blocked` does not send product-manager to prompt a reviewer for a labelled PR", () => {
  const codes = (prs: unknown[]) => reviewBlocked(prs, ["gate"]).map((b: { number: number; code: string }) => `${b.number}:${b.code}`);
  assert.deepEqual(codes([readyAwaitingReview(20, [])]), ["20:AWAITING_REVIEW"], "the control: unlabelled is reported");
  assert.deepEqual(codes([readyAwaitingReview(21, [AWAITING_EVIDENCE_LABEL])]), []);
  // A REFUSAL is real whatever the pull request is waiting on, so the label does not hide it.
  assert.deepEqual(codes([readyAwaitingReview(22, [AWAITING_EVIDENCE_LABEL], "CHANGES_REQUESTED")]), ["22:REFUSED"]);
});

test("#2416 done-when 3: 48h with no comment after the label was applied yields ONE order to product-manager", () => {
  const orders = awaitingEvidenceStaleOrders([labelled(31, 49), labelled(30, 72)], NOW);
  assert.equal(orders.length, 1, "one order for the set, in `greenUnarmedOrders`' shape");
  const [order] = orders;
  assert.equal(order.session, "product-manager");
  assert.equal(order.cause, "awaiting-evidence-stale");
  assert.ok(CAUSES.includes(order.cause), "declared in CAUSES");
  assert.match(order.prompt, /#30 {2}carried `awaiting-evidence` for 72h/, "names the PR and the label's age");
  assert.match(order.prompt, /#31 {2}carried `awaiting-evidence` for 49h/);
  assert.match(order.prompt, /WHAT WOULD CLEAR IT/);
  assert.match(order.prompt, /--remove-label awaiting-evidence/);
  assert.equal(order.causeKey, "product-manager/awaiting-evidence-stale/30.31",
    "keyed on the SET, so an age that moves every tick does not re-ask an unchanged question");
});

test("#2416: the order is withheld unless the wait is genuinely unexplained AND old enough", () => {
  const explained = [{ body: "Waits on the Windows worker capture; orchestrator owns it.", createdAt: ago(40) }];
  const before = [{ body: "written before the label", createdAt: ago(80) }];
  const cases: [string, unknown, boolean][] = [
    ["49h, no comment", labelled(1, 49), true],
    ["47h, no comment -- not yet", labelled(2, 47), false],
    ["exactly 48h -- the bound is 'more than'", labelled(3, AWAITING_EVIDENCE_QUIET_MS / HOUR), false],
    ["72h, a comment AFTER the label", labelled(4, 72, explained), false],
    ["72h, only a comment BEFORE the label", labelled(5, 72, before), true],
    ["72h, a comment whose time cannot be read", labelled(6, 72, [{ body: "x" }]), false],
    ["label age unread", { ...draft(7, GREEN, { labelled: true }) }, false],
    ["comments unread", { ...labelled(8, 72), comments: undefined }, false],
    ["72h but NOT labelled", { ...draft(9, GREEN), awaitingSince: ago(72) }, false],
  ];
  for (const [name, pr, expected] of cases) {
    assert.equal(awaitingEvidenceStaleOrders([pr], NOW).length === 1, expected, name);
  }
});

test("#2416: `decide` emits the stale order beside the per-PR orders and a labelled PR earns no verdict order", () => {
  const orders = decide({ prs: [labelled(40, 100), draft(41, GREEN)], readyRows: [] });
  assert.deepEqual(causes(orders).sort(), ["awaiting-evidence-stale", "draft-awaiting-verdict"]);
  assert.equal(orders.find((o: { cause: string }) => o.cause === "draft-awaiting-verdict")!.session, "reviewer-41");
});

test("#2416: the cause is classified FINISH and JUDGMENT, and has a worker profile", () => {
  assert.ok(!START_CAUSES.includes("awaiting-evidence-stale"), "it takes on no new work, so a drain does not withhold it");
  assert.ok(JUDGMENT_CAUSES.includes("awaiting-evidence-stale"), "its answer is durable, so the expiry does not re-ask it");
  assert.ok("awaiting-evidence-stale" in PROFILES, "`profileFor` refuses a cause with no profile");
});

test("#2416: the label's age is read from the LAST `labeled` event, and only when some open PR carries the label", () => {
  const calls: string[][] = [];
  const events = [ago(200), ago(50)].join("\n");
  const run = (args: string[]) => { calls.push(args); return events; };

  assert.equal(readEvidenceLabelledAt(55, run), ago(50), "a label removed and re-applied is a new wait");
  assert.match(calls[0].join(" "), /issues\/55\/events/);
  assert.match(calls[0].join(" "), /labeled/, "the read is narrowed to the label's own events");

  calls.length = 0;
  const unlabelled = [draft(1, GREEN), draft(2, GREEN)];
  assert.deepEqual(withEvidenceLabelAges(unlabelled, run), unlabelled);
  assert.equal(calls.length, 0, "a queue where nothing carries the label pays NO call");

  const withOne = withEvidenceLabelAges([...unlabelled, draft(3, GREEN, { labelled: true })], run);
  assert.equal(calls.length, 1, "the control: one labelled pull request pays exactly one call");
  assert.equal((withOne[2] as { awaitingSince?: string }).awaitingSince, ago(50));
  assert.equal((withOne[0] as { awaitingSince?: string }).awaitingSince, undefined);
  assert.ok(GH_READS.conditionalOnAwaitingEvidenceLabel, "the conditional read is counted in GH_READS");
});

test("#2416: a REFUSED or empty events read is never an order", () => {
  const refuse = () => { throw new Error("HTTP 403"); };
  assert.equal(readEvidenceLabelledAt(1, refuse), null);
  assert.equal(readEvidenceLabelledAt(1, () => ""), null, "never applied is not a measured age");
  const read = withEvidenceLabelAges([draft(1, GREEN, { labelled: true })], refuse);
  assert.deepEqual(awaitingEvidenceStaleOrders(read, NOW), [], "an unread age must not become 'stale'");
});

test("#2416 done-when 2: the rules sentence says the author's prompt does not apply to a labelled PR", () => {
  const rules = readFileSync(RULES, "utf8").replace(/\s+/g, " ");
  const at = rules.indexOf("PR n's reviewer is `reviewer-<n>`");
  assert.ok(at >= 0, "the sentence about the per-PR reviewer is still there");
  const bullet = rules.slice(at, rules.indexOf("- **ONE CALL IS ENOUGH"));
  assert.match(bullet, /The author re-prompts a live one after a push/, "the sentence the label amends still exists");
  assert.match(bullet, /Neither does for `awaiting-evidence` PRs/);
});
