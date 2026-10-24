// no-token: none -- the git calls are an injected `run` that spawns nothing, and what the note asks of GitHub is the fake code host's (A11-160, step 9)
/**
 * #1477 AND #656: A CARRY TELLS THE PULL REQUEST'S OWNER, AND A NOTE THAT FAILS AFTER THE PUSH LANDED IS A SAID EXIT 3, NEVER A 1. `carry-branch.test.ts` carries a real held branch through real git; this file holds what the carry
 * does AFTER the push: finds the branch's open pull request and leaves the note on it, and reports -- never throws -- when it cannot. The pull requests are the code host's world; the carry's git is a `run` that answers.
 * Which arguments find the pull request and how the answer is read is `plugins/github/rows/pullwork-rows.test.ts`.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { carryMain, EXIT, noteCarryOnPr } from "../carry-branch.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const BRANCH = "agent/held-branch-test";
let host = createFakeCodeHost();
beforeEach(() => { host = createFakeCodeHost(); substituteCodeHost(host); });
afterEach(() => forgetActivation());
const world = () => host.rowsWorld;

test("the note names the carrier and the reason, and lands on the branch's open pull request", () => {
  fakePull(world(), 41, { headRefName: "agent/other" });
  fakePull(world(), 42, { headRefName: BRANCH });
  assert.deepEqual(noteCarryOnPr(BRANCH, "worker-9", "past the escalation window"), { commented: true, prNumber: 42 });
  assert.deepEqual(world().pulls.get(42)?.comments, ["Carried by `worker-9` from a detached checkout: past the escalation window"]);
  assert.deepEqual(world().pulls.get(41)?.comments, [], "no other pull request is written to");
});

test("a branch with no open pull request is a said reason, not a throw: a closed one is not the branch's open one", () => {
  fakePull(world(), 42, { headRefName: BRANCH, closedAt: "2026-09-09T11:00:00Z" });
  assert.deepEqual(noteCarryOnPr(BRANCH, "worker-9", "r"), { commented: false, reason: `no open PR found for ${BRANCH} -- nothing to comment on` });
  assert.deepEqual(world().pulls.get(42)?.comments, []);
});

test("#1477: a lookup the code host refuses, and a note it refuses, are reported with the cause and never thrown (this runs after the push landed)", () => {
  fakePull(world(), 42, { headRefName: BRANCH });
  world().failures.set("openPullNumberOfBranch", new Error("Command failed: gh pr list\nHTTP 502"));
  const lookup = noteCarryOnPr(BRANCH, "worker-9", "r");
  assert.equal(lookup.commented, false);
  assert.match(lookup.commented ? "" : lookup.reason, /^could not look up the open PR for agent\/held-branch-test -- Command failed: gh pr list\nHTTP 502$/);
  world().failures.delete("openPullNumberOfBranch");
  world().failures.set("commentOnPull", new Error("HTTP 403"));
  const note = noteCarryOnPr(BRANCH, "worker-9", "r");
  assert.deepEqual(note, { commented: false, reason: `found PR #42 for ${BRANCH}, but could not post the note on it -- HTTP 403` });
});

test("a code host that cannot be reached at all is the same said reason: the runner is made inside the guarded step", () => {
  substituteCodeHost({ ...host, rows: undefined });
  const note = noteCarryOnPr(BRANCH, "worker-9", "r");
  assert.equal(note.commented, false);
  assert.match(note.commented ? "" : note.reason, /^could not look up the open PR for agent\/held-branch-test -- .*implements rows/);
});

/** `carryMain` over a `run` that answers every git call and spawns none, in a work directory the test owns. */
function carry(over: { run?: (cmd: string, args: string[]) => string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = carryMain([BRANCH, "--carrier=worker-9", "--reason=past the window"], {
    run: over.run ?? (() => " 1 file changed\n"), stamp: () => undefined, workDir: tmpDirForFile("carry-note-"), out: (t) => { out.push(t); }, err: (t) => { err.push(t); },
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("#1477 exit 0: pushed AND noted -- the output names the pull request the note is on", () => {
  fakePull(world(), 42, { headRefName: BRANCH });
  const r = carry();
  assert.equal(r.code, EXIT.CARRIED);
  assert.match(r.out, /CARRIED -- agent\/held-branch-test merged with origin\/main and pushed\./);
  assert.match(r.out, /Noted on PR #42\./);
});

test("#1477 exit 3: the branch WAS pushed and no note was left -- never the 1 that means NOT CARRIED", () => {
  const none = carry();
  assert.equal(none.code, EXIT.CARRIED_NOT_NOTED);
  assert.match(none.err, /^CARRIED, NOT NOTED \(exit 3\) -- agent\/held-branch-test WAS pushed; no note was left on its PR: no open PR found/);
  fakePull(world(), 42, { headRefName: BRANCH });
  world().failures.set("commentOnPull", new Error("HTTP 403"));
  const refused = carry();
  assert.equal(refused.code, EXIT.CARRIED_NOT_NOTED);
  assert.match(refused.err, /found PR #42 for agent\/held-branch-test, but could not post the note on it -- HTTP 403/);
});

test("#1477 exit 1: a carry that pushed nothing leaves no note and asks the code host nothing", () => {
  fakePull(world(), 42, { headRefName: BRANCH });
  const r = carry({ run: (_cmd, args) => { if (args[0] === "push") throw new Error("rejected: non-fast-forward"); return "stat\n"; } });
  assert.equal(r.code, EXIT.NOT_CARRIED);
  assert.match(r.err, /^NOT CARRIED: push refused/);
  assert.deepEqual(world().pulls.get(42)?.comments, [], "a carry that did not land has nothing to note");
});
