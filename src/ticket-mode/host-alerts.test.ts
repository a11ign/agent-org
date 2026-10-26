// no-token: gh -- herdr, the tracker, the clock, the serve check and the host's reads are injected; the pool is driven over fakes and nothing is read of the machine
// A11-279: the board names what is wrong with the host (/tmp over its limit, a soft lockup this boot, a serve it could not put back, the hang settings drifting), with when it began, and clears each alert when its condition clears
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { firstLogTime, hangDifference, HOST_ALERTS_EVERY_MS, softLockupInJournal, TMP_ENTRY_LIMIT, withinMs, type HostAlertReads } from "./host-alerts.ts";
import type { HostReads } from "../hang-settings.ts";
import type { ServeCheck } from "../install/service.ts";

const T0 = Date.UTC(2026, 9, 25, 16, 0, 0);
const LOCKUP_AT = Date.UTC(2026, 9, 25, 15, 20, 0);
const HANG_DIFFERS = "kernel.softlockup_panic is 1 now, wanted 0. The chairman applies the text host-kernel.ts holds.";

/** What the host's reads answer now; a test changes it between passes. */
type Host = { tmp: number; lockup: number | undefined; hang: string | undefined; failing: Set<string>; hanging: Set<string>; asked: number; serves: readonly ServeCheck[] };

/** A pool over a clock the test moves, whose host reads and serve check answer what `host` holds now. `withReads: false` is a pool made without host reads, as every other test makes one. */
function watched({ withReads = true, ...over }: Partial<Host> & { withReads?: boolean } = {}) {
  let clock = T0;
  const host: Host = { tmp: 100, lockup: undefined, hang: undefined, failing: new Set(), hanging: new Set(), asked: 0, serves: [], ...over };
  const read = <T>(name: string, answer: () => T) => async () => { host.asked += 1; if (host.failing.has(name)) throw new Error(`${name} refused`); if (host.hanging.has(name)) await new Promise<never>(() => {}); return answer(); };
  const reads: HostAlertReads = { tmpEntries: read("tmp", () => host.tmp), softLockupAt: read("lockup", () => host.lockup), hangSettings: () => { if (host.failing.has("hang")) throw new Error("hang refused"); return host.hang; } };
  const made = poolFixture({ keys: [], now: () => clock });
  const pool = made.restart({ hostReadMs: 20, serveCheck: async () => host.serves, ...(withReads ? { hostAlertReads: reads } : {}) });
  return { host, pool, advance: async (ms: number) => { clock += ms; await pool.tick(); } };
}

const ids = (pool: { hostAlerts: () => readonly { id: string }[] }): string[] => pool.hostAlerts().map(({ id }) => id);

test("A11-279: a /tmp over the limit is an alert with its count, and /tmp at the limit is not", async () => {
  const run = watched({ tmp: TMP_ENTRY_LIMIT });
  await run.pool.tick();
  assert.deepEqual(run.pool.hostAlerts(), [], "1,000 entries is the limit, not over it");
  run.host.tmp = 19_960;
  await run.advance(HOST_ALERTS_EVERY_MS);
  const [alert, ...rest] = run.pool.hostAlerts();
  assert.deepEqual(rest, []);
  assert.equal(alert.id, "tmp-entries");
  assert.match(alert.sentence, /^\/tmp holds 19,960 entries, over the 1,000 it should stay under\./);
  assert.equal(alert.since, T0 + HOST_ALERTS_EVERY_MS, "it began when the board first saw it");
});

test("A11-279: an alert keeps the time it began while its condition holds, and clears with it; a later return begins again", async () => {
  const run = watched({ tmp: 5_000 });
  await run.pool.tick();
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.equal(run.pool.hostAlerts()[0].since, T0, "a second look does not move the time it began");
  run.host.tmp = 200;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.deepEqual(run.pool.hostAlerts(), [], "the alert clears itself");
  run.host.tmp = 5_000;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.equal(run.pool.hostAlerts()[0].since, T0 + 3 * HOST_ALERTS_EVERY_MS, "back again, it began again");
});

test("A11-279: a soft lockup this boot is an alert that began when the kernel logged it, not when the board looked", async () => {
  const run = watched({ lockup: LOCKUP_AT });
  await run.pool.tick();
  const [alert] = run.pool.hostAlerts();
  assert.equal(alert.id, "soft-lockup");
  assert.equal(alert.since, LOCKUP_AT);
  assert.match(alert.sentence, /^The kernel logged a soft lockup this boot\b.*The host is not rebooted for one/);
  run.host.lockup = undefined;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.deepEqual(run.pool.hostAlerts(), [], "a new boot has none in its log");
});

test("A11-279: hang settings that differ from the text host-kernel.ts holds are an alert that says what differs, and it clears when they match", async () => {
  const run = watched({ hang: HANG_DIFFERS });
  await run.pool.tick();
  assert.deepEqual(run.pool.hostAlerts().map(({ id, sentence }) => [id, sentence]), [["hang-settings", HANG_DIFFERS]]);
  run.host.hang = undefined;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.deepEqual(run.pool.hostAlerts(), []);
});

test("A11-279: a serve the board could not put back and a port another entry holds are alerts, and each clears in the pass its serve is present", async () => {
  const run = watched({ serves: [{ service: "ui", state: "refused", port: 9443, why: "Tailscale is Stopped, not Running" }, { service: "terminal", state: "foreign", port: 9444, why: "port 9444 already serves http://127.0.0.1:9999 on the tailnet" }] });
  await run.pool.tick();
  assert.deepEqual(run.pool.hostAlerts().map(({ id, sentence }) => [id, sentence]), [
    ["serve:ui", "The board serve on port 9443 is not in place, and the board could not put it back: Tailscale is Stopped, not Running. Terminal links stop working until it is."],
    ["serve:terminal", "The terminal serve on port 9444 is held by another entry, which the board leaves alone: port 9444 already serves http://127.0.0.1:9999 on the tailnet."],
  ]);
  run.host.serves = [{ service: "ui", state: "reapplied", port: 9443 }, { service: "terminal", state: "present", port: 9444 }];
  // Refused serves are asked again every fifth check (pool-exposure.ts), so the pass that finds them back is that far on.
  await run.advance(25_000 * 5);
  assert.deepEqual(run.pool.hostAlerts(), [], "cleared in the pass that found the serves in place");
});

test("A11-279: the host is read once a minute and not on each tick", async () => {
  const run = watched();
  await run.pool.tick();
  const first = run.host.asked;
  assert.equal(first, 2, "the /tmp listing and the kernel log are asked; the hang settings are a plain read");
  await run.advance(HOST_ALERTS_EVERY_MS - 1);
  assert.equal(run.host.asked, first, "a wake just after a read asks nothing again");
  await run.advance(1);
  assert.equal(run.host.asked, 2 * first);
});

test("A11-279: a read that fails keeps the last answer, so a failing journalctl neither raises nor clears the lockup alert", async () => {
  const run = watched({ lockup: LOCKUP_AT, tmp: 5_000 });
  await run.pool.tick();
  run.host.failing = new Set(["lockup", "tmp", "hang"]);
  run.host.lockup = undefined;
  run.host.tmp = 10;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.deepEqual(ids(run.pool), ["tmp-entries", "soft-lockup"], "what was last read still stands, since an unread host is not a well one");
});

test("A11-279: a read that fails before it has ever answered raises nothing", async () => {
  const run = watched({ failing: new Set(["lockup", "tmp", "hang"]), lockup: LOCKUP_AT, tmp: 5_000, hang: "differs" });
  await run.pool.tick();
  assert.deepEqual(run.pool.hostAlerts(), []);
});

test("A11-279: a pool made without host reads shows the exposure's alerts alone and reads nothing", async () => {
  const run = watched({ withReads: false, tmp: 5_000, lockup: LOCKUP_AT, serves: [{ service: "ui", state: "refused", port: 9443, why: "no" }] });
  await run.pool.tick();
  assert.deepEqual(ids(run.pool), ["serve:ui"]);
  assert.equal(run.host.asked, 0);
});

test("A11-279: firstLogTime reads the first line's time out of journalctl's short-unix output, in ms", () => {
  assert.equal(firstLogTime("1792941622.123456 agents kernel: watchdog: BUG: soft lockup - CPU#8 stuck for 26s! [ioq-2:717575]\n1792941700.5 agents kernel: watchdog: BUG: soft lockup - CPU#8 stuck for 22s!\n"), 1792941622123);
  assert.equal(firstLogTime(""), undefined);
  assert.equal(firstLogTime("-- No entries --\n"), undefined);
});

/** A stand-in for `journalctl`: a script that prints `stdout`, then `stderr`, and exits with `code`. */
function journalctl(stdout: string, code: number, stderr = ""): string {
  const path = join(tmpDir("host-alerts-journal-"), "journalctl");
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("A11-279: the kernel log read answers the first soft lockup's time, none when journalctl finds no line, and an error when it fails", async () => {
  assert.equal(await softLockupInJournal(journalctl("1792941622.5 agents kernel: watchdog: BUG: soft lockup - CPU#8 stuck for 26s!\n", 0)), 1792941622500);
  assert.equal(await softLockupInJournal(journalctl("", 1)), undefined, "journalctl exits 1 with nothing printed when no entry matches");
  await assert.rejects(softLockupInJournal(journalctl("", 1, "Failed to open journal")), "an exit 1 that says something is a failure, not 'none'");
  await assert.rejects(softLockupInJournal(journalctl("", 2)));
  await assert.rejects(softLockupInJournal(join(tmpDir("host-alerts-none-"), "no-such-journalctl")));
});

test("A11-279: a read of the host that does not answer is given up on, so the tick does not wait for a stalled listing; its alert keeps the last answer", async () => {
  const run = watched({ tmp: 5_000 });
  await run.pool.tick();
  run.host.hanging = new Set(["tmp", "lockup"]);
  run.host.lockup = LOCKUP_AT;
  await run.advance(HOST_ALERTS_EVERY_MS);
  assert.deepEqual(ids(run.pool), ["tmp-entries"], "the pass ended, the listing kept its last answer, and the hung kernel-log read raised nothing");
  await assert.rejects(withinMs(() => new Promise<never>(() => {}), 10, "a read"), /a read did not answer in 10 ms/);
  assert.equal(await withinMs(() => 7, 10, "a read"), 7);
});

/** The reads of a host whose hang file holds `file` (null: there is none) and whose live values are `live`. */
function hangHost(file: string | null, live: string): HostReads {
  return { readFile: (path) => { if (path.startsWith("/proc/")) return live; if (file === null) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return file; }, listDir: () => [] };
}
const WANTED = "kernel.softlockup_panic = 0\nkernel.panic_on_rcu_stall = 1\nkernel.panic_on_oops = 1\nkernel.panic = 10\n";

test("A11-279: the hang settings alert says what differs on a host that has the file, and is silent on one that has none (a laptop, a CI runner)", () => {
  assert.match(hangDifference(hangHost(WANTED.replace("softlockup_panic = 0", "softlockup_panic = 1"), "0")) ?? "", /softlockup_panic = 1, wanted 0/);
  assert.equal(hangDifference(hangHost(null, "1")), undefined, "no file: not set up for it, so not drifted");
});
