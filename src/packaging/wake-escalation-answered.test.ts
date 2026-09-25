// no-token: gh -- every `gh` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #2462: REMOVING `needs:chairman` IS AN ANSWER, and the gate must not undo it. Measured 2026-09-25: #2451, #2258 and
 * #2223 were re-labelled 26-28 s after a person removed the label, because the state after the removal (key at the cap,
 * cause still emitted) is the state before it, and `escalateStuck` read nothing that said it had already escalated.
 *
 * Its own file for #2280's reason (`wake.test.ts` reaches `gh`, so the token-less acceptance job refuses it). The
 * entry is driven through PATH stubs with a real ledger file, because a test that handed `escalateStuck` its memory
 * would pass with the writer deleted: what the tick WRITES is what the next tick READS.
 *
 * Every refusal has the same fixture with ONE thing changed as its control, so the test names what flipped the outcome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalateStuck, escalatedKeys, deliveryCounts, ledgerKeyOf, ESCALATED, RESET, MAX_DELIVERIES }
  from "../wake.mjs";

const WAKE_ENTRY = fileURLToPath(new URL("../wake.mjs", import.meta.url));
const STUB_MODE = 0o755;
const MINUTE = 60_000;
const DELIVERY_GAP = 20 * MINUTE;
const HOUR = 60 * MINUTE;
const MARKED_AT = 3 * HOUR;     // after the six deliveries have all been made
const RESET_AT = 4 * HOUR;
const SECOND_RUN_AT = 5 * HOUR;
const ROW_2451 = "issue edit 2451 --add-label needs:chairman";
const ROW_2223 = "issue edit 2223 --add-label needs:chairman";
const LONG_AGO = Date.UTC(2026, 8, 22, 0, 0, 0); // days before the tick, so the deliveries are past every TTL
const KEY = "worker-5/blocker-cleared/row-2451/2340";
const CHANGED_KEY = "worker-5/blocker-cleared/row-2451/2340.2341";
const RESET_KEY = "worker-13/blocker-cleared/row-2223/2247";
const order = (causeKey: string) => JSON.stringify({ session: "worker-5", cause: "blocker-cleared", causeKey,
  prompt: "the blocker on this row cleared" });
/** Six deliveries twenty minutes apart: the cap, reached the way the org reaches it. */
const sixDeliveries = (key: string, from = LONG_AGO) =>
  Array.from({ length: MAX_DELIVERIES }, (_, i) => `${from + i * DELIVERY_GAP}\t${key}\tworker-5\n`).join("");
const marker = (kind: string, key: string, at: number) => `${at}\t${kind}\t${key}\n`;

/** One tick of the real entry over `ledger`, and every `gh` argument line it issued. */
function tick(dir: string, orders: string[], { ghFails = false } = {}) {
  const ghLog = join(dir, "gh-calls");
  writeFileSync(ghLog, "");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf '%s' '{"result":{"workspaces":[]}}'\n`);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> '${ghLog}'\n${ghFails ? "echo refused >&2\nexit 1\n" : ""}`);
  for (const name of ["herdr", "gh"]) chmodSync(join(dir, name), STUB_MODE);
  const ran = spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`], {
    input: `${orders.join("\n")}\n`, encoding: "utf8",
    env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
  const labels = readFileSync(ghLog, "utf8").split("\n").filter((l) => l.includes("--add-label"));
  return { ran, labels, ledger: readFileSync(join(dir, "wake-ledger"), "utf8") };
}

function withLedger<T>(seed: string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wake-escalation-"));
  try {
    writeFileSync(join(dir, "wake-ledger"), seed);
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2462 THE NEGATIVE: a key escalated on tick 1 and unchanged on tick 2 is NOT labelled again", () => {
  withLedger(sixDeliveries(KEY), (dir) => {
    const first = tick(dir, [order(KEY)]);
    // The control, inside the same fixture: the key at the cap with no mark DOES escalate, so tick 2's silence below
    // is the mark and not a gate that never labels.
    assert.deepEqual(first.labels, [ROW_2451], first.ran.stderr);
    assert.match(first.ledger, new RegExp(`\\t${ESCALATED}\\t${KEY.replaceAll("/", "\\/")}\\n`),
      "the escalation is written down where the next tick reads it");
    // Between the ticks a person removes the label. The gate never reads labels, and the stub shows none.
    const second = tick(dir, [order(KEY)]);
    assert.deepEqual(second.labels, [], `the removal was an answer, and the gate re-labelled: ${second.ran.stderr}`);
    assert.match(second.ran.stderr, /ALREADY ESCALATED #2451/, "the skip is said, not silent");
    const third = tick(dir, [order(KEY)]);
    assert.deepEqual(third.labels, [], "and it stays off tick after tick, not merely once");
  });
});

test("#2462 POSITIVE: a CHANGED key at the cap escalates, on the same row as an escalated one", () => {
  const seed = sixDeliveries(KEY) + marker(ESCALATED, KEY, LONG_AGO + MARKED_AT) + sixDeliveries(CHANGED_KEY, LONG_AGO + MINUTE);
  withLedger(seed, (dir) => {
    const { ran, labels } = tick(dir, [order(KEY), order(CHANGED_KEY)]);
    assert.deepEqual(labels, [ROW_2451], ran.stderr);
    assert.match(ran.stderr, new RegExp(`ALREADY ESCALATED #2451 \\(${KEY}\\)`), "the old key is the one held back");
    assert.match(ran.stderr, /ESCALATED #2451 -> needs:chairman/, "the changed key is the one that went");
  });
});

test("#2462 POSITIVE: the SAME key escalates again after a RESET, which is what ends a run", () => {
  const seed = sixDeliveries(RESET_KEY) + marker(ESCALATED, RESET_KEY, LONG_AGO + MARKED_AT)
    + marker(RESET, RESET_KEY, LONG_AGO + RESET_AT) + sixDeliveries(RESET_KEY, LONG_AGO + SECOND_RUN_AT);
  withLedger(seed, (dir) => {
    const reset = tick(dir, [order(RESET_KEY)]);
    assert.deepEqual(reset.labels, [ROW_2223], reset.ran.stderr);
  });
  // The control for it: the ledger up to the mark, WITHOUT the RESET and the second run, is held back, so the RESET
  // is what flipped it.
  withLedger(sixDeliveries(RESET_KEY) + marker(ESCALATED, RESET_KEY, LONG_AGO + MARKED_AT), (dir) => {
    assert.deepEqual(tick(dir, [order(RESET_KEY)]).labels, [], "no RESET, no new run: held back");
  });
});

test("#2462 a `gh` refusal is NOT recorded, so the next tick tries again (the alarm may not fail silently)", () => {
  withLedger(sixDeliveries(KEY), (dir) => {
    const refused = tick(dir, [order(KEY)], { ghFails: true });
    assert.match(refused.ran.stderr, /COULD NOT ESCALATE #2451/, refused.ran.stderr);
    assert.ok(!refused.ledger.includes(ESCALATED), "nothing was labelled, so nothing is marked escalated");
    assert.deepEqual(tick(dir, [order(KEY)]).labels, [ROW_2451]);
  });
});

test("#2462 a ledger that cannot record the escalation says so, and the label still went", () => {
  const log: string[] = [];
  const ran: string[][] = [];
  const labelled = escalateStuck([`${KEY}: delivered 6 times`], (args) => { ran.push(args); return ""; },
    (l) => log.push(l), { record: () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } });
  assert.deepEqual(labelled, [2451]);
  assert.match(log.join(""), /COULD NOT RECORD the escalation of #2451, so the next tick labels it again: ENOSPC/);
  assert.ok(ran.length === 1, "the label was applied once");
});

test("#2462 the marker is a marker: it is not a delivery, and it does not count toward the cap or the dedupe", () => {
  const seed = sixDeliveries(KEY) + marker(ESCALATED, KEY, LONG_AGO + MARKED_AT);
  const read = () => seed;
  assert.equal(ledgerKeyOf(`${ESCALATED}\t${KEY}`), `${ESCALATED}\t${KEY}`);
  assert.equal(deliveryCounts("p", read).get(KEY), MAX_DELIVERIES, "an alarm does not add a seventh delivery");
  assert.ok(![...deliveryCounts("p", read).keys()].some((k) => k.startsWith(ESCALATED)), "and is not a key of its own");
  assert.deepEqual([...escalatedKeys("p", read)], [KEY]);
  assert.deepEqual([...escalatedKeys("p", () => seed + marker(RESET, KEY, LONG_AGO + RESET_AT))], [],
    "a RESET after the mark ends the run and clears it");
  assert.equal(escalatedKeys(join(tmpdir(), "no-such-wake-ledger-2462")).size, 0,
    "a missing ledger is an empty memory, not an error");
});

test("#2462 a delivery after the mark means the run began again, so the mark does not outlive its run", () => {
  const seed = sixDeliveries(KEY) + marker(ESCALATED, KEY, LONG_AGO + MARKED_AT) + `${LONG_AGO + RESET_AT}\t${KEY}\n`;
  assert.deepEqual([...escalatedKeys("p", () => seed)], []);
});

test("#2462 the writer appends the exact line the reader clears", () => {
  withLedger("", (dir) => {
    const ledger = join(dir, "wake-ledger");
    appendFileSync(ledger, marker(ESCALATED, KEY, 1));
    assert.deepEqual([...escalatedKeys(ledger)], [KEY]);
    appendFileSync(ledger, marker(RESET, KEY, 2));
    assert.deepEqual([...escalatedKeys(ledger)], []);
  });
});
