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
import { promptable, clearThenPrompt, EXIT } from "../prompt-session.mjs";

const agents = [{ label: "reviewer", status: "idle" }, { label: "reviewer-2", status: "working" },
  { label: "ceo", status: "done" }, { label: "worker-judge", status: "blocked" }];

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

test("the exit codes distinguish 'could not' from 'must not'", () => {
  // A caller scripting this needs to tell a transient refusal from a session that was never eligible.
  assert.deepEqual(EXIT, { OK: 0, REFUSED: 1, NOT_WAKEABLE: 2 });
});
