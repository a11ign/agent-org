// no-token: none -- every read and write goes through the fake code host; nothing here reaches GitHub, git, herdr or the fleet
//
// A11-160 (step 5): the arming doors' DECISION about a pull request the merge queue ejected is core's, and runs on the fake code host's world (a pull request that carries the time of its ejection, or none). How the
// timeline of the queue is READ -- #3460's real nodes, a push since, another reason, a live entry, an answer with no history -- is the GitHub plugin's (`plugins/github/rows/armed-state.test.ts`), and the sweep as a real process over
// a stub `gh` is the plugin's end to end (`plugins/github/rows/arm-refuses-an-ejected-pr-process.test.ts`).
/**
 * #3487: A PULL REQUEST THE MERGE QUEUE EJECTED FOR `failed_checks` IS NOT ARMED AGAIN WHILE ITS HEAD IS UNMOVED.
 *
 * Measured 2026-10-04 on `a11ign/a11ign#3460` (approved, CLEAN, head `11aa53a` throughout): `a11ign-ci` armed it four times
 * and the queue ejected it four times, each pass about seven minutes of CI on a run that could only fail the same way. The
 * reader (`queueEjectionOf`) existed and was tested; its only caller was the gate, which REPORTS. The two doors that ARM
 * did not ask it, which is #2046's one-place-decides rule again. Both now reach it through `ejectionVerdict`.
 *
 * THE FIXTURE IS #3460: its last removal from the queue, 14:48:06Z, with nothing pushed since. The controls change ONE thing each, so the refusal cannot pass by never being reached.
 *
 * THE MUTANT is the tree before this row (`v0.14.0`, or `origin/main` at the branch point): every refusal case here arms the ejected PR there, so this file goes red there. The run is pasted on the row.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { runArmPr, EXIT } from "../arm-pr.ts";
import { refusalBeforeArming } from "../auto-arm-sweep.ts";
import { ejectionVerdict } from "../pr-armed-state.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";

const REPO = "a11ign/a11ign";
const LAST_REMOVAL = "2026-10-04T14:48:06Z";

afterEach(() => forgetActivation());

/** What #3460 looked like to the queue, and the one thing each control changes. */
type Case = { ejectedAt?: string | null; queued?: boolean; unread?: boolean; refuse?: Error };
const EJECTED_3460: Case = { ejectedAt: LAST_REMOVAL };

/** The fake code host with pull request #3460 (an org-less author, the row it closes unblocked) in the state `c` says. */
function world3460(c: Case) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.repo = REPO;
  world.rows.set(1, fakeRow(world, 1));
  const pull = fakePull(world, 3460, { body: "Closes #1", author: "worker-1", ejectedAt: c.ejectedAt ?? null, ejectionUnread: c.unread });
  if (c.queued === true) world.queue.entries = [{ state: "QUEUED", enqueuedAt: LAST_REMOVAL, position: 1, headSha: null, pull: 3460, pullId: "PR_3460" }];
  if (c.refuse !== undefined) world.failures.set("readQueueEjection", c.refuse);
  substituteCodeHost(host);
  return { world, pull };
}

// --- the shared decision ---

test("#3487 (1): #3460's ejection reads EJECTED, and the reason carries the ejection time and the remedy", () => {
  world3460(EJECTED_3460);
  const verdict = ejectionVerdict({ number: 3460, repo: REPO });
  assert.equal(verdict.kind, "ejected");
  assert.ok("why" in verdict && verdict.why.includes(LAST_REMOVAL), "the ejection time");
  assert.match("why" in verdict ? verdict.why : "", /without a push[^.]*fails the same way/);
  assert.match("why" in verdict ? verdict.why : "", /a push to the head/);
});

/** The code host reads a push since the last removal, no queue history and another reason for the removal all as "not ejected" (the plugin's `armed-state.test.ts` holds each of them). */
const PUSHED_SINCE = "(2)(3) not ejected: a push since, no history, another reason";

/** Each control is #3460 with ONE thing changed. */
const CONTROLS: Record<string, Case> = {
  [PUSHED_SINCE]: { ejectedAt: null },
  "it is IN the queue now, whatever the history says": { ...EJECTED_3460, queued: true },
};

test("#3487 (2)(3) CONTROLS: a push since, no queue history, another reason and a live queue entry are all CLEAR", () => {
  assert.ok(Object.keys(CONTROLS).length >= 2, "the controls exist, so the loop below cannot pass by being empty");
  for (const [name, c] of Object.entries(CONTROLS)) {
    world3460(c);
    assert.deepEqual(ejectionVerdict({ number: 3460, repo: REPO }), { kind: "clear" }, name);
  }
});

test("#3487 (4): a refused read is `cannot-ask` -- not clear, and not ejected -- for a throw and for an answer with no history", () => {
  for (const c of [{ ...EJECTED_3460, refuse: new Error("HTTP 502") }, { ...EJECTED_3460, unread: true }]) {
    world3460(c);
    const verdict = ejectionVerdict({ number: 3460, repo: REPO });
    assert.equal(verdict.kind, "cannot-ask");
    assert.match("why" in verdict ? verdict.why : "", /#3460/);
  }
});

// --- door one: the per-PR `arm` job ---

function driveArm(c: Case) {
  const { pull } = world3460(c);
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=3460", `--repo=${REPO}`], env: {}, sleep: () => "ok" as const,
    log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes: { lanes: [] } });
  return { code, said: said.join("\n"), merged: pull.armed };
}

test("#3487 (1) arm-pr: #3460's ejection is NOT armed -- no arm, exit DONE, the line carries the ejection time", () => {
  const out = driveArm(EJECTED_3460);
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.DONE, "waiting for a push is not a failure, as a hold is not");
  assert.match(out.said, /NOT arming #3460/);
  assert.ok(out.said.includes(LAST_REMOVAL), out.said);
});

test("#3487 (2)(3) arm-pr CONTROLS: every changed fixture ARMS, so the refusal above was reached and decided", () => {
  for (const [name, c] of Object.entries(CONTROLS)) {
    assert.equal(driveArm(c).merged, true, name);
  }
});

test("#3487 (4) arm-pr: a refused read does not arm and exits CANNOT_ASK, the code an unreadable label list already gets", () => {
  for (const c of [{ ...EJECTED_3460, refuse: new Error("HTTP 502") }, { ...EJECTED_3460, unread: true }]) {
    const out = driveArm(c);
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.CANNOT_ASK);
  }
});

// --- door two: the sweep's decider (the sweep as a real process is the plugin's end-to-end test) ---

test("#3487 sweep: `refusalBeforeArming` -- ejected is refused, a push since is clear, a refused read is `cannot-ask`", () => {
  const ask = (c: Case) => {
    const { world } = world3460(c);
    const verdict = refusalBeforeArming({ number: "3460", repo: REPO, author: "worker-1", prBody: "Closes: none — a fixture" });
    assert.ok(world.calls.every((call) => call === `readQueueEjection ${REPO}#3460`), `the only read for a non-lane author is the queue history: ${world.calls.join(" | ")}`);
    return verdict;
  };
  const ejected = ask(EJECTED_3460);
  assert.equal(ejected.kind, "ejected");
  assert.ok("why" in ejected && ejected.why.includes(LAST_REMOVAL));
  assert.equal(ask(CONTROLS[PUSHED_SINCE]).kind, "clear");
  assert.equal(ask({ ...EJECTED_3460, refuse: new Error("HTTP 502") }).kind, "cannot-ask");
});
