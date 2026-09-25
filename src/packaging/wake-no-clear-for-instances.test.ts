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
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, deliverHandoffs, isPerRowInstance, clearBeforeOrder, ledgerLine, ledgerKeyOf, readLedger,
  NO_CLEAR_NOTE } from "../wake.mjs";
import { clearThenPrompt } from "../prompt-session.mjs";

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
    assert.equal(clearThenPrompt(r.run, label, "the check failed", "worker-5"), null);
    assert.deepEqual(r.cleared(), [], `${label} was not cleared`);
    assert.equal(r.typed().length, 1, `${label}: the text was typed`);
  }
});

test("#2483 clearThenPrompt CONTROL: the standing seats are still cleared first", () => {
  for (const label of STANDING) {
    const r = recorder();
    assert.equal(clearThenPrompt(r.run, label, "a ruling", "worker-5"), null);
    assert.deepEqual(r.cleared(), [label], `${label} was cleared`);
    assert.equal(r.typed()[0], `${label}: /clear`, `${label}: first`);
  }
});

test("#2483 clearBeforeOrder says whether a clear was sent, and passes a refusal through for a standing seat", () => {
  const r = recorder();
  assert.deepEqual(clearBeforeOrder(r.run, "reviewer-2456"), { sent: false, refusal: null });
  assert.deepEqual(r.calls, [], "an instance is not even asked");
  const refusing = () => { throw new Error("no socket"); };
  const got = clearBeforeOrder(refusing, "orchestrator");
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
