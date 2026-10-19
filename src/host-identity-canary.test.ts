// no-token: none -- reads and writes temp directories and the fixture project; nothing here reaches `gh`, `herdr` or `git`
//
// agent-org#1247: A NEW IDENTITY GOES LIVE ON ONE REPOSITORY FIRST AND PROVES ITS EFFECT BEFORE IT WIDENS. Three pins, each with the refusal it depends on:
//   1. no proof reading: the new `github-apps` identity stays on the canary repository and widening is REFUSED, naming the proof it lacks;
//   2. a proof reading that counts (the PR moved to APPROVED by the role's own bot, on the canary): widening is allowed;
//   3. a proof reading that ends at REVIEW_REQUIRED after the approval does NOT count, and neither does a reading of a permission rather than of the PR.
// The controls are the paired tests (the same host, the same canary, one reading different) and the record-once writer. Remove the refusal in `widenIdentity` and
// pin 1 goes red; make `countsAsProof` accept any reading and pin 3 goes red.
import "./packaging/host-units-project.ts"; // FIRST: it names the fixture project the tool resolves at import
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./packaging/host-units-project.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { parseHostConfig } from "./host-config.ts";
import { HostConfigRefusal } from "./host-config.ts";
import { countsAsProof, identityProofFile, identityProofs, recordIdentityProof, widenIdentity, type IdentityProofReading } from "./host-units/gh-wrapper-and-notes.ts";

const CANARY = "a11ign/agent-org";
const REVIEWER_BOT = "a11ign-ai-reviewer[bot]";
const AT = "2026-10-12T09:00:00Z";

/** A `host.json` whose reviewer role is a new GitHub App, and whose other roles are user accounts (so only the reviewer is the new identity). */
const hostWithReviewerApp = (root: string) => parseHostConfig(JSON.stringify({
  ...JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")),
  binDir: join(root, "bin"),
  github: { identity: { reviewer: { mode: "github-apps", appId: "id-reviewer", keyPath: "/scratch/reviewer.pem", slug: "a11ign-ai-reviewer" } } },
}), "scratch host.json");

/** One reading as the proof file takes it: who approved, on which repository, which PR, the decision either side, and when. */
const reading = (over: Partial<IdentityProofReading> = {}): IdentityProofReading => ({
  who: REVIEWER_BOT, repository: CANARY, pr: 1247, reviewDecisionBefore: "REVIEW_REQUIRED", reviewDecisionAfter: "APPROVED", at: AT, ...over,
});

/** The proof file for a host under `root`, with `readings` written as the reviewer's record (one write per reading, so the writer is the only path onto disk). */
const recorded = (root: string, readings: IdentityProofReading[] = []) => {
  const host = hostWithReviewerApp(root);
  const file = identityProofFile({ host, home: root, env: {} });
  for (const each of readings) recordIdentityProof("reviewer", each, { file });
  return { host, file };
};

// ---- pin 1: no proof reading, so the canary is the whole of it and widening is refused -----------------------------------------------------

test("#1247 NEGATIVE: a new github-apps identity with no proof reading stays on the canary repository and widening names the missing proof", () => {
  const root = tmpDir("identity-canary-1247-none-");
  const { host, file } = recorded(root);
  assert.equal(existsSync(file), false, "nothing has been recorded, so the file does not exist");
  const decision = widenIdentity("reviewer", { host, canary: CANARY, file });
  assert.ok(!decision.widen);
  assert.equal(decision.scope, CANARY, "the identity is installed for the canary repository only");
  assert.match(decision.missing, /github\.identity\.reviewer stays on a11ign\/agent-org until a proof reading counts for it/);
  assert.match(decision.missing, /none is on record/);
});

test("#1247 NEGATIVE: a reading that ends at REVIEW_REQUIRED after the approval does not count, and says it did not move the PR", () => {
  const root = tmpDir("identity-canary-1247-review-");
  const { host, file } = recorded(root, [reading({ reviewDecisionAfter: "REVIEW_REQUIRED" })]);
  const decision = widenIdentity("reviewer", { host, canary: CANARY, file });
  assert.ok(!decision.widen, "REVIEW_REQUIRED after the approval is not an effect");
  assert.match(decision.missing, /1 on record in .*, and none moved the PR from not-APPROVED to APPROVED by a11ign-ai-reviewer\[bot\] on a11ign\/agent-org/);
});

test("#1247 NEGATIVE: a reading that is not this role's approval on the canary does not count", () => {
  const identity = { appId: "id-reviewer", keyPath: "/scratch/reviewer.pem", slug: "a11ign-ai-reviewer" };
  // the PR was already APPROVED before the approval, so "APPROVED after" proves nothing about this identity
  assert.equal(countsAsProof(reading({ reviewDecisionBefore: "APPROVED" }), { canary: CANARY, identity }), false);
  // a human's login is not the role's bot
  assert.equal(countsAsProof(reading({ who: "a11ign-chairman" }), { canary: CANARY, identity }), false);
  // another app's bot is not this role's bot
  assert.equal(countsAsProof(reading({ who: "a11ign-ai-leads[bot]" }), { canary: CANARY, identity }), false);
  // a reading on another repository is not the canary's effect
  assert.equal(countsAsProof(reading({ repository: "a11ign/other" }), { canary: CANARY, identity }), false);
  // a reading with no PR is not a reading of an approval
  assert.equal(countsAsProof(reading({ pr: 0 }), { canary: CANARY, identity }), false);
});

// ---- pin 2: a counting proof reading lets the identity widen ------------------------------------------------------------------------------

test("#1247 POSITIVE: with a reading that counts for that role, the identity widens", () => {
  const root = tmpDir("identity-canary-1247-proof-");
  const { host, file } = recorded(root, [reading()]);
  assert.deepEqual(widenIdentity("reviewer", { host, canary: CANARY, file }), { widen: true });
});

test("#1247 POSITIVE: the reading counts for the role it was written for, and no other role widens on it", () => {
  const root = tmpDir("identity-canary-1247-other-");
  const host = parseHostConfig(JSON.stringify({
    ...JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")),
    binDir: join(root, "bin"),
    github: { identity: {
      reviewer: { mode: "github-apps", appId: "id-reviewer", keyPath: "/scratch/reviewer.pem", slug: "a11ign-ai-reviewer" },
      workers: { mode: "github-apps", appId: "id-workers", keyPath: "/scratch/workers.pem", slug: "a11ign-ai-workers-app" },
    } },
  }), "scratch host.json");
  const file = identityProofFile({ host, home: root, env: {} });
  recordIdentityProof("reviewer", reading(), { file });
  assert.deepEqual(widenIdentity("reviewer", { host, canary: CANARY, file }), { widen: true });
  const workers = widenIdentity("workers", { host, canary: CANARY, file });
  assert.ok(!workers.widen, "the reviewer's reading is not the workers' proof");
  assert.match(workers.missing, /github\.identity\.workers stays on/);
});

test("#1247 POSITIVE: a user-accounts role is not a new identity and widens with no proof", () => {
  const root = tmpDir("identity-canary-1247-user-");
  const host = parseHostConfig(JSON.stringify({ ...JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")),
    binDir: join(root, "bin") }), "scratch host.json");
  assert.deepEqual(widenIdentity("reviewer", { host, canary: CANARY, file: join(root, "none.json") }), { widen: true });
});

// ---- the record: written once, never rewritten, and an unreadable record is refused rather than overwritten ---------------------------

test("#1247 RECORD: a reading is written once; the same reading again is refused and the file keeps one entry", () => {
  const root = tmpDir("identity-canary-1247-once-");
  const { file } = recorded(root, [reading()]);
  assert.throws(() => recordIdentityProof("reviewer", reading(), { file }), /already on record, and a proof is written once/);
  assert.equal(identityProofs(file)["reviewer"]?.length, 1);
});

/** A scratch home with the reviewer's app configured, and its identity proof file recorded once. */
function recordedProof(prefix: string) {
  const root = tmpDir(prefix);
  const host = hostWithReviewerApp(root);
  const file = identityProofFile({ host, home: root, env: {} });
  recordIdentityProof("reviewer", reading(), { file }); // creates the file and its directory
  return { host, file };
}

test("#1247 RECORD: a present proof file that does not parse is refused and is not overwritten", () => {
  const { host, file } = recordedProof("identity-canary-1247-garbled-");
  writeFileSync(file, "{ not json");
  assert.throws(() => recordIdentityProof("reviewer", reading({ pr: 1248 }), { file }), /does not parse as a map of role to readings/);
  assert.equal(readFileSync(file, "utf8"), "{ not json", "the unreadable record is left as it was");
  assert.throws(() => widenIdentity("reviewer", { host, canary: CANARY, file }), /does not parse/);
});

test("#1247 RECORD: a proof file whose role value or reading entry is malformed is refused by the gate and the writer, and is not overwritten", () => {
  const { host, file } = recordedProof("identity-canary-1247-shape-");
  const partial = JSON.stringify({ reviewer: [{ who: REVIEWER_BOT }] });
  for (const garbled of ['{"reviewer":{}}', '{"reviewer":"APPROVED"}', '{"reviewer":[null]}', partial, "[]", "null"]) {
    writeFileSync(file, garbled);
    assert.throws(() => widenIdentity("reviewer", { host, canary: CANARY, file }), HostConfigRefusal, `widening refuses ${garbled}`);
    assert.throws(() => recordIdentityProof("reviewer", reading(), { file }), HostConfigRefusal, `the writer refuses ${garbled}`);
    assert.equal(readFileSync(file, "utf8"), garbled, "the record is left as it was");
  }
});
