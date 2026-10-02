// no-token: gh -- every `gh` and `herdr` here is an injected `run` seam; nothing imported spawns the real one
/**
 * #2403: the engineer pool has NO CEILING. `sessions.json` declares the spare engineers as ONE FAMILY (`worker-<n>`
 * for n from 4) and, when every address holds a process and a claimable row waits, `spawnableRole` allocates a
 * spare instead of refusing at the list's length (#2469: named for the row, no longer the lowest free number).
 *
 * Its own file, and not a block in `wake.test.ts`, for #2280's reason: that file spawns `route`, which reaches `gh`,
 * so the token-less acceptance job refused it and verified nothing. Every fact read here -- herdr, GitHub, the
 * cycle ledger -- is injected, so the row's declared Acceptance is a command the job can RUN.
 *
 * WHERE THE ACCEPTED CASES' POSITIVE CONTROLS ARE, because an assertion that a label is accepted proves nothing
 * beside a reader that accepts everything: each reader below is also asked for a name INSIDE no family
 * (`worker-3`, below `from`; `worker-09`, a second spelling; `worker-capture-9`, another prefix) and must refuse it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, spawnableRole, spareLabelForRow, withSpareInstances, engineerRoles, spareInstances,
  endFinishedSpares, readSpareCycles, consecutiveClean, route }
  from "../wake.mjs";
import { isLiveSession, familyNumber, unknownSessionLabels, labelArmedPr, LIVE_SESSIONS, SPARE_FAMILIES }
  from "../arm-pr.mjs";
import { laneReason, runnerReason } from "../row-claim/runner-rule.mjs";
import { labelAfterCreate } from "../pr-open.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { claimRow, CLAIM_LABEL, STARTED_LABEL } from "../row-claim.mjs";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const ROSTER_OF_EIGHT = [...STANDING, "worker-4", "worker-5", "worker-6", "worker-7", "worker-8"];
const REAL_ROSTER = engineerRoles();
const ROW_ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: "engineers/ready-row-unclaimed/2403",
  prompt: "Ready row #2403 is unclaimed. Claim it with `--session=<you>`.",
};
const SESSIONS_JSON = join(HOME_CHECKOUT, ".agent-org/roles/sessions.json");

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
  return { run, said: (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb)) };
}

// --- Done-when 1: the allocation --------------------------------------------------------------------------------
// #2469: a spare is NAMED FOR ITS ROW (`worker-<row>`), so the tests that once read the LOWEST free counter now read
// the row's own number; what they still pin is that there is NO CEILING and that a held address is not shared.

test("#2403 ACCEPTANCE (1): with all eight addresses busy the spare is named for the row, not refused", () => {
  // The row's own Open-check shape: the eight-name roster, every one working, the standing three drained.
  const busy = agents(Object.fromEntries(ROSTER_OF_EIGHT.map((r) => [r, "working"])));
  assert.deepEqual(spawnableRole(ROW_ORDER, busy, ROSTER_OF_EIGHT, STANDING), { role: "worker-2403" });
  // And through `deliver`, against the REAL roster: only the standing three are listed there, and the five spares
  // that hold a process are found among the agents -- so the answer is the same.
  const h = recordingHerdr();
  const got = deliver([ROW_ORDER], busy, REAL_ROSTER, { run: h.run });
  assert.deepEqual(got.sent, ["worker-2403 <- engineers/ready-row-unclaimed/2403 (STARTED sonnet/high)"]);
  assert.deepEqual(got.refused, []);
  assert.ok(h.said("workspace create")[0].includes("--label worker-2403 "));
});

test("#2403: a free counter number no longer decides the name -- worker-5 free, and the row is still worker-2403", () => {
  const spec = Object.fromEntries(ROSTER_OF_EIGHT.map((r) => [r, "working"]));
  delete spec["worker-5"];
  const gap = agents({ ...spec, "worker-9": "working" });
  assert.deepEqual(spawnableRole(ROW_ORDER, gap, ROSTER_OF_EIGHT, STANDING), { role: "worker-5" },
    "a roster that LISTS an absent spare still offers it first (the fixture shape; the real file lists none)");
  const realShape = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-4": "working",
    "worker-6": "working", "worker-9": "working" });
  assert.deepEqual(spawnableRole(ROW_ORDER, realShape, REAL_ROSTER), { role: "worker-2403" },
    "the real roster lists no spare, so the gap at worker-5 is not filled");
});

test("#2403: no count appears -- twenty busy spares still spawn, and the `ceiling` refusal text is gone", () => {
  const spares = Array.from({ length: 20 }, (_, i) => `worker-${i + 4}`);
  const busy = agents(Object.fromEntries([...STANDING, ...spares].map((r) => [r, "working"])));
  assert.deepEqual(spawnableRole(ROW_ORDER, busy, REAL_ROSTER), { role: "worker-2403" });
  const source = readFileSync(new URL("../wake.mjs", import.meta.url), "utf8");
  assert.ok(!/that is the\s*"?\s*\+?\s*"?ceiling/.test(source) && !source.includes("adding one is `ceo`'s"),
    "the refusal that called the roster's size the ceiling no longer exists");
  // The one refusal left is a roster that DECLARES no family, and it does not call anything a ceiling.
  assert.equal(spareLabelForRow({ row: 2403, families: [] }), null);
  assert.equal(spareLabelForRow({ row: 2403 }), "worker-2403");
  assert.ok(SPARE_FAMILIES.length === 1, "the positive control: the real file declares a family, so the case above is the fixture's");
});

test("#2403 (3): an order for a row that is NOT claimable still yields no instance", () => {
  const busy = agents(Object.fromEntries(ROSTER_OF_EIGHT.map((r) => [r, "working"])));
  const h = recordingHerdr();
  const got = deliver([ROW_ORDER], busy, REAL_ROSTER, { run: h.run, claimable: () => "held (#2324)" });
  assert.deepEqual(h.said("workspace create"), [], "a held, blocked, lane-locked or fleet-gated row starts nothing");
  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /held \(#2324\)/, "and the refusal says why");
  // CONTROL: the same call with the row claimable does start one, so the refusal above is the precheck's.
  const control = recordingHerdr();
  assert.equal(deliver([ROW_ORDER], busy, REAL_ROSTER, { run: control.run, claimable: () => null }).sent.length, 1);
});

test("#2403: ONE spawn per tick still holds, and an instance that exists is OFFERED the order before another starts", () => {
  const busy = agents(Object.fromEntries(STANDING.map((r) => [r, "working"])));
  const h = recordingHerdr();
  const second = { ...ROW_ORDER, causeKey: "engineers/ready-row-unclaimed/2404" };
  const got = deliver([ROW_ORDER, second], busy, REAL_ROSTER, { run: h.run });
  assert.equal(h.said("agent start").length, 1, "MAX_SPAWNS_PER_TICK is untouched");
  assert.deepEqual(got.sent, ["worker-2403 <- engineers/ready-row-unclaimed/2403 (STARTED sonnet/high)"]);

  // An idle worker-12 (a spawn whose prompt was refused, left running) is a roster member for `route`, so the
  // next order goes to it rather than starting worker-4.
  const idle = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-12": "idle" });
  assert.deepEqual(withSpareInstances(REAL_ROSTER, idle), [...REAL_ROSTER, "worker-12"]);
  assert.deepEqual(route("engineers", idle, withSpareInstances(REAL_ROSTER, idle)), { label: "worker-12" });
  const offered = recordingHerdr();
  assert.deepEqual(deliver([ROW_ORDER], idle, REAL_ROSTER, { run: offered.run }).sent,
    ["worker-12 <- engineers/ready-row-unclaimed/2403 (no clear)"]);
  assert.deepEqual(offered.said("workspace create"), []);
  // Numeric, not lexical, order: worker-9 comes before worker-10.
  assert.deepEqual(withSpareInstances([], agents({ "worker-10": "idle", "worker-9": "idle", ceo: "idle" })),
    ["worker-9", "worker-10"]);
});

// --- Done-when 2: both directions, by each reader -----------------------------------------------------------------

/** Names INSIDE the family, the largest of them spelled every way a reader could mishandle. */
const IN_FAMILY = ["worker-4", "worker-9", "worker-10", "worker-11", "worker-99", "worker-1000"];
/** Names OUTSIDE it: below `from`, a second spelling, another prefix, and not a number. */
const OUTSIDE = ["worker-3", "worker-0", "worker-09", "worker-04", "worker-", "worker-9x", "worker-4.5",
  "worker--5", "worker-capture-9", "workers-9", "worker-fleet", "worker-<n>", "Worker-9"];

test("#2403 ACCEPTANCE (2): the family predicate accepts every number from 4 and refuses the rest", () => {
  for (const name of IN_FAMILY) assert.ok(isLiveSession(name), `${name} is a member`);
  for (const name of OUTSIDE) assert.ok(!isLiveSession(name), `${name} is not`);
  assert.equal(familyNumber("worker-11"), 11);
  assert.equal(familyNumber("worker-3"), null);
  // The listed addresses are still live, and a retired name is still not.
  assert.ok(LIVE_SESSIONS.every((s) => isLiveSession(s)));
  assert.ok(!isLiveSession("dispatcher"));
  // The family is read from the file, so the file and the predicate cannot disagree.
  const file = JSON.parse(readFileSync(SESSIONS_JSON, "utf8")) as { live: { family?: unknown }[] };
  assert.equal(file.live.filter((e) => e.family !== undefined).length, SPARE_FAMILIES.length);
});

test("#2403 ACCEPTANCE (2), reader 1 -- arm-pr's live check: `session:worker-<n>` arms the PR, `session:worker-3` does not", () => {
  const armed = (label: string) => {
    const calls: string[][] = [];
    const run = (_cmd: string, args: string[]) => {
      calls.push(args);
      return args.includes("view") ? JSON.stringify({ labels: [{ name: label }] }) : "";
    };
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => { errors.push(String(line)); };
    try {
      const { refused } = labelArmedPr({ number: "9001", repo: "org/repo", prBody: "Closes #2403\n", run });
      return { refused, edited: calls.some((c) => c.includes("edit") && c.includes(label)), errors };
    } finally {
      console.error = original;
    }
  };
  for (const name of ["worker-4", "worker-9", "worker-11"]) {
    const got = armed(`session:${name}`);
    assert.deepEqual([got.refused, got.edited], [false, true], `${name} labels the PR`);
  }
  for (const name of ["worker-3", "worker-09"]) {
    const got = armed(`session:${name}`);
    assert.deepEqual([got.refused, got.edited], [true, false], `${name} is refused and nothing is applied`);
    assert.match(got.errors.join("\n"), /every worker-<n> for n from 4/, "and the refusal names the family it would have accepted");
  }
});

test("#2403 ACCEPTANCE (2), reader 2 -- the unknown-label check", () => {
  assert.deepEqual(unknownSessionLabels(IN_FAMILY.map((n) => `session:${n}`)), []);
  assert.deepEqual(unknownSessionLabels(OUTSIDE.map((n) => `session:${n}`)).map((u) => u.label),
    OUTSIDE.map((n) => `session:${n}`), "every outside name is reported, not dropped");
  assert.ok(unknownSessionLabels(["session:worker-3"]).every((u) => u.retired === false),
    "and an unknown name is not told it was retired by the Org Reset");
});

test("#2403 ACCEPTANCE (2), reader 3 -- laneReason: a lane naming a family member reserves the row; one naming a non-member reserves nothing", () => {
  const reason = laneReason(["ready", "lane:worker-9"], "worker-5");
  assert.ok(reason?.includes("worker-9's lane"), "worker-9 is a live owner, so the row is its lane's");
  assert.equal(laneReason(["ready", "lane:worker-9"], "worker-9"), null, "and the owner itself proceeds");
  for (const name of OUTSIDE) {
    assert.equal(laneReason(["ready", `lane:${name}`], "worker-5"), null,
      `${name} names no session, so a lane for it reserves nothing (a reservation nobody can claim is a stuck row)`);
  }
});

test("#2403 ACCEPTANCE (2), reader 4 -- runnerReason compares the label to the asking session and reads no roster", () => {
  // It never consulted the roster, so a family member needs no change to be accepted and this pins that it stays true:
  // a reservation for worker-9 admits worker-9 and refuses everyone else, exactly as for a listed address.
  for (const runner of ["worker-9", "worker-31", "worker-tooling"]) {
    assert.equal(runnerReason(["ready", `runner:${runner}`], runner), null, `${runner} may take its own row`);
    assert.match(String(runnerReason(["ready", `runner:${runner}`], "worker-5")), /reserved for/,
      `${runner}'s row is refused to another session`);
  }
  assert.match(String(runnerReason(["ready", "runner:worker-3"], "worker-9")), /reserved for worker-3/,
    "a name outside the family is still just a string: nobody but that name takes it");
});

test("#2403: pr-open labels a PR opened from a family member's tree, and not one from a non-member's", () => {
  const args = ["--head", "agent/x-2403"];
  assert.deepEqual(labelAfterCreate("create", args, "worker-9"),
    [["pr", "edit", "agent/x-2403", "--add-label", "session:worker-9"]]);
  assert.deepEqual(labelAfterCreate("create", args, "worker-3"), []);
});

// --- Done-when 4 of the ruling: the label exists before it is used ------------------------------------------------

test("#2403: `row-claim` creates `session:worker-<n>` before adding it, so the first use of an address never fails", () => {
  const calls: string[][] = [];
  let reads = 0;
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "view") {
      reads += 1;
      const labels = reads === 1 ? [] : [{ name: CLAIM_LABEL }, { name: "session:worker-12" }, { name: STARTED_LABEL }];
      return JSON.stringify({ number: 2403, title: "A row", labels });
    }
    return "";
  };
  const got = claimRow(2403, "worker-12", { run, moveStatus: () => ({ moved: true }), branch: "agent/x-2403" });
  assert.equal(got.claimed, true);
  const create = calls.findIndex((a) => a[0] === "label" && a[1] === "create" && a[2] === "session:worker-12");
  // #2151: the claim's labels are one `PUT`, which names the label as `labels[]=<name>`.
  const add = calls.findIndex((a) => a[2] === "PUT" && a.includes("labels[]=session:worker-12"));
  assert.ok(create !== -1 && add !== -1 && create < add, "created, then added");
  assert.ok(calls[create].includes("--force"), "idempotently: a label a previous instance made is not an error");
});

// --- Done-when 3: the engineer lifecycle is unchanged -------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const HOUR = 3_600_000;

/** One instance that finished its row, ended exactly as `wake-spare-teardown.test.ts` ends `worker-4`. */
function endedCycle(label: string, ledger: string) {
  const listed = agents({ [label]: "idle", "worker-tooling": "idle" });
  const closed: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: listed.map((a, i) => ({ label: a.label,
        workspace_id: `w${i}`, agent_status: a.status })) } });
    }
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const got = endFinishedSpares(listed, {
    spares: spareInstances(listed), registry: { [label]: { spawnedAt: T0 - 5 * HOUR, rows: [2403] } }, now: T0, run,
    heldRows: () => [], rowState: () => "CLOSED", worktrees: () => [],
    record: (c: unknown) => writeFileSync(ledger, `${JSON.stringify(c)}\n`, { flag: "a" }), warn: () => {},
  } as never);
  return { got, closed };
}

test("#2403 ACCEPTANCE (3): `endFinishedSpares` ends worker-11 as it ends worker-4, and both ledger lines read back alike", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-family-"));
  try {
    const four = join(dir, "four");
    const eleven = join(dir, "eleven");
    const a = endedCycle("worker-4", four);
    const b = endedCycle("worker-11", eleven);
    assert.equal(a.closed.length, 1);
    assert.equal(b.closed.length, 1, "the family member's workspace is closed");
    assert.deepEqual(b.got.ended.map((c) => c.role), ["worker-11"]);

    const [lineFour] = readSpareCycles(four);
    const [lineEleven] = readSpareCycles(eleven);
    assert.deepEqual(Object.keys(lineEleven).sort(), Object.keys(lineFour).sort(), "the same fields");
    assert.deepEqual(JSON.parse(JSON.stringify(lineEleven).replaceAll("worker-11", "worker-4")), lineFour,
      "and the same values apart from the address, which the `why` names too");
    assert.deepEqual(consecutiveClean(readSpareCycles(eleven)), { run: 1, empty: false });
    assert.deepEqual(consecutiveClean([...readSpareCycles(four), ...readSpareCycles(eleven)]),
      { run: 2, empty: false }, "#1950's count continues across the family");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2403 (3) POSITIVE CONTROL: a standing engineer and a number below the family are never ended", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-family-"));
  try {
    const ledger = join(dir, "ledger");
    for (const label of ["worker-tooling", "worker-3"]) {
      const got = endedCycle(label, ledger);
      assert.deepEqual([got.closed, got.got.ended], [[], []], `${label} is not a spare`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
