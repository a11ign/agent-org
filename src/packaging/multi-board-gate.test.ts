// no-token: gh -- imports `work-gate.mjs` and `wake.mjs`, whose default readers spawn `gh`; every read here is handed an injected `run` and every per-tick read a stub, so nothing is spawned (#2618)
/**
 * #2618 (child 3c of #69): THE GATE AND WAKE ENUMERATE EVERY REPOSITORY THE PROJECT DECLARES, AND A SEAT NAME CANNOT COLLIDE ACROSS TWO.
 *
 * ADR 0040, decision 2. A pull request or row number is only unique WITHIN a repository, so with a second one declared `reviewer-7` names two
 * pull requests and `engineers/ready-row-unclaimed/7` names two rows -- one ledger key, so a `RESET` written for one would silence the other.
 * The grammar, and where each half is asserted below:
 *
 *   name        `<role>-<n>` for the EMPTY key (the primary project's first repository), `<role>-<key>-<n>` otherwise
 *   ledger key  the bare `<n>` for the empty key, `<key>#<n>` otherwise -- so the primary's wake ledger, its `VOIDED` markers and the handoff queue
 *               are read by the new code with NO conversion and by the old code unchanged, which is what makes a rollback a unit edit
 *
 * POSITIVE CONTROLS ARE IN THIS FILE, AND EACH NAMES THE ASSERTION IT SERVES (`.claude/rules/guards-and-assertions.md`). Every "distinct" claim is
 * made over a NON-EMPTY population: the recorded fixture, the ledger sample, the two-scope order lists and the second tracker's ready rows each
 * carry an explicit `length > 0` before anything is compared to them, so a gate that emitted nothing cannot equal an empty fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decide, scopesOf, readLanes, scopeTick, unreadLanes, greenUnarmedOrders, performActions }
  from "../work-gate.mjs";
import { ledgerLine, readLedger, readLedgerDeliveries, reviewerMismatch, orderPullRequest, orderPullRequestRef, noReviewCheckoutFor,
  stuckRowOf, rowOfOrder, isReviewerOrder, liveReviewers, isPerRowInstance, codeRepositoryOf }
  from "../wake.mjs";
import { parityOwner, reviewerSeat, reviewerInstance, reviewerInstanceNumber, seatName, subjectRef, subjectMention }
  from "../review-attribution.mjs";

const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const HEAD = "abc12345deadbeefcafe000011112222";
const pr = (number: number, extra: Record<string, unknown> = {}) => ({ number, isDraft: true, headRefOid: HEAD, statusCheckRollup: GREEN,
  author: { login: "a11ign-ai-workers" }, comments: [], labels: [], ...extra });
const row = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `row ${number}`, labels: [{ name: "ready" }], ...extra });
type Order = { session: string, cause: string, subject: string, discriminator: string, causeKey: string, prompt: string, title?: string,
  action?: Record<string, unknown> };
const asOrders = (orders: unknown) => orders as Order[];

// --- THE TWO PROJECTS ------------------------------------------------------------------------------------------------------------

/** The primary project (empty key) and a second one (key `other`), each with a code repository and a tracker. */
const PRIMARY_DECLARATION = { tracker: [{ key: "", repo: "acme/main" }], code: [{ key: "", repo: "acme/main" }] };
const OTHER_DECLARATION = { tracker: [{ key: "other", repo: "acme/other" }], code: [{ key: "other", repo: "acme/other" }] };

/** A `gh` that answers per repository -- the second argument is the repository the read is AIMED at (`undefined` for the primary's own). */
function fakeGh(byRepo: Record<string, { prs?: unknown[] | Error, ready?: unknown[], open?: unknown[] }>) {
  const calls: { args: string[], repo: string | undefined }[] = [];
  const run = (args: string[], repo?: string) => {
    calls.push({ args, repo });
    const answers = byRepo[repo ?? "acme/main"];
    const pick = (value: unknown[] | Error | undefined) => {
      if (value instanceof Error) throw value;
      return JSON.stringify(value ?? []);
    };
    if (args[0] === "pr") return pick(answers.prs);
    if (args.includes("--label") && args.includes("ready")) return pick(answers.ready);
    if (args.includes("--limit") && args[args.indexOf("--limit") + 1] === "500") return pick(answers.open);
    return "[]";
  };
  return { run, calls };
}

const NO_READINGS = { code: (prs: any[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
  tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null }) };

/** One scope's orders, made the way `main` makes them: the lanes through `readLanes`, then `decide` (the per-tick extras stubbed). */
function ordersOf(scope: ReturnType<typeof scopesOf>[number], gh: ReturnType<typeof fakeGh>) {
  const lanes = readLanes(scope, gh.run);
  return { lanes, tick: scopeTick(scope, false, lanes, NO_READINGS) };
}

test("the scopes: one per KEY, the primary's (empty) key FIRST, and a key declared twice REFUSES naming it", () => {
  const scopes = scopesOf([OTHER_DECLARATION, PRIMARY_DECLARATION]);
  assert.deepEqual(scopes.map((s) => s.key), ["", "other"], "the primary is first whatever order the declarations came in");
  assert.deepEqual(scopes[1], { key: "other", code: { repo: "acme/other" }, tracker: { repo: "acme/other" } });
  // A layer repository has code and NO tracker of its own (ADR 0040, decision 2): the absent half is `null`, never the primary's.
  const layer = scopesOf([PRIMARY_DECLARATION, { tracker: [], code: [{ key: "layer", repo: "acme/layer" }] }]);
  assert.deepEqual(layer[1], { key: "layer", code: { repo: "acme/layer" }, tracker: null });
  // The one-project list has exactly one scope, and it is the primary's -- the population `main` ticks itself.
  assert.deepEqual(scopesOf([PRIMARY_DECLARATION]).map((s) => s.key), [""]);
  // NEGATIVES: the same key twice in one list of two declarations, and the EMPTY key claimed by a second project.
  assert.throws(() => scopesOf([PRIMARY_DECLARATION, OTHER_DECLARATION, OTHER_DECLARATION]), /key `other` declares a tracker repository twice/);
  assert.throws(() => scopesOf([PRIMARY_DECLARATION, { tracker: [], code: [{ key: "", repo: "acme/x" }] }]), /key \(empty\) declares a code repository twice/);
});

// --- THE COLLISION: PR 7 IN TWO REPOSITORIES ------------------------------------------------------------------------------------

const SAME_NUMBER = 7;

test("DONE-WHEN 1: with two projects, one open pull request in each with the SAME number yields two seats, two cause keys and two ledger keys", () => {
  const gh = fakeGh({ "acme/main": { prs: [pr(SAME_NUMBER)] }, "acme/other": { prs: [pr(SAME_NUMBER)] } });
  const [primary, other] = scopesOf([PRIMARY_DECLARATION, OTHER_DECLARATION]);
  const mine = asOrders(ordersOf(primary, gh).tick.orders);
  const theirs = asOrders(ordersOf(other, gh).tick.orders);
  // POSITIVE CONTROL: each scope emitted its reviewer order, or every "distinct" below compares two empty lists.
  assert.equal(mine.length, 1, "the primary's PR 7 is awaiting a verdict");
  assert.equal(theirs.length, 1, "and so is the other repository's PR 7");
  assert.deepEqual([mine[0].session, theirs[0].session], ["reviewer-7", "reviewer-other-7"], "two seats: `reviewer-<n>` and `reviewer-<key>-<n>`");
  assert.equal(mine[0].causeKey, "reviewer-7/draft-awaiting-verdict/pr-7/abc12345");
  assert.equal(theirs[0].causeKey, "reviewer-other-7/draft-awaiting-verdict/pr-other#7/abc12345");
  assert.notEqual(mine[0].causeKey, theirs[0].causeKey, "two cause keys");
  // THE LEDGER KEY, as the ledger writes it: the bare number for the primary, `<key>#<n>` for the other.
  const keys = [mine[0], theirs[0]].map((o) => ledgerLine(1, o.causeKey).trim().split("\t")[1]);
  assert.equal(new Set(keys).size, 2, "two ledger keys");
  assert.deepEqual(keys.map((k) => /pr-([a-z#0-9-]+)\//.exec(k)?.[1]), ["7", "other#7"], "the subject token is `<n>` and `<key>#<n>`");
  assert.equal(subjectRef("", 7), "7");
  assert.equal(subjectRef("other", 7), "other#7");
  // Tagged in, and only the OTHER is tagged: the primary's pull request is byte-for-byte what `gh` returned.
  assert.equal("repoKey" in mine[0], false);
  assert.match(theirs[0].prompt, /REPOSITORY `other` \(code `acme\/other`, rows `acme\/other`\)/, "and the prompt says which repository a bare `gh` number belongs to");
  assert.match(theirs[0].prompt, /^Draft other#7 at `abc12345`/, "the mention is `<key>#<n>`, not a bare `#7` the reader would take for the primary's");
});

test("the collision holds over EVERY cause: the same fixture in two repositories shares no cause key, and differs only in the naming", () => {
  const { BUSY_INPUT } = fixtures();
  const tag = (list: any[], key: string) => list.map((item) => ({ ...item, repoKey: key, repo: `acme/${key}` }));
  const asKey = (input: any, key: string) => ({ ...input, prs: tag(input.prs, key), readyRows: tag(input.readyRows, key), answerOwed: tag(input.answerOwed, key),
    openRows: tag(input.openRows, key), key, repo: `acme/${key}` });
  const primary = asOrders(decide(BUSY_INPUT));
  const other = asOrders(decide(asKey(BUSY_INPUT, "other")));
  assert.ok(primary.length >= 12, `POSITIVE CONTROL: the fixture emits ${primary.length} orders across many causes, not a handful`);
  assert.equal(other.length, primary.length, "the same causes fire for the same facts, in either repository");
  const primaryKeys = new Set(primary.map((o) => o.causeKey));
  const shared = other.filter((o) => primaryKeys.has(o.causeKey)).map((o) => o.causeKey);
  assert.deepEqual(shared, [], "NO cause key is shared: a `RESET` or a delivery for one repository can never silence the other");
  // What differs is the NAMING and nothing else: strip the key back out of the other's and it IS the primary's.
  const unkeyed = (o: Order) => ({ ...o, causeKey: o.causeKey.replaceAll("other#", "").replaceAll("reviewer-other-", "reviewer-"),
    session: o.session.replace("reviewer-other-", "reviewer-"), subject: o.subject.replaceAll("other#", ""), discriminator: o.discriminator.replaceAll("other#", "") });
  assert.deepEqual(other.map((o) => unkeyed(o).causeKey), primary.map((o) => o.causeKey));
  assert.deepEqual(other.map((o) => unkeyed(o).session), primary.map((o) => o.session));
  assert.deepEqual(other.map((o) => unkeyed(o).discriminator), primary.map((o) => o.discriminator));
  // EVERY subject number of the other repository carries the key -- none is left bare to collide.
  for (const o of other) assert.ok(/other#/.test(o.causeKey) || !/\/(?:row-|pr-|epic-)?\d+(?:[/:]|$)/.test(o.causeKey), `${o.causeKey} carries a bare number`);
  assert.ok(other.some((o) => o.session === "reviewer-other-101"), "and the reviewer seat is `reviewer-<key>-<n>`");
});

test("the seat grammar: `<role>-<n>` for the empty key and `<role>-<key>-<n>` otherwise, READ from the right, and `reviewer-2` retired for that one name only", () => {
  assert.equal(seatName("reviewer", "", 12), "reviewer-12");
  assert.equal(seatName("reviewer", "agent-org", 12), "reviewer-agent-org-12");
  assert.equal(seatName("worker", "agent-org", 7), "worker-agent-org-7");
  assert.equal(parityOwner(7), "reviewer-7");
  assert.deepEqual([1, 2, 3].map(parityOwner), ["reviewer-1", "reviewer-2", "reviewer-3"], "`map` hands parityOwner an index, which must NOT become a key");
  assert.equal(reviewerSeat({ number: 7 }), "reviewer-7");
  assert.equal(reviewerSeat({ repoKey: "", number: 7 }), "reviewer-7");
  assert.equal(reviewerSeat({ repoKey: "nvda-worker", number: 12 }), "reviewer-nvda-worker-12");
  assert.equal(subjectMention({ number: 7 }), "#7");
  assert.equal(subjectMention({ repoKey: "agent-org", number: 7 }), "agent-org#7");
  // Round trip and the parse from the right.
  for (const [key, n] of [["", 7], ["agent-org", 12], ["nvda-worker", 3], ["a1", 40]] as const) {
    assert.deepEqual(reviewerInstance(reviewerSeat({ repoKey: key, number: n })), { key, number: n }, `${key || "(empty)"}#${n} round-trips`);
  }
  assert.equal(reviewerInstance("reviewer-2"), null, "the retired standing pane is no instance");
  assert.deepEqual(reviewerInstance("reviewer-agent-org-2"), { key: "agent-org", number: 2 }, "and the retirement is of that ONE name");
  for (const notOne of ["reviewer", "reviewer-x", "reviewer-a-3-12", "worker-agent-org-7", "reviewer-", "reviewer-agent-org-0"]) {
    assert.equal(reviewerInstance(notOne), null, `${notOne} is no reviewer instance (a key ending in -<digits> would parse two ways)`);
  }
  // The number-only reader answers for the PRIMARY alone: another repository's bare number names the wrong pull request.
  assert.equal(reviewerInstanceNumber("reviewer-7"), 7);
  assert.equal(reviewerInstanceNumber("reviewer-agent-org-7"), null);
});

// --- THE LEDGER: BYTE-IDENTICAL FOR THE PRIMARY -----------------------------------------------------------------------------------

/**
 * A recorded sample of the LIVE wake ledger, read 2026-09-26 from `~/.cache/a11ign/wake-ledger` (4,971 lines): one line of each shape the ADR names
 * -- `.../N`, `.../row-N`, `.../N:STATE`, `.../pr-N/head`, a recipient, the no-clear field, and the three markers.
 */
const LEDGER_SAMPLE = [
  "1790426322840\tengineers/ready-row-unclaimed/2620\tworker-2620\n",
  "1790426673219\tceo/answer-owed/row-2649\n",
  "1790410549749\tproduct-manager/pr-review-blocked/2630:REFUSED\n",
  "1790425919681\tworker-2667/pr-checks-failing/pr-2669/ed8208fe\t\tno-clear\n",
  "1790426180371\tproduct-manager/unclaimed-blocker-cleared/row-2620/2616.2658\n",
  "1790426175330\tRESET\tproduct-manager/ready-queue-empty/2\n",
  "1790410184375\tRESET\tproduct-manager/pr-review-blocked/2630:AWAITING_REVIEW\n",
  "1790426568909\tESCALATED\tworker-2632/pr-checks-failing/pr-2649/c1d23a21\n",
];

test("DONE-WHEN 4: today's ledger lines are READ by the new code unchanged, and the new code WRITES the same bytes for a primary entry", () => {
  assert.ok(LEDGER_SAMPLE.length >= 8, "POSITIVE CONTROL: the sample is not empty, so 'read unchanged' is not satisfied by reading nothing");
  const text = LEDGER_SAMPLE.join("");
  // Each line is read ALONE, one second after it was written: the reader keeps a key live for `WAKE_TTL_MS` (20 minutes) and the sample spans
  // hours, so reading them together would drop the old ones for their AGE and say nothing about their SHAPE.
  let read = 0;
  for (const line of LEDGER_SAMPLE) {
    const [at, first, second] = line.trimEnd().split("\t");
    if (first === "RESET" || first === "ESCALATED") continue;
    assert.ok(readLedger("ledger", () => line, Number(at) + 1000).has(first), `the ledger reader keeps \`${first}\` exactly as written (${second ?? "no recipient"})`);
    read += 1;
  }
  assert.equal(read, 5, "five delivery lines were read, of eight (three are markers, which `endedRuns` and the escalation writer own)");
  const deliveries = readLedgerDeliveries("ledger", () => text);
  assert.deepEqual(deliveries.map((d) => d.key), ["engineers/ready-row-unclaimed/2620", "ceo/answer-owed/row-2649", "product-manager/pr-review-blocked/2630:REFUSED",
    "worker-2667/pr-checks-failing/pr-2669/ed8208fe", "product-manager/unclaimed-blocker-cleared/row-2620/2616.2658"]);
  assert.equal(deliveries[0].session, "worker-2620", "a recipient is read as before");
  // WRITTEN: `ledgerLine` reproduces each delivery line byte for byte.
  assert.equal(ledgerLine(1790426322840, "engineers/ready-row-unclaimed/2620", "worker-2620"), LEDGER_SAMPLE[0]);
  assert.equal(ledgerLine(1790426673219, "ceo/answer-owed/row-2649"), LEDGER_SAMPLE[1]);
  assert.equal(ledgerLine(1790410549749, "product-manager/pr-review-blocked/2630:REFUSED"), LEDGER_SAMPLE[2]);
  assert.equal(ledgerLine(1790425919681, "worker-2667/pr-checks-failing/pr-2669/ed8208fe", undefined, true), LEDGER_SAMPLE[3]);
  // A KEYED key travels through the same reader and writer with no special case: it is one more opaque key.
  const keyed = "engineers/ready-row-unclaimed/other#2620";
  assert.equal(ledgerLine(5, keyed, "worker-other-2620"), `5\t${keyed}\tworker-other-2620\n`);
  assert.deepEqual(readLedgerDeliveries("l", () => `5\t${keyed}\tworker-other-2620\n5\tRESET\t${keyed}\n`).map((d) => d.key), [keyed]);
  assert.equal(readLedger("l", () => ledgerLine(Date.now(), keyed), Date.now()).has(keyed), true);
  assert.equal(readLedger("l", () => `${ledgerLine(Date.now(), keyed)}${ledgerLine(Date.now(), "engineers/ready-row-unclaimed/2620")}`, Date.now()).size, 2,
    "the primary's row 2620 and the other's are TWO live keys, so neither's delivery silences the other");
});

// --- THE ONE-PROJECT FIXTURE: BYTE-IDENTICAL ORDERS -------------------------------------------------------------------------------

/** The inputs `RECORDED_*` was recorded from; the shapes `work-gate.test.ts` uses. */
function fixtures() {
  const BUSY_INPUT = {
    prs: [
      pr(101),
      pr(102, { statusCheckRollup: RED, labels: [{ name: "session:worker-x" }] }),
      pr(103, { isDraft: false, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", labels: [{ name: "session:worker-y" }], reviewDecision: "APPROVED" }),
      pr(104, { isDraft: false, reviewDecision: "REVIEW_REQUIRED", reviews: [], labels: [] }),
      pr(105, { isDraft: false, reviewDecision: "APPROVED", labels: [] }),
    ],
    readyRows: [row(201), row(202, { labels: [{ name: "ready" }, { name: "priority" }] }), row(203, { labels: [{ name: "ready" }, { name: "lane:ceo" }] })],
    answerOwed: [{ number: 301, title: "asks", labels: [{ name: "answer:ceo" }] },
      { number: 302, title: "asks 2", isDraft: true, labels: [{ name: "answer:product-manager" }] }],
    unarmed: [105],
    openRows: [{ number: 501, title: "gated", labels: [{ name: "fleet-gated" }], body: "", blockedBy: [] }],
  };
  const EMPTY_SHELF_INPUT = {
    prs: [],
    readyRows: [],
    promotableRows: [{ number: 401, labels: [{ name: "backlog" }], body: "", blockedBy: [] }, { number: 402, labels: [{ name: "backlog" }], body: "", blockedBy: [] }],
    epics: [{ number: 601, title: "an epic", subIssuesSummary: { total: 0, completed: 0 } }, { number: 602, title: "done epic", subIssuesSummary: { total: 2, completed: 2 } }],
    openRows: [{ number: 501, title: "gated", labels: [{ name: "fleet-gated" }], body: "", blockedBy: [] },
      { number: 502, title: "blocked no referent", labels: [{ name: "blocked" }], body: "", blockedBy: [] }],
  };
  return { BUSY_INPUT, EMPTY_SHELF_INPUT };
}

/**
 * RECORDED FROM `origin/main` AT `1b5176697` -- BEFORE THIS CHANGE -- by running its own `decide` over `fixtures()` and keeping, per order, every
 * field but the prompt and the prompt's SHA-256 and length (a prompt is thousands of characters and the digest is the same claim). A pinned digest
 * is only as good as the run that made it, so the recording script (`decide` from `git archive origin/main`, the same inputs) printed
 * these and the new code printed the same file, `cmp` identical.
 */
const RECORDED_BUSY = [
  { session: "ceo", cause: "answer-owed", subject: "row-301", discriminator: "301", causeKey: "ceo/answer-owed/row-301", promptSha256: "19dc374722c2083bccd5fa028196b6d0a4748cea5c41cb44a1ff0a2287e6af25", promptLength: 598 },
  { session: "product-manager", cause: "answer-owed", subject: "row-302", discriminator: "302", causeKey: "product-manager/answer-owed/row-302", promptSha256: "46129b1b1472975bb72ccb0d1fbd382f55ddbba3885110c1417e4c99330b102f", promptLength: 643 },
  { session: "reviewer-101", cause: "draft-awaiting-verdict", subject: "pr-101", discriminator: "abc12345", causeKey: "reviewer-101/draft-awaiting-verdict/pr-101/abc12345", promptSha256: "4139ebb6ba237ac5d60499cbe7f51b8be4e9a924462963af48341fea0111180f", promptLength: 179 },
  { session: "worker-x", cause: "pr-checks-failing", subject: "pr-102", discriminator: "abc12345", causeKey: "worker-x/pr-checks-failing/pr-102/abc12345", promptSha256: "4b867314bbbbbb5b63129a0cd85357157ec328118500592a7819f0da60438313", promptLength: 668 },
  { session: "reviewer-103", cause: "draft-awaiting-verdict", subject: "pr-103", discriminator: "abc12345", causeKey: "reviewer-103/draft-awaiting-verdict/pr-103/abc12345", promptSha256: "e9edab747c388f9da70c5eff8b3e2c335fb5f9063da8e4b8ff3168350870cf68", promptLength: 193 },
  { session: "reviewer-104", cause: "draft-awaiting-verdict", subject: "pr-104", discriminator: "abc12345", causeKey: "reviewer-104/draft-awaiting-verdict/pr-104/abc12345", promptSha256: "3b9fc8a9e5357634ab5561b570964fc37d11ecbcd45d16ea14201b5d89c57f6e", promptLength: 193 },
  { session: "reviewer-105", cause: "draft-awaiting-verdict", subject: "pr-105", discriminator: "abc12345", causeKey: "reviewer-105/draft-awaiting-verdict/pr-105/abc12345", promptSha256: "55b2844e92c43f39f1ddb3fa7a5a6c603652130612d706d9972cb2f77c76f309", promptLength: 193 },
  { session: "engineers", cause: "ready-row-unclaimed", subject: "row-202", discriminator: "202", causeKey: "engineers/ready-row-unclaimed/202", title: "row 202", promptSha256: "db0b62244a043edc9bf8e6a6188a20e0ed2b385346ac5d666c56c63f5aa600a5", promptLength: 339 },
  { session: "engineers", cause: "ready-row-unclaimed", subject: "row-201", discriminator: "201", causeKey: "engineers/ready-row-unclaimed/201", title: "row 201", promptSha256: "9bcbc1aa084c3433a3ccdf6e9caaeb94f854c32b807b939ca5b26f38864ead00", promptLength: 339 },
  { session: "ceo", cause: "ready-row-unclaimed", subject: "row-203", discriminator: "203", causeKey: "ceo/ready-row-unclaimed/203", title: "row 203", promptSha256: "0e18f3a9822097dcbc9d00096a326fbb9acfb7adae15a304f871bdcf96e256b6", promptLength: 339 },
  { session: "orchestrator", cause: "fleet-batch-due", subject: "fleet-batch", discriminator: "501", causeKey: "orchestrator/fleet-batch-due/501", promptSha256: "5d73451b5f55e4ab401c5bd6199d4a4e8283a0860dcf5218e4e869f20646560d", promptLength: 834 },
  { session: "product-manager", cause: "pr-green-unarmed", subject: "pr-green-unarmed", discriminator: "105", causeKey: "product-manager/pr-green-unarmed/105", promptSha256: "00b76232fa3df5a877ad5b40b8ce530e366010a6baeaf253de4ae315f24096dc", promptLength: 1446 },
  { session: "product-manager", cause: "pr-review-blocked", subject: "pr-review-blocked", discriminator: "104:AWAITING_REVIEW", causeKey: "product-manager/pr-review-blocked/104:AWAITING_REVIEW", promptSha256: "aefffdcd3c8bcb4a1e6de8bb1977742ffcfde461ab2b4586c06c883a41c601f6", promptLength: 1444 },
  { session: "worker-y", cause: "pr-merge-conflict", subject: "pr-103", discriminator: "abc12345", causeKey: "worker-y/pr-merge-conflict/pr-103/abc12345", promptSha256: "4da17865611827c0c35f07130e2deb7961a324de3efdf325673ba95bbf75282d", promptLength: 554 },
];
const RECORDED_EMPTY_SHELF = [
  { session: "product-manager", cause: "ready-queue-empty", subject: "ready-queue", discriminator: "2", causeKey: "product-manager/ready-queue-empty/2", promptSha256: "b736cb78be7634b1bf246e7fbc4e3953237e941cf31f70f3bc33e1b8e9ac0a30", promptLength: 1554 },
  { session: "product-manager", cause: "epic-unfiled", subject: "epic-601", discriminator: "601", causeKey: "product-manager/epic-unfiled/epic-601", promptSha256: "f888877ea2db03faabac02a31b132bca2be67b9e38eec5927ac3235c09e0245f", promptLength: 896 },
  { session: "product-manager", cause: "epic-finished", subject: "epic-602", discriminator: "602", causeKey: "product-manager/epic-finished/epic-602", promptSha256: "42e41d96798173186beb8d2d9fc1289d926568e5c73dd1b79654923ac22a689c", promptLength: 932 },
  { session: "product-manager", cause: "blocked-unexaminable", subject: "row-502", discriminator: "502", causeKey: "product-manager/blocked-unexaminable/row-502", promptSha256: "84f0ad969fcbda8ec7c718e573171d73fa0dae38b549c117bb516d85dbe2a512", promptLength: 2127 },
  { session: "orchestrator", cause: "fleet-batch-due", subject: "fleet-batch", discriminator: "501", causeKey: "orchestrator/fleet-batch-due/501", promptSha256: "5d73451b5f55e4ab401c5bd6199d4a4e8283a0860dcf5218e4e869f20646560d", promptLength: 834 },
];

const view = (o: Order) => ({ session: o.session, cause: o.cause, subject: o.subject, discriminator: o.discriminator, causeKey: o.causeKey,
  ...(o.title === undefined ? {} : { title: o.title }), ...(o.action === undefined ? {} : { action: o.action }),
  promptSha256: createHash("sha256").update(o.prompt).digest("hex"), promptLength: o.prompt.length });

test("DONE-WHEN 4: with one project the orders EQUAL the recorded fixture of today's -- every field, every prompt to the byte", () => {
  const { BUSY_INPUT, EMPTY_SHELF_INPUT } = fixtures();
  assert.ok(RECORDED_BUSY.length >= 13 && RECORDED_EMPTY_SHELF.length >= 5,
    "POSITIVE CONTROL: the recorded fixture is non-empty and spans many causes, so an empty gate cannot equal an empty fixture");
  assert.ok(new Set(RECORDED_BUSY.map((o) => o.cause)).size >= 8, "and its causes are varied");
  assert.deepEqual(asOrders(decide(BUSY_INPUT)).map(view), RECORDED_BUSY);
  assert.deepEqual(asOrders(decide(EMPTY_SHELF_INPUT)).map(view), RECORDED_EMPTY_SHELF);
  // The primary path adds nothing to what it returns: no `repoKey`, no `repo`, no repository note in any prompt.
  for (const o of asOrders(decide(BUSY_INPUT))) assert.ok(!o.prompt.includes("REPOSITORY `"), `${o.causeKey} says nothing of a repository`);
  // AND THE PRIMARY'S ENUMERATION IS UNTOUCHED: a one-project `readLanes` returns the lists exactly as `gh` did, with no tag on any member.
  const gh = fakeGh({ "acme/main": { prs: [pr(101)], ready: [row(201)], open: [row(201)] } });
  const lanes = readLanes(scopesOf([PRIMARY_DECLARATION])[0], gh.run);
  assert.deepEqual(lanes.prs, [pr(101)]);
  assert.deepEqual(lanes.readyRows, [row(201)]);
  assert.ok(gh.calls.length >= 5 && gh.calls.every((c) => c.repo === undefined), "and every call is AIMED at nothing: the checkout's own repository, as before");
});

// --- THE SECOND TRACKER REACHES THE QUEUE -----------------------------------------------------------------------------------------

test("a row in the SECOND tracker reaches the ready queue and is offered -- under its own key, beside the primary's row of the same number", () => {
  const gh = fakeGh({ "acme/main": { ready: [row(SAME_NUMBER)] }, "acme/other": { ready: [row(SAME_NUMBER, { title: "the other's row" })] } });
  const [primary, other] = scopesOf([PRIMARY_DECLARATION, OTHER_DECLARATION]);
  const mine = asOrders(ordersOf(primary, gh).tick.orders).filter((o) => o.cause === "ready-row-unclaimed");
  const theirs = asOrders(ordersOf(other, gh).tick.orders).filter((o) => o.cause === "ready-row-unclaimed");
  assert.equal(mine.length, 1, "POSITIVE CONTROL: the primary's row is offered");
  assert.equal(theirs.length, 1, "and so is the second tracker's -- it REACHED the queue");
  assert.equal(mine[0].causeKey, "engineers/ready-row-unclaimed/7");
  assert.equal(theirs[0].causeKey, "engineers/ready-row-unclaimed/other#7");
  assert.equal(theirs[0].discriminator, "other#7");
  assert.match(theirs[0].prompt, /^Ready row other#7 is unclaimed: the other's row\./);
  assert.equal(ordersOf(other, gh).lanes.readyRows?.[0].repoKey, "other", "read from THE OTHER TRACKER's repository, not the primary's");
  assert.ok(gh.calls.some((c) => c.repo === "acme/other" && c.args.includes("ready")), "the call was aimed at the second tracker's repository");
  // NEGATIVE: wake's row parser does NOT read the keyed key as the primary's row 7 -- claiming the wrong row would be worse than none.
  assert.equal(rowOfOrder({ causeKey: mine[0].causeKey } as any), 7);
  assert.equal(rowOfOrder({ causeKey: theirs[0].causeKey } as any), null);
});

// --- A FAILED READ OF ONE REPOSITORY --------------------------------------------------------------------------------------------

test("a failed read of one repository is REPORTED and does NOT drop the other's orders", () => {
  const refusal = new Error("HTTP 403: rate limit");
  const gh = fakeGh({ "acme/main": { prs: [pr(SAME_NUMBER)] }, "acme/other": { prs: refusal, ready: [row(9)] } });
  const [primary, other] = scopesOf([PRIMARY_DECLARATION, OTHER_DECLARATION]);
  const mine = ordersOf(primary, gh);
  const theirs = ordersOf(other, gh);
  assert.equal(asOrders(mine.tick.orders).length, 1, "POSITIVE CONTROL: the primary's order is there");
  assert.deepEqual(mine.tick.refused, [], "and it read everything");
  assert.equal(theirs.lanes.prs, null, "the refused lane is `null` -- never `[]`, which would read as 'nothing is open there' (#1286)");
  assert.deepEqual(theirs.tick.refused, ["the pull-request list of acme/other"], "and the refusal NAMES the repository");
  assert.equal(asOrders(theirs.tick.orders).filter((o) => o.cause === "ready-row-unclaimed").length, 1, "the same repository's OTHER lane still produced its order");
  // `main` reports it: the unread lanes of every scope, joined, with the primary's own first.
  assert.deepEqual(unreadLanes({ prs: [], readyRows: [], others: [theirs.tick] }), ["the pull-request list of acme/other"]);
  assert.deepEqual(unreadLanes({ prs: null, readyRows: [], others: [theirs.tick] }), ["the pull-request list", "the pull-request list of acme/other"]);
  assert.deepEqual(unreadLanes({ prs: [], readyRows: [], others: [mine.tick] }), [], "and NOTHING unread is nothing -- a refusal is not reported when there was none");
});

// --- WAKE: THE SEAT AND THE ORDER MUST AGREE --------------------------------------------------------------------------------------

test("wake: `reviewer-7` and `reviewer-other-7` each refuse an order about the OTHER's PR 7, and accept their own", () => {
  const mine = { causeKey: "reviewer-7/draft-awaiting-verdict/pr-7/abc12345" };
  const theirs = { causeKey: "reviewer-other-7/draft-awaiting-verdict/pr-other#7/abc12345" };
  assert.equal(reviewerMismatch(mine, "reviewer-7"), null, "POSITIVE CONTROL: each accepts its own");
  assert.equal(reviewerMismatch(theirs, "reviewer-other-7"), null);
  assert.match(String(reviewerMismatch(theirs, "reviewer-7")), /"reviewer-7" reviews PR #7 and nothing else, and this order is about PR other#7/);
  assert.match(String(reviewerMismatch(mine, "reviewer-other-7")), /"reviewer-other-7" reviews PR other#7 and nothing else, and this order is about PR #7/);
  assert.notEqual(reviewerMismatch({ causeKey: "reviewer-other-7/x/pr-third#7/abc" }, "reviewer-other-7"), null, "and a THIRD repository's PR 7 is refused by both");
  assert.notEqual(reviewerMismatch({ causeKey: "engineers/ready-row-unclaimed/7" }, "reviewer-other-7"), null, "an order about no pull request is refused (fail closed)");
  // Parsing.
  assert.deepEqual(orderPullRequestRef(theirs), { key: "other", number: 7 });
  assert.deepEqual(orderPullRequestRef(mine), { key: "", number: 7 });
  assert.equal(orderPullRequest(mine), 7);
  assert.equal(orderPullRequest(theirs), null, "the number-only reader answers for the primary alone");
  assert.equal(orderPullRequestRef({ causeKey: "x/pr-07/y" }), null, "a leading zero is not a pull request number");
  // Routing predicates recognise the keyed instance, so its order is NOT taken for an engineer's.
  assert.equal(isReviewerOrder({ session: "reviewer-other-7", cause: "draft-awaiting-verdict" }), true);
  assert.equal(isReviewerOrder({ session: "worker-other-7", cause: "draft-awaiting-verdict" }), false);
  assert.deepEqual(liveReviewers([{ label: "reviewer-7" }, { label: "reviewer-other-7" }, { label: "reviewer-2" }, { label: "worker-4" }] as any),
    ["reviewer-7", "reviewer-other-7"]);
  assert.equal(isPerRowInstance("reviewer-other-7"), true, "a keyed reviewer is a per-row instance and is never /clear-ed between orders (#2483)");
});

test("wake: a keyed reviewer is REFUSED a checkout, by name, because the tick's `origin` is the primary's repository", () => {
  assert.equal(noReviewCheckoutFor("reviewer-7"), null, "POSITIVE CONTROL: the primary's instance gets one");
  assert.match(String(noReviewCheckoutFor("reviewer-other-7")), /no review checkout for "reviewer-other-7".*ADR 0040, decision 3 -- child 3f.*WRONG repository's pull request/);
  assert.equal(noReviewCheckoutFor("worker-4"), null, "a session that is not a reviewer instance is not this function's to refuse");
  assert.equal(codeRepositoryOf("other"), null, "and a key the declaration does not list is UNREADABLE, never the primary's repository");
});

test("wake: a keyed cause key never parses as a PRIMARY row or pull request -- the parsers read nothing rather than the wrong row", () => {
  assert.equal(stuckRowOf("ceo/answer-owed/row-2649"), 2649, "POSITIVE CONTROL: the primary's still parses");
  assert.equal(stuckRowOf("worker-x/pr-checks-failing/pr-2649/abc"), 2649);
  assert.equal(stuckRowOf("ceo/answer-owed/row-other#2649"), null, "escalating a keyed row by its bare number would label the PRIMARY's row");
  assert.equal(stuckRowOf("worker-other-x/pr-checks-failing/pr-other#2649/abc"), null);
});

// --- THE ORDERS THAT NAME A REPOSITORY --------------------------------------------------------------------------------------------

test("`pr-green-unarmed` for another repository names ITS number and ITS repository in the arming command; the primary's is unchanged", () => {
  const [mine] = greenUnarmedOrders([5, 9]) as Order[];
  const [theirs] = greenUnarmedOrders([5, 9], { key: "other", repo: "acme/other" }) as Order[];
  assert.equal(mine.causeKey, "product-manager/pr-green-unarmed/5.9");
  assert.equal(theirs.causeKey, "product-manager/pr-green-unarmed/other#5.other#9");
  assert.match(mine.prompt, /--repo=a11ign\/a11ign/, "the primary's arming command is the repository it always was");
  assert.match(theirs.prompt, /--repo=acme\/other/);
  assert.doesNotMatch(theirs.prompt, /--repo=a11ign\/a11ign/);
  assert.match(theirs.prompt, /other#5, other#9/);
});

test("`gh pr ready` for a pull request of another repository is aimed at THAT repository; the primary's is exactly `pr ready <n>`", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return ""; };
  const order = (action: Record<string, unknown>) => ({ session: "product-manager", cause: "draft-convinced-not-ready", causeKey: "k", prompt: "p", action });
  const quiet = () => undefined;
  performActions([order({ kind: "ready", pr: 12 }), order({ kind: "ready", pr: 12, repo: "acme/other" })] as any, run, quiet);
  assert.deepEqual(calls, [["pr", "ready", "12"], ["pr", "ready", "12", "--repo", "acme/other"]]);
});
