// no-token: GH_READS -- #3045. Importing anything from `work-gate.ts` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it
// run: every read is handed the injected `fakeGh`. Measured 2026-10-02 with `gh` off `PATH` and `GH_TOKEN`/`GITHUB_TOKEN`/`GH_CONFIG_DIR` unset.
/**
 * #3045: A VERDICT STAYS VALID WHILE THE PULL REQUEST'S OWN PATCH IS UNCHANGED.
 *
 * a11ign#3033 re-ordered its reviewer three times for four merges from `main` (6 reviews, 5 redundant). The gate decided "same work" by
 * the author's last commit, read through a HEADLINE regex that could not see a conflict resolved by hand and could not see a rebase, and
 * dropped the order for the minutes CI took after each merge. Each describe below is one done-when, and each carries the control that
 * proves the assertion could have failed: an emptiness check passes for a function that returns nothing, so every "no order" has its
 * "order" twin in the same test.
 *
 * The gate is driven end to end -- `withPatchIds` over a fake `gh`, then `decide` -- and the sequence in done-when 2 goes through the
 * wake ledger's own `readLedger`, `undelivered` and `endedRuns`, so "delivered" and "RESET" are what the ledger would have written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, withPatchIds, GH_READS } from "../work-gate.ts";
import { patchIdOfDiff } from "../review-verdict.ts";
import { readLedger, undelivered, endedRuns, ledgerLine, RESET, WAKE_TTL_MS } from "../wake.ts";

const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const PENDING = [{ name: "ci", status: "IN_PROGRESS", conclusion: null }];
const oid = (c: string) => c.repeat(40);
const AUTHORED = oid("a");
const MERGES = [oid("b"), oid("c"), oid("d"), oid("e")];
const REBASED = oid("f");

/** A one-file diff. `hunk` and `context` are what a merge from `main` changes without touching the PR's own lines. */
const diffOf = (added: string, hunk = "-3,3 +3,3", context = "unchanged line") =>
  `diff --git a/src/f.txt b/src/f.txt\nindex 1111111..2222222 100644\n--- a/src/f.txt\n+++ b/src/f.txt\n@@ ${hunk} @@\n ${context}\n-old line\n+${added}\n`;
const PATCH_A = (hunk?: string, context?: string) => diffOf("the PR's own line", hunk, context);
const PATCH_B = diffOf("the PR's own line, edited while resolving a conflict");

/** A fake `gh`: the compare diff by head (abbreviations resolve, as GitHub's do) and the commit list. Anything else throws, like a refusal. */
function fakeGh(diffs: Record<string, string>, commits: string[] = []) {
  return (args: string[]): string => {
    const target = args[args.length - 1];
    if (args.includes("Accept: application/vnd.github.diff")) {
      const wanted = target.split("...")[1];
      const found = Object.keys(diffs).find((h) => h.startsWith(wanted) || wanted.startsWith(h));
      if (found === undefined) throw new Error(`HTTP 404: no ${wanted}`);
      return diffs[found];
    }
    if (args.some((a) => a.endsWith("/commits"))) return commits.join("\n");
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}
const refusingGh = () => { throw new Error("HTTP 403"); };

type Pr = Record<string, unknown>;
const pr = (n: number, head: string, extra: Pr = {}): Pr => ({ number: n, isDraft: false, headRefOid: head, statusCheckRollup: GREEN,
  author: { login: "worker-1" }, comments: [], labels: [{ name: "session:worker-1" }], ...extra });
const verdictAt = (n: number, head: string, word: string) =>
  ({ body: `**Review of #${n} at \`${head.slice(0, 8)}\`, by reviewer-${n}: ${word}.**`, createdAt: "2026-10-02T17:50:00Z" });

type Order = { cause: string, session: string, causeKey: string, prompt: string };
const ordersOf = (p: Pr, run: (args: string[]) => string, extra: Record<string, unknown> = {}) =>
  decide({ prs: withPatchIds([p], run), readyRows: [], ...extra }) as Order[];
const awaiting = (orders: Order[]) => orders.filter((o) => o.cause === "draft-awaiting-verdict");

test("#3045 the patch read is declared in GH_READS, which is also what the `no-token` header above names", () => {
  assert.match(GH_READS.conditionalOnUnreviewedGreenPr, /compare\/\{base\}\.\.\.\{head\}/);
});

// --- the patch id itself: what makes two heads "the same work" -------------------------------------------

test("#3045 the patch id ignores where the change sits and reads what it changes", () => {
  const base = patchIdOfDiff(PATCH_A());
  assert.match(String(base), /^[0-9a-f]{64}$/);
  assert.equal(patchIdOfDiff(PATCH_A("-90,3 +95,3", "a neighbour's edit moved the context")), base,
    "hunk line numbers and context are what a merge from main changes");
  assert.equal(patchIdOfDiff(PATCH_A().replace("1111111..2222222", "3333333..4444444")), base, "blob ids are not the change");
  assert.notEqual(patchIdOfDiff(PATCH_B), base, "THE CONTROL: a line of the PR's own that changed is a different patch");
  assert.notEqual(patchIdOfDiff(PATCH_A().replaceAll("src/f.txt", "src/g.txt")), base, "the file touched is part of the change");
  assert.equal(patchIdOfDiff(undefined), null, "not text is `could not read`, never the empty patch");
  assert.equal(typeof patchIdOfDiff(""), "string", "an empty diff is a real patch (head equal to base)");
});

// --- done-when 1: two heads of one PR are the same work when their PATCH is equal --------------------------

test("#3045 (1) a verdict at an older head STANDS when the patch is equal, and does not when it is not", () => {
  const answered = pr(3033, MERGES[0], { comments: [verdictAt(3033, AUTHORED, "convinced")] });
  const sameWork = fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-40,3 +41,3", "main moved") });
  assert.deepEqual(awaiting(ordersOf(answered, sameWork)), [], "the same patch at a later head: the verdict stands");
  // THE CONTROL: the identical PR with a patch that changed is asked again, so the assertion above is not a function that returns [].
  const changed = fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B });
  assert.equal(awaiting(ordersOf(answered, changed)).length, 1, "a changed patch is new work and is ordered");
});

test("#3045 (1) `MERGE_FROM_MAIN` and `isMergeFromMain` are DELETED, not kept as a fast path", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const ban = /\bisMergeFromMain\b|\bMERGE_FROM_MAIN\b|\breviewChainOf\b/;
  // The positive control for the emptiness below: the pattern matches the very names the row deletes.
  assert.ok(ban.test("const MERGE_FROM_MAIN = /x/; function isMergeFromMain(c) {} reviewChainOf(pr)"));
  const files = [join(dir, "work-gate.ts"), join(dir, "work-gate", "pr-orders.ts"), join(dir, "review-verdict.ts")];
  assert.equal(files.length, 3);
  for (const file of files) assert.ok(!ban.test(readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "")), `${file} still names the headline test`);
});

// --- done-when 2: the ledger key is the patch id, and a re-run of CI at the same patch orders nothing --------

type Delivery = { delivered: number, resets: number, keys: string[] };

/** Run a PR through ticks two minutes apart, through the wake ledger's own functions, and report what it would have written. */
function runTicks(steps: { pr: Pr, run: (args: string[]) => string }[]): Delivery {
  const dir = mkdtempSync(join(tmpdir(), "patch-ledger-"));
  try {
    const ledger = join(dir, "ledger");
    const emitted = join(dir, "emitted");
    const start = Date.parse("2026-10-02T17:46:00Z");
    steps.forEach(({ pr: p, run }, i) => {
      const at = start + i * 2 * 60 * 1000;
      const orders = awaiting(ordersOf(p, run));
      const todo = undelivered(orders, readLedger(ledger, readFileSync, at));
      for (const key of endedRuns(orders.map((o) => o.causeKey), emitted)) appendFileSync(ledger, `${at}\t${RESET}\t${key}\n`);
      for (const o of todo) appendFileSync(ledger, ledgerLine(at, o.causeKey, o.session));
    });
    const lines = readFileSync(ledger, "utf8").split("\n").filter((l) => l !== "");
    return { delivered: lines.filter((l) => !l.includes(`\t${RESET}\t`)).length, resets: lines.filter((l) => l.includes(`\t${RESET}\t`)).length,
      keys: [...new Set(lines.filter((l) => !l.includes(`\t${RESET}\t`)).map((l) => l.split("\t")[1]))] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** #3033's shape: ONE authored commit, then four merges from main, each pushed (checks pending) and then settled. Nine ticks, 16 minutes. */
function sequenceOf(gh: (commits: string[]) => (args: string[]) => string) {
  const steps = [{ pr: pr(3033, AUTHORED, { isDraft: true }), run: gh([AUTHORED]) }];
  MERGES.forEach((head, i) => {
    const chain = [AUTHORED, ...MERGES.slice(0, i + 1)];
    steps.push({ pr: pr(3033, head, { isDraft: true, statusCheckRollup: PENDING }), run: gh(chain) });
    steps.push({ pr: pr(3033, head, { isDraft: true }), run: gh(chain) });
  });
  return steps;
}

test("#3045 (2) #3033's shape yields exactly ONE order across the whole sequence, and no RESET", () => {
  assert.ok(9 * 2 * 60 * 1000 < WAKE_TTL_MS, "the sequence is shorter than the ledger's window, so a second delivery can only be a re-arm");
  const diffs: Record<string, string> = { [AUTHORED]: PATCH_A() };
  MERGES.forEach((head, i) => { diffs[head] = PATCH_A(`-${40 + i},3 +${41 + i},3`, `main moved ${i}`); });
  const result = runTicks(sequenceOf((commits) => fakeGh(diffs, commits)));
  assert.equal(result.delivered, 1, `ONE draft-awaiting-verdict order, not one per merge: ${JSON.stringify(result.keys)}`);
  assert.equal(result.resets, 0, "the cause never vanished while CI re-ran, so no RESET re-armed it");
  assert.match(result.keys[0], new RegExp(`/pr-3033/${patchIdOfDiff(PATCH_A())?.slice(0, 8)}$`), "keyed on the patch id, not a head");
});

test("#3045 (2) CONTROL: with the patch UNREAD the same sequence re-arms, so the test can see the defect", () => {
  const result = runTicks(sequenceOf(() => refusingGh));
  assert.ok(result.resets > 0, "the cause vanished while checks ran and a RESET was written");
  assert.ok(result.delivered > 1, `the order came back for work that did not change: ${result.delivered} deliveries`);
});

test("#3045 (2) CONTROL: a merge whose resolution CHANGED the patch is new work and keys a new order", () => {
  const diffs: Record<string, string> = { [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B };
  const result = runTicks([
    { pr: pr(3033, AUTHORED, { isDraft: true }), run: fakeGh(diffs, [AUTHORED]) },
    { pr: pr(3033, MERGES[0], { isDraft: true, statusCheckRollup: PENDING }), run: fakeGh(diffs, [AUTHORED, MERGES[0]]) },
    { pr: pr(3033, MERGES[0], { isDraft: true }), run: fakeGh(diffs, [AUTHORED, MERGES[0]]) },
  ]);
  assert.equal(result.keys.length, 2, "two patches, two keys");
});

test("#3045 (2) a head whose checks are RUNNING is kept in the question only when it adds no work, and never earns a verdict's follow-up", () => {
  const running = (head: string, extra: Pr = {}) => pr(3033, head, { isDraft: true, statusCheckRollup: PENDING, ...extra });
  const chain = [AUTHORED, MERGES[0]];
  assert.equal(awaiting(ordersOf(running(MERGES[0]), fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-9,3 +9,3") }, chain))).length, 1,
    "the positive control: an update-branch head with the patch intact stays asked");
  assert.deepEqual(awaiting(ordersOf(running(MERGES[0]), fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B }, chain))), [],
    "a running head that CHANGED the patch is new work whose checks have not settled: nobody is asked yet");
  assert.deepEqual(awaiting(ordersOf(running(MERGES[0]), refusingGh)), [], "an unread patch is not an equal one");
  // A verdict already standing at the equal head orders nothing while checks run -- in particular not `draft-convinced-not-ready`'s ready-flip.
  const answered = running(MERGES[0], { comments: [verdictAt(3033, AUTHORED, "convinced")] });
  const orders = ordersOf(answered, fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-9,3 +9,3") }, chain));
  assert.deepEqual(orders.map((o) => o.cause), [], "settled checks are what a ready-flip waits for");
  const settled = { ...answered, statusCheckRollup: GREEN };
  assert.deepEqual(ordersOf(settled, fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-9,3 +9,3") }, chain)).map((o) => o.cause),
    ["draft-convinced-not-ready"], "THE CONTROL: the same pull request with checks settled does reach the ready-flip");
});

// --- done-when 3: positive controls, both ways ------------------------------------------------------------

test("#3045 (3a) a merge from main whose conflict resolution CHANGES the patch orders a review", () => {
  // The head's headline is `Merge branch 'main' into ...` -- exactly what the retired regex exempted. Only the patch says otherwise.
  const head = pr(3033, MERGES[0], { comments: [verdictAt(3033, AUTHORED, "convinced")] });
  const orders = awaiting(ordersOf(head, fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B }, [AUTHORED, MERGES[0]])));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "reviewer-3033");
  assert.deepEqual(awaiting(ordersOf(head, fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-9,3 +9,3") }, [AUTHORED, MERGES[0]]))), [],
    "the same merge with the patch intact orders none (the contrast that makes the line above a finding)");
});

test("#3045 (3b) a commit authored on top of the reviewed head orders a review", () => {
  const head = pr(3033, MERGES[1], { comments: [verdictAt(3033, AUTHORED, "convinced")] });
  const diffs = { [AUTHORED]: PATCH_A(), [MERGES[1]]: diffOf("a line the author added after the review") };
  assert.equal(awaiting(ordersOf(head, fakeGh(diffs, [AUTHORED, MERGES[1]]))).length, 1);
});

test("#3045 (3c) a rebased head with the identical patch orders none", () => {
  // REBASED has no ancestor in common with AUTHORED and is not in any commit list the old chain could walk; the patch alone says it is the same work.
  const rebased = pr(3033, REBASED, { comments: [verdictAt(3033, AUTHORED, "convinced")] });
  const same = fakeGh({ [AUTHORED]: PATCH_A(), [REBASED]: PATCH_A("-77,3 +80,3", "rebased onto a newer main") }, [REBASED]);
  assert.deepEqual(awaiting(ordersOf(rebased, same)), []);
  // THE CONTROL: the same rebased head with a different patch is asked.
  assert.equal(awaiting(ordersOf(rebased, fakeGh({ [AUTHORED]: PATCH_A(), [REBASED]: PATCH_B }, [REBASED]))).length, 1);
});

// --- done-when 4: a refusal at an unchanged patch says it stands, and that a re-ask is not owed ---------------

const refused = (head: string) => ({ ...pr(2049, head), reviewDecision: "CHANGES_REQUESTED",
  statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
  labels: [{ name: "session:worker-4" }], comments: [verdictAt(2049, AUTHORED, "not convinced")],
  reviews: [{ state: "CHANGES_REQUESTED", commit: { oid: AUTHORED } }] });
const blockedPrompt = (p: Pr, run: (args: string[]) => string) => {
  const [order] = ordersOf(p, run, { required: ["gate"] }).filter((o) => o.cause === "pr-review-blocked");
  assert.ok(order, "the refusal reaches its author");
  assert.equal(order.session, "worker-4");
  return order.prompt;
};

test("#3045 (4) `refusedPrompt` stops asking for a fresh look when the patch is unchanged since the refusal", () => {
  const prompt = blockedPrompt(refused(MERGES[0]), fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-50,3 +52,3") }));
  assert.match(prompt, /the refusal stands at the same work/);
  assert.match(prompt, /a re-ask of `reviewer-2049` is not owed/);
  assert.doesNotMatch(prompt, /for a fresh look/, "the re-ask sentence is gone when there is no new work to look at");
});

test("#3045 (4) CONTROL: a refusal at an older head with a CHANGED patch still carries the re-ask sentence", () => {
  const prompt = blockedPrompt(refused(MERGES[0]), fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B }));
  assert.match(prompt, /ask `reviewer-2049` for a fresh look at the head/);
  assert.doesNotMatch(prompt, /not owed/);
  // And an UNREAD patch is not an unchanged one: the old sentence, which is what the gate said before the patch was read.
  assert.match(blockedPrompt(refused(MERGES[0]), refusingGh), /for a fresh look/);
});

// --- a11ign#3199: A REFUSAL POSTED FOR A FAILING CHECK DOES NOT STAND AT AN EQUAL PATCH ONCE THE CHECK IS GREEN ----------------------------
//
// #3154 (Dependabot): refused at AUTHORED while `ts / run` failed on a defect in `main`, `main` was fixed, the rebase made MERGES[0] with the SAME
// patch. The gate read "the PATCH is unchanged ... the rework is yours" and asked nobody to look again; the door refused the follow-up. Both now ask
// `refusalLifted`, which reads check-run CONCLUSIONS at the two commits. Each negative differs from the positive by exactly one fact.

/** `fakeGh` that also answers the check-runs read: the failing names by commit, one per line as `gh --jq` prints them. `calls` logs every read. */
function fakeGhWithChecks(failing: Record<string, string[]>, calls: string[] = [], unreadable = false) {
  const patches = fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_A("-40,3 +41,3", "main moved") });
  return (args: string[]): string => {
    const path = args.find((a) => a.includes("/check-runs"));
    if (path === undefined) return patches(args);
    calls.push(path);
    if (unreadable) throw new Error("HTTP 403");
    const sha = path.split("/commits/")[1].split("/")[0];
    return (failing[sha] ?? []).join("\n");
  };
}
const RED_AT_AUTHORED = { [AUTHORED]: ["ts / run", "gate"] };

/** #3154's own shape: an unlabelled dependency PR, the refusal a review (not a comment) at the older head. */
const dependabot = (head: string, state = "CHANGES_REQUESTED", word = "not convinced", extra: Pr = {}): Pr => pr(3154, head, {
  author: { login: "dependabot[bot]" }, labels: [], comments: [], reviewDecision: state,
  reviews: [{ state, commit: { oid: AUTHORED }, submittedAt: "2026-10-03T10:02:16Z", body: `**Review of #3154 at \`${AUTHORED.slice(0, 8)}\`, by reviewer-3154: ${word}.**` }],
  ...extra,
});
const causes = (orders: Order[]) => orders.map((o) => o.cause);

test("#3199 (2) POSITIVE: the refusal posted for a failing check, equal patch, green head: the reviewer seat is ordered and no rework is assigned", () => {
  const orders = ordersOf(dependabot(MERGES[0]), fakeGhWithChecks(RED_AT_AUTHORED));
  assert.equal(awaiting(orders).length, 1, "the PR is offered to its reviewer seat for a fresh look");
  assert.equal(awaiting(orders)[0].session, "reviewer-3154");
  assert.ok(!causes(orders).includes("verdict-not-convinced"), "no order says the verdict stands");
  for (const o of orders) assert.doesNotMatch(o.prompt, /rework is yours/, `${o.cause} tells nobody the rework is theirs`);
});

test("#3199 (5b) NEGATIVE: the refused commit's checks were all green (the #3033 shape): the refusal STANDS and there is no fresh look", () => {
  const orders = ordersOf(dependabot(MERGES[0]), fakeGhWithChecks({}));
  assert.deepEqual(awaiting(orders), []);
  assert.ok(causes(orders).includes("verdict-not-convinced"));
});

test("#3199 (5c) NEGATIVE: the head still fails a check: the refusal STANDS", () => {
  const orders = ordersOf(dependabot(MERGES[0]), fakeGhWithChecks({ ...RED_AT_AUTHORED, [MERGES[0]]: ["ts / run"] }));
  assert.deepEqual(awaiting(orders), []);
  assert.ok(causes(orders).includes("verdict-not-convinced"));
});

test("#3199 (5d) NEGATIVE: the earlier verdict was an APPROVAL, however red the older commit: it stands, and no check is even read", () => {
  const calls: string[] = [];
  const approved = dependabot(MERGES[0], "APPROVED", "convinced");
  assert.deepEqual(awaiting(ordersOf(approved, fakeGhWithChecks(RED_AT_AUTHORED, calls))), []);
  assert.deepEqual(calls, []);
});

test("#3199 (5e) NEGATIVE: a check-runs read that fails is not a green check: the refusal STANDS", () => {
  const calls: string[] = [];
  const orders = ordersOf(dependabot(MERGES[0]), fakeGhWithChecks(RED_AT_AUTHORED, calls, true));
  assert.deepEqual(awaiting(orders), []);
  assert.ok(causes(orders).includes("verdict-not-convinced"));
  assert.ok(calls.length > 0, "the read WAS attempted: the standing refusal is the failure's doing and not an unread branch");
});

test("#3199 (3) the fresh verdict at the head is what stands afterwards, so the order stops once the reviewer has answered", () => {
  const answered = dependabot(MERGES[0], "CHANGES_REQUESTED", "not convinced", {
    reviews: [
      { state: "CHANGES_REQUESTED", commit: { oid: AUTHORED }, submittedAt: "2026-10-03T10:02:16Z", body: `**Review of #3154 at \`${AUTHORED.slice(0, 8)}\`, by reviewer-3154: not convinced.**` },
      { state: "APPROVED", commit: { oid: MERGES[0] }, submittedAt: "2026-10-03T11:04:23Z", body: `**Review of #3154 at \`${MERGES[0].slice(0, 8)}\`, by reviewer-3154: convinced.**` },
    ],
  });
  assert.deepEqual(awaiting(ordersOf(answered, fakeGhWithChecks(RED_AT_AUTHORED))), []);
  assert.ok(!causes(ordersOf(answered, fakeGhWithChecks(RED_AT_AUTHORED))).includes("verdict-not-convinced"));
});

test("#3199 (4) cost: only an equal-patch refusal reads check runs, one per commit compared, and the head only after a failure was found", () => {
  const read = (p: Pr, failing: Record<string, string[]>) => {
    const calls: string[] = [];
    ordersOf(p, fakeGhWithChecks(failing, calls));
    return calls;
  };
  assert.deepEqual(read(pr(3033, MERGES[0], { comments: [verdictAt(3033, AUTHORED, "convinced")] }), RED_AT_AUTHORED), [], "a verdict that is not a refusal");
  assert.deepEqual(read(pr(3033, MERGES[0]), RED_AT_AUTHORED), [], "no verdict at all: the common path adds no call");
  const refusedPatchChanged = dependabot(MERGES[0]);
  const changed = (args: string[]) => (args.some((a) => a.includes("/check-runs")) ? assert.fail("a CHANGED patch reads no check run") : fakeGh({ [AUTHORED]: PATCH_A(), [MERGES[0]]: PATCH_B })(args));
  ordersOf(refusedPatchChanged, changed);
  const lifted = read(dependabot(MERGES[0]), RED_AT_AUTHORED);
  assert.equal(lifted.length, 2, "the refused commit and the head, though the commit is named twice (its full oid and the opener's abbreviation)");
  assert.ok(lifted[0].includes(AUTHORED) && lifted[1].includes(MERGES[0]));
  assert.equal(read(dependabot(MERGES[0]), {}).length, 1, "an all-green refused commit: the head is not read");
});

test("#3199 (2) `pr-review-blocked`: a lifted refusal never says the rework is the author's, for a labelled PR or the unlabelled set", () => {
  const owned = { ...refused(MERGES[0]), statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] };
  const ownedPrompt = blockedPrompt(owned, fakeGhWithChecks(RED_AT_AUTHORED));
  assert.match(ownedPrompt, /what it refused was not in this patch, so there is no rework to do/);
  assert.match(ownedPrompt, /ask `reviewer-2049` for a fresh look at the head/);
  assert.doesNotMatch(ownedPrompt, /the rework is yours/);
  // THE CONTROL: the same PR whose refused commit was all green keeps the sentence the #3045 test pins.
  assert.match(blockedPrompt(owned, fakeGhWithChecks({})), /the refusal stands at the same work/);
  const unowned = { ...owned, labels: [] };
  const [setOrder] = ordersOf(unowned, fakeGhWithChecks(RED_AT_AUTHORED), { required: ["gate"] }).filter((o) => o.cause === "pr-review-blocked");
  assert.match(setOrder.prompt, /\[LIFTED: posted while a check failed/);
  const [kept] = ordersOf(unowned, fakeGhWithChecks({}), { required: ["gate"] }).filter((o) => o.cause === "pr-review-blocked");
  assert.doesNotMatch(kept.prompt, /LIFTED/, "THE CONTROL: no lift, no note");
});

test("#3199 the check-run read is declared in GH_READS", () => {
  assert.match(GH_READS.conditionalOnEqualPatchRefusal, /commits\/\{sha\}\/check-runs/);
});
