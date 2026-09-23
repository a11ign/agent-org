// THE CLEAR THAT THE DOCUMENTED PATH SKIPPED.
//
// `wake.mjs` clears a session before every order the gate delivers -- 690k -> 37k input tokens on a real
// session. But `agent-practices.md` told the AUTHOR of a draft to prompt the parity reviewer with a raw
// `herdr --session org agent prompt`, which never passes through `wake.mjs` and therefore never clears.
//
// MEASURED 2026-09-19 on a real `reviewer` transcript: six reviews in one unbroken session -- #1765,
// #1767, #1769, #1771, #1775, #1777 -- of which only #1765 arrived through the gate. 2.29M cached input
// tokens carried, at least one auto-compact. Five of the six prompts were the documented path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptable, clearThenPrompt, queueable, queueOrLose, queueDepthNote, EXIT }
  from "../prompt-session.mjs";
import { readHandoffs } from "../wake.mjs";

const agents = [{ label: "reviewer", status: "idle" }, { label: "reviewer-2", status: "working" },
  { label: "ceo", status: "done" }, { label: "worker-judge", status: "blocked" }];

/**
 * Run `body` with stderr captured, and hand back what it wrote.
 *
 * `queueOrLose` reports on stderr by design -- it is a CLI's refusal path -- and a test that let it
 * through would bury the suite's own output in the very messages it is asserting about.
 */
function withStderr<T>(body: () => T): { value: T; err: string } {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    err += s; return true;
  };
  try {
    return { value: body(), err };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

/** A real directory, removed afterwards whatever `body` does. */
function inTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "prompt-session-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("only a session between tasks may be prompted", () => {
  assert.equal(promptable("reviewer", agents), null, "idle is between tasks");
  assert.equal(promptable("ceo", agents), null, "and so is done");
});

test("a WORKING session is refused, because a prompt types into a live turn", () => {
  // This is `wake`'s rule, applied to the path that bypassed `wake`. `agent prompt` submits text into a
  // terminal; sending to an agent mid-turn interleaves with whatever it is doing.
  assert.match(String(promptable("reviewer-2", agents)), /is working.*idle or done/s);
  assert.match(String(promptable("worker-judge", agents)), /is blocked/,
    "blocked is herdr's own refusal, not a state that becomes promptable by being typed at");
});

test("an unknown session names what herdr does know, rather than failing blind", () => {
  assert.match(String(promptable("reviewr", agents)), /no session named "reviewr"/);
  assert.match(String(promptable("reviewr", agents)), /reviewer, reviewer-2, ceo, worker-judge/);
});

test("a refused agent read is refused, never treated as an empty roster", () => {
  // `null` is "could not ask", which is not "there are no sessions". Typing blind is the failure this
  // avoids -- an empty list would otherwise read as "no such session" and hide the real cause.
  assert.match(String(promptable("reviewer", null)), /could not ask herdr/);
});

test("THE CLEAR COMES FIRST, and the order of the two calls is the whole point", () => {
  const calls: string[][] = [];
  assert.equal(clearThenPrompt((a: string[]) => { calls.push(a); return ""; }, "reviewer", "Draft #1 …"),
    null);
  const verbs = calls.map((a) => a.slice(2).join(" "));
  assert.equal(verbs[0], "agent prompt reviewer /clear", "the clear must be the FIRST thing sent");
  assert.equal(verbs.at(-1), "agent prompt reviewer Draft #1 …", "and the order the last");
  assert.ok(verbs.some((v) => v.startsWith("agent wait")), "with the settle between them");
});

test("a refused CLEAR still delivers the prompt, and says so", () => {
  // `clearContext`'s own rule, inherited deliberately: expensive is strictly better than undelivered.
  // A session whose clear failed still gets its order -- on a bloated context, reported rather than
  // swallowed.
  let sent = false;
  const run = (a: string[]) => {
    if (a.includes("/clear")) throw new Error("no socket");
    if (a.includes("Draft #2")) sent = true;
    return "";
  };
  assert.match(String(clearThenPrompt(run, "reviewer", "Draft #2")), /clear refused/);
  assert.equal(sent, true, "the prompt went anyway -- a refused clear is not a refused wake");
});

test("a refused PROMPT is reported, never reported as delivered", () => {
  const run = (a: string[]) => {
    if (a.includes("/clear")) return "";
    if (a[2] === "agent" && a[3] === "prompt") throw new Error("agent_blocked");
    return "";
  };
  assert.match(String(clearThenPrompt(run, "reviewer", "Draft #3")), /prompt refused: agent_blocked/);
});

test("the exit codes distinguish a LOST order from a QUEUED one", () => {
  // A caller scripting this needs to tell "send it again" from "the gate has it". `2` kept its number
  // and changed its meaning (#1966): it was `NOT_WAKEABLE`, which ended the order, and is now `QUEUED`,
  // which defers it. `1` is the only code that means somebody has to do something.
  assert.deepEqual(EXIT, { OK: 0, REFUSED: 1, QUEUED: 2 });
});

// ---------------------------------------------------------------------------------------------------
// THE REFUSAL PATH IS A WRITE (#1966).
//
// Measured 2026-09-22 filing draft #1963: `npm run prompt:session -- reviewer` refused three times in
// 4m37s -- `"reviewer" is working` -- and the order existed nowhere but the author's terminal. The rule
// in `.claude/rules/agent-practices.md` says to run it once; running it once left a draft nobody had
// been told about, while the author believed they had told someone.
//
// So these do not assert a message. They assert that the FILE THE NEXT TICK READS has the order in it:
// a `prompt-session.mjs` that goes back to printing `NOT PROMPTED` and exiting fails every one.

test("A REFUSED PROMPT IS WRITTEN TO THE QUEUE, and the file is the one wake reads", () => {
  inTempDir((dir) => {
    const path = join(dir, "nested", "prompt-session-handoffs");
    const { value, err } = withStderr(() => queueOrLose({
      label: "reviewer", text: "Draft #1963 (odd) is ready for review.",
      why: '"reviewer" is working', agents, path,
    }));

    assert.equal(value, EXIT.QUEUED, "a busy session is a deferral, not a failure");
    // THE POSITIVE CONTROL for every `deepEqual(..., [])` below: this is the population being non-empty.
    // It is also the whole assertion the row asks for -- the order is on disk, in a file this process
    // did not previously have a directory for.
    const queued = readHandoffs(path);
    assert.equal(queued.length, 1, "the order the author wrote is in the queue");
    assert.equal(queued[0].session, "reviewer");
    assert.equal(queued[0].prompt, "Draft #1963 (odd) is ready for review.",
      "byte-for-byte what the author typed -- the reviewer is going to read this");
    assert.ok(Number.isFinite(queued[0].queuedAt), "with the time it started waiting");
    assert.match(err, /QUEUED handoff\/reviewer\//, "and the author is told which order was kept");
    assert.match(err, /DO NOT RETRY/,
      "because this command clears its target: a retry that wins the race wipes a review in progress");
  });
});

test("the same order queued twice is ONE order, not two prompts for one draft", () => {
  // An author who runs the command again because the first printed a refusal must not cause the reviewer
  // to be cleared and prompted twice. `handoffId` is derived from the target and the text for exactly
  // this, and `readHandoffs` collapses on it.
  inTempDir((dir) => {
    const path = join(dir, "q");
    const send = () => withStderr(() => queueOrLose({
      label: "reviewer", text: "Draft #1963 (odd)", why: "is working", agents, path,
    }));
    send();
    send();
    assert.equal(readHandoffs(path).length, 1);
  });
});

test("a session the org does not know is NOT queued -- nothing would ever deliver it", () => {
  // The queue's whole value is that it delivers with nobody watching, which is why a typo must never
  // reach it: `"reviewr"` is not a session that will be free later. The author is still at the terminal
  // and can fix it in one second; two hours from now nobody is.
  inTempDir((dir) => {
    const path = join(dir, "q");
    const { value, err } = withStderr(() => queueOrLose({
      label: "reviewr", text: "Draft #1963", why: 'no session named "reviewr"', agents, path,
    }));
    assert.equal(value, EXIT.REFUSED);
    assert.equal(existsSync(path), false, "and no file was created to hold it");
    assert.match(err, /NOT QUEUED/);
    assert.match(err, /author error/);
  });
});

test("a queue that cannot be written says the order is LOST, and exits so", () => {
  // The one case where the order really does end here. Silence would be the original defect exactly.
  inTempDir((dir) => {
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const { value, err } = withStderr(() => queueOrLose({
      label: "reviewer", text: "Draft #1963", why: "is working", agents,
      path: join(blocker, "q"),
    }));
    assert.equal(value, EXIT.REFUSED, "never QUEUED -- nothing holds this order");
    assert.match(err, /THIS ORDER IS LOST/);
  });
});

test("a failed ROSTER READ queues, because 'could not ask' is not 'no such session'", () => {
  assert.equal(queueable("reviewer", null), true,
    "herdr not answering says nothing about whether reviewer exists; the next tick can ask again");
  assert.equal(queueable("reviewer-2", agents), true, "busy now, free later");
  assert.equal(queueable("worker-judge", agents), true,
    "blocked is a state a human clears -- the order should be waiting when they do");
  assert.equal(queueable("reviewr", agents), false, "a name herdr does know it does not have");
});

// ---------------------------------------------------------------------------------------------------
// WHAT THE AUTHOR IS TOLD ABOUT THE QUEUE THEY JUST JOINED (#2102).
//
// `QUEUED <id>` is true and says nothing about whether anyone will ever read it. On 2026-09-23 that line
// was printed to fifty-seven successive authors, each correctly told their order was held, none told it
// was fifty-seventh in a queue whose oldest entry had waited ten hours -- among them a `ceo` ruling and a
// STOP-THE-LINE. The tick reports the backlog to the org; this reports it to the only person who can
// still choose to put the thing on the row instead.

test("A DEEP QUEUE IS SAID TO THE AUTHOR, with the count and the oldest wait", () => {
  inTempDir((dir) => {
    const path = join(dir, "q");
    // Nine earlier orders for the same target, the oldest ten hours old: the 2026-09-23 shape, smaller.
    const now = Date.now();
    writeFileSync(path, Array.from({ length: 9 }, (_, i) => JSON.stringify({
      id: `handoff/product-manager/${i}`, session: "product-manager", prompt: `report ${i}`,
      queuedAt: now - (10 - i) * 60 * 60_000,
    })).join("\n") + "\n");

    const { value, err } = withStderr(() => queueOrLose({
      label: "product-manager", text: "completion report on #2102", why: "is working",
      agents: [{ label: "product-manager", status: "working" }], path,
    }));

    assert.equal(value, EXIT.QUEUED, "the order is still queued -- this note changes no outcome");
    assert.equal(readHandoffs(path).length, 10, "the positive control: it really is on disk, tenth");
    assert.match(err, /QUEUE DEPTH: this is order 10 waiting for "product-manager"/);
    assert.match(err, /oldest has waited 10\.0h/);
    assert.match(err, /put it on the row where the org can see it/,
      "and it names the mechanism that does not depend on the target ever being idle");
  });
});

test("THE CONTROL: the FIRST order for a session gets no depth note", () => {
  // Without this, the note prints on every queued order and is noise on the case #1966 was built for --
  // one author, one reviewer, one draft, delivered on the next tick.
  inTempDir((dir) => {
    const path = join(dir, "q");
    const { err } = withStderr(() => queueOrLose({
      label: "reviewer", text: "Draft #1963 (odd)", why: "is working",
      agents: [{ label: "reviewer", status: "working" }], path,
    }));
    assert.equal(readHandoffs(path).length, 1, "the control: one order, which is the ordinary case");
    assert.match(err, /QUEUED handoff\/reviewer\//, "still told their order is held");
    assert.doesNotMatch(err, /QUEUE DEPTH/);
  });
});

test("a queue that cannot be read back is a DIAGNOSTIC, never a lost order", () => {
  // The order is on disk by the time this runs, so the exit code is settled -- and `readHandoffs` throws
  // on a malformed line by design. Letting that throw would turn a queued order into a crash and send
  // the author back to retrying, which is the one thing this command tells them not to do.
  assert.match(queueDepthNote("reviewer", "/dev/null/nope/q"), /could not read/);
  assert.match(queueDepthNote("reviewer", "/dev/null/nope/q"), /Your order is written; this note is not/);
  inTempDir((dir) => {
    const path = join(dir, "q");
    writeFileSync(path, '{"session":"reviewer"}\n');
    assert.match(queueDepthNote("reviewer", path), /could not read/,
      "a malformed line is reported here and thrown by the tick, where it costs only its own orders");
  });
});
