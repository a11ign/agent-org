// no-token: clearContext -- every herdr call is the injected `run`; nothing here reaches gh or a real session
// A DIRECT DELIVERY LEAVES A RECORD (#2500).
//
// MEASURED 2026-09-25 on #2494: `worker-tooling` sent `reviewer-2` an order at 16:53:12Z on 2026-09-24 and
// the ledger had no line for it, because only the QUEUED path wrote one. `grep -c 2376` over the ledger
// gave 0, and 0 was read as "nobody prompted it". The record is a SEPARATE file: a line shaped like a
// queue entry would be read back by `readHandoffs` as an order still waiting and delivered again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptOrQueue as settlingPromptOrQueue, recordDirectDelivery, directRecordPath, DIRECT_RECORD_FILE, STANCE, EXIT,
  PROMPT_REFUSED_PREFIX } from "../prompt-session.mjs";
import { handoffQueuePath, readHandoffs, HANDOFF_QUEUE_FILE } from "../wake.mjs";
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const promptOrQueue: typeof settlingPromptOrQueue = (order) => settlingPromptOrQueue({ ...order, sleep: noSettle });


const agents = [{ label: "reviewer-2376", status: "idle" }, { label: "reviewer-2377", status: "working" },
  { label: "product-manager", status: "done" }];

const ORDER = "PR #2376 head is now b7fd42fe (was 4bacba26). Please re-review.";

/** A real directory holding the queue's parent, removed afterwards whatever `body` does. */
function inLedgerDir(body: (queue: string, direct: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "prompt-session-direct-"));
  try {
    const queue = handoffQueuePath(join(dir, "wake-ledger"));
    body(queue, directRecordPath(queue));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `body` with stdout and stderr captured, so a CLI-shaped function does not bury the suite's output. */
function quietly<T>(body: () => T): { value: T; err: string } {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let captured = "";
  const w = process as unknown as { stdout: { write: unknown }; stderr: { write: unknown } };
  w.stdout.write = () => true;
  w.stderr.write = (s: string) => { captured += s; return true; };
  try {
    return { value: body(), err: captured };
  } finally {
    w.stdout.write = out;
    w.stderr.write = err;
  }
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const accepting = () => "";
const refusingPrompt = (a: string[]) => {
  if (a[2] === "agent" && a[3] === "prompt" && !a.includes("/clear")) throw new Error("agent_blocked");
  return "";
};

test("the direct record sits BESIDE the queue, under its own name", () => {
  assert.notEqual(DIRECT_RECORD_FILE, HANDOFF_QUEUE_FILE);
  assert.equal(directRecordPath("/x/y/prompt-session-handoffs"), "/x/y/prompt-session-direct");
});

test("POSITIVE CONTROL: an idle target leaves exactly one direct line naming the sender and the order", () => {
  inLedgerDir((queue, direct) => {
    const { value } = quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2376", text: ORDER, agents,
      path: queue, stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(value, EXIT.OK);
    const written = lines(direct);
    assert.equal(written.length, 1, "one order, one line");
    const line = JSON.parse(written[0]);
    assert.deepEqual(Object.keys(line).sort(), ["cleared", "prompt", "sender", "sentAt", "session"]);
    assert.equal(line.session, "reviewer-2376");
    assert.equal(line.sender, "worker-tooling");
    assert.equal(line.prompt, ORDER);
    assert.equal(typeof line.sentAt, "number");
    assert.equal(line.cleared, false, "a per-row instance is never cleared (#2483)");
  });
});

test("a standing seat is recorded as CLEARED, and an unknown sender as null", () => {
  inLedgerDir((queue, direct) => {
    quietly(() => promptOrQueue({ run: accepting, label: "product-manager", text: ORDER, agents, path: queue,
      stance: STANCE.UNDECLARED, sender: null }));
    const line = JSON.parse(lines(direct)[0]);
    assert.equal(line.cleared, true);
    assert.equal(line.sender, null);
  });
});

test("the prompt is cut at 300 characters", () => {
  inLedgerDir((queue, direct) => {
    quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2376", text: "x".repeat(1000), agents,
      path: queue, stance: STANCE.UNDECLARED, sender: "a" }));
    assert.equal(JSON.parse(lines(direct)[0]).prompt.length, 300);
  });
});

test("a direct delivery leaves the QUEUE byte-identical, so the gate cannot deliver it again", () => {
  inLedgerDir((queue) => {
    const before = "";
    writeFileSync(queue, before);
    quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2376", text: ORDER, agents, path: queue,
      stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(readFileSync(queue, "utf8"), before);
    assert.deepEqual(readHandoffs(queue), []);
  });
  inLedgerDir((queue) => {
    quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2376", text: ORDER, agents, path: queue,
      stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(existsSync(queue), false, "and does not create one");
  });
});

test("TWIN CONTROL: a busy target queues the order and leaves NO direct line", () => {
  inLedgerDir((queue, direct) => {
    const { value } = quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2377", text: ORDER, agents,
      path: queue, stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(value, EXIT.QUEUED);
    assert.equal(readHandoffs(queue).length, 1, "the queue entry is the non-empty case");
    assert.deepEqual(lines(direct), []);
  });
});

test("TWIN CONTROL: a prompt refused at the last moment queues it and leaves NO direct line", () => {
  inLedgerDir((queue, direct) => {
    const { value } = quietly(() => promptOrQueue({ run: refusingPrompt, label: "reviewer-2376", text: ORDER, agents,
      path: queue, stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(value, EXIT.QUEUED);
    assert.equal(readHandoffs(queue).length, 1);
    assert.deepEqual(lines(direct), [], `no ${PROMPT_REFUSED_PREFIX.trim()} order is also a delivered one`);
  });
});

test("a failed append does not fail the delivery, and says so on stderr", () => {
  inLedgerDir((queue) => {
    // The ledger directory's would-be parent is a FILE, so `mkdir` fails for real, with no injected fault.
    const blocker = join(queue, "..", "blocker");
    writeFileSync(blocker, "");
    const path = join(blocker, "prompt-session-handoffs");
    const { value, err } = quietly(() => promptOrQueue({ run: accepting, label: "reviewer-2376", text: ORDER, agents,
      path, stance: STANCE.UNDECLARED, sender: "worker-tooling" }));
    assert.equal(value, EXIT.OK, "the order went, so it is not reported lost");
    assert.match(err, /WAS delivered, but its record could not be written to .*prompt-session-direct/);
    assert.match(err, /Do not send it again/);
  });
});

test("recordDirectDelivery reports whether it wrote", () => {
  inLedgerDir((queue) => {
    assert.equal(quietly(() => recordDirectDelivery(queue, { label: "reviewer-2376", text: ORDER,
      sender: "a", cleared: false })).value, true);
  });
});
