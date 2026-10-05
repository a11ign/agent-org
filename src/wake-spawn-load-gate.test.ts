// no-token: gh -- every `herdr` and `git` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.mjs`, #3560: A NEW ENGINEER IS NOT STARTED WHILE THE HOST'S 1-MINUTE LOAD IS OVER ITS CORE COUNT.
 *
 * Measured by `ceo` at 21:35Z on 2026-10-04: load 98 on 16 cores with swap in use, the gate's tick 6 min 44 s, and one more
 * full-suite engineer started per tick because `MAX_SPAWNS_PER_TICK` capped the count and nothing read the load.
 *
 * DRIVEN THROUGH `deliver`, the production entry, with the reading as an injected seam (`hostLoad`, as `run` is). THE CONTROL IS
 * FIRST: load 4 on 16 cores starts the engineer, so the refusal at 98 is not simply what this fixture always does. Each other test
 * is the same fixture with ONE thing changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, MAX_SPAWNS_PER_TICK, hostLoadRefusal } from "./wake.mjs";
import { startedPanes } from "./packaging/started-pane.ts";

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const reading = (load: number, cores = 16) => () => ({ load, cores });

const engineerOrder = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed.",
};
const reviewerOrder = {
  session: "reviewer-18", cause: "draft-awaiting-verdict", causeKey: "reviewer-18/draft-awaiting-verdict/pr-18/abc12345",
  prompt: "Draft #18 is green with no verdict at its head.",
};
const promptToCeo = {
  session: "ceo", cause: "state-reading", causeKey: "ceo/state-reading/1", prompt: "Read the state.",
};
const checkoutSeams = {
  git: (_cmd: string, args: string[]) => (args.join(" ").includes("rev-parse") ? `${"d".repeat(40)}\n` : ""),
  link: () => null,
  exists: () => true,
  root: "/reviews-root",
  repoRoot: "/primary",
};

/** A herdr that opens a workspace and starts whatever it is asked to, recording every call. */
function recordingHerdr() {
  const calls: string[] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run, started: () => calls.filter((c) => c.includes("agent start")) };
}

const BUSY = agents({ ceo: "working" });

test("#3560 CONTROL: load 4 on 16 cores starts the engineer", () => {
  const herdr = recordingHerdr();
  const got = deliver([engineerOrder], BUSY, [], { run: herdr.run, hostLoad: reading(4) });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], /^worker-2131 <- engineers\/ready-row-unclaimed\/2131 \(STARTED /);
  assert.equal(herdr.started().length, 1, "a process was started");
});

test("#3560: load 98 on 16 cores refuses the spawn, naming both numbers, and starts nothing", () => {
  const herdr = recordingHerdr();
  const got = deliver([engineerOrder], BUSY, [], { run: herdr.run, hostLoad: reading(98) });

  assert.deepEqual(got.sent, []);
  assert.equal(got.refused.length, 1);
  assert.ok(got.refused[0].startsWith("engineers/ready-row-unclaimed/2131: "), got.refused[0]);
  assert.ok(got.refused[0].includes("host load 98 is over its 16 cores: no new engineer is started"), got.refused[0]);
  assert.deepEqual(herdr.started(), [], "no process was started");
});

test("#3560: it clears itself -- the same order on the next tick, with the load down, starts", () => {
  const first = deliver([engineerOrder], BUSY, [], { run: recordingHerdr().run, hostLoad: reading(98) });
  const next = deliver([engineerOrder], BUSY, [], { run: recordingHerdr().run, hostLoad: reading(4) });

  assert.equal(first.sent.length, 0);
  assert.equal(next.sent.length, 1, "no state was kept between the two");
});

test("#3560: a load exactly EQUAL to the cores does not refuse, and the least amount over does", () => {
  assert.equal(hostLoadRefusal({ load: 16, cores: 16 }), null);
  assert.equal(hostLoadRefusal({ load: 15.99, cores: 16 }), null);
  assert.equal(hostLoadRefusal({ load: 16.01, cores: 16 }), "host load 16.01 is over its 16 cores: no new engineer is started");
  assert.equal(hostLoadRefusal(undefined), null, "no reading is no refusal");
  assert.equal(hostLoadRefusal({ load: Number.NaN, cores: 16 }), null, "an unreadable load is not a refusal either");

  const got = deliver([engineerOrder], BUSY, [], { run: recordingHerdr().run, hostLoad: reading(16) });
  assert.equal(got.sent.length, 1, "through `deliver` too");
});

test("#3560: a reviewer start is untouched at load 98", () => {
  const herdr = recordingHerdr();
  const got = deliver([reviewerOrder], BUSY, [], { run: herdr.run, checkout: checkoutSeams, hostLoad: reading(98) });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], /^reviewer-18 /);
  assert.equal(herdr.started().length, 1);
});

test("#3560: a prompt to a live seat is untouched at load 98", () => {
  const got = deliver([promptToCeo], agents({ ceo: "idle" }), [], { run: recordingHerdr().run, hostLoad: reading(98) });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], /^ceo /);
});

test("#3560: a free engineer taking a row is untouched at load 98", () => {
  const herdr = recordingHerdr();
  const got = deliver([engineerOrder], agents({ ceo: "working", "worker-1": "idle" }), ["worker-1"],
    { run: herdr.run, hostLoad: reading(98) });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent.join("\n"), /^worker-1 <- /, "the idle engineer was prompted");
  assert.deepEqual(herdr.started(), [], "and nothing new was started");
});

test("#3560: MAX_SPAWNS_PER_TICK still reads 1", () => {
  assert.equal(MAX_SPAWNS_PER_TICK, 1);
});
