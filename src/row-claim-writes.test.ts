// no-token: none -- the fake code host's rows hold the rows in memory, and the batch is a fake; nothing reaches `gh` or the network
/**
 * a11ign/a11ign#3566, slice 9: THE CLAIM'S FOUR LABEL CREATES WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * One real claim tick was read call by call (the census on the row, 2026-10-06T13:25Z): `applyClaimLabels` made four `gh label create <label> --repo
 * --force` before the label `PUT`, one after another, 3,168 ms of a claim's 15,662 ms (1,063, 439, 773 and 893). They create-or-update a label to the
 * same colour and description each time, so none depends on another and each is idempotent. The fix moves WHEN they wait (the gate's batch, as slice
 * 4 did for the reads) and nothing else, so what is pinned is:
 *   - the control: a claim handed no `labelBatch` makes the four creates one at a time, in order, before the label set;
 *   - the four go out as ONE batch, the code host's own four commands (`ensureLabelArgs`), none added and none dropped, and none of them is then created again;
 *   - the label set, the fresh label read before it and the re-read after it are NOT in the batch and keep their order (condition 3 of the Region);
 *   - a refused create is retried one at a time, and the claim says what the one-at-a-time claim says (a throw before any label was written);
 *   - a batch that cannot start does not stop the claim: the creates run one at a time, as before;
 *   - the wiring: the real batch is the default ONLY when `run` is the real `gh`.
 *
 * A11-160, step 7: the rows are the fake code host's, watched; the argument lists of the creates and of the label set are the plugin's test (`plugins/github/rows/claim-ops.test.ts`).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimRow, claimWithWorktree, moveProjectStatus } from "./row-claim.ts";
import { REPO } from "./project-identity.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { watchedRows } from "./plugins/fakes/watched-rows.test.support.ts";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };

const here = dirname(fileURLToPath(import.meta.url));
const REST = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\nTRUE ALREADY\n";
const BODY = `## Region\n\nNo file declared here.\n${REST}`;
const FOUR = ["in-progress", "session:worker-3566", "started", "was-ready"];

afterEach(() => forgetActivation());

/** `run` for a claim whose `gh` is the code host's: it is for `git` and the board snapshot only, so a `gh` through it is a loud mistake, and a claim handed it makes no batch of its own. */
const noGh = (cmd: string): string => { throw new Error(`a claim reached \`${cmd}\` through its run: GitHub is the code host's`); };

/** The creates a `refuse`d label is refused, as `gh` refuses a create: the operation throws for that label alone. */
const refusing = (refuse: string[]) => (rows: any) => {
  const create = rows.ensureLabelIn;
  rows.ensureLabelIn = (request: { name: string }) => {
    if (refuse.includes(request.name)) throw Object.assign(new Error("Command failed: gh label create"), { status: 1, stderr: "HTTP 502", stdout: "" });
    return create(request);
  };
};

/**
 * The fake code host holding a ready row 3566 of the tracker's repository, watched: `ops` are the operations asked of the rows in order. A label the code host is refused a create of is `refuse`d.
 */
function fakeClaim({ refuse = [] as string[] } = {}) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  host.rowsWorld.rows.set(3566, fakeRow(host.rowsWorld, 3566, { title: "A row", labels: ["ready"], body: BODY }));
  refusing(refuse)(host.rows);
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  const ops = () => watched.calls.map((call) => call.op);
  return { world: host.rowsWorld, calls: watched.calls, ops };
}

/** A batch that answers every create and notes each batch it was handed; a label in `refuse` fails in the batch. */
function fakeBatch(batches: Call[][], refuse: string[] = []) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => (refuse.includes(call.args[2]) ? { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 } : { stdout: "" }));
  };
}

/** The stderr a claim wrote while it ran: a batch that could not run is said aloud, never swallowed. */
function saidAloud<T>(act: () => T): { result: T, said: string[] } {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { result: act(), said }; } finally { process.stderr.write = write; }
}

const claim = (deps: Record<string, unknown>) => claimRow(3566, "worker-3566", { run: noGh as never, moveStatus: () => ({ moved: true }), ...deps } as never);
const outcomeOf = (act: () => unknown) => { try { return { returned: act() }; } catch (error) { return { threw: (error as Error).message }; } };

test("POSITIVE CONTROL: the one-at-a-time claim makes the four label creates in order, each before the label set", () => {
  const fake = fakeClaim();
  const result = claim({});
  assert.equal(result.claimed, true, "a clear row is claimed, so the calls below are the ones a claim makes");
  assert.deepEqual(fake.world.labelsCreated, FOUR, "the four labels, in the order the claim names them");
  const ops = fake.ops();
  assert.deepEqual(ops.filter((op) => op === "ensureLabelIn"), Array(4).fill("ensureLabelIn"));
  assert.ok(ops.indexOf("setRowLabels") > ops.lastIndexOf("ensureLabelIn"), "every create is before the label set");
});

test("the four creates go out in ONE batch, the code host's four commands, and the code host is not asked to create them again", () => {
  const batches: Call[][] = [];
  const fake = fakeClaim();
  const result = claim({ labelBatch: fakeBatch(batches) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1, "one batch, not one per label");
  assert.deepEqual(batches[0].map((call) => call.args[2]), FOUR, "the four commands, in the order the claim names them, none added and none dropped");
  assert.ok(batches[0].every((call) => call.args[1] === REPO), "each names the tracker's repository");
  assert.deepEqual(fake.ops().filter((op) => op === "ensureLabelIn"), [], "a create the batch answered is not asked of the code host again");
});

test("NOTHING AROUND THE LABEL SET MOVES: the fresh label read, the set and the re-read stay one at a time, in order, after the creates", () => {
  const sequential = fakeClaim();
  claim({});
  const oneByOne = sequential.ops().filter((op) => op !== "ensureLabelIn");
  const batched = fakeClaim();
  const batches: Call[][] = [];
  claim({ labelBatch: fakeBatch(batches) });
  assert.deepEqual(batched.ops().filter((op) => op !== "ensureLabelIn" && op !== "ensureLabelArgs"), oneByOne, "every call but the creates is the one-at-a-time claim's own, in its own order");
  assert.deepEqual(batches[0].filter((call) => call.args.includes("setRowLabels") || call.args[0] === "fake-read"), [], "no label set or read is in the batch");
  const ops = batched.ops();
  const reads = ops.map((op, at) => (op === "readRestRow" ? at : -1)).filter((at) => at >= 0);
  const put = ops.indexOf("setRowLabels");
  assert.ok(reads.some((at) => at < put) && reads.some((at) => at > put), "a label read right before the set and the re-read after it");
});

test("a REFUSED create is retried one at a time, and the claim says what the one-at-a-time claim says", () => {
  const sequentialFake = fakeClaim({ refuse: ["session:worker-3566"] });
  const before = outcomeOf(() => claim({}));
  assert.ok("threw" in before, "positive control: a refused create stops the claim today");
  assert.equal(sequentialFake.ops().includes("setRowLabels"), false);
  const batches: Call[][] = [];
  const fake = fakeClaim({ refuse: ["session:worker-3566"] });
  const { result: together, said } = saidAloud(() => outcomeOf(() => claim({ labelBatch: fakeBatch(batches, ["session:worker-3566"]) })));
  assert.deepEqual(together, before, "the same throw");
  assert.equal(fake.ops().includes("setRowLabels"), false, "and nothing was written to the row");
  assert.deepEqual(fake.world.labelsCreated, FOUR.slice(0, 1), "the creates ran one at a time, up to the refused one, as before");
  assert.ok(said.some((line) => /NOTE: .*label/.test(line)), "the batch's failure is said aloud, not swallowed");
});

test("a batch that cannot START does not stop the claim: the creates run one at a time", () => {
  const fake = fakeClaim();
  const { result, said } = saidAloud(() => claim({ labelBatch: () => { throw new Error("spawn node ENOENT"); } }));
  assert.equal(result.claimed, true);
  assert.deepEqual(fake.world.labelsCreated, FOUR, "all four, through the code host");
  assert.ok(said.some((line) => /spawn node ENOENT/.test(line)), "and the reason is said aloud");
});

test("THE WIRING: the real batch is the default only when `run` is the real `gh`, and the creates take it from there", () => {
  const source = readFileSync(resolve(here, "row-claim.ts"), "utf8");
  assert.match(source, /labelBatch = run === defaultRun \? runBatch : undefined/);
  const apply = source.slice(source.indexOf("\nfunction applyClaimLabels("), source.indexOf("\n/**", source.indexOf("\nfunction applyClaimLabels(")));
  assert.match(apply, /ensureLabelsExist\([^)]*batch: labelBatch/, "`applyClaimLabels` hands the batch to the creates");
  assert.ok(apply.indexOf("ensureLabelsExist(") < apply.indexOf("fetchLabels(issueNumber"), "and they are still made BEFORE the fresh label read");
});

// --- a11ign/a11ign#4737: the same claim in a KEYED tracker, over two repositories that both hold row 481 --------------------------------------

const PRIMARY_REPO = REPO;
const KEYED_REPO = "a11ign/agent-org";
const KEYED = { key: "agent-org", repo: KEYED_REPO, board: { owner: "a11ign", number: 9 } };
const KEYED_SESSION = "worker-agent-org-481";
const KEYED_FOUR = ["in-progress", `session:${KEYED_SESSION}`, "started", "was-ready"];

/** The operations that write a row, and the card move: whose repository a keyed claim must get right. */
const WRITE_OPS = ["ensureLabelIn", "setRowLabels", "editRowLabels", "postRowComment"];

/** Two repositories, each holding a `ready` row 481; the code host is watched, and a Status move is kept whole (the fake would put it on the home row of the same number). */
function twoRepos() {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.repo = PRIMARY_REPO;
  world.rows.set(481, fakeRow(world, 481, { title: "A row", labels: ["ready"], body: BODY, onBoard: true }));
  world.foreignRows.set(`${KEYED_REPO}#481`, fakeRow(world, 481, { title: "A row", labels: ["ready"], body: BODY, onBoard: true }));
  const moves: { owner: string; projectNumber: number; url: string }[] = [];
  const base = host.rows!;
  const rows = { ...base, setProjectStatus: (request: { owner: string; projectNumber: number; url: string }) => { moves.push(request); } } as unknown as typeof base;
  const watched = watchedRows({ ...host, rows });
  substituteCodeHost(watched.host);
  const calls = watched.calls;
  const writes = () => calls.filter((call) => WRITE_OPS.includes(call.op));
  return { world, calls, moves, writes, keyed: () => world.foreignRows.get(`${KEYED_REPO}#481`)!, primary: () => world.rows.get(481)! };
}

const keyedClaim = (deps: Record<string, unknown>) =>
  claimRow(481, KEYED_SESSION, { tracker: KEYED, run: noGh as never, drained: [], instance: { spare: false, rows: [] }, persistent: false, ...deps } as never);

test("a11ign/a11ign#4737: a keyed claim writes `a11ign/agent-org` and NOT `a11ign/a11ign` -- the code host is asked with the repository of every write", () => {
  const fake = twoRepos();
  const result = keyedClaim({ moveStatus: (n: number, status: string, opts?: object) => moveProjectStatus(n, status, { ...(opts ?? {}), run: noGh as never, log: () => {} }) });
  assert.equal(result.claimed, true);
  const writes = fake.writes();
  assert.ok(writes.length >= 6, `the creates, the label set, the claim record and the card move are all writes: ${writes.length + fake.moves.length}`);
  for (const write of writes) assert.equal(write.request.repo, KEYED_REPO, `write ${write.op}`);
  assert.deepEqual(writes.filter((call) => call.request.repo === PRIMARY_REPO), [], "no write named the first tracker's repository");
  assert.deepEqual(fake.world.labelsCreated, KEYED_FOUR, "the four lifecycle labels are created in the keyed repository");
  const readsOfPrimary = fake.calls.filter((call) => call.request?.repo === PRIMARY_REPO && !["openPullsWithFilesOf", "openPullReviewsOf"].includes(call.op));
  assert.deepEqual(readsOfPrimary.map((call) => call.op), [],
    "nor was its row read: the one call that names it is B4's read of the open pull requests of every declared CODE repository, which is not a row's");
});

test("a11ign/a11ign#4737: the same number as a primary row (481) is untouched -- its labels, its comments and its card", () => {
  const fake = twoRepos();
  keyedClaim({});
  assert.deepEqual(fake.primary().labels, ["ready"], "the first tracker's 481 is exactly `ready` as it was");
  assert.deepEqual(fake.primary().comments, []);
  assert.ok(fake.keyed().labels.includes("in-progress"), "control: the keyed 481 is the one that was claimed");
  assert.deepEqual(fake.moves.map((move) => move.url), [`https://github.com/${KEYED_REPO}/issues/481`]);
});

test("a11ign/a11ign#4737: the batched creates of a keyed claim name the keyed repository too, and nothing the batch holds is the first tracker's", () => {
  const fake = twoRepos();
  const batches: Call[][] = [];
  const result = keyedClaim({ labelBatch: fakeBatch(batches) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((c) => c.args[2]), KEYED_FOUR);
  assert.deepEqual([...new Set(batches[0].map((c) => c.args[1]))], [KEYED_REPO]);
  assert.deepEqual(fake.world.labelsCreated, [], "and none of them was created again, one by one");
});

test("a11ign/a11ign#4737: a DECLARED board moves THAT board's card (its own owner and number); a tracker with NONE claims with labels alone and says so", () => {
  const declared = twoRepos();
  keyedClaim({});
  assert.deepEqual(declared.moves.map((move) => [move.owner, move.projectNumber]), [["a11ign", 9]], "the declared board's number, not the first tracker's");

  const none = twoRepos();
  const said: string[] = [];
  const result = claimRow(481, KEYED_SESSION, { tracker: { key: "agent-org", repo: KEYED_REPO } as never, run: noGh as never, drained: [], instance: { spare: false, rows: [] },
    persistent: false, moveStatus: (n: number, status: string, opts?: object) => moveProjectStatus(n, status, { ...(opts ?? {}), log: (line: string) => said.push(line) }) } as never);
  assert.equal(result.claimed, true, "the labels are the claim");
  assert.deepEqual(none.moves, [], "no board of any kind is touched, the first tracker's included");
  assert.match((result as { statusReason: string }).statusReason, /^no board declared for tracker `agent-org`/);
  assert.ok(none.keyed().labels.includes("in-progress"));
  assert.deepEqual(none.primary().labels, ["ready"]);
});

test("a11ign/a11ign#4737: a half-finished keyed claim (labels written, then the worktree or record failed) is ROLLED BACK in the same call, and says so", () => {
  const fake = twoRepos();
  const git: string[][] = [];
  const failingClaim = ((n: number, s: string, deps: object) => {
    fake.world.failures.set("postRowComment", new Error("HTTP 502 posting the claim record"));
    try {
      return claimRow(n, s, { ...deps, drained: [], instance: { spare: false, rows: [] }, persistent: false, run: noGh } as never);
    } finally {
      fake.world.failures.delete("postRowComment");
    }
  }) as never;
  // A clone that holds no such branch: `rev-parse --verify` fails, `ls-remote --exit-code` exits 2, and every other git call answers nothing.
  const missing = (status: number) => Object.assign(new Error(`Command failed: git (exit ${status})`), { status, stdout: "", stderr: "" });
  const run = (cmd: string, args: string[]) => {
    if (cmd !== "git") return noGh(cmd);
    git.push(args);
    if (args.includes("rev-parse")) throw missing(1);
    if (args.includes("ls-remote") && args.includes("--exit-code")) throw missing(2);
    return "";
  };
  let thrown: Error | undefined;
  let direct: unknown;
  try {
    direct = claimWithWorktree(481, KEYED_SESSION, { branch: "agent/x-agent-org-481", worktree: "../wt-agent-org-481", run: run as never, claim: failingClaim,
      stamp: () => {}, exists: () => false, claimDeps: { tracker: KEYED, moveStatus: () => ({ moved: true }) }, clone: "/clones/agent-org" });
  } catch (error) { thrown = error as Error; }
  assert.ok(thrown, `the original failure is still raised: ${JSON.stringify(direct)} ${JSON.stringify(git)}`);
  assert.match(thrown.message, /HTTP 502 posting the claim record/);
  assert.match(thrown.message, /UNDONE IN THE SAME CALL/);
  assert.deepEqual(fake.keyed().labels, ["ready"], "the keyed row is `ready` again: the labels were written and then taken back");
  assert.deepEqual(fake.primary().labels, ["ready"]);
  assert.ok(git.some((args) => args.includes("worktree") && args.includes("remove")), "and the tree this call made is removed");
  assert.ok(git.every((args) => args[0] === "-C" && args[1] === "/clones/agent-org"), "every git call of the keyed claim names the keyed clone");
});
