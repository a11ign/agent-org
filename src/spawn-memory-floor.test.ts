// no-token: gh -- every `herdr` here is an injected seam or a stub on PATH, the claim is a fake, and the memory reading is a fixture; nothing imported reaches the real `gh`, `herdr` or `/proc/meminfo`
/**
 * `packages/agent-org/src/spawn-memory-floor.mjs`, #2508: THE SPAWNER HOLDS A NEW INSTANCE WHILE `MemAvailable` IS BELOW A FLOOR.
 *
 * WHAT IS PINNED, in the row's own order: the pure decision (Done-when 1), the floor's value and that it says it is
 * CHOSEN (2), the hold BOTH ways with no pane and no claim behind it (3), an unreadable reading that neither holds nor
 * passes silently (4), and a held order that is offered again and not consumed (5). The reviewer path is held too, and
 * the wake ENTRY is driven as a subprocess so the wiring in `main` is read and not assumed.
 *
 * THE READING IS NEVER THE HOST'S: every test hands the gate a fixture, so a host that is short of memory today cannot
 * turn one of them red -- the property a test of a memory gate most needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holdForMemory, parseMemAvailableKb, readMemAvailable, spawnMemoryGate, SPAWN_MEMORY_FLOOR_KB, MEMINFO_PATH, MEMINFO_ENV,
} from "./spawn-memory-floor.mjs";
import { DEFAULT_MEMORY_MAX } from "../../guards/src/test-memory-cap.mjs";
import { deliver } from "./wake.mjs";

const KB_PER_MB = 1024;
const KB_PER_GB = 1024 * 1024;
/** ceo's reading during the runaway, 2026-09-25 13:14Z: the value to stay ABOVE, never a floor to copy. */
const RUNAWAY_KB = 351 * KB_PER_MB;
/** The idle host when the row was filed (`MemAvailable: 23830268 kB`). */
const IDLE_HOST_KB = 23_830_268;
const FLOOR_KB = SPAWN_MEMORY_FLOOR_KB;
const STUB_MODE = 0o755;
const WAKE_ENTRY = fileURLToPath(new URL("./wake.mjs", import.meta.url));

/** The text `/proc/meminfo` carries around the one line that matters, as the kernel prints it. */
const meminfo = (availableKb: number) =>
  `MemTotal:       31594708 kB\nMemFree:          412000 kB\nMemAvailable:   ${availableKb} kB\nBuffers:          10240 kB\n`;

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROW_ORDER = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed.",
};
const reviewOrder = (n: number) => ({
  session: `reviewer-${n}`, cause: "draft-awaiting-verdict", causeKey: `reviewer-${n}/draft-awaiting-verdict/pr-${n}/abc12345`,
  prompt: `Draft #${n} is green with no verdict at its head.`,
});

/** A `herdr` that records every call and answers `workspace create` as the live org does. */
function recordingHerdr() {
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    return args.join(" ").includes("workspace create")
      ? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } }) : "{}";
  };
  return { calls, run };
}

/** A claim that records that it was asked and lands, so "no claim was made" is an assertion about a call and not an absence. */
function recordingClaimer() {
  const asked: string[] = [];
  const claimer = {
    claim: (order: { causeKey: string }, role: string) => {
      asked.push(`${order.causeKey} -> ${role}`);
      return { row: 2131, worktree: "/wt/wt-2131", branch: "agent/x-2131", session: role };
    },
    release: () => "",
  };
  // The claimer's declared shape carries facts this test does not need; the seam takes what it is given.
  return { asked, claimer: claimer as never };
}

// --- Done-when 1: the pure decision ------------------------------------------------------------------------

test("#2508 (1): a reading AT or ABOVE the floor is no hold; one below it is a sentence naming the reading, the floor "
  + "and MemAvailable's source", () => {
  assert.equal(holdForMemory({ availableKb: FLOOR_KB, floorKb: FLOOR_KB }), null, "at the floor is not below it");
  assert.equal(holdForMemory({ availableKb: FLOOR_KB + 1, floorKb: FLOOR_KB }), null);
  assert.equal(holdForMemory({ availableKb: IDLE_HOST_KB, floorKb: FLOOR_KB }), null);

  const held = holdForMemory({ availableKb: FLOOR_KB - 1, floorKb: FLOOR_KB });
  assert.ok(held !== null, "one kB under the floor is a hold -- otherwise the assertions below judge nothing");
  assert.match(held, /MemAvailable/);
  assert.ok(held.includes(`${FLOOR_KB - 1} kB`), `the reading is named exactly: ${held}`);
  assert.ok(held.includes(`${FLOOR_KB} kB`), `the floor is named exactly: ${held}`);
  assert.ok(held.includes(MEMINFO_PATH), `and where the reading came from: ${held}`);
  assert.match(held, /CHOSEN/, "and it says the floor is chosen, not measured");
});

test("#2508 (1b): MemAvailable is parsed from the line, not from MemFree -- and a text without one is null, not zero", () => {
  assert.equal(parseMemAvailableKb(meminfo(351 * KB_PER_MB)), 351 * KB_PER_MB, "MemFree (412000) is a different line");
  assert.equal(parseMemAvailableKb("MemTotal: 1 kB\nMemFree: 2 kB\n"), null);
  assert.equal(parseMemAvailableKb("MemAvailable: lots\n"), null, "a non-number is not a reading");
  assert.equal(parseMemAvailableKb(""), null);
});

// --- Done-when 2: the floor ---------------------------------------------------------------------------------

test("#2508 (2): the floor sits above the runaway's reading, well below the idle host, and not below M1's cap plus one instance", () => {
  assert.ok(RUNAWAY_KB < FLOOR_KB, "a reading during the runaway is held");
  assert.ok(holdForMemory({ availableKb: RUNAWAY_KB, floorKb: FLOOR_KB } ) !== null);
  assert.ok(FLOOR_KB < IDLE_HOST_KB / 2, "well below the idle host, so an ordinary tick is never held");
  // M1's cap is read from ITS module, not restated, so raising it past this floor is a red test and not a silent hole.
  const cap = /^(\d+)G$/.exec(DEFAULT_MEMORY_MAX);
  assert.ok(cap !== null, `the cap is stated in whole G: ${DEFAULT_MEMORY_MAX}`);
  const INSTANCE_KB = 200 * KB_PER_MB; // `ceo`'s 12:01Z process table: about 200 MB per claude
  assert.ok(FLOOR_KB >= Number(cap[1]) * KB_PER_GB + INSTANCE_KB,
    "a spawn that then starts a capped run must not begin with the cap already out of reach");
});

// --- Done-when 3: both ways, and no pane and no claim behind a hold -----------------------------------------

test("#2508 (3a): BELOW the floor the order is refused `no spawn:` naming MemAvailable, the floor and the reading -- and "
  + "NO pane is opened, NO claim is asked, NO precheck is run", () => {
  const h = recordingHerdr();
  const c = recordingClaimer();
  const asked: string[] = [];
  const out = deliver([ROW_ORDER], agents({}), [], {
    run: h.run, claimer: c.claimer, claimable: (o) => { asked.push(o.causeKey); return null; },
    memory: spawnMemoryGate({ read: () => meminfo(RUNAWAY_KB), warn: () => assert.fail("a readable file warns of nothing") }),
  });

  assert.deepEqual(out.sent, [], "nothing was delivered");
  assert.equal(out.refused.length, 1);
  assert.match(out.refused[0], /no spawn: held for memory: the host's MemAvailable is 351 MB \(359424 kB, from \/proc\/meminfo\)/);
  assert.ok(out.refused[0].includes(`${FLOOR_KB} kB`), out.refused[0]);
  assert.deepEqual(h.calls, [], "herdr was not called at all: no workspace, no agent start, no prompt");
  assert.deepEqual(c.asked, [], "the claim was not made");
  assert.deepEqual(asked, [], "and the claim's PRECHECK was not run either, since the answer is known before it");
});

test("#2508 (3b): AT the floor the order spawns exactly as it did -- a pane, a claim, and the order delivered", () => {
  const h = recordingHerdr();
  const c = recordingClaimer();
  const recorded: string[] = [];
  const out = deliver([ROW_ORDER], agents({}), [], {
    run: h.run, claimer: c.claimer, record: (k) => recorded.push(k),
    memory: spawnMemoryGate({ read: () => meminfo(FLOOR_KB) }),
  });

  assert.deepEqual(out.refused, []);
  assert.match(out.sent[0], /^worker-2131 <- engineers\/ready-row-unclaimed\/2131 \(STARTED /);
  assert.equal(c.asked.length, 1, "the claim was made");
  assert.ok(h.calls.some((s) => s.includes("workspace create")), "and a pane opened");
  assert.deepEqual(recorded, ["engineers/ready-row-unclaimed/2131"]);
});

test("#2508 (3c): a `deliver` given NO gate spawns as it did before -- the seam's absence is not a hold", () => {
  const h = recordingHerdr();
  const out = deliver([ROW_ORDER], agents({}), [], { run: h.run, claimer: recordingClaimer().claimer });
  assert.match(out.sent[0] ?? "", /STARTED/, `${out.refused.join(" | ")}`);
});

// --- Done-when 4: an unreadable reading is neither a hold nor a silent pass ----------------------------------

test("#2508 (4): an unreadable /proc/meminfo spawns as today AND says the reading was unavailable -- and the two faults "
  + "(no file, no line) are told apart", () => {
  const warned: string[] = [];
  const h = recordingHerdr();
  const out = deliver([ROW_ORDER], agents({}), [], {
    run: h.run, claimer: recordingClaimer().claimer,
    memory: spawnMemoryGate({ read: () => { throw new Error("ENOENT: no such file or directory, open '/proc/meminfo'\nat x"); },
      warn: (l) => warned.push(l) }),
  });
  assert.match(out.sent[0] ?? "", /STARTED/, "no reading is not a hold");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /memory reading unavailable/);
  assert.match(warned[0], /ENOENT/);
  assert.doesNotMatch(warned[0], /\n.|at x/, "one line: the first line of the error only");
  assert.match(warned[0], /NOT the same as memory being fine|not\s+the same as memory being fine/);

  const noLine = readMemAvailable({ read: () => "MemTotal: 1 kB\n" });
  assert.ok("unavailable" in noLine && /no MemAvailable line/.test(noLine.unavailable), JSON.stringify(noLine));
  const noFile = readMemAvailable({ read: () => { throw new Error("ENOENT"); } });
  assert.ok("unavailable" in noFile && /could not be read/.test(noFile.unavailable), JSON.stringify(noFile));
});

// --- Done-when 5: the hold is offered again -----------------------------------------------------------------

test("#2508 (5): a held order is NOT consumed -- tick one is below the floor and writes nothing, tick two is above it and "
  + "spawns once", () => {
  let reading = RUNAWAY_KB;
  const memory = spawnMemoryGate({ read: () => meminfo(reading) });
  const h = recordingHerdr();
  const c = recordingClaimer();
  const recorded: string[] = [];
  const deps = { run: h.run, claimer: c.claimer, memory, record: (k: string) => recorded.push(k) };

  const first = deliver([ROW_ORDER], agents({}), [], deps);
  assert.equal(first.refused.length, 1, "tick one refuses the order by name");
  assert.deepEqual(recorded, [], "and writes NOTHING to the ledger, which is what lets tick two see it again");
  assert.equal(c.asked.length, 0);

  reading = IDLE_HOST_KB;
  const second = deliver([ROW_ORDER], agents({}), [], deps);
  assert.deepEqual(second.refused, []);
  assert.equal(second.sent.length, 1, "tick two spawns");
  assert.equal(c.asked.length, 1, "exactly once");
  assert.deepEqual(recorded, [ROW_ORDER.causeKey]);
  assert.equal(h.calls.filter((s) => s.includes("workspace create")).length, 1, "and one pane");
});

// --- The reviewer path: held too, and only when it would ADD a process ---------------------------------------

test("#2508 (reviewer): a NEW `reviewer-<n>` is held below the floor BEFORE its checkout or pane; a LIVE one is not asked", () => {
  const h = recordingHerdr();
  const git: string[] = [];
  // `link` is #2498's seam: a checkout ends in `linkReviewDependencies`, which REFUSES a tree with no dependencies, and
  // this test has no disk -- so the link is injected, as `wake-reviewer-instance.test.ts` does, never a real `node_modules`.
  const checkout = { git: (_c: string, a: string[]) => { git.push(a.join(" ")); return ""; }, link: () => null,
    exists: () => true, root: "/reviews-root", repoRoot: "/primary" };
  const memory = spawnMemoryGate({ read: () => meminfo(RUNAWAY_KB) });

  const held = deliver([reviewOrder(2398)], agents({ ceo: "working" }), [], { run: h.run, checkout, memory });
  assert.deepEqual(held.sent, []);
  assert.match(held.refused[0], /no spawn: held for memory: the host's MemAvailable is 351 MB/);
  assert.deepEqual(h.calls, [], "no pane");
  assert.deepEqual(git, [], "and no fetch or worktree: the checkout is the first thing a reviewer would have cost");

  // A live instance adds no process, so the hold does not apply: the order goes to it as it always did.
  const live = deliver([reviewOrder(2398)], agents({ "reviewer-2398": "idle" }), [], { run: h.run, checkout: { ...checkout,
    git: (_c: string, a: string[]) => (a.join(" ").includes("rev-parse") ? `${"a".repeat(40)}\n` : "") }, memory });
  assert.deepEqual(live.refused, [], live.refused.join(" | "));
  assert.equal(live.sent.length, 1);
});

// --- The wake ENTRY: the wiring in `main` is read, not assumed -----------------------------------------------

/** Run `wake.mjs` with one order on stdin and `herdr`/`gh` as stubs; returns what the tick said and what herdr saw. */
function tick(dir: string, meminfoText: string | null) {
  const log = join(dir, "herdr-calls");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in\n  *'workspace list') printf '%s' '{"result":{"workspaces":[]}}' ;;\n`
    + `  *'workspace create'*) printf '%s' '{"result":{"root_pane":{"pane_id":"wB:p1"},"workspace":{"workspace_id":"wB"}}}' ;;\n  *) : ;;\nesac\n`);
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(dir, "herdr"), STUB_MODE);
  chmodSync(join(dir, "gh"), STUB_MODE);
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` };
  if (meminfoText !== null) {
    writeFileSync(join(dir, "meminfo"), meminfoText);
    env[MEMINFO_ENV] = join(dir, "meminfo");
  } else {
    env[MEMINFO_ENV] = join(dir, "no-such-meminfo");
  }
  const ran = spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`, `--worktrees-dir=${join(dir, "wts")}`],
    { input: `${JSON.stringify(ROW_ORDER)}\n`, encoding: "utf8", env });
  return { ran, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("#2508 THE WAKE ENTRY: below the floor the tick log says `UNDELIVERED ... held for memory` and herdr is never asked to "
  + "create a workspace; with the reading unavailable it warns and goes on to the claim", () => {
  const held = mkdtempSync(join(tmpdir(), "wake-mem-held-"));
  const blind = mkdtempSync(join(tmpdir(), "wake-mem-blind-"));
  try {
    const low = tick(held, meminfo(RUNAWAY_KB));
    assert.match(low.ran.stderr, /UNDELIVERED engineers\/ready-row-unclaimed\/2131: .*no spawn: held for memory: the host's MemAvailable is 351 MB/, low.ran.stderr);
    assert.doesNotMatch(low.calls, /workspace create/, "no pane was opened");
    assert.equal(existsSync(join(held, "wake-ledger")) ? /ready-row-unclaimed/.test(readFileSync(join(held, "wake-ledger"), "utf8")) : false, false,
      "and the ledger holds nothing of the order, so the next tick offers it again");

    const none = tick(blind, null);
    assert.match(none.ran.stderr, /memory reading unavailable/, none.ran.stderr);
    assert.doesNotMatch(none.ran.stderr, /held for memory/, "unreadable is not a hold");
    // THE STUB HOST HAS NO GIT, so the spawn is refused at the CLAIM's own `git fetch` -- which is past the memory gate,
    // and is the observable that the unreadable reading let the spawner go on (a hold would have stopped before it).
    assert.match(none.ran.stderr, /no spawn: git fetch origin failed/, "the spawner went on to the claim, as before");
  } finally {
    rmSync(held, { recursive: true, force: true });
    rmSync(blind, { recursive: true, force: true });
  }
});
