// no-token: clearContext -- every herdr call is the injected `run` or a stub `herdr` on PATH; nothing here reaches gh
/**
 * #2483: A PER-ROW INSTANCE IS NEVER `/clear`ed (chairman, via `ceo`, 2026-09-25). A spawned `worker-<n>` and a
 * `reviewer-<n>` have one row as their whole life, so a failing check or a refusal on THEIR pull request is the same
 * task and not an unrelated topic; wiping the window discards exactly what the order is about.
 *
 * THERE ARE TWO CLEAR PATHS AND EACH IS DRIVEN HERE: `deliver` (the gate's, and a queued handoff's through
 * `deliverHandoffs`) and `clearThenPrompt` (every `prompt:session`, reached here through its CLI as well as directly).
 * The controls sit in the SAME file: `ceo`, `product-manager`, `orchestrator` and `worker-tooling` are still cleared
 * on both paths, because a predicate that matches everything passes the instance half by clearing nothing.
 *
 * A clear costs five seconds (`CLEAR_SETTLE_MS`), so the control tests hold the file's runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver as settlingDeliver, deliverHandoffs as settlingDeliverHandoffs, isPerRowInstance, clearBeforeOrder, ledgerLine, ledgerKeyOf, readLedger,
  NO_CLEAR_NOTE, compactContext, instanceCacheRead, COMPACT_THRESHOLD_TOKENS } from "../wake.mjs";
import { clearThenPrompt as settlingClearThenPrompt } from "../prompt-session.mjs";

/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
/**
 * #2688: a fixed, EMPTY transcript root, so a test naming a real org label (`worker-4`, `worker-11`,
 * `reviewer-2456` -- all of which are real, reused role names on a shared host) never picks up an
 * unrelated live session's actual transcript and compacts on that account. A test ABOUT the compact check
 * overrides this with {@link transcriptRootFor}'s own directory.
 */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-2688-no-transcripts");
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) =>
  settlingDeliver(orders, agents, roster, { contextRoot: NO_TRANSCRIPTS, ...deps, sleep: noSettle });
const deliverHandoffs: typeof settlingDeliverHandoffs = (handoffs, agents, roster, deps) =>
  settlingDeliverHandoffs(handoffs, agents, roster, { contextRoot: NO_TRANSCRIPTS, ...deps, sleep: noSettle });
const clearThenPrompt: typeof settlingClearThenPrompt = (run, label, text, options) =>
  settlingClearThenPrompt(run, label, text, { contextRoot: NO_TRANSCRIPTS, ...options, sleep: noSettle });

/**
 * #2688: a transcript root with ONE file naming `label`, whose last (and only) turn read `cacheRead`
 * tokens -- the shape `claudeTurns` actually reads: the wake preamble's own words for {@link sessionOf} to
 * find, and one usage record for the figure itself. The caller removes the directory.
 */
function transcriptRootFor(label: string, cacheRead: number): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-2688-"));
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session in this repository.` } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ];
  writeFileSync(join(dir, "t.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

const PROMPT_SESSION = fileURLToPath(new URL("../prompt-session.mjs", import.meta.url));
const STUB_MODE = 0o755;
const STANDING = ["ceo", "product-manager", "orchestrator", "worker-tooling"];
const INSTANCES = ["worker-4", "worker-11", "reviewer-2456"];
const ROSTER = ["ceo", "product-manager", "orchestrator", "worker-capture", "worker-judge", "worker-tooling"];
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));

/** A `run` that records every herdr call. */
function recorder() {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return "{}"; },
    typed: () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt").map((c) => `${c[4]}: ${c[5]}`),
    cleared: () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt" && c[5] === "/clear").map((c) => c[4]) };
}
const order = (session: string) => ({ session, cause: "changes-requested", causeKey: `${session}/changes-requested/pr-2456/k`,
  prompt: "Your PR has a refusal to answer." });

// --- THE PREDICATE: ONE PLACE, THE TWO EXISTING READERS ---

test("#2483 the predicate: an instance by either reader is one; every standing seat is not (positive control inside)", () => {
  for (const label of INSTANCES) assert.equal(isPerRowInstance(label), true, `${label} is an instance`);
  for (const label of [...STANDING, "worker-capture", "worker-judge", "reviewer", "reviewer-2"]) {
    assert.equal(isPerRowInstance(label), false, `${label} is a standing seat (or the retired reviewer-2) and is cleared`);
  }
});

// --- PATH 1: `deliver` ---

test("#2483 deliver: an order to a spawned worker or a reviewer instance sends no /clear, and the line says so", () => {
  const r = recorder();
  const recorded: [string, boolean | undefined][] = [];
  const record = (key: string, _who?: string, noClear?: boolean) => recorded.push([key, noClear]);
  const got = deliver(INSTANCES.map(order), agents(INSTANCES), ROSTER, { run: r.run, record });
  assert.deepEqual(got.refused, [], `all delivered: ${JSON.stringify(got)}`);
  assert.deepEqual(recorded, INSTANCES.map((s) => [`${s}/changes-requested/pr-2456/k`, true]), "the ledger is told no clear was sent");
  assert.deepEqual(r.cleared(), [], "no /clear reached any instance");
  assert.equal(r.typed().length, INSTANCES.length, "and every order WAS typed, so the empty clear list is not an empty run");
  assert.deepEqual(got.sent, INSTANCES.map((s) => `${s} <- ${s}/changes-requested/pr-2456/k${NO_CLEAR_NOTE}`));
});

test("#2483 deliver CONTROL: ceo, product-manager, orchestrator and worker-tooling are still cleared, before their order", () => {
  const r = recorder();
  const recorded: (boolean | undefined)[] = [];
  const got = deliver(STANDING.map(order), agents(STANDING), ROSTER,
    { run: r.run, record: (_key: string, _who?: string, noClear?: boolean) => recorded.push(noClear) });
  assert.deepEqual(got.refused, []);
  assert.deepEqual(recorded, STANDING.map(() => false), "and the ledger is told a clear WAS sent");
  assert.deepEqual(r.cleared(), STANDING, "each was cleared");
  for (const label of STANDING) {
    const mine = r.typed().filter((t) => t.startsWith(`${label}: `));
    assert.equal(mine[0], `${label}: /clear`, `${label}: the clear is the FIRST thing typed`);
    assert.equal(mine.length, 2, `${label}: and the order follows it`);
  }
  assert.ok(got.sent.every((line) => !line.includes(NO_CLEAR_NOTE)), "a standing seat's line is not marked no-clear");
});

// A queued handoff to `reviewer-<n>` is not driven here: its causeKey (`handoff/<session>/<id>`) names no pull request,
// so `reviewerMismatch` refuses it before any clear question arises. That is a separate defect, filed on the row.
test("#2483 a queued handoff to a spawned worker is delivered without a clear; one to ceo is still cleared", () => {
  const now = 10 * 60 * 60 * 1000;
  const handoff = (session: string) =>
    [{ id: `handoff/${session}/0001`, session, prompt: "the check failed", queuedAt: now - 60_000 }];
  const inst = recorder();
  const out = deliverHandoffs(handoff("worker-4"), agents(["worker-4"]), ROSTER, { run: inst.run, now });
  assert.equal(out.ids.length, 1, "it landed");
  assert.deepEqual(inst.cleared(), []);
  assert.equal(inst.typed().length, 1);
  const ceo = recorder();
  assert.equal(deliverHandoffs(handoff("ceo"), agents(["ceo"]), ROSTER, { run: ceo.run, now }).ids.length, 1);
  assert.deepEqual(ceo.cleared(), ["ceo"], "the control: a standing seat's queued order is cleared");
});

// --- PATH 2: `clearThenPrompt`, which every `prompt:session` takes ---

test("#2483 clearThenPrompt: an instance gets its text and no /clear", () => {
  for (const label of INSTANCES) {
    const r = recorder();
    assert.equal(clearThenPrompt(r.run, label, "the check failed", { sender: "worker-5" }), null);
    assert.deepEqual(r.cleared(), [], `${label} was not cleared`);
    assert.equal(r.typed().length, 1, `${label}: the text was typed`);
  }
});

test("#2483 clearThenPrompt CONTROL: the standing seats are still cleared first", () => {
  for (const label of STANDING) {
    const r = recorder();
    assert.equal(clearThenPrompt(r.run, label, "a ruling", { sender: "worker-5" }), null);
    assert.deepEqual(r.cleared(), [label], `${label} was cleared`);
    assert.equal(r.typed()[0], `${label}: /clear`, `${label}: first`);
  }
});

test("#2483 clearBeforeOrder says whether a clear was sent, and passes a refusal through for a standing seat", () => {
  const r = recorder();
  assert.deepEqual(clearBeforeOrder(r.run, "reviewer-2456", noSettle, NO_TRANSCRIPTS), { sent: false, refusal: null });
  assert.deepEqual(r.calls, [], "an instance is not even asked, below #2688's threshold");
  const refusing = () => { throw new Error("no socket"); };
  const got = clearBeforeOrder(refusing, "orchestrator", noSettle, NO_TRANSCRIPTS);
  assert.equal(got.sent, true);
  assert.match(String(got.refusal), /orchestrator: \/clear refused/);
});

// --- THE CLI: what `prompt:session` prints, with a stub `herdr` ---

/** `prompt:session <label>` against a stub herdr that lists `label` idle and records every call. */
function cli(label: string) {
  const dir = mkdtempSync(join(tmpdir(), "no-clear-"));
  try {
    const log = join(dir, "calls");
    const herdr = join(dir, "herdr");
    const workspaces = JSON.stringify({ result: { workspaces: [{ label, agent_status: "idle" }] } });
    writeFileSync(herdr, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *"workspace list"*) echo '${workspaces}';; esac\n`);
    chmodSync(herdr, STUB_MODE);
    const res = spawnSync(process.execPath, [PROMPT_SESSION, label, "the check failed", "--ledger", join(dir, "ledger")], {
      encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
    });
    return { out: res.stdout, err: res.stderr, status: res.status,
      calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2483 prompt:session to a reviewer instance sends no /clear and does not claim one", () => {
  const got = cli("reviewer-2456");
  assert.equal(got.status, 0, `${got.err}`);
  assert.ok(got.calls.some((c) => c.includes("agent prompt reviewer-2456")), "the order was typed");
  assert.ok(!got.calls.some((c) => c.includes("/clear")), `no /clear: ${JSON.stringify(got.calls)}`);
  assert.match(got.out, /^PROMPTED reviewer-2456, context kept/);
  assert.ok(!got.out.includes("cleared context"), "the line no longer claims a clear it did not send");
});

// --- THE LEDGER: a no-clear line is a line older readers read the same ---

test("#2483 the ledger line records no-clear after the recipient, and the key and the dedupe are untouched", () => {
  const at = Date.now();
  const key = "worker-4/changes-requested/k";
  assert.equal(ledgerLine(at, key, undefined, true), `${at}\t${key}\t\tno-clear\n`);
  assert.equal(ledgerLine(at, key, "worker-9", true), `${at}\t${key}\tworker-9\tno-clear\n`);
  assert.equal(ledgerLine(at, key), `${at}\t${key}\n`, "the ordinary line is unchanged");
  assert.equal(ledgerKeyOf(`${key}\t\tno-clear`), key);
  const read = readLedger("x", (() => ledgerLine(at, key, undefined, true)) as never, at);
  assert.deepEqual([...read], [key], "the reader still counts it as one delivered cause");
});

// --- #2688: A PER-ROW INSTANCE OVER THRESHOLD IS `/compact`ED, NEVER `/clear`ED ---

test("#2688 instanceCacheRead: the live proxy read straight from the instance's own transcript, null when none names it", () => {
  const dir = transcriptRootFor("worker-11", 130_321);
  try {
    assert.equal(instanceCacheRead("worker-11", dir), 130_321);
    assert.equal(instanceCacheRead("worker-4", dir), null, "a different session's transcript says nothing about this one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(instanceCacheRead("worker-11", NO_TRANSCRIPTS), null, "no transcript at all is CANNOT TELL, never zero");
});

/** One transcript file naming `label`, reading `cacheRead`, written to `path` directly (no fresh temp dir). */
function writeTranscript(path: string, label: string, cacheRead: number): void {
  writeFileSync(path, `${[
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session in this repository.` } }),
    JSON.stringify({ message: { id: "m", model: "x", usage: { cache_read_input_tokens: cacheRead } } }),
  ].join("\n")}\n`);
}

test("#2688 instanceCacheRead: the MOST RECENTLY WRITTEN transcript naming this session wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-2688-multi-"));
  try {
    const older = join(dir, "a.jsonl");
    const newer = join(dir, "b.jsonl");
    writeTranscript(older, "worker-11", 500_000);
    writeTranscript(newer, "worker-11", 1_000);
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    assert.equal(instanceCacheRead("worker-11", dir), 1_000, "the newer, smaller figure wins over the older, larger one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2688 compactContext: submits /compact, waits, and reports a refusal the same way clearContext does", () => {
  const r = recorder();
  assert.equal(compactContext(r.run, "worker-11", noSettle), null);
  assert.deepEqual(r.typed(), ["worker-11: /compact"]);
  const refusing = () => { throw new Error("gone"); };
  assert.match(String(compactContext(refusing, "worker-11", noSettle)), /worker-11: \/compact refused \(gone\)/);
});

test("#2688 clearBeforeOrder: an instance over the threshold is sent /compact, never /clear", () => {
  const dir = transcriptRootFor("worker-11", COMPACT_THRESHOLD_TOKENS + 1);
  try {
    const r = recorder();
    assert.deepEqual(clearBeforeOrder(r.run, "worker-11", noSettle, dir), { sent: false, refusal: null });
    assert.deepEqual(r.typed(), ["worker-11: /compact"]);
    assert.deepEqual(r.cleared(), [], "never a /clear -- #2483 stands");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2688 clearBeforeOrder CONTROL: AT the threshold (not over it), and no transcript at all, sends nothing", () => {
  const dir = transcriptRootFor("worker-11", COMPACT_THRESHOLD_TOKENS);
  try {
    const r = recorder();
    assert.deepEqual(clearBeforeOrder(r.run, "worker-11", noSettle, dir), { sent: false, refusal: null });
    assert.deepEqual(r.calls, [], "AT the threshold is not OVER it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const r2 = recorder();
  assert.deepEqual(clearBeforeOrder(r2.run, "worker-11", noSettle, NO_TRANSCRIPTS), { sent: false, refusal: null });
  assert.deepEqual(r2.calls, [], "cannot tell is never assumed large enough to compact");
});

test("#2688 clearBeforeOrder passes a refused /compact through, and the caller still sends the order (mirrors #2483's clear refusal)", () => {
  const dir = transcriptRootFor("worker-11", COMPACT_THRESHOLD_TOKENS + 1);
  try {
    const refusing = () => { throw new Error("no socket"); };
    const got = clearBeforeOrder(refusing, "worker-11", noSettle, dir);
    assert.equal(got.sent, false);
    assert.match(String(got.refusal), /worker-11: \/compact refused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2688 deliver: an over-threshold instance is compacted before its order; a standing seat is untouched by the check", () => {
  const dir = transcriptRootFor("worker-11", COMPACT_THRESHOLD_TOKENS + 500);
  try {
    const r = recorder();
    const recorded: [string, boolean | undefined][] = [];
    const record = (key: string, _who?: string, noClear?: boolean) => recorded.push([key, noClear]);
    const got = deliver([order("worker-11")], agents(["worker-11"]), ROSTER, { run: r.run, record, contextRoot: dir });
    assert.deepEqual(got.refused, [], `delivered: ${JSON.stringify(got)}`);
    const mine = r.typed().filter((t) => t.startsWith("worker-11: "));
    assert.equal(mine[0], "worker-11: /compact", "compact is the FIRST thing typed");
    assert.equal(mine.length, 2, "and the order follows it");
    assert.deepEqual(r.cleared(), [], "never a /clear");
    assert.deepEqual(recorded, [["worker-11/changes-requested/pr-2456/k", true]], "still recorded no-clear, exactly as an untouched instance would be");
    assert.deepEqual(got.sent, [`worker-11 <- worker-11/changes-requested/pr-2456/k${NO_CLEAR_NOTE}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2688 clearThenPrompt: an over-threshold instance is compacted, not cleared, before its text", () => {
  const dir = transcriptRootFor("reviewer-2456", COMPACT_THRESHOLD_TOKENS + 1);
  try {
    const r = recorder();
    assert.equal(clearThenPrompt(r.run, "reviewer-2456", "the check failed", { sender: "worker-5", contextRoot: dir }), null);
    assert.deepEqual(r.cleared(), []);
    assert.equal(r.typed()[0], "reviewer-2456: /compact");
    assert.equal(r.typed().length, 2, "the compact, then the text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
