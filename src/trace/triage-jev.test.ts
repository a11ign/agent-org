// agent-org#465 (a11ign/a11ign#4187 Change 4): the Jev sheet scorer. A fake `fetch`, a fake `readKey` and a fake diagnostic only: no network, no real key, no key file read.
// no-token: gh -- nothing here calls `gh`; every dependency is injected, and the CLI cases run a command that is refused before any request
//
// EACH CASE HAS ITS NEGATIVE CONTROL beside it: the same rig with the one thing changed that makes the case's claim false, so a test that could not fail shows itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHostConfig } from "../host-config.ts";
import { freshState, JEV_MODEL, JEV_URL } from "../triage-provider.ts";
import { MAX_IN_FLIGHT, parseArgs, parseThreshold, renderRun, scoreSheet, thresholdFor, type Reading } from "./triage-jev.ts";
import { LABELS, loadLabels, scoreTriage } from "./triage-sample.ts";

const FAKE_KEY = "tsk-FAKE-0123456789-do-not-print";
const KEY_PATH = "/fake/typesafe/key";
const THRESHOLD = 0.9;
const HOST = { triage: { provider: "jev", keyPath: KEY_PATH, minConfidence: THRESHOLD } };
const FROZEN = loadLabels();
const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "triage-jev-")); made.push(dir); return dir; };

type Row = { position: number; session: string; cause: string; causeKey: string; cost: string; label: string; excluded: boolean };
const row = (position: number, over: Partial<Row> = {}): Row => ({ position, session: "ceo", cause: "answer-owed", causeKey: `ceo/answer-owed/row-${position}`, cost: "$0.1000", label: "wake", excluded: false, ...over });
const sheetOf = (rows: Row[]) => ({ definitions: FROZEN.definitions, rows });

type Say = { choice: string; confidence: number; usage?: boolean };
type Reply = Say | { status: number } | { throws: true };
/** The `state` a request carried, parsed from its body: the fake answers by the row's `causeKey`, so the answer does not depend on the order the pool sent them in. */
type Call = { url: string; init: any; body: any };

function fakeFetch(answer: (causeKey: string) => Reply, { delayMs = 0 }: { delayMs?: number } = {}) {
  const calls: Call[] = [];
  const flight = { now: 0, max: 0 };
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const reply = answer(body.state.causeKey);
      if ("throws" in reply) throw new Error(`connection refused ${KEY_PATH}`);
      if ("status" in reply) return { ok: false, status: reply.status, json: async () => ({}) };
      const answers = { label: { type: "choice", choice: reply.choice, probabilities: {}, confidence: reply.confidence } };
      return { ok: true, status: 200, json: async () => ({ model: "jev-1.13.0", answers, ...(reply.usage === false ? {} : { usage: { input_tokens: 500, output_tokens: 40 } }) }) };
    } finally {
      flight.now -= 1;
    }
  }) as unknown as typeof fetch;
  return { fn, calls, flight };
}

/** Everything one run can leak through is collected here, so the key's text is searched for in ALL of it. */
function rig(answer: (causeKey: string) => Reply, options: { delayMs?: number; readKey?: (path: string) => string } = {}) {
  const net = fakeFetch(answer, options);
  const lines: string[] = [];
  const reads: string[] = [];
  const deps = {
    host: HOST, fetch: net.fn, state: freshState(), diagnostic: (line: string) => lines.push(line),
    readKey: options.readKey ?? ((path: string) => { reads.push(path); return FAKE_KEY; }),
  };
  return { deps, net, lines, reads };
}
const by = (readings: Reading[], position: number) => readings.find((r) => r.position === position) as Reading;
const say = (choice: string, confidence: number): Say => ({ choice, confidence });

test("a row below the threshold is written wake, and its label and confidence stay beside it; at the threshold it keeps the label", async () => {
  const sheet = sheetOf([row(1), row(2), row(3)]);
  const answer = (key: string): Reply => (key.endsWith("row-1") ? say("drop", 0.89) : key.endsWith("row-2") ? say("drop", 0.9) : say("digest", 0.97));
  const { readings } = await scoreSheet({ sheet, deps: rig(answer).deps, threshold: THRESHOLD });
  assert.deepEqual(by(readings, 1), { position: 1, label: "wake", asked: "drop", confidence: 0.89, outcome: "under", reason: "drop at 0.89, under the threshold 0.9" });
  assert.deepEqual([by(readings, 2).label, by(readings, 2).outcome], ["drop", "kept"], "exactly at the threshold the label is kept: the seam's floor is `<`");
  assert.deepEqual([by(readings, 3).label, by(readings, 3).confidence], ["digest", 0.97]);
  // negative control: the threshold is what holds row 1, not the row or the answer
  const lowered = await scoreSheet({ sheet, deps: rig(answer).deps, threshold: 0.5 });
  assert.equal(by(lowered.readings, 1).label, "drop");
});

test("a row with no cause is wake whatever the model says, and is not asked at all", async () => {
  const sheet = sheetOf([row(1, { cause: "(no cause)", causeKey: "(no ledger line)" }), row(2, { cause: "", causeKey: "x" }), row(3)]);
  const { deps, net } = rig(() => say("drop", 1));
  const { readings, usage } = await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  assert.deepEqual([by(readings, 1).label, by(readings, 1).outcome, by(readings, 2).label, by(readings, 2).outcome], ["wake", "no-cause", "wake", "no-cause"]);
  assert.equal(net.calls.length, 1, "only the row with a cause went out");
  assert.equal(usage.requests, 1);
  // negative control: the same answer, on a row WITH a cause, is kept: it is the missing cause that wakes the other two
  assert.equal(by(readings, 3).label, "drop");
});

test("a provider failure writes wake for that row, the other rows are still read, and the run finishes", async () => {
  const sheet = sheetOf([row(1), row(2), row(3), row(4), row(5)]);
  const answer = (key: string): Reply => {
    if (key.endsWith("row-1")) return { status: 500 };
    if (key.endsWith("row-2")) return { throws: true };
    if (key.endsWith("row-3")) return say("maybe", 1);
    if (key.endsWith("row-4")) return { choice: "drop", confidence: 7 };
    return say("drop", 1);
  };
  const { deps, lines } = rig(answer);
  const { readings, usage } = await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  assert.deepEqual(readings.map((r) => [r.position, r.label, r.outcome]), [[1, "wake", "failed"], [2, "wake", "failed"], [3, "wake", "failed"], [4, "wake", "failed"], [5, "drop", "kept"]]);
  assert.match(by(readings, 1).reason, /HTTP 500/);
  assert.equal(by(readings, 3).asked, null, "a label this sheet does not allow is not carried as what Jev said");
  assert.equal(usage.requests, 5);
  assert.deepEqual(lines, [], "no diagnostic: a failed row is a reason on the row, not a line");
  // negative control: with every request answered, the same four rows keep their label
  const healthy = await scoreSheet({ sheet, deps: rig(() => say("drop", 1)).deps, threshold: THRESHOLD });
  assert.deepEqual(healthy.readings.map((r) => r.label), ["drop", "drop", "drop", "drop", "drop"]);
});

test("no more than 10 requests are in flight at once; a pool of 25 shows the counter would notice", async () => {
  const sheet = sheetOf(Array.from({ length: 60 }, (_, i) => row(i + 1)));
  const held = rig(() => say("wake", 1), { delayMs: 5 });
  await scoreSheet({ sheet, deps: held.deps, threshold: THRESHOLD });
  assert.equal(held.net.calls.length, 60);
  assert.equal(held.net.flight.max, MAX_IN_FLIGHT, "the pool does run ten at a time (it is not serial), and never more");
  const wide = rig(() => say("wake", 1), { delayMs: 5 });
  await scoreSheet({ sheet, deps: wide.deps, threshold: THRESHOLD, concurrency: 25 });
  assert.ok(wide.net.flight.max > MAX_IN_FLIGHT, `negative control: a wider pool is seen at ${wide.net.flight.max}`);
});

test("the key and the request header appear in no output, and the key is read once", async () => {
  const sheet = sheetOf(Array.from({ length: 12 }, (_, i) => row(i + 1)));
  const { deps, net, lines, reads } = rig((key) => (key.endsWith("row-3") ? { throws: true } : say("digest", 0.95)));
  const { readings, usage } = await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  const output = [JSON.stringify(readings), renderRun({ sheet, readings, usage, threshold: THRESHOLD }), lines.join("\n")].join("\n");
  assert.ok(net.calls.every((call) => call.init.headers.Authorization === `Bearer ${FAKE_KEY}`), "positive control: every request DID carry the key in its header");
  for (const secret of [FAKE_KEY, "Bearer", "Authorization", KEY_PATH]) assert.ok(!output.includes(secret), `${secret} is in the output`);
  assert.deepEqual(reads, [KEY_PATH], "one read of the key for twelve requests");
});

test("a key that cannot be read leaves every row wake, says so once, and names neither the key nor its path", async () => {
  const sheet = sheetOf([row(1), row(2), row(3)]);
  const { deps, net, lines } = rig(() => say("drop", 1), { readKey: () => { throw new Error(`ENOENT: no such file ${KEY_PATH}`); } });
  const { readings, usage } = await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  assert.deepEqual(readings.map((r) => r.label), ["wake", "wake", "wake"]);
  assert.equal(net.calls.length, 0, "no request left the process");
  assert.equal(lines.length, 1);
  assert.equal(usage.requests, 0);
  assert.ok(![JSON.stringify(readings), ...lines].join("").includes(KEY_PATH));
});

test("what Jev is sent: the four printed columns as state and one choice question whose criteria are the fixture's three definitions", async () => {
  const sheet = sheetOf([row(7, { label: "drop", excluded: true })]);
  const { deps, net } = rig(() => say("wake", 1));
  await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  const [call] = net.calls;
  assert.equal(call.url, JEV_URL);
  assert.equal(call.body.model, JEV_MODEL);
  assert.deepEqual(call.body.state, { session: "ceo", cause: "answer-owed", causeKey: "ceo/answer-owed/row-7", cost: "$0.1000" }, "no label, no excluded mark, no position");
  assert.deepEqual(Object.keys(call.body.questions), ["label"]);
  assert.equal(call.body.questions.label.type, "choice");
  assert.deepEqual(call.body.questions.label.criteria, FROZEN.definitions);
  assert.deepEqual(Object.keys(call.body.questions.label.criteria), [...LABELS]);
});

test("the usage is the API's own, and a reply without one is counted as unreported rather than as zero", async () => {
  const sheet = sheetOf([row(1), row(2), row(3)]);
  const { deps } = rig((key) => (key.endsWith("row-3") ? { choice: "wake", confidence: 1, usage: false } : say("wake", 1)));
  const { usage, readings } = await scoreSheet({ sheet, deps, threshold: THRESHOLD });
  assert.deepEqual(usage, { requests: 3, inputTokens: 1000, outputTokens: 80, unreported: 1 });
  assert.match(renderRun({ sheet, readings, usage, threshold: THRESHOLD }), /requests 3, input tokens 1000, output tokens 80 \(1 reply reported no usage: a floor\)/);
});

test("the predictions file is accepted by the unchanged --score, and one with a label outside wake | digest | drop is refused", async () => {
  // the whole frozen sheet, every row answered `digest` at 0.95: a real 100-row file in the scorer's own shape
  const { deps } = rig(() => say("digest", 0.95));
  const { readings } = await scoreSheet({ sheet: FROZEN, deps, threshold: THRESHOLD });
  assert.equal(readings.length, FROZEN.rows.length);
  const dir = scratch();
  const good = join(dir, "predictions.json");
  writeFileSync(good, JSON.stringify(readings));
  const score = (file: string) => spawnSync(process.execPath, [join(SCRIPTS, "triage-sample.ts"), "--score", file], { encoding: "utf8" });
  const accepted = score(good);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /WITHOUT them .*agreement \d+\/94/);
  assert.equal(scoreTriage(FROZEN.rows, readings).withExcluded.n, 100);
  // the six unreadable rows are wake whatever Jev said, so every one of them is predicted wake in the file
  assert.ok(FROZEN.rows.filter((r) => r.excluded).every((r) => by(readings, r.position).label === "wake"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(readings.map((r, i) => (i === 0 ? { ...r, label: "maybe" } : r))));
  const refused = score(bad);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /label "maybe" is not one of wake \| digest \| drop/);
});

test("the threshold is a number from 0 to 1, defaulting to the host's declared minConfidence", () => {
  assert.equal(parseThreshold("0.9"), 0.9);
  assert.equal(parseThreshold("0"), 0);
  for (const text of ["", "1.1", "-0.1", "high", "NaN"]) assert.throws(() => parseThreshold(text), /--threshold takes a number from 0 to 1/);
  const declared = parseHostConfig(JSON.stringify({
    schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
    gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] }, triage: { provider: "jev", keyPath: KEY_PATH },
  }));
  assert.deepEqual(declared.triage, { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 });
  assert.equal(thresholdFor(null, declared.triage as { provider: "jev"; minConfidence: number }), 0.9);
  assert.equal(thresholdFor(0.5, declared.triage as { provider: "jev"; minConfidence: number }), 0.5, "the flag wins");
  assert.deepEqual(parseArgs(["--out", "p.json", "--threshold", "0.8"]), { input: null, out: "p.json", threshold: 0.8, host: null });
  assert.throws(() => parseArgs([]), /--out .* is required/);
  assert.throws(() => parseArgs(["--out", "p.json", "--seed", "1"]), /unexpected argument --seed/);
});

test("a host with no jev provider is refused before any request and writes no file", () => {
  const dir = scratch();
  const host = join(dir, "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }], gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] } }));
  const out = join(dir, "predictions.json");
  const ran = spawnSync(process.execPath, [join(SCRIPTS, "triage-jev.ts"), "--out", out, "--host", host], { encoding: "utf8" });
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /declares no `jev` triage provider/);
  assert.equal(existsSync(out), false);
  // negative control: the refusal is the host's, not the command's: a host that does declare a provider is not refused for that reason
  const declared = join(dir, "declared.json");
  writeFileSync(declared, JSON.stringify({ ...JSON.parse(readFileSync(host, "utf8")), triage: { provider: "jev", keyPath: join(dir, "no-such-key") } }));
  const unread = spawnSync(process.execPath, [join(SCRIPTS, "triage-jev.ts"), "--out", out, "--host", declared], { encoding: "utf8" });
  assert.doesNotMatch(unread.stderr, /declares no `jev` triage provider/);
  assert.equal(unread.status, 1, "and with a key that cannot be read, nothing asked came back readable, so the run does not look like a result");
  assert.ok(![unread.stdout, unread.stderr].join("").includes(join(dir, "no-such-key")), "the key's path is in no output");
});
