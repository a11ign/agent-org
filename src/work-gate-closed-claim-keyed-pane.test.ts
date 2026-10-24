// no-token: gh -- the rows are the fake code host's (A11-160, step 9) and every `herdr` call is an injected seam (`log`); nothing imported reaches the real one
/**
 * agent-org#757 (a11ign#4437): A CLOSED ROW ENDS ITS KEYED WORKER PANE, `worker-agent-org-<n>` AS WELL AS `worker-<n>`.
 *
 * The closed-claim pass asked herdr for panes named `worker-<number>` only, and `familyNumber("worker-agent-org-730")` is `null` BY DESIGN (730 alone would name the first
 * tracker's row 730), so a keyed pane's row was never asked about, open or closed. These drive the gate's own decision (`closedClaimsWhenWorkerListed` for the read,
 * `withClosedClaims` for the orders), never a copy of it, and each "nothing is ordered" assertion is read against the same fixture with the row CLOSED.
 *
 * The project is a RECORDED one (`wake-teardown-keyed-rows.test.ts`'s shape): the host file is set FIRST and the tool imported AFTER it, because a keyed name is a member of a
 * spare family only for a key the project declares (`familyMember`).
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = mkdtempSync(join(tmpdir(), "closed-claim-keyed-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const DECLARATION = join(PROJECT, ".agent-org", "project.json");
const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { tracker: { key: string; repo: string; board: { owner: string; number: number } }[] };
declared.tracker.push({ key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } });
writeFileSync(DECLARATION, JSON.stringify(declared));
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }], clones: { "agent-org": "/clones/agent-org" },
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { closedClaimsWhenWorkerListed, withClosedClaims } = await import("./work-gate/tick.ts");
const { closedClaimDebris } = await import("./work-gate/causes/rows-claims-closed.ts");
const { readOpenRowFollowUps } = await import("./work-gate.ts");
const { homeProjectDeclaration } = await import("./project-config.ts");
const { claimRecordComment } = await import("./row-claim.ts");
const { forgetActivation, substituteCodeHost } = await import("./plugins/active.ts");
const { createFakeCodeHost } = await import("./plugins/fakes/code-host.ts");
const { fakeRow } = await import("./plugins/fakes/code-host-rows.ts");

afterEach(() => forgetActivation());

type Agent = { label: string; status: string };
type Order = { session: string; subject: string; causeKey: string; release?: { row: number; tracker?: string; session: string; why: string; interrupt?: boolean;
  branch: string | null; worktree: string | null } };

const AGENT_ORG = "a11ign/agent-org";
const KEYED = "worker-agent-org-730";
const BARE = "worker-4877";
const BRANCH = "agent/a-closed-row-ends-agent-org-730";

const record = (session: string) => ({ body: claimRecordComment({ session, branch: BRANCH, worktree: "../wt-agent-org-730" }),
  created_at: "2026-10-10T19:30:00Z", user: { login: "a11ign-ai-workers" } });

/** One row of a tracker's world (agent-org#1113): `state` decides whether it comes back as a closed claim, and its labels and comments carry `session`. `repo` is the tracker it is of (absent: the home one). */
type IssueRow = { number: number; state: "OPEN" | "CLOSED"; session: string; repo?: string; };
const issueRow = (number: number, state: IssueRow["state"], session: string, repo?: string): IssueRow => ({ number, state, session, repo });

/** What the closed-claim read asked of the code host: the tracker it was aimed at (`undefined`: the home one) and the row numbers. */
type Asked = { aim: string | undefined; numbers: number[] };

/**
 * The fake code host in place with `rows` seeded (the home tracker's in the world's rows, a keyed tracker's among its foreign rows), `refuse` naming the trackers whose read is refused, and every
 * closed-claim read noted in `asked`. `run` is the `run` the caller is handed, which the fake never calls.
 */
function trackers(rows: IssueRow[], { refuse = [], unasked = false }: { refuse?: (string | undefined)[]; unasked?: boolean } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  for (const { number, state, session, repo } of rows) {
    const { body, created_at: createdAt, user } = record(session);
    const row = fakeRow(world, number, { state, closedAt: state === "CLOSED" ? "2026-10-10T19:49:39Z" : null, labels: ["in-progress", "started", `session:${session}`], comments: [{ id: world.nextCommentId++, body, createdAt, author: user.login }] });
    if (repo === undefined) world.rows.set(number, row);
    else world.foreignRows.set(`${repo}#${number}`, row);
  }
  const asked: Asked[] = [];
  const read = host.rows!.closedClaimedRowsOf;
  host.rows!.closedClaimedRowsOf = (request) => {
    if (unasked) throw new Error("must not be asked");
    asked.push({ aim: request.aim, numbers: request.numbers });
    if (refuse.includes(request.aim)) throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" });
    return read(request);
  };
  substituteCodeHost(host);
  const run = (): string => { throw new Error("the fake code host acts on its own state: no run is made"); };
  return { asked, run };
}

/** The orders the gate hands the stall pass for one tick's closed claims, decided as `main` decides them. */
function ordersOf(agents: Agent[], rows: IssueRow[], { log = () => {}, ...options }: { log?: (line: string) => void; refuse?: (string | undefined)[]; unasked?: boolean } = {}) {
  const { run, asked } = trackers(rows, options);
  const read = closedClaimsWhenWorkerListed(agents, run, log);
  const stalls = withClosedClaims({ claimStalls: [] } as never, read) as unknown as { claimStalls: Order[] };
  return { orders: stalls.claimStalls, read, asked };
}

test("positive control: the fixture project DECLARES agent-org, so a keyed pane names a row and not a stranger", () => {
  assert.equal(homeProjectDeclaration().tracker.find((t) => t.key === "agent-org")?.repo, AGENT_ORG);
});

test("agent-org#757 (1): a CLOSED row held by worker-agent-org-<n> yields the release, in ITS tracker, and the interrupt when the pane is mid-turn", () => {
  const { orders, asked } = ordersOf([{ label: KEYED, status: "working" }], [issueRow(730, "CLOSED", KEYED, AGENT_ORG)]);
  assert.deepEqual(asked, [{ aim: AGENT_ORG, numbers: [730] }],
    "ONE read, for the one tracker the listed pane is of: agent-org's repository, for agent-org's row 730 -- the home tracker's 730 is a different row");
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.session, KEYED);
  assert.deepEqual([order.release?.row, order.release?.tracker, order.release?.why, order.release?.interrupt], [730, "agent-org", "closed", true],
    "the release carries the tracker's key (agent-org#834), so `performRelease` declines the row THERE");
  assert.equal(order.release?.branch, BRANCH);
  assert.equal(order.subject, "row-agent-org#730", "spelled as the stall pass spells another tracker's row");
  assert.match(order.causeKey, /^worker-agent-org-730\/claim-stalled\/row-agent-org#730\/release-closed$/);
});

test("agent-org#757 (1) an IDLE keyed pane on a closed row is released and NOT interrupted (there is nothing to interrupt)", () => {
  const { orders } = ordersOf([{ label: KEYED, status: "idle" }], [issueRow(730, "CLOSED", KEYED, AGENT_ORG)]);
  assert.deepEqual(orders.map((o) => [o.release?.row, o.release?.tracker, o.release?.why, o.release?.interrupt]), [[730, "agent-org", "closed", undefined]]);
});

test("agent-org#757 (1) CONTROL: the SAME keyed pane whose row is still OPEN yields nothing", () => {
  const { orders, asked } = ordersOf([{ label: KEYED, status: "working" }], [issueRow(730, "OPEN", KEYED, AGENT_ORG)]);
  assert.deepEqual(asked.map((read) => read.aim), [AGENT_ORG], "the read IS made: the row is asked about, and found open");
  assert.deepEqual(orders, []);
});

test("agent-org#757 (2) the existing path: worker-4877 on a CLOSED home row still yields the release, with no tracker key", () => {
  const { orders, asked } = ordersOf([{ label: BARE, status: "working" }], [issueRow(4877, "CLOSED", BARE)]);
  assert.deepEqual(asked, [{ aim: undefined, numbers: [4877] }], "the home tracker's read is made exactly as it always was: no repository aimed");
  assert.deepEqual(orders.map((o) => [o.session, o.release?.row, o.release?.tracker, o.release?.why, o.release?.interrupt, o.subject]),
    [[BARE, 4877, undefined, "closed", true, "row-4877"]]);
});

test("agent-org#757 (1) both spellings of ONE number are two rows: each is asked of its own tracker, and neither answers for the other", () => {
  const { orders, asked } = ordersOf([{ label: "worker-730", status: "working" }, { label: KEYED, status: "idle" }],
    [issueRow(730, "CLOSED", KEYED, AGENT_ORG), issueRow(730, "OPEN", "worker-730")]);
  assert.deepEqual(asked, [{ aim: undefined, numbers: [730] }, { aim: AGENT_ORG, numbers: [730] }]);
  assert.deepEqual(orders.map((o) => [o.session, o.release?.tracker]), [[KEYED, "agent-org"]], "only agent-org's 730 is closed");
});

test("agent-org#757 (1) one tracker's refused read is said, and does NOT hold the other tracker's closed row", () => {
  const log: string[] = [];
  const rows = [issueRow(4877, "CLOSED", BARE)];
  const { orders, read } = ordersOf([{ label: BARE, status: "idle" }, { label: KEYED, status: "idle" }], rows, { refuse: [AGENT_ORG], log: (l) => log.push(l) });
  assert.deepEqual(orders.map((o) => o.release?.row), [4877]);
  assert.notEqual(read?.rows, null, "partly read is not 'unread'");
  assert.equal(log.filter((l) => /tracker `agent-org` were NOT read/.test(l)).length, 1, "said once, naming the tracker");
  const every = ordersOf([{ label: KEYED, status: "idle" }], rows, { refuse: [AGENT_ORG] });
  assert.equal(every.read?.rows, null, "every read refused: null, never an empty list (#1286)");
  assert.deepEqual(every.orders, []);
});

test("agent-org#757 (3) a keyed label naming a tracker the project does NOT declare yields no read, and SAYS so", () => {
  const log: string[] = [];
  const { asked, read, orders } = ordersOf([{ label: "worker-capture-2407", status: "working" }], [], { unasked: true, log: (l) => log.push(l) });
  assert.deepEqual(asked, [], "no read: nothing says whose row it holds");
  assert.equal(read, null, "not asked");
  assert.deepEqual(orders, []);
  assert.equal(log.length, 1);
  assert.match(log[0], /worker-capture-2407 names tracker `capture`, which the project does not declare/);
  // CONTROL: the declared spelling of the same shape IS read, so the refusal above is the key's and not the shape's.
  const declaredRead = ordersOf([{ label: "worker-agent-org-2407", status: "working" }], [issueRow(2407, "OPEN", "worker-agent-org-2407", AGENT_ORG)]);
  assert.deepEqual(declaredRead.asked.map((read) => read.aim), [AGENT_ORG]);
});

test("agent-org#757 a listing with no instance at all asks nothing, as before", () => {
  const { asked, read } = ordersOf([{ label: "ceo", status: "working" }, { label: "worker-3", status: "idle" }], [], { unasked: true });
  assert.deepEqual(asked, []);
  assert.equal(read, null);
});

test("agent-org#757 the read is made in the follow-ups' wave, so a keyed pane's closed row is among the follow-ups' reads", () => {
  const open = [{ number: 41, title: "open row", labels: [{ name: "ready" }], body: "", blockedBy: { nodes: [] }, updatedAt: "2026-10-06T05:00:00Z" }];
  const { run, asked } = trackers([issueRow(730, "CLOSED", KEYED, AGENT_ORG)]);
  const got = readOpenRowFollowUps(open, run as never, undefined as never, () => [{ label: KEYED, status: "idle" }]) as unknown as
    { closedClaims: ReturnType<typeof closedClaimsWhenWorkerListed> };
  assert.deepEqual(got.closedClaims?.rows?.map((r) => [r.number, r.tracker?.key]), [[730, "agent-org"]]);
  assert.deepEqual(asked, [{ aim: AGENT_ORG, numbers: [730] }], "and it is the one read aimed at agent-org");
});

test("agent-org#757 a keyed pane's closed row is DEBRIS ten minutes after the close, as a bare-number one's is -- not a standing seat's day", () => {
  const closedAt = "2026-10-10T19:49:39Z";
  const row = (session: string) => ({ number: 730, closedAt, labels: ["in-progress", "started", `session:${session}`], repo: AGENT_ORG });
  const nowMs = Date.parse("2026-10-10T20:01:00Z"); // 11 min 21 s after the close
  const idle = (label: string) => [{ label, status: "idle" }];
  assert.deepEqual(closedClaimDebris([row(KEYED)], idle(KEYED), nowMs).strip.map((r) => r.number), [730], "idle keyed pane, past the worker grace: stripped");
  assert.deepEqual(closedClaimDebris([row(BARE)], idle(BARE), nowMs).strip.map((r) => r.number), [730], "the bare-number pane, as it already was");
  assert.deepEqual(closedClaimDebris([row(KEYED)], [{ label: KEYED, status: "working" }], nowMs).kept.map((r) => r.number), [730], "CONTROL: a working keyed pane may be mid-turn on it");
  assert.deepEqual(closedClaimDebris([row(KEYED)], idle(KEYED), Date.parse("2026-10-10T19:55:00Z")).kept.map((r) => r.number), [730], "CONTROL: inside the ten minutes it is held");
});
