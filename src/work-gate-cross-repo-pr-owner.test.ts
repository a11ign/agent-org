// no-token: gh -- imports `work-gate.ts`, whose default readers spawn `gh`; the lanes are handed in, the per-tick reads are stubs and `gh` is an injected recorder, so nothing is spawned (#4386)
/**
 * #4386: AN AGENT-ORG PULL REQUEST IS OWNED BY THE WORKER ITS ROW NAMES, and a fallback that still fires files its own defect.
 *
 * agent-org#436 (branch `agent/agent-org-two-copy-4371`, no labels, body `Row: a11ign/a11ign#4371`) and #437 (branch
 * `agent/triage-provider-4384`, `Closes: none`) each ordered `ceo` with NOBODY COULD BE NAMED while `worker-4371` / `worker-4384`
 * held the rows; `scopeTick` never ran the owner ladder at all. EVERY "falls back to ceo" assertion below is read against the
 * same fixture with ONE thing changed (the positive control for it): the first test of each group.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopesOf, scopeTick, withScopedPrOwners, resolverDefectOf, fileResolverDefects } from "./work-gate.ts";
import { sendToGitHub, unstampableRefusal, main as prOpen, EXIT_NOTHING_SENT } from "./pr-open.ts";

// agent-org#519: the body is no longer an acceptance source, so the diff ADDS this file and `readFile` returns the text the body meant to carry.
const withAcceptanceFile = (body: string) => ({
  git: (args: string[]) => (args[0] === "diff" ? ".acceptance/agent~example-1.md" : "x"), readFile: () => body,
});

/** The private directories the filing tests wrote state into, removed when the file is done (`private-tmp` refuses a test that leaves one). */
const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const HOME = "a11ign/a11ign";
const AGENT_ORG = "a11ign/agent-org";
const scope = scopesOf([{ tracker: [{ key: "", repo: HOME }], code: [{ key: "", repo: HOME }, { key: "agent-org", repo: AGENT_ORG }] }])
  .find((candidate) => candidate.key === "agent-org")!;

type Fixture = Record<string, any>;
const RED = [{ name: "ts", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-09T05:50:00Z" }];
const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
const claimed = (number: number, session: string) => row(number, "in-progress", `session:${session}`);
const LIVE_4371 = [claimed(4371, "worker-4371")];

/** agent-org#436 as the gate read it: no labels, no closing reference, the `Row:` form in the body. */
const pr436 = (over: Fixture = {}): Fixture => ({
  number: 436, repo: AGENT_ORG, repoKey: "agent-org", headRefOid: "ee84bda0cafe0000", isDraft: false, statusCheckRollup: RED, labels: [],
  headRefName: "agent/agent-org-two-copy-4371", body: "Row: a11ign/a11ign#4371. Two comment-header edits.\n\n**Why.** a11ign/a11ign#4367 renamed the originals.",
  closingIssuesReferences: [], ...over,
});
/** The same pull request with NO name anywhere: the control every positive result below is read against. */
const nameless = (over: Fixture = {}) => pr436({ headRefName: "agent/agent-org-a-fix", body: "Two comment-header edits.", ...over });

const readings = {
  code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
  tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null }),
} as unknown as NonNullable<Parameters<typeof scopeTick>[3]>;

/** The `pr-checks-failing` order(s) a tick of the agent-org scope makes for these pull requests, with the primary's rows handed in as `home`. */
function failingOrders(prs: Fixture[], rows: Fixture[]) {
  const read = { prs, readyRows: [], promotableRows: [], chairmanBlocked: [], openRows: [], codeRepo: AGENT_ORG, trackerRepo: undefined,
    home: { rows, repo: HOME } } as unknown as Parameters<typeof scopeTick>[2];
  const tick = scopeTick(scope, false, read, readings);
  return { orders: tick.orders.filter((order: Fixture) => order.cause === "pr-checks-failing"), defects: tick.defects };
}

const ownerOf = (prs: Fixture[], rows: Fixture[]) => failingOrders(prs, rows).orders.map((order: Fixture) => order.session);

test("(1) the #436 fixture is ordered to worker-4371 by the BRANCH NUMBER alone", () => {
  const { orders } = failingOrders([pr436({ body: "" })], LIVE_4371);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "worker-4371");
  assert.match(orders[0].prompt, /its branch `agent\/agent-org-two-copy-4371` was claimed for row #4371/);
  assert.match(orders[0].prompt, /REPOSITORY `agent-org`/, "the order still says which repository its number belongs to");
});

test("(1) NEGATIVE: a branch number naming a row held by NOBODY keeps the fallback order to ceo", () => {
  for (const rows of [[], [row(4371, "in-progress")], [row(4371, "session:worker-4371")], [claimed(9999, "worker-9999")]]) {
    const { orders } = failingOrders([pr436({ body: "" })], rows);
    assert.equal(orders[0].session, "ceo");
    assert.match(orders[0].prompt, /NOBODY COULD BE NAMED/);
  }
});

test("(2) the `Row:` line alone resolves it; the same line naming ANOTHER repository, or a bare #n, does not", () => {
  assert.deepEqual(ownerOf([nameless({ body: "Row: a11ign/a11ign#4371. Two edits." })], LIVE_4371), ["worker-4371"]);
  assert.deepEqual(ownerOf([nameless({ body: "- **Row:** a11ign/a11ign#4371" })], LIVE_4371), ["worker-4371"], "bold and bulleted spellings are read");
  assert.deepEqual(ownerOf([nameless({ body: "Row: a11ign/other#4371" })], LIVE_4371), ["ceo"], "a row of another repository is not the tracker's");
  assert.deepEqual(ownerOf([nameless({ body: "Row: #4371" })], LIVE_4371), ["ceo"], "a bare #n in an agent-org PR is an agent-org issue, the wrong-tracker match");
  assert.deepEqual(ownerOf([nameless({ body: "Two edits; see a11ign/a11ign#4371 for why." })], LIVE_4371), ["ceo"], "a mention on a line that states no row is prose");
});

test("(3) a `Closes a11ign/a11ign#4371` line alone resolves it, and so does GitHub's own closing reference", () => {
  assert.deepEqual(ownerOf([nameless({ body: "Closes a11ign/a11ign#4371\n" })], LIVE_4371), ["worker-4371"]);
  const ref = (repo: string) => ({ number: 4371, repository: { name: repo.split("/")[1], owner: { login: repo.split("/")[0] } } });
  assert.deepEqual(ownerOf([nameless({ closingIssuesReferences: [ref(HOME)] })], LIVE_4371), ["worker-4371"]);
  assert.deepEqual(ownerOf([nameless({ closingIssuesReferences: [ref(AGENT_ORG)] })], LIVE_4371), ["ceo"], "agent-org's own #4371 is not the tracker's");
});

test("(4) the second fixture, agent-org#437: no row line at all, the branch number alone", () => {
  const pr437 = nameless({ number: 437, headRefName: "agent/triage-provider-4384", body: "Closes: none -- a triage fix" });
  assert.deepEqual(ownerOf([pr437], [claimed(4384, "worker-4384")]), ["worker-4384"]);
  assert.deepEqual(ownerOf([pr437], LIVE_4371), ["ceo"], "control: the same PR with the claim held by another row");
});

test("(5) a PR with its own live session label is never touched, whatever its lines say", () => {
  const labelled = pr436({ labels: [{ name: "session:worker-77" }] });
  assert.deepEqual(ownerOf([labelled], LIVE_4371), ["worker-77"]);
  const [kept] = withScopedPrOwners([labelled], LIVE_4371, { rowsRepo: HOME });
  assert.equal(kept.rowOwner, undefined, "the row never outranks the label");
  const [resolved] = withScopedPrOwners([pr436()], LIVE_4371, { rowsRepo: HOME });
  assert.equal(resolved.rowOwner.session, "worker-4371", "control: the same PR unlabelled IS resolved");
});

test("(6) two different claimants across the lines are a split, not a guess", () => {
  const rows = [claimed(4371, "worker-4371"), claimed(4372, "worker-4372")];
  const split = pr436({ body: "Closes a11ign/a11ign#4372\nRow: a11ign/a11ign#4371" });
  assert.deepEqual(ownerOf([split], rows), ["ceo"]);
  assert.deepEqual(ownerOf([pr436({ body: "Closes a11ign/a11ign#4371\nRow: a11ign/a11ign#4371" })], rows), ["worker-4371"], "control: the same claimant twice is an answer");
  assert.deepEqual(failingOrders([split], rows).defects, [], "a split is a question the ladder was right to leave, not a resolver defect");
});

test("(7) a scope that declares no primary rows is returned as it was: nothing is invented from rows nobody read", () => {
  const read = { prs: [pr436()], readyRows: [], promotableRows: [], chairmanBlocked: [], openRows: [], codeRepo: AGENT_ORG, trackerRepo: undefined } as unknown as Parameters<typeof scopeTick>[2];
  const [order] = scopeTick(scope, false, read, readings).orders.filter((o: Fixture) => o.cause === "pr-checks-failing");
  assert.equal(order.session, "ceo");
});

// ---- (c): the fallback files its own defect ----

test("(8) resolverDefectOf: a PR that reached ceo while naming a live claimant IS a defect; one naming nobody, a dead claim, two claimants or an answered PR is not", () => {
  // The positive control: `pr436()` has NOT been through the ladder, so it stands at ceo's rung while its branch names a live claimant.
  assert.deepEqual(resolverDefectOf(pr436(), LIVE_4371, HOME), { repo: AGENT_ORG, number: 436, session: "worker-4371", row: 4371, via: "stated" });
  assert.equal(resolverDefectOf(pr436({ body: "" }), LIVE_4371, HOME)?.via, "branch");
  assert.equal(resolverDefectOf(nameless(), LIVE_4371, HOME), null, "truly nothing to resolve");
  assert.equal(resolverDefectOf(pr436(), [row(4371, "in-progress")], HOME), null, "the row is held by nobody");
  assert.equal(resolverDefectOf(pr436({ body: "Closes a11ign/a11ign#4372" }), [claimed(4371, "worker-4371"), claimed(4372, "worker-4372")], HOME), null, "two claimants");
  const [resolved] = withScopedPrOwners([pr436()], LIVE_4371, { rowsRepo: HOME });
  assert.equal(resolverDefectOf(resolved, LIVE_4371, HOME), null, "the ladder answered it");
  assert.equal(resolverDefectOf(pr436({ labels: [{ name: "session:worker-77" }] }), LIVE_4371, HOME), null, "its own label answers it");
});

/** A recorder standing in for `gh`; `open` is what `issue list --label resolver-defect` answers. */
function recorder(open: number[], { refuse = false }: { refuse?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (refuse) throw new Error("HTTP 502");
    return args[0] === "issue" && args[1] === "list" ? JSON.stringify(open.map((number) => ({ number }))) : "";
  };
  return { calls, run };
}
const defectOf = (number: number) => resolverDefectOf(pr436({ number }), LIVE_4371, HOME)!;

test("(9) fileResolverDefects: the first defect files ONE row, later ones comment on it, and a PR is written once", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolver-defect-"));
  scratch.push(dir);
  const statePath = join(dir, "state.json");
  const log = () => {};
  const first = recorder([]);
  assert.equal(fileResolverDefects([defectOf(436)], { run: first.run, statePath, log }), 1);
  assert.deepEqual(first.calls.map((call) => call.slice(0, 2).join(" ")), ["issue list", "label create", "issue create"]);
  assert.ok(first.calls[2].includes("resolver-defect"), "the row carries the label");
  assert.match(first.calls[2].join(" "), /a11ign\/agent-org#436/, "and names its fixture");
  const second = recorder([4400]);
  assert.equal(fileResolverDefects([defectOf(436), defectOf(437)], { run: second.run, statePath, log }), 1, "436 is remembered; 437 is new");
  assert.deepEqual(second.calls.map((call) => call.slice(0, 2).join(" ")), ["issue list", "issue comment"]);
  assert.equal(second.calls[1][2], "4400", "a later PR comments on the open class row");
  const third = recorder([4400]);
  assert.equal(fileResolverDefects([defectOf(436), defectOf(437)], { run: third.run, statePath, log }), 0);
  assert.deepEqual(third.calls, [], "once per pull request: nothing is asked for a PR already written");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8"))), ["a11ign/agent-org#436", "a11ign/agent-org#437"]);
});

test("(10) a refused gh is said, not remembered, and retried; no defect means no call at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolver-defect-"));
  scratch.push(dir);
  const statePath = join(dir, "state.json");
  const said: string[] = [];
  const refused = recorder([], { refuse: true });
  assert.equal(fileResolverDefects([defectOf(436)], { run: refused.run, statePath, log: (line) => said.push(line) }), 0);
  assert.match(said.join(""), /could not file a11ign\/agent-org#436 \(HTTP 502\); the next tick retries/);
  assert.equal(existsSync(statePath), false, "nothing was written, so the next tick asks again");
  const retried = recorder([]);
  assert.equal(fileResolverDefects([defectOf(436)], { run: retried.run, statePath, log: () => {} }), 1);
  const none = recorder([]);
  assert.equal(fileResolverDefects([], { run: none.run, statePath, log: () => {} }), 0);
  assert.deepEqual(none.calls, []);
});

// ---- (b): pr:open stamps, or refuses ----

test("(11) pr:open: a create with no nameable owner is REFUSED before anything is sent; a live one is stamped (and the label made when absent)", () => {
  assert.equal(unstampableRefusal("create", "ceo"), null, "control: a live session stamps");
  assert.match(unstampableRefusal("create", null)!, /REFUSED -- no session could be named as its owner[\s\S]*Closes <owner\/repo>#<n>[\s\S]*Nothing was sent/);
  assert.match(unstampableRefusal("create", "worker-0")!, /`worker-0` is not a live session/);
  assert.equal(unstampableRefusal("edit", null), null, "an edit never creates a label");

  const sent: string[][] = [];
  const err: string[] = [];
  const body = "## Acceptance\n\nnode -e \"process.exit(0)\"\n\nCloses: none -- a test fixture\n";
  const open = (owner: string | null) => prOpen(["create", "--draft", "--body", body], { run: (a) => { sent.push(a); }, ...withAcceptanceFile(body),
    prHead: () => ({ ref: "x", oid: "x" }), runAcceptance: () => 0, runMutation: () => 0, owner: () => owner, rowLabels: () => [],
    labelExists: () => false, out: () => {}, err: (line) => { err.push(line); } });
  assert.equal(open(null), EXIT_NOTHING_SENT);
  assert.equal(sent.length, 0, "nothing reached gh");
  assert.match(err.join(""), /pr-open: REFUSED -- no session could be named/);
  assert.equal(open("ceo"), 0);
  assert.deepEqual(sent.map((a) => a.slice(0, 2).join(" ")), ["pr create", "label create", "pr edit"], "the label is created in the repository the PR is opened in, then stamped");
  assert.ok(sent[2].includes("session:ceo"));
});

test("(12) sendToGitHub is unchanged for a stamped create: the label step still runs after the arm", () => {
  const ran: string[][] = [];
  assert.equal(sendToGitHub("create", ["--draft"], { run: (a) => { ran.push(a); }, git: () => "", err: () => {}, owner: () => "ceo", labelExists: () => true }), 0);
  assert.deepEqual(ran.map((a) => a[1]), ["create", "edit"]);
});
