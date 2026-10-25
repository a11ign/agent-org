// no-token: none -- pure readers over facts in memory
// A11-277: the board closes the After-merge checks it can observe by itself, each with its evidence, and only on the event its spec names
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry as DependencyEntry } from "../dependency-updates/filed.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { RunEvent } from "../queue/run-log.ts";
import { closeObserved, filedKeys, observed, observedChecks, watchesSweep, withFiledBaselines, type ObserveFacts, type ObserveSpec } from "./observe.ts";
import { emptyChecks, EVIDENCE_CHARS, type CheckRecord, type ChecksFile } from "./checks.ts";

const LISTED = 10_000;
const PULL = "https://github.com/a11ign/lab/pull/12";

/** An open board check watching for `spec` from {@link LISTED}, with the dependency sweep's filed keys then, when given. */
const watching = (spec: ObserveSpec, filed?: readonly string[]): CheckRecord => ({
  id: "A11-260#1", key: "A11-260", url: null, line: "the check", owner: null, runner: "board", observe: { spec, from: LISTED, ...(filed === undefined ? {} : { filed }) }, listedAt: LISTED, state: "open",
});

/** Facts with nothing in them but what `over` gives. */
const facts = (over: Partial<ObserveFacts> = {}): ObserveFacts => ({ dependencyTickets: {}, queue: { entries: [] }, reviewOn: () => null, ...over });
const filedTicket = (ticket: string): DependencyEntry => ({ state: "filed", ticket, queue: true, queued: true });
const runLog = (logs: Record<string, readonly RunEvent[]>): Pick<Queue, "entries" | "runLog"> => ({ entries: [], runLog: logs });
const merged = (url: string, at: number): RunEvent => ({ kind: "merged", url, at });
/** A queue whose one run is ticket `key`, its worker woken at `at` for `why` on a fleet job wait. */
const woken = (key: string, at: number, why: "finished" | "failed" | "late" = "finished") => ({
  entries: [{ ticket: { key }, working: { reason: "waiting", at: 0, waits: [{ kind: "fleetJob", id: "fj-1" }], ended: [{ kind: "fleetJob", id: "fj-1" }], woke: { at, why } } }],
}) as unknown as Pick<Queue, "entries" | "runLog">;

test("A11-277: a ticket the dependency sweep files after the board began to watch passes the check, and one filed already does not", () => {
  const before = { "a11ign/agent-org:typescript@6": filedTicket("A11-90") };
  const check = watching({ kind: "sweep-ticket" }, filedKeys(before));
  assert.equal(observed(check, facts({ dependencyTickets: before })), null, "an already-filed ticket does not pass it");
  const after = { ...before, "a11ign/agent-org:typescript@7": filedTicket("A11-301"), "a11ign/lab:vite@8": { state: "requested", writerRun: "w-1", at: 1, attempts: 0 } as const };
  assert.equal(observed(check, facts({ dependencyTickets: after })), "A11-301 filed by the dependency sweep for a11ign/agent-org:typescript@7");
  assert.equal(observed(watching({ kind: "sweep-ticket" }), facts({ dependencyTickets: after })), null, "no check passes before its baseline is recorded");
});

test("A11-277: a sweep-ticket check for one package passes only on that package's ticket", () => {
  const check = watching({ kind: "sweep-ticket", scope: "a11ign/agent-org:TypeScript" }, []);
  assert.equal(observed(check, facts({ dependencyTickets: { "a11ign/agent-org:typescript-eslint@9": filedTicket("A11-302") } })), null, "a package whose name only starts the same");
  assert.equal(observed(check, facts({ dependencyTickets: { "a11ign/agent-org:typescript@7": filedTicket("A11-301") } })), "A11-301 filed by the dependency sweep for a11ign/agent-org:typescript@7");
});

test("A11-277: a review on the named pull request's head passes the check; none, or another pull request's, does not", () => {
  const check = watching({ kind: "review", url: PULL });
  assert.equal(observed(check, facts()), null);
  assert.equal(observed(check, facts({ reviewOn: (url) => (url === PULL ? null : "APPROVED") })), null, "another pull request's review");
  assert.equal(observed(check, facts({ reviewOn: (url) => (url === PULL ? "CHANGES_REQUESTED" : null) })), `review CHANGES_REQUESTED on ${PULL}`);
});

test("A11-277: a merge in the repository on a run with no person's action passes the check; a merge on a run a person answered, or before the board watched, does not", () => {
  const check = watching({ kind: "queue-merge", repository: "a11ign/agent-org" });
  const ours = "https://github.com/a11ign/agent-org/pull/1920";
  assert.equal(observed(check, facts({ queue: runLog({ "A11-270": [merged(ours, LISTED - 1)] }) })), null, "a merge before the board began to watch");
  assert.equal(observed(check, facts({ queue: runLog({ "A11-270": [merged("https://github.com/a11ign/lab/pull/40", LISTED + 1)] }) })), null, "a merge in another repository");
  for (const person of [{ kind: "answered", by: "answer", at: 1 }, { kind: "answered", by: "terminal", at: 1 }, { kind: "round", cause: "talk", reason: null, at: 1 }, { kind: "round", cause: "asked", reason: null, at: 1 }] as const) {
    assert.equal(observed(check, facts({ queue: runLog({ "A11-270": [person, merged(ours, LISTED + 1)] }) })), null, `a run with ${person.kind} ${"by" in person ? person.by : person.cause}`);
  }
  const board = { kind: "round", cause: "feedback", reason: "red checks", at: 1 } as const;
  assert.equal(observed(check, facts({ queue: runLog({ "A11-270": [board, merged(ours, LISTED + 1)] }) })), "a11ign/agent-org #1920 merged with no person (run A11-270)", "a round the board started is no person's");
});

test("A11-277: the board waking a worker on its finished or failed wait after it began to watch passes the check; a late wake, an earlier one, or another kind of wait does not", () => {
  assert.equal(observed(watching({ kind: "wake" }), facts({ queue: woken("A11-275", LISTED + 5) })), "A11-275 woken by the board on fleet job fj-1");
  assert.equal(observed(watching({ kind: "wake", wait: "fleetJob" }), facts({ queue: woken("A11-275", LISTED + 5, "failed") })), "A11-275 woken by the board on fleet job fj-1");
  assert.equal(observed(watching({ kind: "wake" }), facts({ queue: woken("A11-275", LISTED - 5) })), null, "a wake from before the board watched");
  assert.equal(observed(watching({ kind: "wake" }), facts({ queue: woken("A11-275", LISTED + 5, "late") })), null, "a wait that passed its deadline is no wake on an event");
  assert.equal(observed(watching({ kind: "wake", wait: "ciRun" }), facts({ queue: woken("A11-275", LISTED + 5) })), null, "a wake on another kind of wait");
});

test("A11-277: a check not open, or not watched, is never passed by the board, and evidence is cut to the length a close takes", () => {
  const review = watching({ kind: "review", url: PULL });
  const seen = facts({ reviewOn: () => "APPROVED" });
  assert.equal(observed({ ...review, state: "failed" }, seen), null);
  const { observe: _none, ...unwatched } = review;
  assert.equal(observed(unwatched, seen), null);
  const long = watching({ kind: "review", url: `https://github.com/a11ign/lab/pull/${"1".repeat(EVIDENCE_CHARS)}` });
  assert.equal(observed(long, seen)?.length, EVIDENCE_CHARS);
});

test("A11-277: the board closes each check it saw passed, by the board, with its evidence, and leaves a check closed meanwhile as it was", () => {
  const file: ChecksFile = { checks: { "A11-260#1": watching({ kind: "review", url: PULL }), "A11-261#1": { ...watching({ kind: "wake" }), id: "A11-261#1", key: "A11-261" } } };
  const passes = observedChecks(file, facts({ reviewOn: () => "APPROVED" }));
  assert.deepEqual(passes, [{ id: "A11-260#1", evidence: `review APPROVED on ${PULL}` }]);
  const closed = closeObserved(file, passes, 20_000).checks["A11-260#1"];
  assert.deepEqual([closed.state, closed.result, closed.closedBy, closed.closedAt], ["passed", `review APPROVED on ${PULL}`, "board", 20_000]);
  const meanwhile: ChecksFile = { checks: { ...file.checks, "A11-260#1": { ...file.checks["A11-260#1"], state: "failed", result: "a person saw it fail", closedBy: "person", closedAt: 15_000 } } };
  assert.equal(closeObserved(meanwhile, passes, 20_000).checks["A11-260#1"].state, "failed");
});

test("A11-277: the dependency sweep's filed keys are recorded once on each open sweep-ticket check, and only such a check needs the file read", () => {
  const sweep = watching({ kind: "sweep-ticket" });
  const file: ChecksFile = { checks: { [sweep.id]: sweep, "A11-261#1": { ...watching({ kind: "wake" }), id: "A11-261#1" } } };
  assert.equal(watchesSweep(file), true);
  assert.equal(watchesSweep({ checks: { "A11-261#1": file.checks["A11-261#1"] } }), false);
  assert.equal(watchesSweep(emptyChecks()), false);
  const recorded = withFiledBaselines(file, ["a:b@1"]);
  assert.deepEqual(recorded.checks[sweep.id].observe?.filed, ["a:b@1"]);
  assert.equal(recorded.checks["A11-261#1"], file.checks["A11-261#1"], "a check that watches something else is untouched");
  assert.equal(withFiledBaselines(recorded, ["a:b@1", "a:b@2"]), recorded, "a recorded baseline is never moved on");
});
