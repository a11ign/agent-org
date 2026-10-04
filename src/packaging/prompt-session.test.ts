// no-token: clearContext -- every herdr call is the injected `run`; nothing here reaches gh or a real session
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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptable, clearThenPrompt as settlingClearThenPrompt, queueable, queueOrLose, queueDepthNote, queueDepth,
  deepQueueRefusal, DEEP_QUEUE, NEEDS_DECISION_FLAG, EXIT, senderName, resolveSender, attributed,
  deliveredText }
  from "../prompt-session.mjs";
import { readHandoffs, handoffOrder, addressed } from "../wake.mjs";

import { readLoadedRules } from "./rules-files.ts";
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const clearThenPrompt: typeof settlingClearThenPrompt = (run, label, text, options) =>
  settlingClearThenPrompt(run, label, text, { ...options, sleep: noSettle });


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
  assert.equal(clearThenPrompt((a: string[]) => { calls.push(a); return ""; }, "reviewer", "Draft #1 …",
    { sender: "worker-5" }), null);
  const verbs = calls.map((a) => a.slice(2).join(" "));
  assert.equal(verbs[0], "agent prompt reviewer /clear", "the clear must be the FIRST thing sent");
  assert.equal(verbs.at(-1), `agent prompt reviewer ${deliveredText("reviewer", "Draft #1 …", "worker-5")}`,
    "and the order the last");
  assert.ok(verbs.some((v) => v.startsWith("agent wait")), "with the settle between them");
});

test("a refused CLEAR still delivers the prompt, and says so", () => {
  // `clearContext`'s own rule, inherited deliberately: expensive is strictly better than undelivered.
  // A session whose clear failed still gets its order -- on a bloated context, reported rather than
  // swallowed.
  let sent = false;
  const run = (a: string[]) => {
    if (a.includes("/clear")) throw new Error("no socket");
    if (a.some((x) => x.includes("Draft #2"))) sent = true;
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
    assert.equal(queued[0].prompt, attributed("Draft #1963 (odd) is ready for review.", null),
      "what the author typed, byte-for-byte, behind the line saying who asked (#2344)");
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

// ---------------------------------------------------------------------------------------------------
// A REPORT THAT NEEDS NO DECISION IS A ROW WRITE, NOT AN ORDER (#2167).
//
// Read on the agent host 2026-09-23T15:03Z: 60 pending orders, 55 of them for `product-manager`, the
// oldest about eight hours old, and every other session at 2 or fewer. That is not a `wake` defect --
// delivery clears its target first, so delivering faster wipes work in progress (#912/#1966) -- it is a
// routing consequence, because `ceo`'s 2026-09-14 rule makes one session the first reader for rows,
// claims, completions and close-outs, and that session is the one that is never between tasks.
//
// #2102 already told the author what they were joining, AND THE QUEUE STILL REACHED 60. A note at the
// end of a command that has already succeeded is advice; this moves the same fact in front of the write,
// where it decides. BOTH DIRECTIONS ARE PINNED BELOW, and the second is not a formality: without it this
// is a mute button on the one inbox that must never be muted.

/** A queue of `n` orders for `session`, the oldest `oldestHours` old. The 2026-09-23 shape, resized. */
function queueOf(path: string, session: string, n: number, oldestHours: number): void {
  const now = Date.now();
  writeFileSync(path, Array.from({ length: n }, (_unused, i) => JSON.stringify({
    id: `handoff/${session}/${i}`, session, prompt: `report ${i}`,
    queuedAt: now - (oldestHours - (i * oldestHours) / n) * 60 * 60_000,
  })).join("\n") + "\n");
}

test("AT THE THRESHOLD the order is REFUSED, and the refusal names depth, oldest wait and the remedy", () => {
  inTempDir((dir) => {
    const path = join(dir, "q");
    queueOf(path, "product-manager", DEEP_QUEUE, 8);

    const { value, err } = withStderr(() => queueOrLose({
      label: "product-manager", text: "Merged #2158; row closed out.", why: "is working",
      agents: [{ label: "product-manager", status: "working" }], path,
    }));

    assert.equal(value, EXIT.REFUSED, "non-zero -- nothing holds this order, and the author must act");
    assert.match(err, /already has 10 order\(s\) waiting/, "the DEPTH, as the row asks");
    assert.match(err, /oldest has waited 8\.0h/, "the OLDEST PENDING AGE, as the row asks");
    assert.match(err, /WRITE IT ON THE ROW/, "the REMEDY, as the row asks");
    assert.match(err, /--needs-decision/, "and the declaration that gets past it");
    // IT NEVER QUEUES BEHIND THE PILE IT IS REFUSING TO JOIN. The row says so in those words, and this
    // is the assertion: the file it was refused for is exactly as deep as it was.
    assert.equal(readHandoffs(path).length, DEEP_QUEUE, "the refused order was NOT appended");
    assert.equal(readHandoffs(path).some((h) => h.prompt.includes("2158")), false);
  });
});

test("AND THE REFUSAL DOES NOT SWALLOW THE REPORT -- the text comes back, because stdin holds no copy", () => {
  // `main` reads the order from stdin by default, so a refusal that printed only the depth would destroy
  // the only copy of a report an author had piped in. The row's own words: it never silently drops.
  inTempDir((dir) => {
    const path = join(dir, "q");
    queueOf(path, "product-manager", DEEP_QUEUE + 5, 3);
    const text = "Claimed #2167 on branch agent/queue-depth-refusal-2167.";
    const { err } = withStderr(() => queueOrLose({
      label: "product-manager", text, why: "is working",
      agents: [{ label: "product-manager", status: "working" }], path,
    }));
    assert.ok(err.includes(text), "the report is printed back verbatim, for the author to paste on the row");
  });
});

test("THE SECOND DIRECTION: an order DECLARING a decision still queues at the same depth", () => {
  // WITHOUT THIS TEST THIS CHANGE IS A MUTE BUTTON. A ruling, a stop-the-line, a question whose answer
  // changes what somebody does next are the orders a deep queue makes MORE urgent, not less.
  inTempDir((dir) => {
    const path = join(dir, "q");
    queueOf(path, "product-manager", DEEP_QUEUE, 8);

    const { value, err } = withStderr(() => queueOrLose({
      label: "product-manager", text: "STOP THE LINE: main is red at 60e8784ce.", why: "is working",
      agents: [{ label: "product-manager", status: "working" }], path, stance: "decision",
    }));

    assert.equal(value, EXIT.QUEUED, "declared a decision -- it is held, not refused");
    const queued = readHandoffs(path);
    assert.equal(queued.length, DEEP_QUEUE + 1, "and it is ON DISK, which is the assertion that matters");
    assert.equal(queued.at(-1)?.prompt, attributed("STOP THE LINE: main is red at 60e8784ce.", null));
    assert.match(err, /QUEUE DEPTH: this is order 11/,
      "still told what it joined -- the declaration buys a place in the queue, not silence about it");
  });
});

test("ONE ORDER BELOW THE THRESHOLD still queues, so the boundary is pinned on both sides", () => {
  // The refusal fires at DEEP_QUEUE, not near it. An off-by-one here is the difference between a rule
  // and a rule that also refuses the ninth report anybody ever sends.
  inTempDir((dir) => {
    const path = join(dir, "q");
    queueOf(path, "product-manager", DEEP_QUEUE - 1, 8);
    const { value, err } = withStderr(() => queueOrLose({
      label: "product-manager", text: "completion report", why: "is working",
      agents: [{ label: "product-manager", status: "working" }], path,
    }));
    assert.equal(value, EXIT.QUEUED);
    assert.equal(readHandoffs(path).length, DEEP_QUEUE, "the positive control: it really was appended");
    assert.doesNotMatch(err, /NOT PROMPTED, AND NOT QUEUED/);
    assert.match(err, /QUEUE DEPTH: this is order 10/, "#2102's note is what a queue under the bar gets");
  });
});

test("the threshold decision is PURE, and it is the measurement that picked 10", () => {
  // Pinned as a function of the two inputs, away from the filesystem, so the boundary is readable. 10 is
  // the row's starting point and this file is where it is pinned: every other session's queue on
  // 2026-09-23 was 2 or fewer, and the stalled one was 55.
  assert.equal(DEEP_QUEUE, 10);
  const order = { label: "product-manager", text: "report", decision: false };
  const at = (waiting: number) => ({ session: "product-manager", waiting, oldestMs: 8 * 3_600_000, stale: waiting });
  assert.equal(deepQueueRefusal(at(DEEP_QUEUE - 1), order), null, "under the bar queues");
  assert.ok(deepQueueRefusal(at(DEEP_QUEUE), order), "at the bar refuses");
  assert.ok(deepQueueRefusal(at(DEEP_QUEUE + 45), order), "and above it");
  assert.equal(deepQueueRefusal(at(DEEP_QUEUE + 45), { ...order, decision: true }), null,
    "and a declared decision is never refused, at any depth");
  assert.equal(deepQueueRefusal(undefined, order), null,
    "a target with nothing waiting is not in the backlog at all, and must not read as deep");
});

test("A DEPTH THAT CANNOT BE READ NEVER REFUSES -- 'could not ask' is not 'too deep'", () => {
  // The same judgement `queueable(label, null)` makes one refusal earlier: an order is not destroyed
  // because a file could not be parsed. `queueDepth` hands the failure back rather than throwing, and
  // this is the assertion that the refusal path treats it as no-depth.
  inTempDir((dir) => {
    const path = join(dir, "q");
    writeFileSync(path, '{"session":"product-manager"}\n');
    const { mine, unreadable } = queueDepth("product-manager", path);
    assert.equal(mine, undefined);
    assert.match(String(unreadable), /missing id\/session\/prompt/, "the cause is carried, not swallowed");
    assert.equal(deepQueueRefusal(mine, { label: "product-manager", text: "r", decision: false }), null,
      "an unmeasurable queue must not refuse an order");
  });
  // AND THE CONTROL: a queue that CAN be read reports a depth, so the line above is not vacuous.
  inTempDir((dir) => {
    const path = join(dir, "q");
    queueOf(path, "product-manager", 3, 1);
    const { mine, unreadable } = queueDepth("product-manager", path);
    assert.equal(unreadable, undefined);
    assert.equal(mine?.waiting, 3);
  });
});

test("the flag the rules file tells an author to type is the flag this command accepts", () => {
  // A refusal that names a flag `refuseUnknownFlags` would reject is a refusal nobody can act on -- the
  // same shape as a refusal quoting a rule nobody wrote, which is why the row asks for both halves.
  assert.equal(NEEDS_DECISION_FLAG, "--needs-decision");
  const source = readFileSync(
    new URL("../prompt-session.mjs", import.meta.url), "utf8");
  assert.match(source,
    /refuseUnknownFlags\(\["--ledger", DECISION_FLAG, FYI_FLAG, NEEDS_DECISION_FLAG\]/,
    "the flag is declared to the unknown-flag guard, or typing it is refused before it is read");
  const rules = readLoadedRules();
  assert.ok(rules.includes(NEEDS_DECISION_FLAG),
    "and the loaded rules name it, so the refusal quotes a rule that exists");
  assert.ok(rules.includes("ROW WRITE"), "with the routing change itself stated, not just its flag");
});

test("the loaded rules are the host project's, and an absent or empty rule set is refused rather than read as \"\"", () => {
  // The positive control for the two assertions above and for worker-profile.test.ts's PRACTICES: a reader that
  // returned "" for a missing directory would fail them with a message about wording, and pass any "does not say".
  assert.ok(readLoadedRules().length > 0, "the host project's rules directory is found and not empty");
  inTempDir((dir) => {
    assert.throws(() => readLoadedRules(dir), /no rules files under/, "an empty directory is refused");
    assert.throws(() => readLoadedRules(join(dir, "absent")), /ENOENT/, "a missing directory is refused");
  });
});

// ---------------------------------------------------------------------------------------------------
// THE CLEARED SESSION WAKES KNOWING WHO IT IS AND WHO ASKED (#2344).
//
// `prompt:session` clears its target and used to type the sender's raw text at it, so `ceo`, cleared at
// 2026-09-24T12:22:50Z, woke nameless. The wake path wraps every order in `addressed`; this path now
// does too, through the same function.

const workspaces = [{ workspace_id: "w3", label: "worker-5" }, { workspace_id: "w1", label: "ceo" },
  { workspace_id: "w7", label: "" }];

/** What the cleared session was actually typed, as its FIRST (and only) prompt after the clear. */
function firstMessage(label: string, text: string, sender: string | null): string {
  const prompts: string[] = [];
  const run = (a: string[]) => {
    if (a[2] === "agent" && a[3] === "prompt" && a[5] !== "/clear") prompts.push(a[5]);
    return "";
  };
  assert.equal(clearThenPrompt(run, label, text, { sender }), null);
  assert.equal(prompts.length, 1, "the positive control: exactly one prompt reached the session");
  return prompts[0];
}

test("THE FIRST MESSAGE says who the session is and who asked, the asker resolved from the workspace id", () => {
  const sender = senderName(workspaces, "w3");
  assert.equal(sender, "worker-5");
  const got = firstMessage("reviewer", "Draft #9 (odd) is ready.", sender);
  assert.match(got, /^You are `reviewer`, an org session in this repository\./, "its own label, first");
  assert.match(got, /Sent to you by `worker-5`/, "and who asked");
  assert.ok(got.includes("Draft #9 (odd) is ready."), "and the order itself");
});

test("THE TEXT IS `addressed`'s OWN OUTPUT -- the one function, compared, not a copy", () => {
  const got = firstMessage("reviewer", "Draft #9", "worker-5");
  assert.equal(got, addressed({ session: "reviewer", prompt: attributed("Draft #9", "worker-5") }, "reviewer"));
});

test("there is ONE copy of the autonomy footer in the agent-org sources (with its positive control)", () => {
  const sentence = "ENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING";
  const dir = new URL("../", import.meta.url);
  const holders = readdirSync(dir).filter((f) => f.endsWith(".mjs"))
    .filter((f) => readFileSync(new URL(f, dir), "utf8").includes(sentence));
  assert.deepEqual(holders, ["wake.mjs"],
    "the control: wake.mjs holds it, so an empty result would mean the scan is blind, not that it is unique");
});

test("BOTH DIRECTIONS: a caller the roster does not list is named unknown, never another session, and is delivered", () => {
  for (const [id, why] of [["w99", "an id herdr does not list"], [undefined, "no workspace id at all"],
    ["w7", "a listed id with no label"]] as const) {
    const sender = senderName(workspaces, id);
    assert.equal(sender, null, why);
    const got = firstMessage("reviewer", "Draft #9", sender);
    assert.match(got, /could not identify/, `${why}: named as unknown`);
    assert.ok(!/worker-5|`ceo`, through/.test(got.split("Draft #9")[0].split("could not identify")[1]),
      "and not given another session's name");
    assert.ok(got.includes("Draft #9"), "the order was still delivered");
  }
});

test("the sender is resolved from herdr's workspace list, and a failed read is unknown, not a failure", () => {
  const list = JSON.stringify({ result: { workspaces } });
  const calls: string[][] = [];
  assert.equal(resolveSender((a: string[]) => { calls.push(a); return list; }, "w1"), "ceo");
  assert.deepEqual(calls, [["--session", "org", "workspace", "list"]]);
  assert.equal(resolveSender(() => { throw new Error("no socket"); }, "w1"), null);
  assert.equal(resolveSender(() => "not json", "w1"), null);
  assert.equal(resolveSender(() => list, undefined), null, "no id, no read");
});

test("THE QUEUED PATH carries the sender, and the entry the gate delivers names who asked", () => {
  inTempDir((dir) => {
    const path = join(dir, "q");
    withStderr(() => queueOrLose({ label: "reviewer", text: "Draft #9 (odd)", why: "is working", agents,
      path, sender: "worker-5" }));
    const queued = readHandoffs(path);
    assert.equal(queued.length, 1, "the control: the order is queued");
    assert.match(queued[0].prompt, /Sent to you by `worker-5`/, "the sender is on the queue entry");
    const delivered = addressed(handoffOrder(queued[0]), "reviewer");
    assert.match(delivered, /Sent to you by `worker-5`/, "and survives the gate's delivery");
    assert.match(delivered, /^You are `reviewer`/);
  });
});

test("REGRESSION: an order to `ceo` carries ceo's own escalation route, not product-manager's", () => {
  const got = firstMessage("ceo", "State reading.", "product-manager");
  assert.match(got, /^You are `ceo`/);
  assert.match(got, /message `the chairman on the row itself -- no session can message them`/);
  assert.ok(!got.includes("message `product-manager`"), "the route is not product-manager's");
  assert.match(firstMessage("reviewer", "x", "ceo"), /message `product-manager`/, "the control: others keep it");
});
