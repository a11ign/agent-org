// no-token: gh -- `gh` is never reached: every call is handed a fake `run` and a fake `labelBatch`.
/**
 * a11ign/a11ign#3566, slice 9: THE CLAIM'S FOUR `label create --force` WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * One real claim tick was read call by call (the census on the row, 2026-10-06T13:25Z): `applyClaimLabels` made four `gh label create <label> --repo
 * --force` before the label `PUT`, one after another, 3,168 ms of a claim's 15,662 ms (1,063, 439, 773 and 893). They create-or-update a label to the
 * same colour and description each time, so none depends on another and each is idempotent. The fix moves WHEN they wait (the gate's batch, as slice
 * 4 did for the reads) and nothing else, so what is pinned is:
 *   - the control: a claim handed no `labelBatch` (a test's `run` stands for `gh`) makes the four creates one at a time, in order, before the `PUT`;
 *   - the four go out as ONE batch, the same four commands, none added and none dropped, and none of them is then asked of `run`;
 *   - the `PUT`, the fresh label read before it and the re-read after it are NOT in the batch and keep their order (condition 3 of the Region);
 *   - a refused create is retried one at a time, and the claim says what the one-at-a-time claim says (a throw before any label was written);
 *   - a batch that cannot start does not stop the claim: the creates run one at a time, as before;
 *   - the wiring: the real batch is the default ONLY when `run` is the real `gh`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimRow, claimWithWorktree, moveProjectStatus } from "./row-claim.ts";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };

const here = dirname(fileURLToPath(import.meta.url));
const REST = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\nTRUE ALREADY\n";
const BODY = `## Region\n\nNo file declared here.\n${REST}`;
const FOUR = ["in-progress", "session:worker-3566", "started", "was-ready"];

const fieldsOf = (args: string[]) => args[args.indexOf("--json") + 1] ?? "";
const isCreate = (args: string[]) => args[0] === "label" && args[1] === "create";
const isPut = (args: string[]) => args[0] === "api" && args.includes("--method") && args.includes("PUT");
const isLabelRead = (args: string[]) => args[0] === "issue" && args[1] === "view" && fieldsOf(args) === "number,title,labels,state";

/** What `gh` answers, by argv: a ready row nothing stands in the way of. `refuse` throws for a call naming one of the words. */
function ghAnswer(args: string[], refuse: string[] = []): string {
  if (refuse.some((word) => args.includes(word))) throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" });
  if (args[0] === "issue" && args[1] === "view") {
    if (fieldsOf(args) === "blockedBy") return JSON.stringify({ blockedBy: { nodes: [] } });
    if (fieldsOf(args) === "body") return JSON.stringify({ body: BODY });
    return JSON.stringify({ number: 3566, title: "A row", labels: [{ name: "ready" }], state: "OPEN" });
  }
  if (isCreate(args) || isPut(args) || args[0] === "issue") return "";
  return "[]";
}

const sequentialRun = (seen: Call[], refuse: string[] = []) =>
  (_cmd: string, args: string[]) => { seen.push({ args, repo: undefined }); return ghAnswer(args, refuse); };

/** A batch that answers as `ghAnswer` does and notes each batch it was handed. */
function fakeBatch(batches: Call[][], refuse: string[] = []) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => {
      try { return { stdout: ghAnswer(call.args, refuse) }; } catch { return { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 }; }
    });
  };
}

/** The stderr a claim wrote while it ran: a batch that could not run is said aloud, never swallowed. */
function saidAloud<T>(act: () => T): { result: T, said: string[] } {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { result: act(), said }; } finally { process.stderr.write = write; }
}

const claim = (deps: Record<string, unknown>) => claimRow(3566, "worker-3566", { moveStatus: () => ({ moved: true }), ...deps } as never);
const labelOf = (call: Call) => call.args[2];
const outcomeOf = (act: () => unknown) => { try { return { returned: act() }; } catch (error) { return { threw: (error as Error).message }; } };

test("POSITIVE CONTROL: the one-at-a-time claim makes the four label creates in order, each before the label PUT", () => {
  const seen: Call[] = [];
  const result = claim({ run: sequentialRun(seen) });
  assert.equal(result.claimed, true, "a clear row is claimed, so the calls below are the ones a claim makes");
  const creates = seen.filter((call) => isCreate(call.args));
  assert.deepEqual(creates.map(labelOf), FOUR, "the four labels, in the order the claim names them");
  assert.ok(creates.every((call) => call.args.includes("--force") && call.args.includes("--repo")), "each is the create-or-update `gh` always ran");
  const put = seen.findIndex((call) => isPut(call.args));
  assert.ok(put > seen.indexOf(creates[3]), "every create is before the PUT");
});

test("the four creates go out in ONE batch, the same four commands, and `run` is not asked for them again", () => {
  const sequential: Call[] = [];
  claim({ run: sequentialRun(sequential) });
  const batches: Call[][] = [];
  const left: Call[] = [];
  const result = claim({ run: sequentialRun(left), labelBatch: fakeBatch(batches) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1, "one batch, not one per label");
  assert.deepEqual(batches[0].map((call) => call.args), sequential.filter((call) => isCreate(call.args)).map((call) => call.args),
    "the same four commands, in the same order, none added and none dropped");
  assert.deepEqual(left.filter((call) => isCreate(call.args)), [], "a create the batch answered is not asked of `run` again");
});

test("NOTHING AROUND THE PUT MOVES: the fresh label read, the PUT and the re-read stay one at a time, in order, after the creates", () => {
  const sequential: Call[] = [];
  claim({ run: sequentialRun(sequential) });
  const batches: Call[][] = [];
  const left: Call[] = [];
  claim({ run: sequentialRun(left), labelBatch: fakeBatch(batches) });
  const writes = (calls: Call[]) => calls.filter((call) => !isCreate(call.args)).map((call) => JSON.stringify(call.args));
  assert.deepEqual(writes(left), writes(sequential), "every call but the creates is the one-at-a-time claim's own, in its own order");
  assert.deepEqual(batches[0].filter((call) => isPut(call.args) || isLabelRead(call.args) || call.args[0] === "project"), [], "no PUT, label read or board call is in the batch");
  const put = left.findIndex((call) => isPut(call.args));
  const reads = left.map((call, at) => (isLabelRead(call.args) ? at : -1)).filter((at) => at >= 0);
  assert.ok(reads.some((at) => at < put) && reads.some((at) => at > put), "a label read right before the PUT and the re-read after it, each through `run`");
});

test("a REFUSED create is retried one at a time, and the claim says what the one-at-a-time claim says", () => {
  const sequential: Call[] = [];
  const before = outcomeOf(() => claim({ run: sequentialRun(sequential, ["session:worker-3566"]) }));
  assert.ok("threw" in before, "positive control: a refused create stops the claim today");
  const batches: Call[][] = [];
  const left: Call[] = [];
  const { result: together, said } = saidAloud(() => outcomeOf(() => claim({ run: sequentialRun(left, ["session:worker-3566"]), labelBatch: fakeBatch(batches, ["session:worker-3566"]) })));
  assert.deepEqual(together, before, "the same throw");
  assert.deepEqual(left.filter((call) => isPut(call.args)), [], "and nothing was written to the row");
  assert.deepEqual(left.filter((call) => isCreate(call.args)).map(labelOf), FOUR.slice(0, 2), "the creates ran one at a time, up to the refused one, as before");
  assert.ok(said.some((line) => /NOTE: .*label/.test(line)), "the batch's failure is said aloud, not swallowed");
});

test("a batch that cannot START does not stop the claim: the creates run one at a time", () => {
  const left: Call[] = [];
  const { result, said } = saidAloud(() => claim({ run: sequentialRun(left), labelBatch: () => { throw new Error("spawn node ENOENT"); } }));
  assert.equal(result.claimed, true);
  assert.deepEqual(left.filter((call) => isCreate(call.args)).map(labelOf), FOUR, "all four, through `run`");
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

const PRIMARY_REPO = "a11ign/a11ign";
const KEYED_REPO = "a11ign/agent-org";
const KEYED = { key: "agent-org", repo: KEYED_REPO, board: { owner: "a11ign", number: 9 } };
const KEYED_SESSION = "worker-agent-org-481";
const KEYED_FOUR = ["in-progress", `session:${KEYED_SESSION}`, "started", "was-ready"];

/** Two repositories, each holding a `ready` row 481; every call is recorded with the repository it names (`--repo`, or the `repos/<r>/issues` path of the PUT). */
function twoRepos() {
  const labels = new Map<string, string[]>([[`${PRIMARY_REPO}#481`, ["ready"]], [`${KEYED_REPO}#481`, ["ready"]]]);
  const comments = new Map<string, string[]>();
  const calls: Call[] = [];
  const repoOf = (args: string[]) => {
    const flag = args.indexOf("--repo");
    if (flag >= 0) return args[flag + 1];
    return /^repos\/([^/]+\/[^/]+)\//.exec(args[args.indexOf("PUT") + 1] ?? "")?.[1];
  };
  const answer = (args: string[]): string => {
    const repo = repoOf(args);
    calls.push({ args, repo });
    if (args[0] === "issue" && args[1] === "view") {
      if (fieldsOf(args) === "blockedBy") return JSON.stringify({ blockedBy: { nodes: [] } });
      if (fieldsOf(args) === "body") return JSON.stringify({ body: BODY });
      if (fieldsOf(args) === "comments") return JSON.stringify({ comments: (comments.get(`${repo}#481`) ?? []).map((body) => ({ body })) });
      return JSON.stringify({ number: 481, title: "A row", labels: (labels.get(`${repo}#481`) ?? []).map((name) => ({ name })), state: "OPEN" });
    }
    if (isPut(args)) labels.set(`${repo}#481`, args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length)));
    if (args[0] === "issue" && args[1] === "edit") {
      let held = labels.get(`${repo}#481`) ?? [];
      args.forEach((a, at) => {
        if (a === "--remove-label") held = held.filter((l) => l !== args[at + 1]);
        if (a === "--add-label" && !held.includes(args[at + 1])) held = [...held, args[at + 1]];
      });
      labels.set(`${repo}#481`, held);
    }
    if (args[0] === "issue" && args[1] === "comment") comments.set(`${repo}#481`, [...(comments.get(`${repo}#481`) ?? []), args[args.indexOf("--body") + 1]]);
    if (isCreate(args) || isPut(args) || args[0] === "issue" || args[0] === "project") return "";
    return "[]";
  };
  const run = (_cmd: string, args: string[]) => answer(args);
  const batch = (batches: Call[][]) => (batched: Call[]): Answer[] => { batches.push(batched); return batched.map((c) => ({ stdout: answer(c.args) })); };
  const writes = () => calls.filter((c) => isCreate(c.args) || isPut(c.args) || (c.args[0] === "issue" && c.args[1] !== "view" && c.args[1] !== "list") || c.args[0] === "project");
  return { run, batch, calls, labels, writes };
}

const keyedClaim = (deps: Record<string, unknown>) =>
  claimRow(481, KEYED_SESSION, { tracker: KEYED, drained: [], instance: { spare: false, rows: [] }, persistent: false, ...deps } as never);

test("a11ign/a11ign#4737: a keyed claim writes `a11ign/agent-org` and NOT `a11ign/a11ign` -- the fake gh records the `--repo` of every write", () => {
  const fake = twoRepos();
  const result = keyedClaim({ run: fake.run });
  assert.equal(result.claimed, true);
  const writes = fake.writes();
  assert.ok(writes.length >= 6, `the creates, the PUT, the claim record and the card move are all writes: ${writes.length}`);
  for (const write of writes.filter((c) => c.args[0] !== "project")) assert.equal(write.repo, KEYED_REPO, `write ${write.args.slice(0, 3).join(" ")}`);
  assert.deepEqual(writes.filter((c) => c.repo === PRIMARY_REPO), [], "no write named the first tracker's repository");
  assert.deepEqual(writes.filter(isCreateCall).map(labelOf), KEYED_FOUR, "the four lifecycle labels are created in the keyed repository");
  assert.deepEqual(fake.calls.filter((c) => c.repo === PRIMARY_REPO && c.args[0] !== "pr").map((c) => c.args), [],
    "nor was its row read: the one call that names it is B4's read of the open pull requests of every declared CODE repository, which is not a row's");
});

test("a11ign/a11ign#4737: the same number as a primary row (481) is untouched -- its labels, its comments and its card", () => {
  const fake = twoRepos();
  keyedClaim({ run: fake.run });
  assert.deepEqual(fake.labels.get(`${PRIMARY_REPO}#481`), ["ready"], "the first tracker's 481 is exactly `ready` as it was");
  assert.ok((fake.labels.get(`${KEYED_REPO}#481`) ?? []).includes("in-progress"), "control: the keyed 481 is the one that was claimed");
  const cards = fake.calls.filter((c) => c.args[0] === "project");
  assert.deepEqual(cards.map((c) => c.args.find((a) => a.startsWith("https://"))), [`https://github.com/${KEYED_REPO}/issues/481`]);
});

test("a11ign/a11ign#4737: the batched creates of a keyed claim name the keyed repository too, and nothing the batch holds is the first tracker's", () => {
  const fake = twoRepos();
  const batches: Call[][] = [];
  const result = keyedClaim({ run: fake.run, labelBatch: fake.batch(batches) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((c) => c.args[2]), KEYED_FOUR);
  assert.deepEqual([...new Set(batches[0].map((c) => c.args[c.args.indexOf("--repo") + 1]))], [KEYED_REPO]);
});

test("a11ign/a11ign#4737: a DECLARED board moves THAT board's card (its own owner and number); a tracker with NONE claims with labels alone and says so", () => {
  const declared = twoRepos();
  keyedClaim({ run: declared.run });
  const move = declared.calls.find((c) => c.args[0] === "project") as Call;
  assert.deepEqual(move.args.slice(0, 5), ["project", "item-edit", "9", "--owner", "a11ign"], "the declared board's number, not the first tracker's");

  const none = twoRepos();
  const said: string[] = [];
  const result = claimRow(481, KEYED_SESSION, { tracker: { key: "agent-org", repo: KEYED_REPO } as never, run: none.run, drained: [], instance: { spare: false, rows: [] },
    persistent: false, moveStatus: (n: number, status: string, opts?: object) => moveProjectStatus(n, status, { ...(opts ?? {}), log: (line: string) => said.push(line) }) } as never);
  assert.equal(result.claimed, true, "the labels are the claim");
  assert.deepEqual(none.calls.filter((c) => c.args[0] === "project" || c.args.includes("graphql")), [], "no board of any kind is touched, the first tracker's included");
  assert.match((result as { statusReason: string }).statusReason, /^no board declared for tracker `agent-org`/);
  assert.ok((none.labels.get(`${KEYED_REPO}#481`) ?? []).includes("in-progress"));
  assert.deepEqual(none.labels.get(`${PRIMARY_REPO}#481`), ["ready"]);
});

test("a11ign/a11ign#4737: a half-finished keyed claim (labels written, then the worktree or record failed) is ROLLED BACK in the same call, and says so", () => {
  const fake = twoRepos();
  const git: string[][] = [];
  const failingClaim = ((n: number, s: string, deps: object) =>
    claimRow(n, s, { ...deps, drained: [], instance: { spare: false, rows: [] }, persistent: false, run: (cmd: string, args: string[]) => {
      if (args[0] === "issue" && args[1] === "comment") throw new Error("HTTP 502 posting the claim record");
      return fake.run(cmd, args);
    } } as never)) as never;
  // A clone that holds no such branch: `rev-parse --verify` fails, `ls-remote --exit-code` exits 2, and every other git call answers nothing.
  const missing = (status: number) => Object.assign(new Error(`Command failed: git (exit ${status})`), { status, stdout: "", stderr: "" });
  const run = (cmd: string, args: string[]) => {
    if (cmd !== "git") return fake.run(cmd, args);
    git.push(args);
    if (args.includes("rev-parse")) throw missing(1);
    if (args.includes("ls-remote") && args.includes("--exit-code")) throw missing(2);
    return "";
  };
  let thrown: Error | undefined;
  let direct: unknown;
  try {
    direct = claimWithWorktree(481, KEYED_SESSION, { branch: "agent/x-agent-org-481", worktree: "../wt-agent-org-481", run: run as never, claim: failingClaim,
      stamp: () => {}, exists: () => false, claimDeps: { tracker: KEYED }, clone: "/clones/agent-org" });
  } catch (error) { thrown = error as Error; }
  assert.ok(thrown, `the original failure is still raised: ${JSON.stringify(direct)} ${JSON.stringify(git)}`);
  assert.match(thrown.message, /HTTP 502 posting the claim record/);
  assert.match(thrown.message, /UNDONE IN THE SAME CALL/);
  assert.deepEqual(fake.labels.get(`${KEYED_REPO}#481`), ["ready"], "the keyed row is `ready` again: the labels were written and then taken back");
  assert.deepEqual(fake.labels.get(`${PRIMARY_REPO}#481`), ["ready"]);
  assert.ok(git.some((args) => args.includes("worktree") && args.includes("remove")), "and the tree this call made is removed");
  assert.ok(git.every((args) => args[0] === "-C" && args[1] === "/clones/agent-org"), "every git call of the keyed claim names the keyed clone");
});

function isCreateCall(call: Call) { return isCreate(call.args); }
