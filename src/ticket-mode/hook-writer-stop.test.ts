// no-token: none -- the hook decides on the text of an outcome file in a temporary folder; nothing is spawned
//
// A11-267: the Stop hook judges a new-ticket run by the writer's contract, the one the board reads its outcome with (`parseWriterOutcome`), so a writer that filed its ticket can end on `created`. A ticket worker's contract
// (`OUTCOME_KINDS`) has no `created`, and a run without the writer's mark is still held to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, stopVerdict } from "./hook.ts";
import { OUTCOME_KINDS } from "./outcome.ts";
import { WRITER_FILE } from "./worker-files.ts";

/** A run's folder holding `outcome`, and the writer's mark when the run is a new-ticket run. */
function runWith(outcome: object, { writer, mode = "quick" }: Readonly<{ writer: boolean; mode?: string }>): string {
  const dir = tmpDir("ticket-hook-writer-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
  if (writer) writeFileSync(join(dir, WRITER_FILE), `${JSON.stringify({ mode, tools: [] })}\n`);
  return dir;
}

test("A11-267: a new-ticket run that filed its ticket ends on created, and the hook allows the stop", () => {
  const verdict = stopVerdict(runWith({ kind: "created", created: ["A11-140"] }, { writer: true }));
  assert.deepEqual([verdict.code, verdict.say], [0, []]);
});

test("A11-267: the rest of the writer's contract is allowed: decided for a ticket grill, and needs-human with its reason, off the escalation list too", () => {
  for (const outcome of [{ kind: "decided", ticket: "A11-12" }, { kind: "needs-human", reason: "the attachment was refused", created: ["A11-140"] }]) {
    assert.equal(stopVerdict(runWith(outcome, { writer: true })).code, 0, JSON.stringify(outcome));
  }
});

test("A11-267: a writer's created outcome that names no ticket, or a key that is no key, is refused with the writer contract's own words", () => {
  const none = stopVerdict(runWith({ kind: "created", created: [] }, { writer: true }));
  assert.equal(none.code, 2);
  assert.match(none.say.join("\n"), /its created outcome names no ticket: a run that made none ends needs-human, with its reason/);
  const bad = stopVerdict(runWith({ kind: "created", created: ["not a key"] }, { writer: true }));
  assert.equal(bad.code, 2);
  assert.match(bad.say.join("\n"), /is not a ticket key such as A11-12/);
  const noReason = stopVerdict(runWith({ kind: "needs-human" }, { writer: true }));
  assert.equal(noReason.code, 2);
  assert.match(noReason.say.join("\n"), /its needs-human outcome gives no reason/);
});

test("A11-267: a writer cannot end on a worker's outcome: working, ready-pr and checked are refused", () => {
  for (const outcome of [{ kind: "working", reason: "x" }, { kind: "ready-pr", prs: [], reason: "x" }, { kind: "checked", reason: "x" }]) {
    const verdict = stopVerdict(runWith(outcome, { writer: true }));
    assert.equal(verdict.code, 2, JSON.stringify(outcome));
    assert.match(verdict.say.join("\n"), new RegExp(`the outcome "${outcome.kind}", which a new-ticket run cannot end on`));
  }
});

test("A11-267: a worker run still refuses created, naming the kinds it may end on", () => {
  const verdict = stopVerdict(runWith({ kind: "created", created: ["A11-140"] }, { writer: false }));
  assert.equal(verdict.code, 2);
  const said = verdict.say.join("\n");
  for (const kind of ["ready-pr", "needs-human", "checked"]) assert.ok(OUTCOME_KINDS.includes(kind as never) && said.includes(kind), kind);
  assert.equal((OUTCOME_KINDS as readonly string[]).includes("created"), false, "created is not a worker kind");
});

test("A11-267: a writer's refusal is bounded like every other: past the limit the stop is allowed and the board fails the run", () => {
  const dir = runWith({ kind: "created", created: [] }, { writer: true });
  for (let refused = 0; refused < MAX_STOP_REFUSALS; refused += 1) assert.equal(stopVerdict(dir).code, 2, `refusal ${refused + 1}`);
  const last = stopVerdict(dir);
  assert.equal(last.code, 0);
  assert.match(last.say.join("\n"), /on the same invalid outcome in .*outcome\.json, so this one is allowed and the board fails the run/);
});

test("A11-302: a verifier run ends on passed, failed or superseded with one line of evidence, and the hook refuses anything else with the contract's words", () => {
  for (const kind of ["passed", "failed", "superseded"]) assert.equal(stopVerdict(runWith({ kind, evidence: "the doctor shows 0.5.0" }, { writer: true, mode: "verify" })).code, 0, kind);
  assert.equal(stopVerdict(runWith({ kind: "needs-human", reason: "the host did not answer" }, { writer: true, mode: "verify" })).code, 0, "a run that cannot decide may say so");
  const created = stopVerdict(runWith({ kind: "created", created: ["A11-140"] }, { writer: true, mode: "verify" }));
  assert.equal(created.code, 2);
  assert.match(created.say.join("\n"), /a verifier run ends on "passed", "failed", "superseded" or "cannot-run-here", not "created"/);
  const noEvidence = stopVerdict(runWith({ kind: "passed" }, { writer: true, mode: "verify" }));
  assert.match(noEvidence.say.join("\n"), /its passed outcome gives no evidence/);
  const quick = stopVerdict(runWith({ kind: "passed", evidence: "x" }, { writer: true, mode: "quick" }));
  assert.match(quick.say.join("\n"), /the outcome "passed", which a new-ticket run cannot end on/, "a new-ticket run cannot end as a verifier does");
});

test("A11-302: a migration pass ends on migrated with entries the plan check accepts, and the hook refuses a bad entry naming it, so the run writes it again", () => {
  const good = { kind: "migrated", checks: [{ id: "A11-1#1", runner: "agent", evidence: "run it and quote it" }, { id: "A11-2#1", runner: "superseded", reason: "that machine is retired" }] };
  assert.equal(stopVerdict(runWith(good, { writer: true, mode: "migrate" })).code, 0);
  const onSession = stopVerdict(runWith({ kind: "migrated", checks: [{ id: "A11-1#1", runner: "session", evidence: "x" }] }, { writer: true, mode: "migrate" }));
  assert.equal(onSession.code, 2);
  assert.match(onSession.say.join("\n"), /"A11-1#1" has the runner "session", which is no runner: the person's session runs no check/);
  assert.match(stopVerdict(runWith({ kind: "passed", evidence: "x" }, { writer: true, mode: "migrate" })).say.join("\n"), /a migration pass ends on "migrated", not "passed"/);
});
