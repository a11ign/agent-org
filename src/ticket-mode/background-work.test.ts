// no-token: gh -- the transcript and pane text are fixtures; nothing is read from the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveBackgroundWork, paneBackgroundWork } from "./background-work.ts";

/** A transcript line for an assistant's tool call, as Claude Code writes it. */
const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

/** A transcript line for the tool result of call `id`, whose text is `text`. */
const result = (id: string, text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

/** A transcript line for a `<task-notification>`, as a user message carries it. */
const notice = (id: string, body: string) => JSON.stringify({ type: "user", message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n${body}</task-notification>` } });

/** A background Bash the session started: its tool call and the result that names its id. */
const shell = (callId: string, taskId: string) => [
  call(callId, "Bash", { command: "pnpm fleet:patch", run_in_background: true }),
  result(callId, `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.`),
];

/** A Monitor the session armed: its tool call and the result that names its task. */
const monitor = (callId: string, taskId: string) => [
  call(callId, "Monitor", { command: "until ! kill -0 1313321; do sleep 5; done", description: "fleet patch", timeout_ms: 1800000 }),
  result(callId, `Monitor started (task ${taskId}, expires in 30m unless the source ends first; you get one notice at expiry).`),
];

const transcript = (...lines: string[]) => lines.join("\n");

test("a background shell started and not yet ended is live, and the shell's completion ends it", () => {
  assert.deepEqual(liveBackgroundWork(transcript(...shell("t1", "bjag9qo4g"))), { shells: ["bjag9qo4g"], monitors: [] }, "POSITIVE: a background shell with no ending");
  const ended = transcript(...shell("t1", "bjag9qo4g"), notice("bjag9qo4g", "<status>completed</status>\n<summary>Background command \"fleet\" completed (exit code 0)</summary>\n"));
  assert.deepEqual(liveBackgroundWork(ended), { shells: [], monitors: [] }, "CONTROL: its completion notice ends it");
  const failed = transcript(...shell("t1", "bjag9qo4g"), notice("bjag9qo4g", "<status>failed</status>\n"));
  assert.deepEqual(liveBackgroundWork(failed).shells, [], "a failed shell is ended too");
});

test("a Monitor that its session stopped with TaskStop is not live, and one still watching is", () => {
  assert.deepEqual(liveBackgroundWork(transcript(...monitor("t2", "bq2zc6tzj"))).monitors, ["bq2zc6tzj"], "POSITIVE: a Monitor still armed");
  const stopped = transcript(...monitor("t2", "bq2zc6tzj"), call("t3", "TaskStop", { task_id: "bq2zc6tzj" }));
  assert.deepEqual(liveBackgroundWork(stopped).monitors, [], "a Monitor its TaskStop named is ended");
});

test("two background shells, one of them ended, leave one live; a Monitor's event notice ends nothing, and its expiry does", () => {
  const two = transcript(...shell("t1", "aaa111"), ...shell("t2", "bbb222"), notice("aaa111", "<status>completed</status>\n"));
  assert.deepEqual(liveBackgroundWork(two).shells, ["bbb222"], "one live of two");
  const event = transcript(...monitor("t3", "ccc333"), notice("ccc333", "<summary>Monitor event: \"fleet\"</summary>\n<event>patch 3 of 9 done</event>\n"));
  assert.deepEqual(liveBackgroundWork(event).monitors, ["ccc333"], "a mid-run event ends nothing");
  const expired = transcript(...monitor("t3", "ccc333"), notice("ccc333", "<summary>Monitor event: \"fleet\"</summary>\n<event>[Monitor expired after 30m with no events delivered.]</event>\n"));
  assert.deepEqual(liveBackgroundWork(expired).monitors, [], "its expiry ends it");
});

test("garbage lines are skipped, never fatal, and what they hold is not counted", () => {
  const noisy = transcript("not json at all", "{\"type\":", "", ...shell("t1", "ddd444"), "[1, 2, 3]", "null");
  assert.deepEqual(liveBackgroundWork(noisy).shells, ["ddd444"], "the live shell is still found around the garbage");
  assert.deepEqual(liveBackgroundWork("garbage\n{not json"), { shells: [], monitors: [] });
});

test("A11-31 CONTROL: a process the worker detached itself, with no background flag and no Monitor, is not live work that wakes the session", () => {
  const detached = transcript(
    call("t1", "Bash", { command: "nohup pnpm fleet:patch > patch.log 2>&1 & echo $!" }),
    result("t1", "1313321"),
  );
  assert.deepEqual(liveBackgroundWork(detached), { shells: [], monitors: [] }, "nothing the board can count will wake the session");
  const foreground = transcript(call("t2", "Bash", { command: "pnpm fleet:patch" }), result("t2", "patched 3 boxes"));
  assert.deepEqual(liveBackgroundWork(foreground), { shells: [], monitors: [] }, "a foreground call is not background work either");
});

test("a result that names no task id, or a notice for a task never started, changes nothing", () => {
  const unnamed = transcript(call("t1", "Bash", { command: "x", run_in_background: true }), result("t1", "the output, with no id in it"));
  assert.deepEqual(liveBackgroundWork(unnamed), { shells: [], monitors: [] });
  assert.deepEqual(liveBackgroundWork(notice("zzz999", "<status>completed</status>\n")), { shells: [], monitors: [] });
});

test("the pane's status line counts shells and monitors: `· 1 shell, 1 monitor` is one of each, and a pane with no background work counts none", () => {
  assert.deepEqual(paneBackgroundWork("  ⏵⏵ bypass permissions on · 1 shell, 1 monitor"), { shells: 1, monitors: 1 }, "POSITIVE: both");
  assert.deepEqual(paneBackgroundWork("  ⏵⏵ bypass permissions on · 2 shells"), { shells: 2, monitors: 0 }, "shells only");
  assert.deepEqual(paneBackgroundWork("  ⏵⏵ bypass permissions on · 1 monitor"), { shells: 0, monitors: 1 }, "a monitor only");
  assert.deepEqual(paneBackgroundWork("  ⏵⏵ bypass permissions on (shift+tab to cycle)"), { shells: 0, monitors: 0 }, "CONTROL: none");
  assert.deepEqual(paneBackgroundWork(""), { shells: 0, monitors: 0 }, "an empty pane counts none");
});
