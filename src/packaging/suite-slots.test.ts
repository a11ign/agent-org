// no-token: clearBeforeOrder -- starts only `sh`, `sleep` and `cat` under flock in a temp directory; nothing here prompts or clears a session
// A HOST-WIDE LIMIT ON CONCURRENT FULL TEST SUITES (a11ign/a11ign#3536, done-whens 1, 3, 4 and 6).
//
// EVERY CASE RUNS THE REAL `flock`, `nice` AND `ionice`, in a temp directory: a fake lock would prove the wrapper and not the limit. The CONTROL COMES FIRST in each pair (with one
// slot held the third contender starts at once), because "the third waits" is true of a limit that blocks everything.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { IONICE_CLASS, NICE_LEVEL, SLOT_COUNT, SLOT_DIR_ENV, SLOT_ENV, SuiteSlotRefusal, WAITS_LOG, WAIT_REPORT_MS, findOnPath, insideSlot, runUnderSlot, slotDirectory } from "../suite-slots.ts";

const SELF = fileURLToPath(new URL("../suite-slots.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "suite-slots-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string): string => { counter += 1; const dir = join(scratch, `${name}-${counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const quick = { pollMs: 15, write: () => {}, output: "ignore" as const };
/** The environment of a run on this host: no `CI`, and not already inside a slot (the suite entry sets `SLOT_ENV` for the tests it runs). */
const env = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, CI: undefined, [SLOT_ENV]: undefined, ...extra });
const until = async (what: string, test: () => boolean, ms = 5000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!test()) {
    assert.ok(Date.now() < stop, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

/** A command that runs until `release` exists and leaves `started` behind: a holder (or a contender) a test can let go of. */
const holdsUntil = (release: string, started: string) => ({ command: "sh", args: ["-c", 'touch "$1"; until [ -e "$0" ]; do sleep 0.02; done', release, started] });

/** Holds one slot of `dir` through the module itself, and resolves once it is held. */
async function hold(dir: string, name: string) {
  const release = join(dir, `${name}.release`);
  const started = join(dir, `${name}.started`);
  const done = runUnderSlot({ ...holdsUntil(release, started), dir, env: env(), ...quick, label: name });
  await until(`${name} to hold a slot`, () => existsSync(started));
  return { done, release: () => writeFileSync(release, ""), name };
}

describe("done-when 4: the third contender waits for a slot (2 slots, the control first)", () => {
  test("the slot count is 2, read from the one constant", () => assert.equal(SLOT_COUNT, 2));

  test("CONTROL: with ONE of the two slots held, a third suite starts at once and waits for nothing", async () => {
    const dir = fresh("control");
    const first = await hold(dir, "first");
    const messages: string[] = [];
    const status = await runUnderSlot({ command: "true", dir, env: env(), ...quick, write: (text) => messages.push(text) });
    assert.equal(status, 0);
    assert.deepEqual(messages, [], "a free slot is taken without a word");
    first.release();
    await first.done;
  });

  test("with BOTH slots held the third does NOT start until one releases, says why, and then runs and returns its own exit code", async () => {
    const dir = fresh("queue");
    const [a, b] = [await hold(dir, "a"), await hold(dir, "b")];
    const started = join(dir, "third.started");
    const messages: string[] = [];
    const third = runUnderSlot({ command: "sh", args: ["-c", 'touch "$0"; exit 7', started], dir, env: env(), ...quick, write: (text) => messages.push(text) });
    await until("the first waiting message", () => messages.length > 0);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(existsSync(started), false, "the third suite has not started while both slots are held");
    assert.equal(messages.length, 1, "it said so ONCE at the start, not on every poll");
    assert.match(messages[0], /all 2 slots/);
    assert.match(messages[0], /slot 0: pid \d+, `a`/);
    assert.match(messages[0], /slot 1: pid \d+, `b`/);
    a.release();
    assert.equal(await third, 7, "the waiter ran in the freed slot and the command's own status came back");
    assert.equal(existsSync(started), true);
    b.release();
    await Promise.all([a.done, b.done]);
  });

  test("a holder KILLED mid-run (SIGKILL, no clean-up) frees its slot for the waiter", async () => {
    const dir = fresh("killed");
    const [a, b] = [await hold(dir, "a"), await hold(dir, "b")];
    const [pid, , label] = readFileSync(join(dir, "slot-0.lock"), "utf8").trim().split("\t");
    const [killed, kept] = label === "a" ? [a, b] : [b, a];
    const third = runUnderSlot({ command: "true", dir, env: env(), ...quick });
    await new Promise((done) => setTimeout(done, 150));
    process.kill(Number(pid), "SIGKILL");
    assert.equal(await third, 0, "the waiter got the slot the killed holder never released by hand");
    assert.equal(await killed.done, 137, "the killed holder's own status is 128 + 9");
    kept.release();
    await Promise.all([a.done, b.done]);
  });

  test("the lock is the KERNEL's: two plain `flock -n` holders on the slot files hold the limit with no record of their own", async () => {
    const dir = fresh("kernel");
    // Not the module's holder: a shell that takes `flock -n 9` the way any other tool would, then becomes `sleep` (so killing it frees the lock).
    // It touches `slot-N.held` only AFTER the lock is its own: the wait must not PROBE the lock to learn that, because a probe (`flock -n` on a free file) takes it for an instant and a holder that tries in that instant loses and exits (a11ign/a11ign#3668, measured 6 of 400 replays).
    const held = (index: number) => join(dir, `slot-${index}.held`);
    const holders = [0, 1].map((index) => spawn("sh", ["-c", 'exec 9>>"$0"; flock -n 9 && { touch "$1"; exec sleep 30; }', join(dir, `slot-${index}.lock`), held(index)], { stdio: "ignore" }));
    await until("both plain holders to hold", () => [0, 1].every((index) => existsSync(held(index))));
    // Both hold now, so this probe cannot make one lose: it only confirms the kernel agrees the files are locked.
    for (const index of [0, 1]) assert.notEqual(spawnSync("flock", ["--nonblock", join(dir, `slot-${index}.lock`), "true"]).status, 0, `slot ${index} is held by the plain holder`);
    const messages: string[] = [];
    const third = runUnderSlot({ command: "true", dir, env: env(), ...quick, write: (text) => messages.push(text) });
    await until("the waiting message", () => messages.length > 0);
    assert.match(messages[0], /slot 0: held \(no live record of by whom\)/);
    holders[1].kill("SIGKILL");
    assert.equal(await third, 0);
    holders[0].kill("SIGKILL");
  });
});

describe("done-when 3: a queued run says it is queued, now and every minute", () => {
  test("the message is printed at the start and then once per `WAIT_REPORT_MS`, with the wait so far", async () => {
    const dir = fresh("cadence");
    const [a, b] = [await hold(dir, "a"), await hold(dir, "b")];
    let clock = 0;
    const messages: string[] = [];
    const sleeps: number[] = [];
    // The fake clock jumps 20 s per poll and lets a slot go (and waits until it IS gone, so the next poll finds it) after 150 s: messages at 0, 60, 120 and nothing else.
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += 20_000;
      if (clock > 150_000) { a.release(); await a.done; }
    };
    const third = runUnderSlot({ command: "true", dir, env: env(), ...quick, now: () => clock, sleep, write: (text) => messages.push(text) });
    assert.equal(await third, 0);
    assert.equal(WAIT_REPORT_MS, 60_000);
    assert.equal(messages.length, 3, `at 0 s, 60 s and 120 s: ${JSON.stringify(messages.map((text) => text.split("\n")[0]))}`);
    assert.match(messages[0], /waited 0m00s/);
    assert.match(messages[1], /waited 1m00s/);
    assert.match(messages[2], /waited 2m00s/);
    b.release();
    await Promise.all([a.done, b.done]);
  });
});

describe("a11ign/a11ign#3664: a run that had to wait leaves a record that outlives it (read AFTER the waiter has exited)", () => {
  /** The wait records of `dir`, one array of fields per line; none when nothing was ever recorded. */
  const waits = (dir: string): string[][] => existsSync(join(dir, WAITS_LOG))
    ? readFileSync(join(dir, WAITS_LOG), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"))
    : [];

  test("three contenders against two slots find exactly ONE wait record, naming the third: when, who, where, how long, which slot", async () => {
    const dir = fresh("waits-three");
    const [a, b] = [await hold(dir, "a"), await hold(dir, "b")];
    assert.deepEqual(waits(dir), [], "the two that took a free slot waited for nothing and recorded nothing");
    let clock = 1_000_000;
    const messages: string[] = [];
    const third = runUnderSlot({ command: "true", dir, cwd: scratch, label: "third", env: env(), ...quick, now: () => clock, write: (text) => messages.push(text),
      sleep: async () => { clock += 5000; if (clock >= 1_015_000) { a.release(); await a.done; } } });
    assert.equal(await third, 0);
    const [record, ...others] = waits(dir);
    assert.deepEqual(others, [], "ONE record: the third waited, the other two did not");
    const [at, pid, cwd, waited, slot, label] = record;
    assert.equal(at, new Date(clock).toISOString());
    assert.equal(pid, String(process.pid));
    assert.equal(cwd, scratch);
    assert.equal(waited, "15000", "milliseconds from its first try to the slot it got");
    assert.match(slot, /^[01]$/);
    assert.equal(label, "third");
    assert.match(messages[0], /all 2 slots/, "the same wait the message told the waiter about");
    b.release();
    await Promise.all([a.done, b.done]);
  });

  test("CONTROL: ONE contender, and TWO contenders against two slots, wait for nothing and find no record", async () => {
    const one = fresh("waits-one");
    assert.equal(await runUnderSlot({ command: "true", dir: one, env: env(), ...quick }), 0);
    assert.deepEqual(waits(one), []);
    const two = fresh("waits-two");
    const first = await hold(two, "first");
    assert.equal(await runUnderSlot({ command: "true", dir: two, env: env(), ...quick, label: "second" }), 0);
    first.release();
    await first.done;
    assert.deepEqual(waits(two), []);
  });

  test("a second wait appends: the first is still there, and a record that cannot be written is said, and the suite still runs", async () => {
    const dir = fresh("waits-append");
    const holders = [await hold(dir, "a"), await hold(dir, "b")];
    const waiter = (label: string) => runUnderSlot({ command: "true", dir, label, env: env(), ...quick, write: () => {} });
    const firstWaiter = waiter("first-waiter");
    await new Promise((done) => setTimeout(done, 100));
    holders[0].release();
    await holders[0].done;
    assert.equal(await firstWaiter, 0);
    const refilled = await hold(dir, "c"); // the freed slot is taken again, so the next contender has to wait too
    const secondWaiter = waiter("second-waiter");
    await new Promise((done) => setTimeout(done, 100));
    holders[1].release();
    assert.equal(await secondWaiter, 0);
    refilled.release();
    await Promise.all([refilled.done, holders[1].done]);
    assert.deepEqual(waits(dir).map((fields) => fields[5]), ["first-waiter", "second-waiter"]);

    const blocked = fresh("waits-unwritable");
    const held = [await hold(blocked, "a"), await hold(blocked, "b")];
    mkdirSync(join(blocked, WAITS_LOG)); // a directory where the file should be: appending to it fails
    const messages: string[] = [];
    const third = runUnderSlot({ command: "true", dir: blocked, env: env(), ...quick, write: (text) => messages.push(text) });
    await until("the waiting message", () => messages.length > 0);
    held[0].release();
    assert.equal(await third, 0, "the suite ran although its wait could not be recorded");
    assert.ok(messages.some((text) => text.includes("could not record this wait")), JSON.stringify(messages));
    held[1].release();
    await Promise.all(held.map((one) => one.done));
  });
});

describe("done-when 3: a runner (CI set) takes no slot and is not reniced", () => {
  test("with both slots held, a run with CI set starts at once and never touches the slot directory", async () => {
    const dir = fresh("ci");
    const [a, b] = [await hold(dir, "a"), await hold(dir, "b")];
    const out = join(dir, "ci.out");
    const status = await runUnderSlot({ command: "sh", args: ["-c", `echo "slot=\${${SLOT_ENV}-none}" > "$0"`, out], dir, env: env({ CI: "true" }), ...quick });
    assert.equal(status, 0);
    assert.equal(readFileSync(out, "utf8").trim(), "slot=none");
    a.release();
    b.release();
    await Promise.all([a.done, b.done]);
  });
});

describe("done-when 6: every run starts under nice and ionice, and a missing one is a refusal", () => {
  /** The `nice` field (19th) of `/proc/<pid>/stat`, read by `cat` in the command itself so it is the command's own priority; the `comm` field may hold spaces, so split after `)`. */
  const niceOf = (stat: string): number => Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
  const readBack = ['cat /proc/self/stat > "$0.stat"; ionice -p $$ > "$0.ionice"'];

  test("CONTROL: the same command started without the module reads this process's own niceness", () => {
    const out = join(fresh("nice-control"), "out");
    spawnSync("sh", ["-c", readBack[0], out]);
    assert.equal(niceOf(readFileSync(`${out}.stat`, "utf8")), niceOf(readFileSync("/proc/self/stat", "utf8")), "no renice without the module");
  });

  test("through the module the child's niceness reads back from /proc as this process's plus NICE_LEVEL (capped at 19), in the idle I/O class", async () => {
    const dir = fresh("nice");
    const out = join(dir, "out");
    assert.equal(await runUnderSlot({ command: "sh", args: ["-c", readBack[0], out], dir, env: env(), ...quick }), 0);
    const mine = niceOf(readFileSync("/proc/self/stat", "utf8"));
    assert.equal(NICE_LEVEL, 15);
    assert.equal(niceOf(readFileSync(`${out}.stat`, "utf8")), Math.min(19, mine + NICE_LEVEL));
    assert.equal(IONICE_CLASS, 3);
    assert.match(readFileSync(`${out}.ionice`, "utf8"), /^idle/);
  });

  /** A PATH holding only the named tools (and `true`), as symlinks to the real ones. */
  function pathWith(...names: string[]): string {
    const bin = fresh("bin");
    for (const name of names) symlinkSync(findOnPath(name, process.env.PATH) as string, join(bin, name));
    return bin;
  }

  for (const [missing, keep] of [["flock", ["nice", "ionice"]], ["ionice", ["flock", "nice"]], ["nice", ["flock", "ionice"]]] as const) {
    test(`a missing \`${missing}\` is a refusal that NAMES it, and the command never runs (no silent run at normal priority or without the limit)`, async () => {
      const dir = fresh(`missing-${missing}`);
      const ran = join(dir, "ran");
      await assert.rejects(runUnderSlot({ command: "sh", args: ["-c", 'touch "$0"', ran], dir, env: env({ PATH: pathWith(...keep) }), ...quick }),
        (error: Error) => error instanceof SuiteSlotRefusal && error.message.includes(`\`${missing}\``) && /NOT being run/.test(error.message));
      assert.equal(existsSync(ran), false);
    });
  }

  test("CONTROL for the three above: with all three on PATH the same call runs", async () => {
    const dir = fresh("all-present");
    assert.equal(await runUnderSlot({ command: "/bin/sh", args: ["-c", "exit 0"], dir, env: env({ PATH: pathWith("flock", "nice", "ionice") }), ...quick }), 0);
  });
});

describe("the entry points", () => {
  test("a command running in a slot knows it (`SLOT_ENV`), so a script that re-runs itself under one does not do it twice", async () => {
    const dir = fresh("insideslot");
    const out = join(dir, "out");
    assert.equal(insideSlot(env()), false);
    assert.equal(await runUnderSlot({ command: "sh", args: ["-c", `echo "$${SLOT_ENV}" > "$0"`, out], dir, env: env(), ...quick }), 0);
    assert.match(readFileSync(out, "utf8"), /^[01]$/m);
    assert.equal(insideSlot({ [SLOT_ENV]: "0" }), true);
  });

  test("the default slot directory is the same under /tmp for every caller (a11ign/a11ign#3935), and `SLOT_DIR_ENV` moves it", () => {
    const uid = process.getuid?.() ?? "shared";
    const expected = `/tmp/agent-org-suite-slots-${uid}`;
    assert.equal(slotDirectory({}), expected);
    // The three variables a sandbox or a session changes must not move it: a private directory is a private limit.
    assert.equal(slotDirectory({ HOME: "/read-only/home", XDG_CACHE_HOME: "/x/cache", TMPDIR: "/tmp/private" }), expected);
    assert.equal(slotDirectory({ [SLOT_DIR_ENV]: "/y" }), "/y");
  });

  test("a caller whose home is read-only and whose TMPDIR is private still takes the slot, and a second one finds it held there (a11ign/a11ign#3935)", async () => {
    const shared = fresh("shared-default");
    const readOnlyHome = fresh("ro-home");
    chmodSync(readOnlyHome, 0o500);
    try {
      const sandboxed = { HOME: readOnlyHome, XDG_CACHE_HOME: undefined, TMPDIR: fresh("private-tmp") };
      assert.equal(slotDirectory(env(sandboxed)), slotDirectory(env()), "same directory as an unsandboxed caller");
      const started = join(shared, "s.started");
      const release = join(shared, "s.release");
      const holder = runUnderSlot({ ...holdsUntil(release, started), dir: shared, env: env(sandboxed), ...quick, label: "sandboxed" });
      await until("the sandboxed run to hold a slot", () => existsSync(started));
      assert.equal(existsSync(join(readOnlyHome, ".cache")), false, "nothing was written under the read-only home");
      writeFileSync(release, "");
      assert.equal(await holder, 0);
    } finally {
      chmodSync(readOnlyHome, 0o700);
    }
  });

  test("`run -- <command>` takes a slot and returns the command's status; the CLI refuses what it does not know", () => {
    const dir = fresh("cli");
    const run = (...args: string[]) => spawnSync(process.execPath, [SELF, ...args], { env: env({ [SLOT_DIR_ENV]: dir }), encoding: "utf8" });
    assert.equal(run("run", "--", "sh", "-c", "exit 3").status, 3);
    assert.equal(run("run", "--bogus", "--", "true").status, 2);
    assert.equal(run("nothing").status, 2);
    assert.match(run("nothing").stderr, /usage:/);
  });
});
