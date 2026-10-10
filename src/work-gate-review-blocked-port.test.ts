// no-token: gh -- the ticket port is a fake and the pull requests are in memory; nothing here spawns `gh`
/**
 * agent-org#489 (Phase 1 of a11ign/a11ign#4505): A REFUSAL POSTED AT AN OLDER HEAD THAN THE PULL REQUEST HAS NOW ORDERS NO ONE.
 *
 * The row's four named cases are the four tests whose names start with their sentence. The orders are the real ones: `withStaleRefusals` is given the pull
 * requests the way the tick reads them, `reviewBlocked` reads what it returns, and the result goes through `reviewBlockedOrders`, the entry `decide` calls, so
 * what the order names is what the gate would send and not what this file thinks it would.
 *
 * THE POPULATION IS CHECKED, NOT ASSUMED: every "no order" below sits beside a control in which the same pull request, refused at the head it has, is ordered,
 * so an empty answer is never the answer of a gate that sends nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVIEW_BLOCKED_SWITCH_ENV, reviewBlocked, staleRefusalOf, withStaleRefusals, type StaleRefusalPort } from "./work-gate.ts";
import { perPullRequestOrders, reviewBlockedOrders } from "./work-gate/pr-orders.ts";
import type { Decision, ItemRef } from "./ticket-port/port.ts";

const HOME = "a11ign/agent-org";
const NOW = Date.parse("2026-10-10T17:00:00Z");
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-10T16:00:00Z" }];
const OLD = "0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0";
const HEAD = "4ead4ead4ead4ead4ead4ead4ead4ead4ead4ead";
const NEWER = "2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e";

type Pr = Record<string, unknown>;

/** A green, ready, unheld pull request GitHub holds with `CHANGES_REQUESTED`, refused at `refusedAt`; `session` labels it to an owner. */
const refused = (number: number, refusedAt: string | null, { session = null, over = {} }: { session?: string | null; over?: Pr } = {}): Pr => ({
  number, headRefOid: HEAD, isDraft: false, statusCheckRollup: GREEN, updatedAt: "2026-10-10T16:59:00Z", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `agent/some-slug-${number}`, comments: [], closingIssuesReferences: [], author: { login: "worker-1" }, reviewDecision: "CHANGES_REQUESTED",
  labels: session === null ? [] : [{ name: `session:${session}` }],
  reviews: refusedAt === null ? [] : [{ state: "CHANGES_REQUESTED", commit: { oid: refusedAt }, submittedAt: "2026-10-10T15:00:00Z" }],
  ...over,
});

/** `refuse` makes every record throw; the fake keeps what was posted and which repositories were asked. */
function fakePort({ refuse = false }: { refuse?: boolean } = {}) {
  const comments: { ref: ItemRef; decision: Decision; }[] = [];
  const scopesAsked: string[] = [];
  const portFor = (scope: string): StaleRefusalPort => {
    scopesAsked.push(scope);
    return {
      postDecision(ref, decision) {
        if (refuse) throw new Error("HTTP 502: the comment could not be posted");
        comments.push({ ref, decision });
        return "1";
      },
    };
  };
  return { portFor, comments, scopesAsked };
}

/** One tick of the cause: the pull requests stamped through the fake port, then the orders `decide` would make from them. */
function tick(prs: Pr[], { port = fakePort(), env = {} }: { port?: ReturnType<typeof fakePort>; env?: Record<string, string | undefined> } = {}) {
  const said: string[] = [];
  const stamped = withStaleRefusals(prs, null, { portFor: port.portFor, env, log: (line) => said.push(line), now: NOW, scope: HOME });
  return { stamped, orders: reviewBlockedOrders(reviewBlocked(stamped, null)), said, ...port };
}

// --- the row's Acceptance, one test per named case ---------------------------------------------------------------------------------------

test("a CHANGES_REQUESTED at an older commit.oid than headRefOid produces no order, and the gate records it on the pull request", () => {
  const prs = [refused(7001, OLD, { session: "worker-7001" }), refused(7002, OLD)];
  const { orders, comments, said, scopesAsked } = tick(prs);
  assert.deepEqual(orders, [], "neither the labelled one nor the unlabelled one is anybody's order");
  assert.deepEqual(comments.map((c) => c.ref), [{ tracker: "github", scope: HOME, id: 7001 }, { tracker: "github", scope: HOME, id: 7002 }], "one row write each, on the pull request");
  assert.deepEqual(scopesAsked, [HOME, HOME], "asked of the repository the pull requests are in");
  for (const { decision } of comments) {
    assert.equal(decision.role, "work-gate");
    assert.equal(decision.kind, "pr-review-blocked");
    assert.match(decision.text, new RegExp(`posted at \`${OLD.slice(0, 8)}\`, and the head is now \`${HEAD.slice(0, 8)}\``));
    assert.match(decision.text, new RegExp(`<!-- stale-refusal: ${OLD} -->`), "the marker the next tick finds");
  }
  assert.match(said.join(""), /#7001 was refused at 0ld0ld0l, the head is 4ead4ead -- recorded on it, no order/);
  // the control, in the same file: the SAME two pull requests refused at the head they have ARE ordered, so the emptiness above is the comparison's and not the cause's.
  assert.equal(tick([refused(7001, HEAD, { session: "worker-7001" }), refused(7002, HEAD)]).orders.length, 2);
});

test("a CHANGES_REQUESTED at the current head produces the order, to the owner session when there is one", () => {
  const { orders, comments, scopesAsked } = tick([refused(7003, HEAD, { session: "worker-7003" })]);
  assert.deepEqual([comments.length, scopesAsked.length], [0, 0], "a live refusal is not recorded and no port is asked");
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.causeKey]), [["worker-7003", "pr-review-blocked", "worker-7003/pr-review-blocked/pr-7003/REFUSED"]],
    "to the session on its label, directly, and not to a manager");
  assert.match(orders[0].prompt, /The refusal was posted AT the current head `4ead4ead`: it is live and the rework is yours\./);
});

test("an unowned pull request still produces the manager's order", () => {
  const { orders } = tick([refused(7004, HEAD), refused(7005, HEAD)]);
  assert.equal(orders.length, 1, "one set order, as it was");
  assert.equal(orders[0].session, "product-manager");
  assert.equal(orders[0].cause, "pr-review-blocked");
  assert.equal(orders[0].causeKey, "product-manager/pr-review-blocked/7004:REFUSED.7005:REFUSED");
  // mixed: the labelled live refusal goes to its owner and the unowned one to the manager, in separate orders.
  const mixed = tick([refused(7006, HEAD, { session: "worker-7006" }), refused(7007, HEAD)]).orders;
  assert.deepEqual(mixed.map((o) => o.session).sort(), ["product-manager", "worker-7006"]);
});

test("negative control: with the switch off, the older-head refusal produces today's order", () => {
  const prs = [refused(7008, OLD, { session: "worker-7008" }), refused(7009, OLD)];
  const off = tick(prs, { env: { [REVIEW_BLOCKED_SWITCH_ENV]: "off" } });
  assert.deepEqual([off.comments.length, off.scopesAsked.length, off.said.length], [0, 0, 0], "no write, no port asked, nothing said");
  assert.equal(off.stamped, prs, "the list comes back as it was");
  assert.deepEqual(off.orders, reviewBlockedOrders(reviewBlocked(prs, null)), "and the orders are the ones the bare readers have always made");
  assert.deepEqual(off.orders.map((o) => o.session).sort(), ["product-manager", "worker-7008"]);
  assert.match(off.orders.find((o) => o.session === "worker-7008")?.prompt ?? "", /The refusal was posted at `0ld0ld0l` and the head is now `4ead4ead`: you pushed after it, and the refusal STILL STANDS/);
});

// --- what the row's premise does not say, each held as a test --------------------------------------------------------------------------------

test("a record is said once: the next tick finds it in the pull request's own comments and posts nothing, and the pull request is still not ordered", () => {
  const first = tick([refused(7010, OLD)]);
  assert.equal(first.comments.length, 1);
  const recorded = refused(7010, OLD, { over: { comments: [{ body: first.comments[0].decision.text + "\n\n<!-- stale-refusal: " + OLD + " -->" }] } });
  const second = tick([recorded]);
  assert.deepEqual([second.comments.length, second.said.length], [0, 0], "no second comment and no repeated log line");
  assert.deepEqual(second.orders, []);
});

test("a record that cannot be posted keeps the pull request in the order, and the order is today's", () => {
  const { orders, said } = tick([refused(7011, OLD, { session: "worker-7011" })], { port: fakePort({ refuse: true }) });
  assert.deepEqual(orders.map((o) => o.causeKey), ["worker-7011/pr-review-blocked/pr-7011/REFUSED"]);
  assert.match(said.join(""), /COULD NOT RECORD the stale refusal on #7011 \(HTTP 502/);
});

test("every doubt is a wake: a refusal at the head beside an older one, an unnamed commit, an equal patch, a draft and a held pull request are not stale", () => {
  const both = refused(7012, OLD, { over: { reviews: [
    { state: "CHANGES_REQUESTED", commit: { oid: OLD } }, { state: "CHANGES_REQUESTED", commit: { oid: HEAD } }] } });
  const unnamed = refused(7013, OLD, { over: { reviews: [{ state: "CHANGES_REQUESTED", commit: { oid: "" } }] } });
  const samePatch = refused(7014, OLD, { over: { patchIds: { [OLD]: "aaaaaaaaaaaa", [HEAD]: "aaaaaaaaaaaa" } } });
  const changedPatch = refused(7015, OLD, { over: { patchIds: { [OLD]: "aaaaaaaaaaaa", [HEAD]: "bbbbbbbbbbbb" } } });
  assert.equal(staleRefusalOf(both), null, "a refusal at the current head is live whatever was refused earlier");
  assert.equal(staleRefusalOf(unnamed), null, "no commit named is no comparison");
  assert.equal(staleRefusalOf(samePatch), null, "the same patch is the same work, refused: the rework is still owed (#3045)");
  assert.equal(staleRefusalOf(changedPatch), OLD, "a patch known to differ is stale");
  assert.equal(staleRefusalOf(refused(7016, OLD, { over: { reviewDecision: "APPROVED" } })), null, "a refusal GitHub no longer counts is not this cause's subject at all");
  const t = tick([both, unnamed, samePatch]);
  assert.deepEqual(t.comments, [], "nothing recorded for any of them");
  assert.equal(t.orders.length, 1, "and all three are in the one set order");
  assert.equal(t.orders[0].causeKey, "product-manager/pr-review-blocked/7012:REFUSED.7013:REFUSED.7014:REFUSED");
  const draft = tick([refused(7017, OLD, { over: { isDraft: true } }), refused(7018, OLD, { over: { labels: [{ name: "hold:ceo" }] } })]);
  assert.deepEqual([draft.comments.length, draft.orders.length], [0, 0], "outside the cause's population nothing is read, written or ordered");
});

test("the stamp names the refusal it was made for: a newer refusal on the same pull request is ordered", () => {
  const [stamped] = tick([refused(7019, OLD)]).stamped;
  assert.equal((stamped as Pr).staleRefusal, OLD);
  const refusedAgain = { ...stamped, headRefOid: NEWER, reviews: [...((stamped as Pr).reviews as object[]), { state: "CHANGES_REQUESTED", commit: { oid: NEWER } }] };
  assert.deepEqual(reviewBlockedOrders(reviewBlocked([refusedAgain], null)).map((o) => o.causeKey), ["product-manager/pr-review-blocked/7019:REFUSED"]);
});

test("the reviewer is still asked: the older-head refusal's pull request earns `draft-awaiting-verdict` at its patch, so leaving it out of this cause leaves no gap", () => {
  const pr = refused(7020, OLD, { session: "worker-7020", over: { patchIds: { [OLD]: "aaaaaaaaaaaa", [HEAD]: "bbbbbbbbbbbb" } } });
  const { orders } = tick([pr]);
  assert.deepEqual(orders, []);
  const asked = perPullRequestOrders([pr] as never, null, null, NOW).filter((o: { cause: string }) => o.cause === "draft-awaiting-verdict");
  assert.deepEqual(asked.map((o: { session: string }) => o.session), ["reviewer-7020"], "one reviewer order, to the pull request's own seat, at the head the refusal did not see");
});

test("the writer reaches a tracker only through the port, and the stale reading is pure", () => {
  const source = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  for (const head of ["export function withStaleRefusals(", "export function staleRefusalOf("]) {
    const start = source.indexOf(head);
    const end = source.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start, `${head} is found`);
    const body = source.slice(start, end);
    for (const forbidden of [/execFileSync/, /\bspawn/, /"gh"/, /issue comment/, /pr review/]) {
      assert.doesNotMatch(body.replace(/defaultRun \}\)\)?/g, ""), forbidden, `${head} must not reach the code host except through the port (${forbidden})`);
    }
  }
});
