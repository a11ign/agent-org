// no-token: gh -- pure
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTimeline } from "./board-view/run-timeline.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import type { RunEvent } from "./queue/run-log.ts";

// A11-219: a run stored before the log was kept shows what its own times rebuild.
const PULL = "https://github.com/a11ign/agent-org/pull/1";
const stored = (over: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "A" }, phase: "finished", model: "opus", effort: "high", queuedAt: 10, startedAt: 20, finishedAt: 30,
  outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/agent-org", url: PULL }] }, ...over });

test("a stored run with no log shows queued, started and finished at its own times, each marked rebuilt", () => {
  assert.deepEqual(runTimeline(stored({ outcome: { kind: "checked", reason: "nothing to change" } }), []), [
    { at: 10, kind: "queued", model: "opus", effort: "high", planFirst: false, rebuilt: true },
    { at: 20, kind: "started", model: "opus", effort: "high", instance: null, rebuilt: true },
    { at: 30, kind: "finished", outcome: "checked", reason: "nothing to change", rebuilt: true },
  ]);
});

test("a rebuilt timeline has the run's publish and each merged pull request, oldest first", () => {
  const events = runTimeline(stored({ pullStates: { [PULL]: "merged", "https://github.com/a11ign/agent-org/pull/2": "open" }, published: { link: "https://slack/1", at: 40 }, worker: { instance: "agents" } }), []);
  assert.deepEqual(events.map(({ kind, at }) => [kind, at]), [["queued", 10], ["started", 20], ["finished", 30], ["merged", 30], ["published", 40]]);
  assert.deepEqual(events.find((event) => event.kind === "merged"), { at: 30, kind: "merged", url: PULL, rebuilt: true });
  assert.equal((events[1] as Extract<RunEvent, { kind: "started" }>).instance, "agents");
  assert.ok(events.every((event) => event.rebuilt === true));
});

test("a run with only some of its times gives only what they say, and a run queued to be planned says so", () => {
  assert.deepEqual(runTimeline({ ticket: { key: "A" }, phase: "queued", queuedAt: 5, model: "opus", effort: "high", plan: { model: "opus", effort: "max" } }, []), [
    { at: 5, kind: "queued", model: "opus", effort: "max", planFirst: true, rebuilt: true },
  ]);
  assert.deepEqual(runTimeline({ ticket: { key: "A" }, phase: "running" }, []), []);
});

test("a run with a log shows its logged events as they are, and rebuilds nothing", () => {
  const logged: RunEvent[] = [{ at: 1, kind: "queued", model: "opus", effort: "high", planFirst: false }];
  assert.equal(runTimeline(stored(), logged), logged);
});
