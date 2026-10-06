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
import { claimRow } from "./row-claim.mjs";

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
  const source = readFileSync(resolve(here, "row-claim.mjs"), "utf8");
  assert.match(source, /labelBatch = run === defaultRun \? runBatch : undefined/);
  const apply = source.slice(source.indexOf("\nfunction applyClaimLabels("), source.indexOf("\n/**", source.indexOf("\nfunction applyClaimLabels(")));
  assert.match(apply, /ensureLabelsExist\([^)]*batch: labelBatch/, "`applyClaimLabels` hands the batch to the creates");
  assert.ok(apply.indexOf("ensureLabelsExist(") < apply.indexOf("fetchLabels(issueNumber"), "and they are still made BEFORE the fresh label read");
});
