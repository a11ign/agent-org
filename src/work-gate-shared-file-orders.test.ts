// no-token: gh -- pure: `sharedFileOrders` and `perPullRequestOrders` over in-memory pull requests; nothing reaches `gh`, `git` or herdr
/**
 * #3480: TWO OPEN PULL REQUESTS THAT CHANGE ONE FILE ARE REPORTED TO THE OWNER OF THE LATER ONE, before either conflicts.
 *
 * THE FIXTURE IS THE INCIDENT, a11ign/agent-org 2026-10-04: #148, #149 and #150 with the file lists `gh pr view --json files` returned at the
 * moment the last of them opened (13:41:48Z), changesets included because B4's exclusion of them is one of the cases. #151 and #152, opened
 * two minutes later, are the pair with nothing in common.
 *
 * POSITIVE CONTROLS: `INCIDENT` yields orders -- the non-empty case that every emptiness below is read against, and each of those differs
 * from it in ONE fact (a file, a changeset, a hold, a wait, a count, a repository). `INCIDENT` yielded none on the code before this row,
 * because nothing compared one pull request with another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedFileOrders } from "./work-gate/shared-file-orders.ts";
import { perPullRequestOrders } from "./work-gate/pr-orders.ts";

type Order = { session: string, fallback?: string, cause: string, causeKey: string, prompt: string, subject: string };
type Pr = { number: number, files: { path: string }[], changedFiles: number, labels: { name: string }[], body: string, comments: unknown[], repoKey?: string, repo?: string,
  headRefName: string };

const CHANGESET = (name: string) => `.changeset/${name}.md`;
const PR_148 = [CHANGESET("buttons-are-drawn"), "docs/messaging.md", "src/messaging/answers.ts", "src/messaging/answers.test.ts", "src/messaging/converse.ts",
  "src/messaging/converse.test.ts", "src/messaging/core.ts", "src/messaging/core.test.ts", "src/messaging/event.ts", "src/messaging/inbound.ts",
  "src/messaging/inbound.test.ts", "src/messaging/listen.ts", "src/messaging/listen.test.ts", "src/messaging/providers/telegram/poll.test.ts",
  "src/messaging/providers/telegram/send.ts", "src/messaging/providers/telegram/send.test.ts", "src/messaging/watch-buttons.test.ts", "src/messaging/watch.ts"];
const PR_149 = [CHANGESET("incident-says-what-is-being-done"), "docs/messaging.md", "src/messaging/sources/incidents.ts", "src/messaging/sources/incidents.test.ts",
  "src/messaging/sources/readers.ts", "src/messaging/sources/readers.test.ts", "src/messaging/sources/stall.ts", "src/messaging/sources/stall.test.ts", "src/messaging/watch.ts"];
const PR_150 = [CHANGESET("a-milestone-moving-is-told"), "src/messaging/check.ts", "src/messaging/config.ts", "src/messaging/config.test.ts", "src/messaging/core.ts",
  "src/messaging/event.ts", "src/messaging/sources/milestones.ts", "src/messaging/sources/milestones.test.ts", "src/messaging/watch.ts"];
const PR_151 = [CHANGESET("host-runs-one-tool-version"), "src/host-config.ts", "src/host-units.ts", "src/lib/release-tag.ts", "src/lib/tool-version.ts",
  "src/packaging/host-tool-install.test.ts", "src/packaging/host-units.test.ts", "src/packaging/work-tick-crash-exit.test.ts", "src/update-tool.ts", "src/update-tool.test.ts",
  "src/work-tick.ts"];
const PR_152 = [CHANGESET("deferred-order-is-a-stall"), "src/api-pool.ts", "src/org-health.ts", "src/packaging/deferred-order-is-a-stall.test.ts",
  "src/packaging/graphql-pool-health.test.ts", "src/packaging/ready-flip-on-green-checks.test.ts", "src/packaging/repeating-lines.test.ts",
  "src/packaging/wake-busy-seat-deferral.test.ts", "src/packaging/wake-capacity-deferral.test.ts", "src/wake.ts", "src/work-gate.ts", "src/work-gate/org-health.ts",
  "src/work-gate/pr-orders.ts"];

const prOf = (number: number, paths: string[], over: Partial<Pr> & { session?: string | null } = {}): Pr => {
  const { session = `worker-${number}`, ...rest } = over;
  return { number, files: paths.map((path) => ({ path })), changedFiles: paths.length, headRefName: `agent/some-slug-${number}`,
    labels: session === null ? [] : [{ name: `session:${session}` }], body: "", comments: [], ...rest };
};
const INCIDENT = () => [prOf(148, PR_148, { session: "worker-3423" }), prOf(149, PR_149, { session: "worker-3419" }), prOf(150, PR_150, { session: "worker-3414" })];
const quiet = () => undefined;
const ordersOf = (prs: Pr[], say: (line: string) => void = quiet) => sharedFileOrders(prs, say) as Order[];
const forPr = (orders: Order[], n: number) => orders.filter((o) => o.subject === `pr-${n}` || o.subject.endsWith(`-${n}`));

test("(1) the 13:41:48Z fixture: the owners of #149 and #150 are told, #148 -- first of the three -- is not", () => {
  const orders = ordersOf(INCIDENT());
  assert.deepEqual(orders.map((o) => o.session), ["worker-3419", "worker-3414"], "one order per LATER pull request, in number order -- and none for #148");
  const [to149, to150] = orders;
  assert.match(to149.prompt, /#148, which is ahead of it \(opened first\), on `docs\/messaging\.md`, `src\/messaging\/watch\.ts`/);
  assert.doesNotMatch(to149.prompt, /core\.ts/, "#149 shares nothing but those two with #148");
  assert.match(to150.prompt, /#148, which is ahead of it \(opened first\), on `src\/messaging\/core\.ts`, `src\/messaging\/event\.ts`, `src\/messaging\/watch\.ts`/);
  assert.match(to150.prompt, /#149, which is ahead of it \(opened first\), on `src\/messaging\/watch\.ts`/);
  assert.doesNotMatch(to150.prompt, /buttons-are-drawn|\.changeset/, "a changeset is never named as a shared file");
  for (const o of orders) {
    assert.equal(o.cause, "pr-merge-conflict", "filed under an existing cause, not a new one");
    assert.match(o.prompt, /Do not rebase onto `main` yet and do not ask for a review; hold behind it/);
    assert.match(o.prompt, /`Waiting-for: merged #148`/);
    assert.match(o.prompt, /rebase once, after it merges/);
  }
  assert.match(to150.prompt, /`Waiting-for: merged #149`/, "one wait per pull request ahead, so both are named");
});

test("(1) it reaches the tick: `perPullRequestOrders` carries the same orders, where `decide` reads them", () => {
  const shared = (perPullRequestOrders(INCIDENT(), null, null, Date.now()) as Order[]).filter((o) => o.causeKey.includes("/shares/"));
  assert.deepEqual(shared.map((o) => o.session), ["worker-3419", "worker-3414"]);
});

test("(2) NEGATIVE CONTROL: #151 and #152, no common file, produce nothing -- the same call that yields orders for the fixture above", () => {
  assert.equal(ordersOf(INCIDENT()).length, 2, "the control's own positive: the same call is not silent");
  assert.deepEqual(ordersOf([prOf(151, PR_151), prOf(152, PR_152)]), []);
});

test("(3) a shared `.changeset/*.md` NAME is no overlap -- B4's exclusion, on both sides", () => {
  const same = CHANGESET("release-note");
  assert.deepEqual(ordersOf([prOf(151, [...PR_151, same]), prOf(152, [...PR_152, same])]), []);
  // the control: the same pair with ONE real file in common is reported, so the empty result above is the changeset's doing and nothing else
  assert.equal(ordersOf([prOf(151, [...PR_151, same, "src/shared.mjs"]), prOf(152, [...PR_152, same, "src/shared.mjs"])]).length, 1);
});

const sequenced = (over: Partial<Pr>) => [prOf(148, PR_148), prOf(149, PR_149, { session: "worker-3419", ...over })];
const HOLD = { name: "hold:worker-3419" };
const WAIT = "Waiting-for: merged #148";

test("(4) the later pull request held AND waiting for the one ahead is sequenced, and is not reported", () => {
  assert.deepEqual(ordersOf(sequenced({ labels: [{ name: "session:worker-3419" }, HOLD], body: `Held.\n\n${WAIT}\n` })), []);
});

test("(4) the label ALONE, the wait ALONE, or a wait for some OTHER pull request each leave it reported", () => {
  assert.equal(ordersOf(sequenced({ labels: [{ name: "session:worker-3419" }, HOLD] })).length, 1, "a hold nobody can lift is not a sequence");
  assert.equal(ordersOf(sequenced({ body: WAIT })).length, 1, "a wait that holds nothing is not a sequence");
  assert.equal(ordersOf(sequenced({ labels: [{ name: "session:worker-3419" }, HOLD], body: "Waiting-for: merged #999" })).length, 1, "a wait for another pull request");
  assert.equal(ordersOf(sequenced({ labels: [{ name: "session:worker-3419" }, HOLD], body: "Waiting-for: closed #148" })).length, 1, "`closed` is not the row's `merged`");
});

test("(4) the wait may be said in the hold's marker comment, which is where `pr:hold` writes it", () => {
  const comment = { body: `<!-- pr-hold-until -->\n${WAIT}`, createdAt: "2026-10-04T14:00:00Z" };
  assert.deepEqual(ordersOf(sequenced({ labels: [{ name: "session:worker-3419" }, HOLD], comments: [comment] })), []);
});

test("(4) a pull request waiting on only SOME of those ahead is still told about the rest", () => {
  const prs = INCIDENT();
  prs[2] = { ...prs[2], labels: [...prs[2].labels, HOLD], body: "Waiting-for: merged #148" };
  const [order, ...rest] = ordersOf(prs).filter((o) => o.session === "worker-3414");
  assert.equal(rest.length, 0);
  assert.doesNotMatch(order.prompt, /#148, which is ahead/);
  assert.match(order.prompt, /#149, which is ahead of it \(opened first\), on `src\/messaging\/watch\.ts`/);
});

test("(5) the same fixture next tick is the same `causeKey`; a file the later pull request adds changes it", () => {
  const first = ordersOf(INCIDENT()).map((o) => o.causeKey);
  assert.deepEqual(ordersOf(INCIDENT()).map((o) => o.causeKey), first, "sent once");
  assert.equal(new Set(first).size, first.length);
  const grown = INCIDENT();
  grown[1] = prOf(149, [...PR_149, "src/messaging/core.ts"], { session: "worker-3419" });
  const [key149, key150] = ordersOf(grown).map((o) => o.causeKey);
  assert.notEqual(key149, first[0], "#149 now also shares core.ts with #148");
  assert.notEqual(key150, first[1], "and #150 now shares core.ts with #149 as well");
  const [other] = ordersOf([prOf(148, PR_148), prOf(149, [...PR_149, "src/messaging/not-shared.mjs"], { session: "worker-3419" })]);
  assert.equal(other.causeKey, first[0], "a file the later one adds that nobody shares does not move the key");
});

test("(6) a list shorter than its `changedFiles` is left OUT, with a diagnostic, and never reads as 'no overlap'", () => {
  const short = prOf(149, PR_149, { session: "worker-3419", changedFiles: PR_149.length + 1 });
  const said: string[] = [];
  assert.deepEqual(ordersOf([prOf(148, PR_148), short], (line) => said.push(line)), []);
  assert.equal(said.length, 1);
  assert.match(said[0], /#149 lists 9 files, not the 10 it reports -- left out of the shared-file comparison, which is NOT a reading of "no overlap"/);
  // the control: the same pair with the count it really has is compared, and reported
  const whole: string[] = [];
  assert.equal(ordersOf([prOf(148, PR_148), prOf(149, PR_149, { session: "worker-3419" })], (line) => whole.push(line)).length, 1);
  assert.deepEqual(whole, [], "a whole list says nothing");
});

test("(6) a pull request left out does not take the others with it", () => {
  const prs = [...INCIDENT().slice(0, 2), { ...prOf(150, PR_150), changedFiles: 99 }];
  assert.deepEqual(ordersOf(prs).map((o) => o.session), ["worker-3419"], "#148 and #149 are still compared");
});

test("(7) pull requests of DIFFERENT repositories never overlap on a path name", () => {
  const here = prOf(148, PR_148, { session: "worker-3423" });
  const there = prOf(149, PR_149, { session: "worker-3419", repoKey: "agent-org", repo: "a11ign/agent-org" });
  assert.deepEqual(ordersOf([here, there]), []);
  // the control: the same two in ONE repository overlap
  assert.equal(ordersOf([{ ...here, repoKey: "agent-org", repo: "a11ign/agent-org" }, there]).length, 1);
});

test("(7) a keyed repository's order names its pull requests by key, and a wait is read against ITS repository", () => {
  const keyed = (n: number, paths: string[], over: Parameters<typeof prOf>[2] = {}) => prOf(n, paths, { repoKey: "agent-org", repo: "a11ign/agent-org", ...over });
  const [order] = ordersOf([keyed(148, PR_148), keyed(149, PR_149, { session: "worker-3419" })]);
  assert.equal(order.subject, "pr-agent-org#149");
  assert.match(order.prompt, /agent-org#149 changes files that another open pull request also changes:/);
  assert.match(order.prompt, /--repo-key=agent-org/);
  const held = { labels: [{ name: "session:worker-3419" }, HOLD], body: WAIT };
  assert.deepEqual(ordersOf([keyed(148, PR_148), keyed(149, PR_149, held)]), [], "a bare #148 on an agent-org pull request is agent-org's #148");
  assert.equal(ordersOf([keyed(148, PR_148), keyed(149, PR_149, { ...held, body: "Waiting-for: merged a11ign/a11ign#148" })]).length, 1, "another repository's #148 is no sequence");
});

test("(8) a pull request with no `session:` label routes to product-manager, and the text says it has no owner", () => {
  const [order] = ordersOf([prOf(148, PR_148), prOf(149, PR_149, { session: null })]);
  assert.equal(order.session, "product-manager");
  assert.match(order.prompt, /IT HAS NO OWNER/);
  assert.match(order.causeKey, /^product-manager\/pr-merge-conflict\/pr-149\/shares\//);
  assert.equal(order.fallback, undefined, "product-manager is already the fallback, so no second hop");
  assert.match(order.prompt, /--session=<its-owner>/, "the hold is taken by whoever is given the pull request, not by the reader of this order");
  // the control: with a label it goes to that session and does not say so
  const [owned] = ordersOf([prOf(148, PR_148), prOf(149, PR_149, { session: "worker-3419" })]);
  assert.equal(owned.session, "worker-3419");
  assert.doesNotMatch(owned.prompt, /NO OWNER/);
  assert.equal(owned.fallback, "product-manager", "an owner whose session is gone is routed on, as the checkless order's is");
});

test("a pull request with no files read at all, or none handed in, is not an accusation and says nothing", () => {
  const said: string[] = [];
  const unread = { number: 150, labels: [], body: "", comments: [] };
  assert.deepEqual(sharedFileOrders([prOf(148, PR_148), unread, null as unknown as Pr], (line) => said.push(line)), []);
  assert.deepEqual(sharedFileOrders(null as unknown as Pr[], quiet), []);
  assert.deepEqual(said, []);
});

test("(#4624) a dependency bot's pull request overlapping an earlier one goes to ceo with the bot's reason, not 'its label or row names you'", () => {
  const bot = prOf(149, PR_149, { session: null, headRefName: "dependabot/npm_and_yarn/axe-core-4.14.0", author: { login: "app/dependabot" } } as Partial<Pr>);
  const [order, ...rest] = ordersOf([prOf(148, PR_148), bot]);
  assert.equal(rest.length, 0, "POSITIVE CONTROL: the overlap is ordered at all");
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /A dependency bot opened it and no session works such a pull request/);
  assert.doesNotMatch(order.prompt, /its session label, or the row it closes, names you/);
  assert.doesNotMatch(order.prompt, /IT HAS NO OWNER/);
});
