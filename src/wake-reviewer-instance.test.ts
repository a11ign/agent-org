// no-token: gh -- every `gh` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/wake.mjs`, #2401: ONE CODEX REVIEWER PER PULL REQUEST, addressed by herdr name.
 *
 * Its own file, and not a block in `wake.test.ts`, for #2280's reason: that file reaches `gh`, so the token-less
 * acceptance job refused it and verified nothing. Every fact read here -- herdr, GitHub -- is an injected seam or a
 * stub on PATH.
 *
 * WHAT IS PINNED, in the row's own order: the instance for PR n is the workspace `reviewer-<n>` started with
 * `A11Y_REVIEWER_SESSION=reviewer-<n>` and the reviewer's own account; the SAME instance answers the next
 * head; the ceiling of 4 REFUSES with a line naming the count; the standing pair never counts against it and is
 * never ended; and the engineer path -- `spawnableRole`, `SPAWN_CAUSES`, `registerSpawn`, the `spare-cycles`
 * ledger -- reads exactly as it did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliver, route, spawnableRole, SPAWN_CAUSES, MAX_REVIEWER_INSTANCES, MAX_REVIEWER_SPAWNS_PER_TICK,
  REVIEWER_CAUSES, REVIEWER_GH_CONFIG_DIR, reviewerEnvironment, spawnableReviewer, isReviewerOrder,
  liveReviewers, endFinishedReviewers, registerReviewer, reviewerPathsFrom, sparePathsFrom, spawnEnvironment,
  MAX_SPAWNS_PER_TICK,
} from "./wake.mjs";
import { readReviewerRegistry, REVIEWER_REGISTRY_FILE } from "./work-gate.mjs";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling", "worker-4"];
const STUB_MODE = 0o755; // the tick invokes `herdr` and `gh` as commands, so the stubs have to be runnable
const TICK_ENTRY = fileURLToPath(new URL("./work-tick.mjs", import.meta.url));

/** The order the gate emits for PR `n`: addressed to `reviewer-<n>`, the name `parityOwner` returns. */
const reviewOrder = (n: number, cause = "draft-awaiting-verdict") => ({
  session: `reviewer-${n}`, cause, causeKey: `reviewer-${n}/${cause}/pr-${n}/abc12345`,
  prompt: `Draft #${n} is green with no verdict at its head.`,
});
/** The standing three are busy, so the first ABSENT engineer role is the spare `worker-4`. */
const STANDING = agents({ "worker-capture": "working", "worker-judge": "working", "worker-tooling": "working" });
const ROW_ORDER = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed.",
};

/** A `herdr` that records every call and answers `workspace create` as the live org did on 2026-09-23. */
function recordingHerdr() {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  const said = (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb));
  return { calls, run, said };
}

// --- the instance for PR n is the workspace `reviewer-<n>` ------------------------------------------------

test("#2401 (1): with no `reviewer-<n>` live, the order STARTS one -- a codex in a workspace of that name, "
  + "as the reviewer's account, with its own session name in the environment", () => {
  const h = recordingHerdr();
  const told: string[] = [];
  const out = deliver([reviewOrder(2398)], agents({ ceo: "working" }), ROSTER,
    { run: h.run, registerReviewer: (s) => told.push(s) });

  assert.match(out.sent[0], /^reviewer-2398 <- reviewer-2398\/draft-awaiting-verdict\/pr-2398\/abc12345 \(STARTED gpt-5\.6-luna\/medium\)$/);
  const [create] = h.said("workspace create");
  assert.match(create, /--label reviewer-2398/);
  assert.ok(create.includes(`--env GH_CONFIG_DIR=${REVIEWER_GH_CONFIG_DIR}`), create);
  assert.ok(create.includes("--env A11Y_REVIEWER_SESSION=reviewer-2398"), create);
  const [start] = h.said("agent start");
  assert.match(start, /agent start reviewer-2398 --kind codex --pane wB:p1/, "a codex, named for the pull request");
  assert.deepEqual(told, ["reviewer-2398"], "the start is registered, for the detector and the teardown");
  assert.equal(h.said("/clear").length, 0, "a process that has existed for two seconds has nothing to clear");
  assert.match(h.said("agent prompt reviewer-2398")[0], /Draft #2398/, "and the order is delivered to it");
});

test("#2401 (1b): the reviewer's own account is `/home/agent/reviewer/gh`, never the workers' -- and an "
  + "override wins key by key", () => {
  assert.equal(REVIEWER_GH_CONFIG_DIR, "/home/agent/reviewer/gh");
  assert.notEqual(REVIEWER_GH_CONFIG_DIR, spawnEnvironment().GH_CONFIG_DIR);
  assert.deepEqual(reviewerEnvironment("reviewer-7"),
    { GH_CONFIG_DIR: "/home/agent/reviewer/gh", A11Y_REVIEWER_SESSION: "reviewer-7" });
  assert.equal(reviewerEnvironment("reviewer-7", { GH_CONFIG_DIR: "/x" }).GH_CONFIG_DIR, "/x");
});

test("#2401 (2): a LIVE idle `reviewer-<n>` answers the next head -- the same instance, cleared, no second one", () => {
  const h = recordingHerdr();
  const told: string[] = [];
  const out = deliver([reviewOrder(2398, "verdict-comment-unreviewed")], agents({ "reviewer-2398": "idle" }), ROSTER,
    { run: h.run, registerReviewer: (s) => told.push(s) });
  assert.deepEqual(out.sent, ["reviewer-2398 <- reviewer-2398/verdict-comment-unreviewed/pr-2398/abc12345"]);
  assert.equal(h.said("workspace create").length, 0, "no second workspace under a label that exists");
  assert.equal(h.said("agent start").length, 0);
  assert.ok(h.said("/clear").length > 0, "context is cleared per pull request before the order is typed");
  assert.deepEqual(told, [], "and a reused instance is not re-registered");
});

test("#2401: a `reviewer-<n>` that is WORKING waits for the next tick -- it is not started a second time", () => {
  const h = recordingHerdr();
  const out = deliver([reviewOrder(2398)], agents({ "reviewer-2398": "working" }), ROSTER, { run: h.run });
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /"reviewer-2398" is working/);
  assert.equal(h.said("workspace create").length, 0);
});

test("#2401: `route` finds the instance by its herdr LABEL, so an order addressed to it needs no roster entry", () => {
  assert.deepEqual(route("reviewer-2398", agents({ "reviewer-2398": "idle" }), ROSTER), { label: "reviewer-2398" });
  assert.match(String((route("reviewer-2398", agents({}), ROSTER) as { refusal: string }).refusal), /no workspace labelled/);
});

// --- THE CEILING: 4 live, REFUSED with the count, never silently dropped ---------------------------------------

test("#2401 (3): a fifth instance is REFUSED with a line naming the count and the ceiling -- and nothing is started", () => {
  assert.equal(MAX_REVIEWER_INSTANCES, 4, "a pilot number, `ceo`'s to raise");
  const full = agents({ "reviewer-101": "working", "reviewer-102": "idle", "reviewer-103": "working", "reviewer-104": "idle" });
  const h = recordingHerdr();
  const out = deliver([reviewOrder(105)], full, ROSTER, { run: h.run });
  assert.deepEqual(out.sent, []);
  assert.equal(out.refused.length, 1, "REFUSED, not dropped: it comes back as an undelivered order");
  assert.match(out.refused[0], /4 live reviewer instance\(s\) \(reviewer-101, reviewer-102, reviewer-103, reviewer-104\)/);
  assert.match(out.refused[0], /the ceiling is 4/);
  assert.equal(h.said("workspace create").length, 0, "no pane was opened to be refused");
});

test("#2401 CONTROL: THREE live instances leave room for the fourth -- so the refusal above is the ceiling, "
  + "not a spawn path that always refuses", () => {
  const three = agents({ "reviewer-101": "working", "reviewer-102": "working", "reviewer-103": "working" });
  const h = recordingHerdr();
  const out = deliver([reviewOrder(105)], three, ROSTER, { run: h.run });
  assert.equal(out.sent.length, 1);
  assert.equal(out.refused.length, 0);
  assert.equal(h.said("workspace create").length, 1);
});

test("#2401: the retired standing pair are NOT instances -- they do not count against the ceiling and are not "
  + "started into", () => {
  const standing = agents({ reviewer: "idle", "reviewer-2": "idle", "reviewer-101": "working", "reviewer-102": "working",
    "reviewer-103": "working" });
  assert.deepEqual(liveReviewers(standing), ["reviewer-101", "reviewer-102", "reviewer-103"]);
  assert.ok("session" in spawnableReviewer(reviewOrder(105), standing),
    "three instances plus the two standing panes is still room for a fourth");
  assert.equal(isReviewerOrder({ session: "reviewer-2", cause: "draft-awaiting-verdict" }), false,
    "`reviewer-2` is the retired pane, so no instance is ever started under its name");
  assert.equal(isReviewerOrder({ session: "reviewer", cause: "draft-awaiting-verdict" }), false);
});

test("#2401: only the two reviewer causes start an instance -- a `pr-checks-failing` order to `reviewer-<n>` does not", () => {
  assert.deepEqual([...REVIEWER_CAUSES], ["draft-awaiting-verdict", "verdict-comment-unreviewed"]);
  assert.equal(isReviewerOrder({ session: "reviewer-9", cause: "pr-checks-failing" }), false);
  assert.equal(isReviewerOrder({ session: "worker-4", cause: "draft-awaiting-verdict" }), false);
  const h = recordingHerdr();
  const out = deliver([reviewOrder(9, "pr-checks-failing")], agents({}), ROSTER, { run: h.run });
  assert.equal(h.said("workspace create").length, 0);
  assert.equal(out.refused.length, 1);
});

test("#2401: ONE reviewer instance is started per tick -- a partial workspace list must cost one process, not one "
  + "per waiting pull request", () => {
  assert.equal(MAX_REVIEWER_SPAWNS_PER_TICK, 1);
  const h = recordingHerdr();
  const out = deliver([reviewOrder(201), reviewOrder(202)], agents({}), ROSTER, { run: h.run });
  assert.equal(out.sent.length, 1);
  assert.equal(h.said("workspace create").length, 1);
  assert.match(out.refused[0], /this tick has already started 1 reviewer instance\(s\)/);
});

// --- THE ENGINEER PATH IS NOT CHANGED (Done-when 3) ---------------------------------------------------------------

test("#2401 (3b): `spawnableRole`, `SPAWN_CAUSES` and `MAX_SPAWNS_PER_TICK` read exactly as before -- a reviewer "
  + "cause is still not a pilot cause", () => {
  assert.deepEqual([...SPAWN_CAUSES], ["ready-row-unclaimed"]);
  assert.equal(MAX_SPAWNS_PER_TICK, 1);
  const refused = spawnableRole(reviewOrder(5), STANDING, ROSTER) as { refusal: string };
  assert.match(refused.refusal, /no spawn: the pilot covers the engineer pool, and this order is addressed to "reviewer-5"/);
  assert.deepEqual(spawnableRole(ROW_ORDER, STANDING, ROSTER), { role: "worker-4" });
});

test("#2401 (3c): an engineer order still starts an engineer and REGISTERS it as a spare -- a reviewer start in the "
  + "same tick neither spends its allowance nor touches the spare registry", () => {
  const h = recordingHerdr();
  const spares: string[] = [];
  const reviewers: string[] = [];
  const out = deliver([reviewOrder(2398), ROW_ORDER], STANDING, ROSTER,
    { run: h.run, registerSpawn: (r) => spares.push(r), registerReviewer: (s) => reviewers.push(s) });
  assert.equal(out.sent.length, 2, "both were started in one tick: each has its own allowance");
  assert.deepEqual(spares, ["worker-4"], "only the ENGINEER start reaches `registerSpawn`, which feeds `spare-cycles`");
  assert.deepEqual(reviewers, ["reviewer-2398"]);
  assert.match(out.sent.join("\n"), /worker-4 <- engineers\/ready-row-unclaimed\/2131 \(STARTED sonnet\/high\)/);
});

test("#2401 (3d): the reviewer registry is its OWN file -- it is never the spare registry or the `spare-cycles` ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-paths-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const rv = reviewerPathsFrom(ledger);
    const sp = sparePathsFrom(ledger);
    assert.equal(rv.registry, join(dir, REVIEWER_REGISTRY_FILE));
    assert.ok(![sp.registry, sp.cycles].includes(rv.registry) && ![sp.registry, sp.cycles].includes(rv.endings));
    registerReviewer(rv, "reviewer-77", 1234);
    assert.deepEqual(readReviewerRegistry(rv.registry), { "reviewer-77": { spawnedAt: 1234 } },
      "what `wake` writes is what the gate's detector reads");
    assert.equal(existsSync(sp.cycles), false, "a reviewer start writes no `spare-cycles` line");
    assert.equal(existsSync(sp.registry), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- THE TEARDOWN: an instance ends when its pull request merges or closes -----------------------------------

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

function teardown(over: Record<string, unknown> = {}, live = { "reviewer-9001": "idle" } as Record<string, string>) {
  const closed: string[] = [];
  const records: { session: string; pr: number; state: string; workspace: string }[] = [];
  const warned: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: Object.entries(live).map(([label, agent_status], i) =>
        ({ label, agent_status, workspace_id: `wR${i}` })) } });
    }
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const deps = { registry: { "reviewer-9001": { spawnedAt: T0 } }, now: T0 + 3_600_000, run,
    prState: () => "closed" as string | null, record: (l: object) => records.push(l as (typeof records)[number]),
    warn: (l: string) => warned.push(l), ...over };
  const got = endFinishedReviewers(agents(live), deps as never);
  return { got, closed, records, warned };
}

test("#2401 (2b): an idle instance whose pull request has MERGED OR CLOSED is ended, and the ending is one ledger line", () => {
  const { got, closed, records } = teardown();
  assert.deepEqual(got.ended, ["reviewer-9001"]);
  assert.deepEqual(closed, ["--session org workspace close wR0"]);
  assert.deepEqual(got.registry, {}, "and it leaves the registry");
  assert.deepEqual([records[0].session, records[0].pr, records[0].state, records[0].workspace],
    ["reviewer-9001", 9001, "closed", "closed"]);
});

test("#2401 CONTROL: an OPEN pull request's instance survives -- head-changing pushes re-review on the same one", () => {
  const { got, closed } = teardown({ prState: () => "open" });
  assert.deepEqual([got.ended, closed], [[], []]);
  assert.deepEqual(Object.keys(got.registry), ["reviewer-9001"]);
});

test("#2401: a WORKING instance is left until it is between turns, and an unreadable state ends nothing, said", () => {
  assert.deepEqual(teardown({}, { "reviewer-9001": "working" }).closed, []);
  const unread = teardown({ prState: () => null });
  assert.deepEqual([unread.got.ended, unread.closed], [[], []]);
  assert.match(unread.warned[0], /could not read PR #9001's state -- leaving "reviewer-9001" running/);
});

test("#2401: a workspace that will not close is left, said and retried -- no ledger line for an ending that did not happen", () => {
  const { got, records, warned } = teardown({
    run: (args: string[]) => {
      if (args.join(" ").endsWith("workspace list")) {
        return JSON.stringify({ result: { workspaces: [{ label: "reviewer-9001", workspace_id: "wR0", agent_status: "idle" }] } });
      }
      throw new Error("herdr: refused\nstack");
    },
  });
  assert.deepEqual([got.ended, records], [[], []]);
  assert.match(warned[0], /could not be closed \(herdr: refused\) -- retried next tick/);
});

test("#2401 (6): THE STANDING PANES ARE NEVER ENDED -- not in the registry, so a merged PR 2 and a `reviewer` label "
  + "close nothing (cutover is `ceo`'s)", () => {
  const { got, closed } = teardown({ registry: {} },
    { reviewer: "idle", "reviewer-2": "idle", "reviewer-9001": "idle" });
  assert.deepEqual([got.ended, closed], [[], []], "a workspace that merely LOOKS like an instance is not one");
  // And a registry entry for the retired name is refused too: it names no pull request an instance could own.
  const stray = teardown({ registry: { "reviewer-2": { spawnedAt: T0 } } }, { "reviewer-2": "idle" });
  assert.deepEqual([stray.got.ended, stray.closed], [[], []]);
});

// --- THE WIRING, AS PROCESSES ----------------------------------------------------------------------------------
//
// `work-tick` must call the teardown on a QUIET gate (a merge produces no order, and `wake` is never run on a quiet
// gate), and `wake` must register what it starts. Neither is reachable by a test that injects the seam.

test("#2401 THE TICK: a QUIET gate still ends a finished reviewer instance, and never closes the standing pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-tick-reviewer-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const log = join(dir, "herdr-calls");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + log + "\ncase \"$*\" in\n  *'workspace list') printf '%s' "
      + `'{"result":{"workspaces":[{"label":"reviewer-9001","workspace_id":"wR","agent_status":"idle"},`
      + `{"label":"reviewer","workspace_id":"w7","agent_status":"idle"},`
      + `{"label":"reviewer-2","workspace_id":"wA","agent_status":"idle"}]}}'`
      + " ;;\n  *) : ;;\nesac\n");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"issue list\"*) printf '%s' '[]' ;;\n"
      + "  *'pulls/9001'*) printf '%s' 'closed' ;;\n  *) exit 1 ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    chmodSync(join(dir, "gh"), STUB_MODE);
    writeFileSync(reviewerPathsFrom(ledger).registry, JSON.stringify({ "reviewer-9001": { spawnedAt: T0 } }));
    const ran = spawnSync(process.execPath, [TICK_ENTRY, `--ledger=${ledger}`], { encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });

    const calls = readFileSync(log, "utf8");
    assert.match(calls, /workspace close wR/, `the tick closed the finished instance; got ${ran.stderr}`);
    assert.doesNotMatch(calls, /workspace close w7|workspace close wA/, "the standing pair stay running");
    assert.match(ran.stderr, /ENDED reviewer-9001: its pull request is no longer open/);
    assert.deepEqual(readReviewerRegistry(reviewerPathsFrom(ledger).registry), {});
    assert.equal(existsSync(sparePathsFrom(ledger).cycles), false, "and no `spare-cycles` line was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2401 THE WAKE ENTRY: a started reviewer instance is REGISTERED with its start time, in a file of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-reg-"));
  try {
    const ledger = join(dir, "wake-ledger");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\ncase \"$*\" in\n  *'workspace list') printf '%s' '{\"result\":{\"workspaces\":[]}}' ;;\n"
      + "  *'workspace create'*) printf '%s' '{\"result\":{\"root_pane\":{\"pane_id\":\"wB:p1\"},\"workspace\":{\"workspace_id\":\"wB\"}}}' ;;\n"
      + "  *) : ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf '%s' '[]'\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    const before = Date.now();
    const ran = spawnSync(process.execPath, [TICK_ENTRY.replace("work-tick.mjs", "wake.mjs"), `--ledger=${ledger}`,
      "--roster=worker-4"], { input: `${JSON.stringify(reviewOrder(2398))}\n`, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    assert.match(ran.stdout, /WOKE reviewer-2398 <- reviewer-2398\/draft-awaiting-verdict\/pr-2398\/abc12345 \(STARTED gpt-5\.6-luna\/medium\)/, ran.stderr);
    const registry = JSON.parse(readFileSync(reviewerPathsFrom(ledger).registry, "utf8"));
    assert.deepEqual(Object.keys(registry), ["reviewer-2398"]);
    assert.ok(registry["reviewer-2398"].spawnedAt >= before, "stamped at the start, which the detector compares to `last_refresh`");
    assert.equal(existsSync(sparePathsFrom(ledger).registry), false, "the engineer registry is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
