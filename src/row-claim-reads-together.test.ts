// no-token: gh -- `gh` is never reached: every read is handed a fake `run` and a fake `batch`.
/**
 * a11ign/a11ign#3566, slice 4: THE CLAIM'S PRE-WRITE READS WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * `claimRow` checks a row before it writes anything: its body (the template fields), its `blockedBy` edge, the rows this session already holds, the
 * row's Region and then every declared code repository's open pull requests. Each was one synchronous `gh`, so a claim waited for the SUM of them
 * (a read-only `check` counted 8 distinct `pr list` and 5 `issue view` of the one row, about 6.7 s). The fix moves WHEN they wait
 * (`readWithFirstWaveTogether`, the gate's seam from slices 2, 3 and 5) and nothing else, so what is pinned is:
 *   - the control: a `run` handed in (a test's stand-in for `gh`) is NOT batched, and reads one call at a time in today's order;
 *   - the pre-write reads the rehearsal can foresee go out in ONE batch, the same calls the one-at-a-time claim made, none added and none dropped
 *     (a refused one replays as the throw it was and is retried exactly as before);
 *   - what it cannot foresee (the claimed-rows list, which is asked only once the row's Region names a file) still runs on its own, through `run`;
 *   - NOTHING FROM THE FIRST WRITE ON IS BATCHED: the label reads either side of the claiming write stay fresh and sequential, and a write is never
 *     rehearsed;
 *   - the import of the batch helper from the gate runs nothing and makes no cycle (condition 4 of the Region).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimRow, CLAIM_LABEL } from "./row-claim.ts";
import { connectionOf, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };
type Options = { body?: string, labels?: { name: string }[], refuse?: string[] };

const here = dirname(fileURLToPath(import.meta.url));
const REST = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\nTRUE ALREADY\n";
const NO_REGION = `## Region\n\nNo file declared here.\n${REST}`;
const WITH_REGION = `## Region\n\n\`\`\`\nsrc/the-claimed-file.mjs\n\`\`\`\n${REST}`;

const has = (args: string[], ...words: string[]) => words.every((word) => args.includes(word));
const fieldsOf = (args: string[]) => args[args.indexOf("--json") + 1] ?? "";
const isWrite = (args: string[]) => args[0] === "label" || (args[0] === "issue" && args[1] === "edit")
  || (args[0] === "api" && args[1] === "--method");
// agent-org#1302: the row's labels and state are read over REST, `gh api repos/<repo>/issues/<n>`, not `gh issue view`
const isLabelRead = (args: string[]) => args[0] === "api" && /^repos\/[^/]+\/[^/]+\/issues\/3566$/.test(args[1] ?? "");

/** What `gh` answers, by argv: a row with nothing in its way, whose body is `options.body`. */
function ghAnswer(args: string[], options: Options = {}): string {
  if ((options.refuse ?? []).some((word) => args.includes(word))) {
    throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" });
  }
  if (isLabelRead(args)) return JSON.stringify({ number: 3566, title: "A row", labels: options.labels ?? [], state: "open" });
  if (args[0] === "issue" && args[1] === "view") {
    if (fieldsOf(args) === "blockedBy") return JSON.stringify({ blockedBy: { nodes: [] } });
    if (fieldsOf(args).split(",").includes("body")) return JSON.stringify({ body: options.body ?? NO_REGION, labels: (options.labels ?? []) });
    return JSON.stringify({ number: 3566, title: "A row", labels: options.labels ?? [], state: "OPEN" });
  }
  if (readsRowsByLabel(args) !== null) return connectionOf([]);
  if (isWrite(args)) return "";
  return "[]";
}

/** The `run` a test hands the claim: one call at a time, noted, answering by argv. */
function sequentialRun(seen: Call[], options: Options = {}) {
  return (_cmd: string, args: string[]) => { seen.push({ args, repo: undefined }); return ghAnswer(args, options); };
}

/** A batch that answers as `ghAnswer` does and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], options: Options = {}) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => {
      try { return { stdout: ghAnswer(call.args, options) }; } catch { return { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 }; }
    });
  };
}

/** What the claim said aloud while it ran: B4 names a refused pull-request list, and a refusal swallowed into an empty answer would say nothing. */
function saidAloud<T>(act: () => T): { result: T, said: string[] } {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { result: act(), said }; } finally { process.stderr.write = write; }
}

const claim = (deps: Record<string, unknown>) => claimRow(3566, "worker-3566", { moveStatus: () => ({ moved: true }), ...deps } as never);
const shape = (call: Call) => `${call.args.slice(0, 2).join(" ")} ${fieldsOf(call.args)}`.trim();
const keyOf = (call: Call) => JSON.stringify(call.args);
const beforeFirstWrite = (calls: Call[]) => calls.slice(0, calls.findIndex((call) => isWrite(call.args)));

test("POSITIVE CONTROL: the one-at-a-time claim reads the body, the edge, the held rows and each repository's pull requests BEFORE its first write", () => {
  const seen: Call[] = [];
  const result = claim({ run: sequentialRun(seen) });
  assert.equal(result.claimed, true, "a clear row is claimed, so the reads below are the ones a claim makes");
  const reads = beforeFirstWrite(seen).map(shape);
  assert.ok(reads.some((read) => read.startsWith("issue view") && read.split(" ").pop()?.split(",").includes("body")), "the body is read");
  assert.ok(reads.some((read) => read.endsWith("blockedBy")), "the edge is read");
  assert.ok(beforeFirstWrite(seen).some((call) => readsRowsByLabel(call.args)?.label === CLAIM_LABEL), "the held rows are listed");
  assert.ok(reads.filter((read) => read.startsWith("pr list")).length >= 1, "each declared repository's pull requests are listed");
  assert.ok(isWrite(seen[beforeFirstWrite(seen).length].args), "the write follows the reads");
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, with no rehearsal pass", () => {
  const seen: Call[] = [];
  claim({ run: sequentialRun(seen) });
  const keys = beforeFirstWrite(seen).map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "no call twice: the read-once cache folded the repeats, and a rehearsal pass would repeat them");
});

test("the pre-write reads go out in ONE batch, and they are the calls the one-at-a-time claim made", () => {
  const sequential: Call[] = [];
  claim({ run: sequentialRun(sequential) });
  const batches: Call[][] = [];
  const left: Call[] = [];
  const result = claim({ run: sequentialRun(left), batch: fakeBatch(batches) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1, "one batch, not one per read");
  const batched = batches[0].map(keyOf);
  const wanted = beforeFirstWrite(sequential).slice(1).map(keyOf); // all but the first thing asked: the labels, which `decideClaim` waits on
  assert.deepEqual([...batched].sort(), [...wanted].sort(), "the same reads, none added and none dropped");
  assert.ok(batches[0].filter((call) => call.args[0] === "pr").length >= 1, "the pull-request lists are in it");
  assert.equal(batches[0].filter((call) => has(call.args, "view")).length, 2, "the row's body and its edge, once each");
  assert.deepEqual(left.filter((call) => batched.includes(keyOf(call))), [], "a read the batch answered is not asked again");
});

test("NOTHING FROM THE FIRST WRITE ON IS BATCHED: the label reads either side of the write stay fresh, and no write is in the batch", () => {
  const batches: Call[][] = [];
  const left: Call[] = [];
  claim({ run: sequentialRun(left), batch: fakeBatch(batches) });
  assert.deepEqual(batches[0].filter((call) => isWrite(call.args)), [], "a write is never rehearsed or batched");
  const labelReads = left.filter((call) => isLabelRead(call.args));
  assert.ok(labelReads.length >= 2, "the labels are read before the checks and again right before the write, each through `run`");
  assert.deepEqual(batches[0].filter((call) => isLabelRead(call.args)), [], "and neither is in the batch");
  assert.equal(isLabelRead(left[0].args), true, "the first thing the claim asks is still the labels, on its own");
});

// #5039: THE CLAIMED ROWS ARE ONE READ NOW. B2's held rows used to be their own search (`--label in-progress --label session:<me>`), and B4's Regions
// the list with bodies; both are `repository.issues(labels: in-progress)` now (the held rows are told apart by their `session:` label after the read), so
// the rehearsal sees the read at B2 -- which names no Region -- and B4's comparison, which waits for a Region that names a file, is answered from it.
test("the claimed-rows list is ONE read in the first wave: B2's held rows ask it, and B4's Regions are compared from that same answer", () => {
  const batches: Call[][] = [];
  const left: Call[] = [];
  const sequential: Call[] = [];
  claim({ run: sequentialRun(sequential, { body: WITH_REGION }) });
  claim({ run: sequentialRun(left, { body: WITH_REGION }), batch: fakeBatch(batches, { body: WITH_REGION }) });
  const claimedList = (call: Call) => readsRowsByLabel(call.args)?.label === CLAIM_LABEL;
  assert.equal(sequential.filter(claimedList).length, 1, "today's claim asks the claimed rows once, for B2 and B4 together");
  assert.equal(batches[0].filter(claimedList).length, 1, "the rehearsal foresaw it at B2, whose read needs no Region");
  assert.deepEqual(left.filter(claimedList), [], "so B4's comparison was answered from it and nothing was asked again");
  assert.deepEqual([...batches[0], ...beforeFirstWrite(left)].map(keyOf).sort(), beforeFirstWrite(sequential).map(keyOf).sort(),
    "every read of the one-at-a-time claim still happens exactly once");
});

test("a REFUSED read replays as the throw it was and is retried as before: the same verdict, no read dropped", () => {
  for (const word of ["blockedBy", "body", "pr"]) {
    const sequential: Call[] = [];
    const { result: sequentialResult, said: saidBefore } = saidAloud(() => claim({ run: sequentialRun(sequential, { refuse: [word] }) }));
    const batches: Call[][] = [];
    const left: Call[] = [];
    const { result: together, said } = saidAloud(() => claim({ run: sequentialRun(left, { refuse: [word] }), batch: fakeBatch(batches, { refuse: [word] }) }));
    assert.deepEqual(together, sequentialResult, `${word}: the claim says what the one-at-a-time claim says`);
    const inconclusive = (lines: string[]) => lines.filter((line) => /INCONCLUSIVE/.test(line)).length;
    assert.equal(inconclusive(said), inconclusive(saidBefore), `${word}: a refused read is said aloud as often as it was`);
    if (word === "pr") assert.equal(inconclusive(said), 1, "pr: and it IS said once (positive control for the comparison)");
    const all = [...batches[0], ...beforeFirstWrite(left)].map(keyOf).sort();
    const today = beforeFirstWrite(sequential).map(keyOf).sort();
    if (word !== "pr") assert.deepEqual(all, today, `${word}: the same calls in all, the repeat of a refused read going out again exactly as before`);
    else {
      // THE ONE DIFFERENCE, and it is on the failure path only: B4 stops at the first repository whose list is refused, while the batch had already
      // asked every repository's. They are the same `pr list` the claim asks on any other day, so what is pinned is that NOTHING ELSE is extra.
      assert.deepEqual(today.filter((key) => !all.includes(key)), [], "no read the one-at-a-time claim made is dropped");
      const extra = all.filter((key) => !today.includes(key));
      assert.ok(extra.length >= 1 && extra.every((key) => key.startsWith('["pr","list"')), "the extra reads are the later repositories' pull-request lists, nothing else");
    }
  }
});

test("RESUMING a row this session already holds asks the body and the edge together, and nothing about eligibility", () => {
  const batches: Call[][] = [];
  const left: Call[] = [];
  const mine = [{ name: CLAIM_LABEL }, { name: "session:worker-3566" }];
  const result = claim({ run: sequentialRun(left, { labels: mine }), batch: fakeBatch(batches, { labels: mine }) });
  assert.equal(result.claimed, true);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(shape).sort(), ["issue view blockedBy", "issue view body,labels"]);
  assert.deepEqual(left.filter((call) => call.args[0] === "pr" || call.args[1] === "list"), [], "a resume spends no round trip on a front that was never new");
});

test("a refusal BEFORE the write is still a refusal, with nothing written", () => {
  const body = "## Template\n";
  const batches: Call[][] = [];
  const left: Call[] = [];
  const result = claim({ run: sequentialRun(left, { body }), batch: fakeBatch(batches, { body }) });
  const sequential: Call[] = [];
  const same = claim({ run: sequentialRun(sequential, { body }) });
  assert.deepEqual(result, same);
  assert.deepEqual(left.filter((call) => isWrite(call.args)), sequential.filter((call) => isWrite(call.args)), "the writes are the one-at-a-time claim's own");
});

test("THE IMPORT: the batch helper's module is already in the claim's closure, loads without running the gate, and never reaches the claim back", () => {
  const sources = new Map<string, string>();
  const closure = new Set<string>();
  const visit = (file: string) => {
    if (closure.has(file) || !existsSync(file)) return;
    closure.add(file);
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    for (const [, from] of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'\n;]*?from\s+"(\.{1,2}\/[^"]+\.ts)"/g)) visit(resolve(dirname(file), from));
  };
  visit(resolve(here, "work-gate.ts"));
  assert.ok(closure.size > 10, "the closure walk found the gate's imports (positive control for the emptiness below)");
  assert.equal(closure.has(resolve(here, "row-claim.ts")), false, "the gate's closure never imports the claim: no cycle");
  const loaded = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const gate = await import(${JSON.stringify(resolve(here, "work-gate/reads/read-memo-and-exit.ts"))}); process.stdout.write(typeof gate.readWithFirstWaveTogether + typeof gate.runBatch);`],
  { encoding: "utf8", timeout: 60_000, env: { ...process.env, GH_REPO: "", GH_TOKEN: "" } });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, "functionfunction", "importing it prints nothing of its own: `main` runs only when the file is the entry point");
});

test("THE WIRING: the claim reads its pre-write checks through the gate's seam and reads the labels outside it", () => {
  const source = readFileSync(resolve(here, "row-claim.ts"), "utf8");
  assert.match(source, /import \{[^}]*readWithFirstWaveTogether[^}]*\} from "\.\/work-gate\/reads\/read-memo-and-exit\.ts"/);
  assert.match(source, /batch = run === defaultRun \? runBatch : undefined/);
  const writer = source.slice(source.indexOf("\nfunction writeRowLabels("), source.indexOf("\nfunction completeClaim("));
  assert.match(writer, /readWithFirstWaveTogether\(/);
  assert.ok(writer.indexOf("fetchLabels(issueNumber, { run })") < writer.indexOf("readWithFirstWaveTogether("), "the first label read is not part of the rehearsal");
});
