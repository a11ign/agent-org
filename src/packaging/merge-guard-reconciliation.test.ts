/**
 * #188: A GUARD WHOSE WRONG ANSWERS ARE ABSORBED BY ANOTHER MECHANISM HAS NO FAILURE SIGNAL.
 * #455's split into `scripts/merge-guard/reconciliation.mjs`.
 *
 * #182 was caught only because strict branch protection refused what the guard passed -- its own
 * wrongness was invisible until somebody happened to run `gh pr update-branch` right after. This records
 * every live verdict and, once a PR is terminal, compares it against the real outcome -- AGREED as
 * explicitly as DISAGREED, because a log that only records conflicts cannot tell "the two agreed" from
 * "the two were never compared".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordVerdict, latestVerdictFor, realOutcomeFor, reconcile,
} from "../../../../scripts/merge-guard/reconciliation.mjs";

function withTempLogDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "merge-guard-log-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Narrows `reconcile`'s discriminated union so a test can read `.record`'s fields. */
function recordOf(result: ReturnType<typeof reconcile>) {
  assert.ok(result.record, `expected a record, got: ${result.reason}`);
  return result.record;
}

test("recordVerdict appends one entry with its reason KINDS, not just READY/REFUSED", () => {
  withTempLogDir((dir) => {
    const log = join(dir, "log.jsonl");
    recordVerdict(log, 165, { code: 1, reasons: ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind.\n  more"] });
    const entry = latestVerdictFor(log, 165);
    assert.ok(entry);
    assert.equal(entry.prNumber, 165);
    assert.equal(entry.code, 1);
    assert.deepEqual(entry.reasonKinds, ["ANCESTRY"]);
  });
});

test("latestVerdictFor returns null for a PR nothing ever recorded, never an empty-but-present entry", () => {
  withTempLogDir((dir) => {
    assert.equal(latestVerdictFor(join(dir, "does-not-exist.jsonl"), 165), null);
  });
});

test("latestVerdictFor picks the MOST RECENT entry when a PR was checked more than once", () => {
  withTempLogDir((dir) => {
    const log = join(dir, "log.jsonl");
    recordVerdict(log, 165, { code: 1, reasons: ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind."] });
    recordVerdict(log, 165, { code: 0, reasons: [] });
    const entry = latestVerdictFor(log, 165);
    assert.ok(entry);
    assert.equal(entry.code, 0, "the branch was updated between the two checks; the later verdict wins");
  });
});

test("realOutcomeFor: MERGED is ACCEPTED, CLOSED is REFUSED, anything else is no outcome yet", () => {
  assert.equal(realOutcomeFor("MERGED"), "ACCEPTED");
  assert.equal(realOutcomeFor("CLOSED"), "REFUSED");
  assert.equal(realOutcomeFor("OPEN"), null, "no outcome exists yet -- never invent one");
});

const BEFORE_RESOLUTION = "2026-09-07T02:00:00.000Z";
const RESOLVED_AT = "2026-09-07T02:10:00.000Z";
const AFTER_RESOLUTION = "2026-09-07T02:20:00.000Z";

test("THE DISAGREEMENT CASE: guard said READY, the platform actually refused it", () => {
  const result = reconcile({
    prNumber: 165,
    recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: "REFUSED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 0, "reconciling successfully is not the same as the two answers agreeing");
  const record = recordOf(result);
  assert.equal(record.guardVerdict, "READY");
  assert.equal(record.realOutcome, "REFUSED");
  assert.equal(record.agreement, "DISAGREED");
});

test("THE AGREEMENT CASE, stated explicitly — not merely the absence of a disagreement", () => {
  const result = reconcile({
    prNumber: 100,
    recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: "ACCEPTED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 0);
  const record = recordOf(result);
  assert.equal(record.agreement, "AGREED");
  assert.equal(record.guardVerdict, "READY");
  assert.equal(record.realOutcome, "ACCEPTED");
});

test("a REFUSED verdict followed by a real refusal is ALSO an agreement", () => {
  const result = reconcile({
    prNumber: 101,
    recordedVerdict: { code: 1, reasonKinds: ["ANCESTRY"], at: BEFORE_RESOLUTION },
    realOutcome: "REFUSED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(recordOf(result).agreement, "AGREED", "both said no; that is agreement too, not just a wash");
});

test("reconcile REFUSES rather than inventing an outcome for a PR that is still OPEN", () => {
  const result = reconcile({
    prNumber: 102, recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: null, resolvedAt: null,
  });
  assert.equal(result.code, 2, "INCONCLUSIVE, never a guess");
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /forward-only|no outcome/);
});

test("reconcile REFUSES when nothing was ever recorded for this PR", () => {
  const result = reconcile({
    prNumber: 103, recordedVerdict: null, realOutcome: "ACCEPTED", resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 2);
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /nothing to reconcile/);
});

test("reconcile REFUSES a verdict recorded AFTER the PR already resolved — a stale post-mortem question", () => {
  // Measured live against #191 minutes after this was written: `guard said REFUSED (ANCESTRY, STALE) ...
  // DISAGREED` for a PR that merged cleanly, because main had kept moving and the merged head read
  // "behind" a tip it never needed to be tested against.
  const result = reconcile({
    prNumber: 191,
    recordedVerdict: { code: 1, reasonKinds: ["ANCESTRY", "STALE"], at: AFTER_RESOLUTION },
    realOutcome: "ACCEPTED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 2, "INCONCLUSIVE, never recorded as a disagreement");
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /AFTER it resolved|stale post-mortem/);
});

test("MUTATION: a write failure is never a silent no-op", () => {
  // A directory used as a file path makes the write fail deterministically without touching real
  // permissions bits, which behave differently across CI and a laptop.
  withTempLogDir((dir) => {
    assert.throws(() => recordVerdict(dir, 165, { code: 0, reasons: [] }),
      /could not write the log/,
      "a log that cannot write must say so loudly, not swallow the error and continue silently");
  });
});
