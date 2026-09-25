// no-token: gh -- every `gh` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/disk-headroom.mjs` and its wiring in `work-gate.mjs`, #2163: THE GATE WATCHES FREE BYTES
 * AND FREE INODES ON `/` AND `/tmp`.
 *
 * THE OUTAGE, 2026-09-25: `/tmp` ran out of INODES (1,048,576 of 1,048,576) at 73% of its bytes, and every session
 * failed with ENOSPC for about six hours. The four cases the row names are the POSITIVE CONTROLS for every empty
 * result below, and each is named where it sits:
 *   (a) no free inodes, most bytes free -- MUST fire.          `#2163 (a)`
 *   (b) no free bytes, plenty of inodes -- MUST fire.          `#2163 (b)`
 *   (c) both healthy -- MUST stay silent.                      `#2163 (c)`
 *   (d) a filesystem reporting zero TOTAL inodes -- MUST stay silent.   `#2163 (d)`
 * (a) and (b) are what stop (c) being a detector that never fires; (c) and (d) are what stop (a) and (b) being one
 * that always does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskHeadroom, lowResources, readFilesystems, MIN_FREE_FRACTION, WATCHED_MOUNTS } from "./disk-headroom.mjs";
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES, diskHeadroomOrders, diskHeadroomTick } from "./work-gate.mjs";
import { profileFor } from "./worker-profile.mjs";

const BLOCK = 4096;
const TOTAL = 1000;
const GATE_ENTRY = fileURLToPath(new URL("./work-gate.mjs", import.meta.url));
const WAKE_ENTRY = fileURLToPath(new URL("./wake.mjs", import.meta.url));
const STUB_MODE = 0o755;
const READ_ONLY = 0o444;

/** What `fs.statfsSync` returns, with `bavail` blocks and `ffree` inodes free out of `TOTAL` of each. */
const stat = (bavail: number, ffree: number, files = TOTAL) => ({ bsize: BLOCK, blocks: TOTAL, bavail, files, ffree });
/** 70% of the bytes and 90% of the inodes free: healthy on both, and the shape every "low" case below changes ONE field of. */
const BYTES_OK = 700;
const INODES_OK = 900;
const HEALTHY = stat(BYTES_OK, INODES_OK);
const FIVE_PERCENT_FREE = 50;
const ONE_FS = () => 1;

const headroom = (s: ReturnType<typeof stat>, mounts = ["/"]) => diskHeadroom({ mounts, statfs: () => s, deviceOf: ONE_FS });

// --- the four controls, through the reader ---------------------------------------------------------------------

test("#2163 (a): NO FREE INODES WITH 70% OF THE BYTES FREE fires -- the outage itself", () => {
  const { low } = headroom(stat(BYTES_OK, 0));
  assert.deepEqual(low.map((f) => [f.resource, f.free, f.total]), [["inodes", 0, TOTAL]],
    "inodes alone, and the bytes are NOT reported: the two are judged separately");
});

test("#2163 (b): NO FREE BYTES WITH PLENTY OF INODES fires", () => {
  const { low } = headroom(stat(0, INODES_OK));
  assert.deepEqual(low.map((f) => [f.resource, f.free, f.total]), [["bytes", 0, TOTAL * BLOCK]]);
});

test("#2163 (c): BOTH HEALTHY is silent -- the emptiness the two above are the control for", () => {
  assert.deepEqual(headroom(HEALTHY), { low: [], unreadable: [] });
});

test("#2163 (d): a filesystem reporting ZERO TOTAL INODES has no inode limit, and is silent", () => {
  const unlimited = stat(BYTES_OK, 0, 0);
  assert.equal(readFilesystems({ mounts: ["/"], statfs: () => unlimited, deviceOf: ONE_FS }).readings[0].inodesTotal, null,
    "zero total is read as 'no limit', not as zero free");
  assert.deepEqual(headroom(unlimited).low, [], "read naively (0 free of 0) this is a permanent false alarm");
  // THE CONTROL ON THE CONTROL: the same zero FREE with a real total DOES fire, so (d) is silent for the total.
  assert.equal(headroom(stat(BYTES_OK, 0, TOTAL)).low.length, 1);
});

// --- the judgement --------------------------------------------------------------------------------------------

test("#2163: both resources low is TWO findings, never one combined figure", () => {
  assert.deepEqual(headroom(stat(0, 0)).low.map((f) => f.resource), ["bytes", "inodes"]);
});

test("#2163: exactly the floor is not low; one below it is", () => {
  const atFloor = TOTAL * MIN_FREE_FRACTION;
  assert.deepEqual(headroom(stat(atFloor, atFloor)).low, [], "10.0% free is not below 10%");
  assert.deepEqual(headroom(stat(atFloor - 1, atFloor - 1)).low.map((f) => f.resource), ["bytes", "inodes"]);
});

test("#2163: a figure that is not a finite number is not 'low' -- absence is not proof", () => {
  const reading = { mounts: ["/"], bytesFree: Number.NaN, bytesTotal: 1000, inodesFree: Number.NaN, inodesTotal: 1000 };
  assert.deepEqual(lowResources(reading), []);
  assert.deepEqual(lowResources({ ...reading, bytesTotal: 0 }), [], "zero total bytes is no measurement either");
});

// --- one filesystem, read once ---------------------------------------------------------------------------------

test("#2163: `/` and `/tmp` on ONE filesystem are read once and reported once, naming both", () => {
  let reads = 0;
  const got = diskHeadroom({ mounts: ["/", "/tmp"], statfs: () => (reads++, stat(BYTES_OK, 0)), deviceOf: ONE_FS });
  assert.equal(reads, 1, "one statfs for one filesystem");
  assert.deepEqual(got.low.map((f) => [f.mounts, f.resource]), [[["/", "/tmp"], "inodes"]]);
});

test("#2163: `/tmp` on a filesystem of its own is read as its own, and only it is reported", () => {
  const statfs = (m: string) => (m === "/tmp" ? stat(BYTES_OK, 0) : HEALTHY);
  const got = diskHeadroom({ mounts: ["/", "/tmp"], statfs, deviceOf: (m) => (m === "/tmp" ? 2 : 1) });
  assert.deepEqual(got.low.map((f) => [f.mounts, f.resource]), [[["/tmp"], "inodes"]]);
});

test("#2163: a mount that cannot be read is named as unreadable -- neither low nor healthy", () => {
  const got = diskHeadroom({ mounts: ["/", "/gone"], statfs: () => HEALTHY,
    deviceOf: (m) => { if (m === "/gone") throw new Error("ENOENT: no such file\n    at stat"); return 1; } });
  assert.deepEqual(got, { low: [], unreadable: [{ mount: "/gone", reason: "ENOENT: no such file" }] });
});

test("#2163: the watched mounts are `/` and `/tmp`, and the REAL host answers for both without throwing", () => {
  assert.deepEqual([...WATCHED_MOUNTS], ["/", "/tmp"]);
  const real = readFilesystems();
  assert.equal(real.unreadable.length, 0, `unreadable: ${JSON.stringify(real.unreadable)}`);
  assert.ok(real.readings.length >= 1, "the real statfs returned a reading, so the tests above are not about a stub");
  const readingCovers = real.readings.flatMap((r) => r.mounts).sort();
  assert.deepEqual(readingCovers, ["/", "/tmp"], "every watched mount is accounted for exactly once");
});

// --- the order --------------------------------------------------------------------------------------------------

const LOW_INODES = headroom(stat(BYTES_OK, 0), ["/", "/tmp"]).low;

test("#2163: the order goes to `ceo`, is keyed on WHICH resource of WHICH filesystem, and says what to read", () => {
  const [order] = diskHeadroomOrders(LOW_INODES);
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "disk-headroom-low");
  assert.equal(order.causeKey, "ceo/disk-headroom-low/root+tmp:inodes");
  assert.match(order.prompt, /FREE INODES: 0 of 1,000 \(0\.0%\)/);
  assert.match(order.prompt, /df -i \/ \/tmp/, "the inode reading is named -- `df -h` alone cannot see this outage");
  assert.match(order.prompt, /prune-tmp\.mjs/);
  assert.deepEqual(diskHeadroomOrders([]), [], "nothing low, no order");
});

test("#2163: a persisting condition keeps its key; a SECOND resource going low is a new question", () => {
  const key = (low: typeof LOW_INODES) => diskHeadroomOrders(low)[0].causeKey;
  assert.equal(key(headroom(stat(BYTES_OK, 0), ["/", "/tmp"]).low), key(headroom(stat(BYTES_OK, FIVE_PERCENT_FREE), ["/", "/tmp"]).low),
    "0 and 5% inodes free are the same question, so the judgment window holds");
  assert.notEqual(key(LOW_INODES), key(headroom(stat(0, 0), ["/", "/tmp"]).low));
  assert.notEqual(key(LOW_INODES), key(headroom(stat(BYTES_OK, 0), ["/"]).low), "a different mount is a different key");
});

test("#2163: it is a JUDGMENT cause, not a START cause, and its profile exists and refuses nothing", () => {
  assert.ok(CAUSES.includes("disk-headroom-low"));
  assert.ok(JUDGMENT_CAUSES.includes("disk-headroom-low"), "re-asked on the judgment window, not every twenty minutes");
  assert.ok(!START_CAUSES.includes("disk-headroom-low"), "a drain must not withhold the report that the disk is full");
  assert.equal("refusal" in profileFor("disk-headroom-low"), false);
});

// --- the tick ---------------------------------------------------------------------------------------------------

test("#2163: the tick says on stderr what is low, returns the order, and says nothing when healthy", () => {
  const said: string[] = [];
  const orders = diskHeadroomTick({ read: () => ({ low: LOW_INODES, unreadable: [] }), log: (l) => said.push(l) });
  assert.equal(orders.length, 1);
  assert.deepEqual(said, ["DISK LOW: / + /tmp  FREE INODES: 0 of 1,000 (0.0%)\n"]);

  const quiet: string[] = [];
  assert.deepEqual(diskHeadroomTick({ read: () => ({ low: [], unreadable: [] }), log: (l) => quiet.push(l) }), []);
  assert.deepEqual(quiet, [], "healthy is silent on stderr too");
});

test("#2163: an unreadable mount is said on stderr and yields no order; a reader that throws does not stop the gate", () => {
  const said: string[] = [];
  const orders = diskHeadroomTick({ read: () => ({ low: [], unreadable: [{ mount: "/gone", reason: "ENOENT" }] }),
    log: (l) => said.push(l) });
  assert.deepEqual(orders, []);
  assert.match(said[0], /could not read \/gone \(ENOENT\) -- neither reported low nor counted healthy/);

  const crashed: string[] = [];
  assert.deepEqual(diskHeadroomTick({ read: () => { throw new Error("statfs exploded\nstack"); }, log: (l) => crashed.push(l) }), []);
  assert.match(crashed[0], /could not run \(statfs exploded\) -- no order this tick/);
});

// --- THE GATE AS A PROCESS: the reading reaches stdout FIRST and stderr on every path -----------------------------

/** A preload that makes `statfsSync` report no free inodes, so the real gate sees the outage. */
const PRELOAD = "const fs = require('node:fs');\n"
  + "fs.statfsSync = () => ({ bsize: 4096, blocks: 1000, bavail: 700, files: 1000, ffree: 0 });\n"
  + "require('node:module').syncBuiltinESMExports();\n";

function gateProcess({ ghWorks }: { ghWorks: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "disk-gate-"));
  try {
    writeFileSync(join(dir, "gh"), ghWorks
      ? "#!/bin/sh\ncase \"$*\" in\n  \"pr list\"*|\"issue list\"*) printf '%s' '[]' ;;\n  *) exit 1 ;;\nesac\n"
      : "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    writeFileSync(join(dir, "preload.cjs"), PRELOAD);
    const ran = spawnSync(process.execPath, ["--require", join(dir, "preload.cjs"), GATE_ENTRY], { encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const orders = ran.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cause: string });
    return { ran, orders };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2163: the real gate emits the disk order FIRST of several, and writes DISK LOW on stderr", () => {
  const { ran, orders } = gateProcess({ ghWorks: true });
  assert.ok(orders.length > 1, `the disk order must be first of SEVERAL for 'first' to mean anything; got ${JSON.stringify(orders.map((o) => o.cause))}\n${ran.stderr}`);
  assert.equal(orders[0].cause, "disk-headroom-low");
  assert.match(ran.stderr, /DISK LOW: \/ \+ \/tmp {2}FREE INODES: 0 of 1,000 \(0\.0%\)/);
});

test("#2163: when GitHub cannot be read the gate still says DISK LOW -- a CANNOT_ASK exit must not hide a full disk", () => {
  const { ran, orders } = gateProcess({ ghWorks: false });
  assert.equal(ran.status, 2, `CANNOT_ASK; got ${ran.status}\n${ran.stderr}`);
  assert.deepEqual(orders, [], "nothing is delivered on this path, which is exactly why stderr must carry it");
  assert.match(ran.stderr, /DISK LOW: \/ \+ \/tmp {2}FREE INODES/);
});

// --- WHAT `wake` DOES WHEN ITS OWN WRITES THROW (#2163 done-when 4) -----------------------------------------------
//
// MEASURED 2026-09-25 with the real `wake.mjs` and a `herdr` stub. A full disk breaks the writes `wake` makes, and
// the two it makes around a delivery fail differently. These are CHARACTERISATION, not a specification: they pin
// what the tick does TODAY so the claim in `work-gate.mjs` is checked rather than remembered, and whoever makes
// `wake`'s writes non-fatal is expected to update them (the gap is named on #2163). Both need a writable-file check
// that a superuser passes, so they are skipped under root WITH the reason, and the writable case below is the control.

const ORDER = { session: "ceo", cause: "disk-headroom-low", subject: "disk-headroom", discriminator: "k",
  prompt: "disk is low", causeKey: "ceo/disk-headroom-low/root+tmp:inodes" };
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP_ROOT = isRoot ? "running as root: a 0444 file is still writable, so a throwing write cannot be provoked" : false;

function wakeProcess(lock: "none" | "wake-emitted" | "wake-ledger") {
  const dir = mkdtempSync(join(tmpdir(), "disk-wake-"));
  try {
    const herdrLog = join(dir, "herdr-calls");
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$*" >> ${herdrLog}\ncase "$*" in\n  *'workspace list') printf '%s' `
      + `'{"result":{"workspaces":[{"label":"ceo","workspace_id":"w1","agent_status":"idle"}]}}' ;;\n  *) : ;;\nesac\n`);
    chmodSync(join(dir, "herdr"), STUB_MODE);
    if (lock !== "none") {
      writeFileSync(join(dir, lock), "");
      chmodSync(join(dir, lock), READ_ONLY);
    }
    writeFileSync(herdrLog, "");
    const ran = spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`], { encoding: "utf8",
      input: `${JSON.stringify(ORDER)}\n`, env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const prompts = readFileSync(herdrLog, "utf8").split("\n").filter((l) => l.includes("agent prompt ceo") && !l.includes("/clear"));
    return { ran, prompts: prompts.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2163 done-when 4 (control): with every state file writable, `wake` delivers the order and exits QUIET", () => {
  const { ran, prompts } = wakeProcess("none");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(prompts, 1);
  assert.match(ran.stdout, /WOKE ceo <- ceo\/disk-headroom-low\//);
});

test("#2163 done-when 4: a throwing write to `wake-emitted` ends `wake` BEFORE any delivery -- nothing is woken", { skip: SKIP_ROOT }, () => {
  const { ran, prompts } = wakeProcess("wake-emitted");
  assert.equal(ran.status, 1, "an uncaught exception, which the unit's SuccessExitStatus=0 1 2 does not mark failed");
  assert.equal(prompts, 0, "no order reached herdr, the disk order included");
  assert.match(ran.stderr, /EACCES/);
});

test("#2163 done-when 4: a throwing LEDGER append ends `wake` AFTER the first delivery and before the rest", { skip: SKIP_ROOT }, () => {
  const { ran, prompts } = wakeProcess("wake-ledger");
  assert.equal(ran.status, 1);
  assert.equal(prompts, 1, "the order WAS sent -- which is why the disk order is placed first in the tick");
  assert.equal(ran.stdout, "", "but no WOKE line was written and the delivery is unrecorded, so the next tick sends it again");
});
