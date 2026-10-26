// no-token: gh -- `host-kernel.ts` starts a process only through the injected `run` (its comment on the row is the code host's `commentOnCheckoutRowByInput`, in `--read-back`'s main, never called here), reads herdr only through the injected `agents`, and the record is a temp-dir fixture; nothing here reboots, stops a timer or reaches a network
// a11ign/a11ign#4046: a newer kernel than the one running is NOTED by `host:check`, and the org does the drained reboot in #3846's order. FIXTURES ONLY.
//
// POSITIVE AND NEGATIVE CONTROL PER QUESTION: each "gives the note" test has a "gives none" twin that differs by ONE fact (which kernel runs), each "defers" has an
// "idle reboots" twin, each "refuses inside 24 h" has an "after 24 h reboots" twin. `emptiness` below is the control for the `[]` results: the same reader reports a note for
// the same /boot with another running kernel, so an empty result is a reading and not a reader that cannot see the kernels.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { DRAIN_BOUND_MS, DRAIN_POLL_MS, HANG_APPLY, HANG_CONF, HANG_CONF_PATH, HANG_SETTINGS, PSTORE_ROOT, REBOOT_ARGV, REBOOT_SERVICE, TICK_TIMER, crashRecordsFindings,
  drainedReboot, hangConfFindings, kdumpFindings, kernelFindings, kernelNotes, kernelReading, newestPstoreRecords, parseRelease, readBack, readBackOwed, rebootReport,
  recordStore, runPrivileged, stillOlderFinding, type HostReads } from "./host-kernel.ts";
import { driftReport } from "./host-units.ts";
import { hostDriftOrders } from "./work-gate.ts";
import { shippedUnitText, shippedUnits } from "./host-units/shipped-unit-texts-and-declarations.ts";
import { unitDrift, unitState } from "./host-units/host-drift-findings-and-notes.ts";
import { homeHostConfig } from "./host-config.ts";
import { trackedTopLevelDirs } from "./region-paths.ts";
import { moduleSource } from "./lib/source-text-reads.ts";

/** The text of the module and of the hang-settings code it re-exports: the source-scanning guards cover both, since the sudo texts and the file's path live in the second. */
const hostKernelSource = (): string => ["./host-kernel.ts", "./hang-settings.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
const BOOT = ["vmlinuz", "vmlinuz.old", "vmlinuz-7.0.0-34-generic", "vmlinuz-7.0.0-38-generic", "config-7.0.0-38-generic", "initrd.img-7.0.0-38-generic"];
const scratch = mkdtempSync(join(tmpdir(), "host-kernel-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const KDUMP = "/sys/kernel/kexec_crash_loaded";
const RECORD = `${PSTORE_ROOT}/1792941657/001/dmesg.txt`;

/**
 * A host's files as `readFile` and `listDir` see them, held in a map: a string is a file's text, an Error is what a read of it throws. A directory is any prefix of a path, and
 * one nothing lies under throws ENOENT. The default is a CLEAN host: the file as {@link HANG_CONF} prints it, the live values equal to it, kdump loaded, a record this user can read.
 * @param {Record<string, string | Error | null>} [over] a path set to null is removed
 */
function cleanHost(over: Record<string, string | Error | null> = {}): HostReads {
  const files = new Map<string, string | Error>([[HANG_CONF_PATH, HANG_CONF], [KDUMP, "1\n"], [RECORD, "Panic#1 Part1"],
    ...HANG_SETTINGS.map(({ key, value }): [string, string] => [`/proc/sys/kernel/${key}`, `${value}\n`])]);
  for (const [path, content] of Object.entries(over)) { if (content === null) files.delete(path); else files.set(path, content); }
  const errno = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code, path });
  return {
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw errno("ENOENT", path);
      if (content instanceof Error) throw content;
      return content;
    },
    listDir: (path) => {
      const refused = files.get(path);
      if (refused instanceof Error) throw refused;
      const below = [...files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1).split("/")[0]);
      if (below.length === 0) throw errno("ENOENT", path);
      return [...new Set(below)];
    },
  };
}
const refusal = (path: string) => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES", path });

/** @param {string} running @param {string[]} [boot] */
const notesFor = (running: string, boot: string[] = BOOT) => kernelNotes({ uname: () => `${running}\n`, bootEntries: () => boot });

/**
 * A host to reboot: `run` RECORDS every argv (and answers the host-job listing from `jobs`), `agents` is the seat listing, the clock moves only when `sleep` is called.
 * @param {{ running?: string, boot?: string[], agents?: ReturnType<typeof import("./herdr-agents.ts").readAgents> | (() => ReturnType<typeof import("./herdr-agents.ts").readAgents>),
 *   jobs?: string, record?: any, failReboot?: boolean, failStop?: boolean, unreadableRecord?: boolean, ignoreSeats?: string[] }} [over]
 */
function host(over: {
    running?: string; boot?: string[]; agents?: ReturnType<typeof import("./herdr-agents.ts").readAgents> | (() => ReturnType<typeof import("./herdr-agents.ts").readAgents>);
    jobs?: string; record?: any; failReboot?: boolean; failStop?: boolean; unreadableRecord?: boolean; ignoreSeats?: string[];
} = {}) {
  const calls = ([] as string[][]);
  const clock = { t: NOW };
  const idle = [{ label: "ceo", status: "idle" }, { label: "worker-1", status: "done" }, { label: "pm", status: "blocked" }];
  const stored = { record: over.record ?? null, writes: ([] as any[]) };
  const agents = "agents" in over ? over.agents : idle;
  return {
    calls, clock, stored,
    deps: {
      run: (argv: string[]) => {
        calls.push(argv);
        if (argv.join(" ") === `systemctl --user stop ${TICK_TIMER}` && over.failStop) throw new Error("stop refused");
        if (argv[0] === "sudo" && over.failReboot) throw new Error("a password is required");
        return argv[2] === "list-units" ? (over.jobs ?? "") : "";
      },
      uname: () => over.running ?? "7.0.0-34-generic",
      bootEntries: () => over.boot ?? BOOT,
      agents: typeof agents === "function" ? agents : () => agents,
      store: { read: () => { if (over.unreadableRecord) throw new Error("kernel-reboot.json is not JSON"); return stored.record; },
        write: (r: any) => { stored.writes.push(r); stored.record = r; } },
      now: () => clock.t,
      sleep: async (ms: number) => { clock.t += ms; },
      ...over.ignoreSeats === undefined ? {} : { ignoreSeats: over.ignoreSeats },
    },
  };
}
const sudoCalls = (calls: string[][]) => calls.filter((argv) => argv[0] === "sudo");
const timerCalls = (calls: string[][], verb: any) => calls.filter((argv) => argv[2] === verb && argv[3] === TICK_TIMER);

/** #1650: these subtests assert the pair under a11ign's `a11ign-` unit prefix (docs/project-tree-dependency.md, row 1650). The fixture's `units.prefix` is `fixture-`, so the shipped pair is `fixture-kernel-reboot.*` and none of these names is shipped there. */
const SKIP_FIXTURE = trackedTopLevelDirs().includes("packages") ? false
  : "the fixture's units.prefix is fixture-, so the shipped pair is fixture-kernel-reboot.*: these subtests assert the a11ign-kernel-reboot.* names that only a11ign's prefix ships";

describe("the note: version order, and what a refused read is", () => {
  test("running 7.0.0-34 over installed 7.0.0-38 gives the note, named as the row words it", () => {
    const [note, ...rest] = notesFor("7.0.0-34-generic");
    assert.equal(note.problem, "newer kernel installed, not running: 7.0.0-38-generic over 7.0.0-34-generic");
    assert.equal(rest.length, 0);
  });

  test("running 7.0.0-38 with the same /boot gives none (the twin), and the same reader notes the other running kernel (emptiness's control)", () => {
    assert.deepEqual(notesFor("7.0.0-38-generic"), []);
    assert.equal(notesFor("7.0.0-34-generic").length, 1);
  });

  test("a running kernel NEWER than every installed one gives none", () => {
    assert.deepEqual(notesFor("7.0.0-100-generic"), []);
  });

  test("7.0.0-100 over 7.0.0-38 is newer: VERSION order, where the string order says the opposite", () => {
    assert.ok("7.0.0-100-generic" < "7.0.0-38-generic", "the control: as strings, 100 sorts BEFORE 38");
    const [note] = notesFor("7.0.0-38-generic", [...BOOT, "vmlinuz-7.0.0-100-generic"]);
    assert.equal(note.problem, "newer kernel installed, not running: 7.0.0-100-generic over 7.0.0-38-generic");
  });

  test("`vmlinuz`, `vmlinuz.old` and another flavour are not candidates", () => {
    assert.deepEqual(notesFor("7.0.0-38-generic", [...BOOT, "vmlinuz-7.0.0-99-lowlatency", "vmlinuz-7.0.0-99-generic.dpkg-bak"]), []);
    assert.equal(parseRelease("vmlinuz.old"), null);
    assert.deepEqual(parseRelease("7.0.0-38-generic"), { nums: [7, 0, 0, 38], flavour: "generic" });
  });

  test("a refused read of the running kernel is NOT READ, never clear", () => {
    const [note] = kernelNotes({ uname: () => { throw new Error("uname: permission denied"); }, bootEntries: () => BOOT });
    assert.equal(note.problem, "NOT READ");
    assert.match(note.detail, /running kernel .* could not be read: uname: permission denied/);
    assert.equal(kernelReading(() => { throw new Error("x"); }, () => BOOT).state, "not-read");
  });

  test("a refused read of /boot is NOT READ, never clear", () => {
    const [note] = kernelNotes({ uname: () => "7.0.0-34-generic", bootEntries: () => { throw new Error("EACCES"); } });
    assert.equal(note.problem, "NOT READ");
    assert.match(note.detail, /\/boot could not be listed: EACCES/);
  });

  test("a /boot with no kernel of the running flavour, and a running name that is no release, are NOT READ too", () => {
    assert.equal(notesFor("7.0.0-34-generic", ["vmlinuz", "vmlinuz.old"])[0].problem, "NOT READ");
    assert.equal(notesFor("custom-build", BOOT)[0].problem, "NOT READ");
  });

  test("host:check PRINTS the note against a fixture and the note is not a failure (driftReport's notes block); with the kernels equal it prints none", () => {
    const printed = driftReport([], notesFor("7.0.0-34-generic"));
    assert.match(printed, /notes \(not failures\):\n {2}kernel: newer kernel installed, not running: 7\.0\.0-38-generic over 7\.0\.0-34-generic/);
    assert.doesNotMatch(driftReport([], notesFor("7.0.0-38-generic")), /newer kernel/);
  });

  test("the wiring: host-units.ts adds the note to hostNotes and the findings to hostFindings", () => {
    const source = moduleSource("host-units.ts");
    assert.match(source, /function hostNotes\(\)[^}]*\.\.\.kernelNotes\(\)/);
    assert.match(source, /function hostFindings\(\)[^}]*\.\.\.kernelFindings\(/);
  });
});

describe("the drained reboot: defer when busy, reboot once when idle", () => {
  test("an idle host with the note true stops the timer, calls the reboot EXACTLY ONCE, and does not start the timer again", async () => {
    const h = host();
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "rebooted");
    assert.deepEqual(sudoCalls(h.calls), [[...REBOOT_ARGV]]);
    assert.equal(timerCalls(h.calls, "stop").length, 1);
    assert.equal(timerCalls(h.calls, "start").length, 0, "boot starts the timer; a tick during shutdown is what the stop was for");
    const order = h.calls.map((argv) => argv.join(" "));
    assert.ok(order.indexOf(`systemctl --user stop ${TICK_TIMER}`) < order.indexOf(REBOOT_ARGV.join(" ")), "stopped BEFORE it reboots");
    assert.equal(h.stored.writes.length, 1, "the record is written before the reboot, because the process does not outlive it");
    assert.deepEqual(h.stored.record, { at: NOW, from: "7.0.0-34-generic", to: "7.0.0-38-generic" });
  });

  test("a seat mid-turn defers: the timer is started again, the deferral is said, and no reboot is called", async () => {
    const h = host({ agents: [{ label: "ceo", status: "idle" }, { label: "worker-9", status: "working" }] });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "deferred");
    assert.deepEqual(result.held, ["seat worker-9 is mid-turn"]);
    assert.equal(sudoCalls(h.calls).length, 0);
    assert.equal(timerCalls(h.calls, "stop").length, 1);
    assert.equal(timerCalls(h.calls, "start").length, 1);
    assert.ok(h.clock.t - NOW >= DRAIN_BOUND_MS, "it waited the whole bound before deferring");
    assert.match(rebootReport(result), /reboot DEFERRED, the timer is started again\. Held by: seat worker-9 is mid-turn/);
    assert.equal(h.stored.writes.length, 0);
  });

  test("a running host job defers the same way", async () => {
    const h = host({ jobs: "a11ign-tmp-prune.service loaded activating start start a11ign: remove old test fixtures\n" });
    const { outcome, held } = await drainedReboot((h.deps as any));
    assert.equal(outcome, "deferred");
    assert.deepEqual(held, ["host job a11ign-tmp-prune.service is running"]);
    assert.equal(sudoCalls(h.calls).length, 0);
    assert.equal(timerCalls(h.calls, "start").length, 1);
  });

  test("the scheduled reboot's OWN service, which shows as `activating` while it runs, does not hold its own reboot (#4053); another job still does", async () => {
    const own = `${REBOOT_SERVICE} loaded activating start start a11ign: reboot onto a newer installed kernel\n`;
    const h = host({ jobs: own });
    assert.equal((await drainedReboot((h.deps as any))).outcome, "rebooted");
    const other = host({ jobs: `${own}a11ign-tmp-prune.service loaded activating start start x\n` });
    assert.deepEqual((await drainedReboot((other.deps as any))).held, ["host job a11ign-tmp-prune.service is running"]);
  });

  test("a herdr that cannot be asked HOLDS the reboot: unknown is not idle", async () => {
    const h = host({ agents: null });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "deferred");
    assert.match(String(result.held?.[0]), /^NOT READ: herdr/);
    assert.equal(sudoCalls(h.calls).length, 0);
  });

});

describe("the drained reboot: defer when busy, reboot once when idle", () => {
  test("a busy seat that goes idle inside the bound lets the reboot through (the wait waits)", async () => {
    let polls = 0;
    const h = host({ agents: () => [{ label: "worker-9", status: ++polls < 3 ? "working" : "idle" }] });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "rebooted");
    assert.equal(h.clock.t - NOW, 2 * DRAIN_POLL_MS);
    assert.equal(sudoCalls(h.calls).length, 1);
  });

  test("the seat that runs the reboot is ignored when it names itself, and only then", async () => {
    const working = [{ label: "worker-4046", status: "working" }];
    assert.equal((await drainedReboot((host({ agents: working, ignoreSeats: ["worker-4046"] }).deps as any))).outcome, "rebooted");
    assert.equal((await drainedReboot((host({ agents: working }).deps as any))).outcome, "deferred");
  });

  test("no note, no reboot, no timer touched; an unreadable kernel is `not-read` and reboots nothing", async () => {
    const h = host({ running: "7.0.0-38-generic" });
    assert.equal((await drainedReboot((h.deps as any))).outcome, "not-needed");
    assert.equal(h.calls.length, 0);
    const blind = host({ boot: [] });
    assert.equal((await drainedReboot((blind.deps as any))).outcome, "not-read");
    assert.equal(blind.calls.length, 0);
  });

  test("a timer that will not stop means nothing was drained: no reboot, and it says so", async () => {
    const h = host({ failStop: true });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "timer-not-stopped");
    assert.equal(sudoCalls(h.calls).length, 0);
  });

  test("a reboot command that fails puts the record back and starts the timer again", async () => {
    const before = { at: NOW - 3 * 24 * HOUR, from: "7.0.0-30-generic", to: "7.0.0-34-generic", readBackAt: NOW - 2 * 24 * HOUR };
    const h = host({ failReboot: true, record: before });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "reboot-failed");
    assert.deepEqual(h.stored.record, before);
    assert.equal(timerCalls(h.calls, "start").length, 1);
  });
});

describe("the ONE privileged command", () => {
  test("every process the whole flow spawns is recorded, and the privileged one is `sudo systemctl reboot` and nothing else", async () => {
    const all = [];
    for (const over of [{}, { jobs: "a11ign-x.service loaded activating start" }, { agents: [{ label: "a", status: "working" }] }, { failReboot: true }]) {
      const h = host(over);
      await drainedReboot((h.deps as any));
      all.push(...h.calls);
    }
    assert.ok(sudoCalls(all).length >= 2, "the control: the recorded flows DID reach the privileged command");
    for (const argv of sudoCalls(all)) assert.deepEqual(argv, ["sudo", "systemctl", "reboot"]);
    for (const argv of all.filter((a) => a[0] !== "sudo")) assert.equal(argv[0], "systemctl", `an unprivileged spawn is a systemctl: ${argv.join(" ")}`);
    for (const argv of all.filter((a) => a[0] === "systemctl")) assert.equal(argv[1], "--user", `and a USER-manager one: ${argv.join(" ")}`);
  });

  test("runPrivileged refuses any other argv, however close; the granted one passes (the positive control)", () => {
    const ran = ([] as string[][]);
    const run = (argv: string[]) => { ran.push(argv); return ""; };
    for (const argv of [["sudo", "systemctl", "poweroff"], ["sudo", "systemctl", "reboot", "--force"], ["sudo", "rm", "-rf", "/"], ["sudo", "-n", "systemctl", "reboot"], ["systemctl", "reboot"], []]) {
      assert.throws(() => runPrivileged(argv, run), /refusing to run/, argv.join(" "));
    }
    assert.equal(ran.length, 0);
    runPrivileged([...REBOOT_ARGV], run);
    assert.deepEqual(ran, [["sudo", "systemctl", "reboot"]]);
  });

  test("every other use of the word in the code is inside a command the chairman is TOLD to run (a *_APPLY text), which nothing passes to `run`", () => {
    const source = hostKernelSource();
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    const told = code.filter((line) => /\bsudo\b/.test(line));
    assert.ok(told.length >= 3, "the control: the texts are found");
    // the *_APPLY texts, the reboot's argv, and the note's sentence about the one granted command
    for (const line of told) assert.match(line, /^(export )?const (HANG_APPLY|KDUMP_APPLY|PSTORE_APPLY|REBOOT_ARGV)\b|runs `sudo systemctl reboot` \(the one granted command\)/, line);
    assert.doesNotMatch(code.join("\n"), /\b(?:run|deps\.run|runPrivileged)\([^)]*(?:HANG_APPLY|KDUMP_APPLY|PSTORE_APPLY)/);
  });

  test("the SOURCE names `sudo` once: a second privileged command would be a second literal, and a new sudoers line", () => {
    const source = hostKernelSource();
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.equal((code.match(/["']sudo["']/g) ?? []).length, 1);
  });
});

describe("it cannot loop: a second reboot inside 24 hours is refused and the finding is raised", () => {
  const last = (hoursAgo: number, to: string = "7.0.0-38-generic") => ({ at: NOW - hoursAgo * HOUR, from: "7.0.0-34-generic", to });

  test("a reboot 2 h ago, the note still true: REFUSED, with the finding, and nothing is stopped or run", async () => {
    const h = host({ record: last(2) });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "refused-loop");
    assert.equal(result.finding?.problem, "REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING");
    assert.match(String(result.finding?.detail), /the boot loader chose the old kernel again/);
    assert.equal(h.calls.length, 0);
    assert.match(rebootReport(result), /reboot REFUSED/);
  });

  test("the twin: the same record 25 h old does not refuse, and the host reboots", async () => {
    const h = host({ record: last(25) });
    assert.equal((await drainedReboot((h.deps as any))).outcome, "rebooted");
    assert.equal(sudoCalls(h.calls).length, 1);
  });

  test("a still newer kernel that arrived since is named as such, not blamed on the boot loader", () => {
    const finding = stillOlderFinding(last(2, "7.0.0-38-generic"), { state: "newer", running: "7.0.0-38-generic", installed: "7.0.0-40-generic" }, NOW);
    assert.match(String(finding?.detail), /a newer kernel \(7\.0\.0-40-generic\) arrived since/);
  });

  test("with the note false the guard is silent whatever the record says; with no record, silent", () => {
    assert.equal(stillOlderFinding(last(2), { state: "current", running: "7.0.0-38-generic", installed: "7.0.0-38-generic" }, NOW), null);
    assert.equal(stillOlderFinding(null, { state: "newer", running: "a", installed: "b" }, NOW), null);
  });

  test("a record that cannot be read refuses the reboot (absence is not proof) and host:check raises it", async () => {
    const h = host({ unreadableRecord: true });
    const result = await drainedReboot((h.deps as any));
    assert.equal(result.outcome, "not-read");
    assert.equal(h.calls.length, 0);
    const [finding] = kernelFindings({ uname: () => "7.0.0-34-generic", bootEntries: () => BOOT, reads: cleanHost(), store: () => ({ read: () => { throw new Error("not JSON"); }, write: () => {} }) });
    assert.equal(finding.problem, "NOT READ");
  });

  test("host:check raises the loop finding as a FINDING (a note would wake nobody), and none on the live-shaped host with no record", () => {
    const store = (record: any) => () => ({ read: () => record, write: () => {} });
    const base = { uname: () => "7.0.0-34-generic", bootEntries: () => BOOT, reads: cleanHost(), now: () => NOW, bootedAt: () => NOW - 100 * HOUR };
    assert.equal(kernelFindings({ ...base, store: store(last(2)) })[0].problem, "REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING");
    assert.deepEqual(kernelFindings({ ...base, store: store(null) }), []);
    assert.deepEqual(kernelFindings({ ...base, uname: () => "7.0.0-38-generic", store: store(null) }), []);
  });
});

describe("the read-back after boot", () => {
  const record = { at: NOW - HOUR, from: "7.0.0-34-generic", to: "7.0.0-38-generic", row: 4046 };

  test("it is owed when the host booted after the record and none was posted; not before, not twice, not with no record", () => {
    assert.equal(readBackOwed(record, NOW - 30 * 60_000), true);
    assert.equal(readBackOwed(record, NOW - 2 * HOUR), false, "this boot predates the record");
    assert.equal(readBackOwed({ ...record, readBackAt: NOW }, NOW - 30 * 60_000), false);
    assert.equal(readBackOwed(null, NOW), false);
  });

  test("host:check raises an owed read-back as a finding naming the command", () => {
    const [finding] = kernelFindings({ uname: () => "7.0.0-38-generic", bootEntries: () => BOOT, reads: cleanHost(), now: () => NOW, bootedAt: () => NOW - 30 * 60_000,
      store: () => ({ read: () => record, write: () => {} }) });
    assert.equal(finding.problem, "REBOOT NOT READ BACK");
    assert.match(finding.detail, /--read-back/);
  });

  test("a boot time that cannot be read is a NOT READ finding, not an exception that crashes host:check (#367 review)", () => {
    const refused = () => { throw new Error("EACCES: /proc/uptime"); };
    const base = { uname: () => "7.0.0-38-generic", bootEntries: () => BOOT, reads: cleanHost(), now: () => NOW, bootedAt: refused };
    const [finding, ...rest] = kernelFindings({ ...base, store: () => ({ read: () => record, write: () => {} }) });
    assert.equal(finding.problem, "NOT READ");
    assert.match(finding.detail, /boot time could not be read/);
    assert.deepEqual(rest, []);
    // negative controls: with no record, or one already read back, the boot time is never asked for and the host is silent
    assert.deepEqual(kernelFindings({ ...base, store: () => ({ read: () => null, write: () => {} }) }), []);
    assert.deepEqual(kernelFindings({ ...base, store: () => ({ read: () => ({ ...record, readBackAt: NOW }), write: () => {} }) }), []);
    // the loop guard still speaks when the boot time cannot be read
    const looped = kernelFindings({ ...base, uname: () => "7.0.0-34-generic", store: () => ({ read: () => ({ ...record, at: NOW - 2 * HOUR }), write: () => {} }) });
    assert.deepEqual(looped.map((f) => f.problem), ["NOT READ", "REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING"]);
  });

  /** @param {Partial<Parameters<typeof readBack>[0]>} [over] */
  const deps = (over: Partial<Parameters<typeof readBack>[0]> = {}) => ({
    run: (argv: string[]) => (argv.includes("show") ? "747554924\n" : "active\n"),
    uname: () => "7.0.0-38-generic\n", agents: () => [{ label: "ceo", status: "idle" }], seats: () => ["ceo"],
    proc: (name: string) => ({ softlockup_panic: "1", panic_on_rcu_stall: "1", panic_on_oops: "1", hung_task_panic: "0", panic: "10" })[name] + "\n",
    tracePages: async () => "https://host/ answered 200, 1102 characters", ...over,
  });

  test("it reads the kernel, the five sysctls, the tick, the seats and the trace pages", async () => {
    const lines = await readBack(deps());
    assert.deepEqual(lines, ["- uname -r: 7.0.0-38-generic", "- kernel.softlockup_panic: 1", "- kernel.panic_on_rcu_stall: 1", "- kernel.panic_on_oops: 1",
      "- kernel.hung_task_panic: 0", "- kernel.panic: 10", "- work tick: fired since boot; timer active", "- standing seats: every persistent seat is listed",
      "- trace pages: https://host/ answered 200, 1102 characters"]);
  });

  test("each refused read is NOT READ on its own line, and a tick that has not fired, a missing seat are said", async () => {
    const lines = await readBack(deps({
      run: (argv) => (argv.includes("show") ? "0\n" : "active\n"), seats: () => ["ceo", "liaison"],
      proc: (name) => { if (name === "panic") throw new Error("EACCES"); return "1"; },
      tracePages: async () => { throw new Error("tailscale serve publishes no web handler"); } }));
    assert.ok(lines.includes("- kernel.panic: NOT READ (EACCES)"));
    assert.ok(lines.includes("- work tick: has NOT fired since boot; timer active"));
    assert.ok(lines.includes("- standing seats: ABSENT: liaison"));
    assert.ok(lines.includes("- trace pages: NOT READ (tailscale serve publishes no web handler)"));
    assert.equal(lines.length, 9);
  });
});

// A11-279: THE MODULE OWNS 90-a11ign-hang.conf. `softlockup_panic = 0` is written HERE, so no host check can put 1 back; every read is injected, so no test reads this machine.
describe("the hang settings file: its text, and the drift from it", () => {
  const settingLines = (text: string) => text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));

  test("the text holds exactly the four settings, with softlockup_panic = 0, and no hung_task_panic", () => {
    assert.deepEqual(settingLines(HANG_CONF), ["kernel.softlockup_panic = 0", "kernel.panic_on_rcu_stall = 1", "kernel.panic_on_oops = 1", "kernel.panic = 10"]);
    assert.doesNotMatch(HANG_CONF, /hung_task_panic\s*=/);
    assert.doesNotMatch(HANG_CONF, /softlockup_panic\s*=\s*1/);
  });

  test("each setting is preceded by its reason, and the header says why the file exists and why softlockup_panic changed", () => {
    const lines = HANG_CONF.split("\n");
    for (const { key, value, reason } of HANG_SETTINGS) assert.equal(lines[lines.indexOf(`kernel.${key} = ${value}`) - 1], `# ${reason}`, key);
    assert.match(lines.slice(0, 3).join("\n"), /#3846/);
    assert.match(lines.slice(0, 3).join("\n"), /A11-279/);
  });

  test("`--hang-conf` prints that text and nothing else, and does not write the file", () => {
    const printed = execFileSync(process.execPath, [fileURLToPath(new URL("./host-kernel.ts", import.meta.url)), "--hang-conf"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(printed, HANG_CONF);
    assert.equal(HANG_CONF.endsWith("\n"), true);
  });

  test("`--hang-conf` beside another flag is refused, not silently preferred: --reboot and --read-back do not run, and nothing is printed", () => {
    const entry = fileURLToPath(new URL("./host-kernel.ts", import.meta.url));
    for (const other of ["--reboot", "--read-back"]) {
      const run = spawnSync(process.execPath, [entry, "--hang-conf", other], { encoding: "utf8", timeout: 60_000 });
      assert.equal(run.status, 1, other);
      assert.equal(run.stdout, "", other);
      assert.match(run.stderr, /run it alone/, other);
    }
  });

  test("the control: a host whose file is the printed text and whose live values equal it raises nothing", () => {
    assert.deepEqual(hangConfFindings(cleanHost()), []);
  });

  test("the file the host has today (softlockup_panic = 1, live 1) raises HANG SETTINGS DIFFER with the command that applies the text", () => {
    const today = "kernel.softlockup_panic = 1\nkernel.panic_on_rcu_stall = 1\nkernel.panic_on_oops = 1\nkernel.panic = 10\n";
    const [finding, ...rest] = hangConfFindings(cleanHost({ [HANG_CONF_PATH]: today, "/proc/sys/kernel/softlockup_panic": "1\n" }));
    assert.equal(finding.problem, "HANG SETTINGS DIFFER");
    assert.match(finding.detail, /the file has kernel\.softlockup_panic = 1, wanted 0/);
    assert.match(finding.detail, /kernel\.softlockup_panic is 1 now, wanted 0/);
    assert.ok(finding.detail.includes(HANG_APPLY), "the exact root command");
    assert.equal(HANG_APPLY, "node src/host-kernel.ts --hang-conf | sudo tee /etc/sysctl.d/90-a11ign-hang.conf && sudo sysctl --system");
    assert.deepEqual(rest, []);
  });

  test("a live value that differs while the file is right is raised (a value set by hand is gone at the next boot), and the file alone differing is raised too", () => {
    const live = hangConfFindings(cleanHost({ "/proc/sys/kernel/softlockup_panic": "1\n" }));
    assert.equal(live[0].problem, "HANG SETTINGS DIFFER");
    assert.doesNotMatch(live[0].detail, /the file has/);
    const file = hangConfFindings(cleanHost({ [HANG_CONF_PATH]: HANG_CONF.replace("kernel.panic = 10", "kernel.panic = 0") }));
    assert.match(file[0].detail, /the file has kernel\.panic = 0, wanted 10/);
    assert.doesNotMatch(file[0].detail, /now, wanted/);
  });

});

describe("the hang settings file: what differs from it", () => {
  test("a file that is absent, or that adds a setting, differs; comments and spacing do not", () => {
    assert.match(hangConfFindings(cleanHost({ [HANG_CONF_PATH]: null }))[0].detail, /does not exist/);
    assert.match(hangConfFindings(cleanHost({ [HANG_CONF_PATH]: `${HANG_CONF}kernel.hung_task_panic = 1\n` }))[0].detail, /sets kernel\.hung_task_panic/);
    const respaced = HANG_CONF.replace(/^#.*$/gm, "# other words").replace(/ = /g, "=");
    assert.deepEqual(hangConfFindings(cleanHost({ [HANG_CONF_PATH]: respaced })), []);
  });

  test("a refused read is NOT READ, never clear; a refused read next to a real difference is still the difference", () => {
    const refused = hangConfFindings(cleanHost({ [HANG_CONF_PATH]: refusal(HANG_CONF_PATH), "/proc/sys/kernel/panic": refusal("/proc/sys/kernel/panic") }));
    assert.equal(refused.length, 1);
    assert.equal(refused[0].problem, "NOT READ");
    assert.match(refused[0].detail, /EACCES/);
    const both = hangConfFindings(cleanHost({ [HANG_CONF_PATH]: refusal(HANG_CONF_PATH), "/proc/sys/kernel/softlockup_panic": "1\n" }));
    assert.equal(both[0].problem, "HANG SETTINGS DIFFER");
    assert.match(both[0].detail, /NOT READ/);
  });

  test("no code path of the module writes the file: the only writes are the reboot record's, and the text is only ever printed", () => {
    const source = hostKernelSource();
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.equal((code.match(/writeFileSync\(/g) ?? []).length, 1, "recordStore's write");
    assert.equal((code.match(/\b(rmSync|mkdirSync|appendFileSync|renameSync|copyFileSync)\(/g) ?? []).length, 2, "recordStore's rmSync and mkdirSync");
    assert.doesNotMatch(code, /writeFileSync\([^)]*HANG_CONF_PATH/);
  });
});

describe("kdump and the crash records, found and cleared", () => {
  test("kdump not loaded raises KDUMP NOT LOADED with the root commands; loaded raises none (the twin); an unreadable flag is NOT READ", () => {
    const [finding, ...rest] = kdumpFindings(cleanHost({ [KDUMP]: "0\n" }));
    assert.equal(finding.problem, "KDUMP NOT LOADED");
    assert.match(finding.detail, /USE_KDUMP=1/);
    assert.match(finding.detail, /systemctl restart kdump-tools/);
    assert.deepEqual(rest, []);
    assert.deepEqual(kdumpFindings(cleanHost()), []);
    assert.equal(kdumpFindings(cleanHost({ [KDUMP]: null }))[0].problem, "NOT READ");
  });

  test("the files of the newest boot stamp, then the newest numbered folder, are the ones opened; numbers order by value, and a stray file is passed over", () => {
    const reads = cleanHost({ [`${PSTORE_ROOT}/1790893277/001/dmesg.txt`]: "old", [`${PSTORE_ROOT}/1792941657/002/dmesg.txt`]: "newest", [`${PSTORE_ROOT}/1792941657/002/dmesg-efi_pstore-1`]: "raw",
      [`${PSTORE_ROOT}/1792941657/1000/dmesg.txt`]: "the 1000th" });
    assert.deepEqual(newestPstoreRecords(reads).map((p) => p.slice(PSTORE_ROOT.length)), ["/1792941657/1000/dmesg.txt"]);
    const stray = { ...reads, listDir: (path: string) => { if (path === `${PSTORE_ROOT}/1792941657/1000`) throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR", path }); return reads.listDir(path); } };
    assert.deepEqual(newestPstoreRecords(stray).map((p) => p.slice(PSTORE_ROOT.length)).sort(), ["/1792941657/002/dmesg-efi_pstore-1", "/1792941657/002/dmesg.txt"]);
  });

  test("every file of the newest record is opened: one 0600 file beside a readable dmesg.txt is the finding, and it names that file", () => {
    const raw = `${PSTORE_ROOT}/1792941657/001/dmesg-efi_pstore-179294165601001`;
    const [finding] = crashRecordsFindings(cleanHost({ [raw]: refusal(raw) }));
    assert.equal(finding.problem, "CRASH RECORDS NOT READABLE");
    assert.ok(finding.detail.includes(raw));
  });

  test("a folder the archive refuses is named in the finding, not the archive root; a folder that vanishes mid-read is NOT READ, not 'no archive'", () => {
    const folder = `${PSTORE_ROOT}/1792941657/001`;
    const clean = cleanHost();
    const refused = { ...clean, listDir: (path: string) => { if (path === folder) throw refusal(folder); return clean.listDir(path); } };
    assert.ok(crashRecordsFindings(refused)[0].detail.includes(folder));
    const vanished = { ...clean, listDir: (path: string) => { if (path === folder) throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path }); return clean.listDir(path); } };
    assert.equal(crashRecordsFindings(vanished)[0].problem, "NOT READ");
  });

  test("a record file this user is refused raises CRASH RECORDS NOT READABLE with the root command, and a record it can read raises none", () => {
    const [finding, ...rest] = crashRecordsFindings(cleanHost({ [RECORD]: refusal(RECORD) }));
    assert.equal(finding.problem, "CRASH RECORDS NOT READABLE");
    assert.ok(finding.detail.includes(RECORD));
    assert.match(finding.detail, /setfacl -R -m g:adm:rX -m d:g:adm:rX \/var\/lib\/systemd\/pstore \/var\/crash/);
    assert.deepEqual(rest, []);
    assert.deepEqual(crashRecordsFindings(cleanHost()), []);
  });

  test("an archive whose DIRECTORY is refused is the same finding; an archive that is not there holds no record, so it raises none; another failure is NOT READ", () => {
    assert.equal(crashRecordsFindings(cleanHost({ [PSTORE_ROOT]: refusal(PSTORE_ROOT), [RECORD]: null }))[0].problem, "CRASH RECORDS NOT READABLE");
    assert.deepEqual(crashRecordsFindings(cleanHost({ [RECORD]: null })), []);
    const broken = Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
    assert.equal(crashRecordsFindings(cleanHost({ [RECORD]: broken }))[0].problem, "NOT READ");
  });

  test("the real file system: a 0600 file of another owner is the refusal the finding is for (a mode-000 file stands in for root's)", { skip: process.getuid?.() === 0 && "root reads any file" }, () => {
    const archive = join(scratch, "pstore");
    const record = join(archive, "1792941657", "001", "dmesg.txt");
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, "Panic#1 Part1");
    const inArchive = (path: string) => path.replace(PSTORE_ROOT, archive);
    const real: HostReads = { readFile: (path) => readFileSync(inArchive(path), "utf8"), listDir: (path) => readdirSync(inArchive(path)) };
    assert.deepEqual(crashRecordsFindings(real), [], "the control: readable while the mode allows it");
    chmodSync(record, 0o000);
    const [finding] = crashRecordsFindings(real);
    assert.equal(finding.problem, "CRASH RECORDS NOT READABLE");
    assert.ok(finding.detail.includes(record), "it names the file the file system refused");
  });

});

describe("the crash settings findings, as host:check raises them", () => {
  test("the three are STANDING findings: manualFix, so the host-drift gate wakes nobody to run host:install, and a unit each, so one NOT READ is not another's key", () => {
    const dirty = cleanHost({ [HANG_CONF_PATH]: "kernel.softlockup_panic = 1\n", [KDUMP]: "0\n", [RECORD]: refusal(RECORD) });
    const found = [...hangConfFindings(dirty), ...kdumpFindings(dirty), ...crashRecordsFindings(dirty)];
    assert.equal(found.length, 3);
    assert.ok(found.every((f) => f.manualFix === true));
    assert.equal(new Set(found.map((f) => f.unit)).size, 3);
    assert.deepEqual(hostDriftOrders(found), [], "the gate emits nothing for a set of only manual findings");
    const reboot = stillOlderFinding({ at: NOW - 2 * HOUR, from: "a", to: "7.0.0-38-generic" }, { state: "newer", running: "7.0.0-34-generic", installed: "7.0.0-38-generic" }, NOW);
    assert.notEqual(reboot?.manualFix, true, "the control: the loop guard is not manual, and still wakes the gate");
    assert.equal(hostDriftOrders([...found, reboot as any]).length, 1);
  });

  test("a host with no user systemd (crashSettings: false) is not told its kernel settings drifted; the same host with it on is", () => {
    const base = { uname: () => "7.0.0-38-generic", bootEntries: () => BOOT, now: () => NOW, bootedAt: () => NOW, store: () => ({ read: () => null, write: () => {} }) };
    const bare = cleanHost({ [HANG_CONF_PATH]: null, [KDUMP]: null });
    assert.deepEqual(kernelFindings({ ...base, reads: bare, crashSettings: false }), []);
    assert.ok(kernelFindings({ ...base, reads: bare }).length >= 2);
  });

  test("kernelFindings raises all three beside the reboot findings, and none on a clean host (the wiring)", () => {
    const base = { uname: () => "7.0.0-38-generic", bootEntries: () => BOOT, now: () => NOW, bootedAt: () => NOW, store: () => ({ read: () => null, write: () => {} }) };
    assert.deepEqual(kernelFindings({ ...base, reads: cleanHost() }), []);
    const dirty = cleanHost({ [HANG_CONF_PATH]: "kernel.softlockup_panic = 1\n", [KDUMP]: "0\n", [RECORD]: refusal(RECORD) });
    assert.deepEqual(kernelFindings({ ...base, reads: dirty }).map((f) => f.problem), ["HANG SETTINGS DIFFER", "KDUMP NOT LOADED", "CRASH RECORDS NOT READABLE"]);
    const unreadableStore = { ...base, store: () => ({ read: () => { throw new Error("not JSON"); }, write: () => {} }) };
    assert.deepEqual(kernelFindings({ ...unreadableStore, reads: dirty }).map((f) => f.problem), ["NOT READ", "HANG SETTINGS DIFFER", "KDUMP NOT LOADED", "CRASH RECORDS NOT READABLE"],
      "a record of the last reboot that cannot be read does not hide the crash settings");
  });
});

describe("the record store", () => {
  test("round-trips, answers null for an absent record, and THROWS for a corrupt one", () => {
    const path = join(scratch, "state", "kernel-reboot.json");
    const store = recordStore(path);
    assert.equal(store.read(), null);
    store.write({ at: NOW, from: "a", to: "b" });
    assert.deepEqual(store.read(), { at: NOW, from: "a", to: "b" });
    writeFileSync(path, "{not json");
    assert.throws(() => store.read(), /is not JSON/);
    store.write(null);
    assert.equal(store.read(), null);
  });
});

// a11ign/a11ign#4053: SOMETHING RUNS `--reboot`. Rendered against a host built HERE -- a scratch project and a `tool` -- and never against the
// machine's own declaration: CI has no `a11y-witness` checkout, so reading `project.json` from the real host refused there (the first push of this row).
describe("the scheduled reboot: the shipped unit pair (#4053)", () => {
  const SERVICE = "a11ign-kernel-reboot.service";
  const TIMER = "a11ign-kernel-reboot.timer";
  const project = join(scratch, "project");
  mkdirSync(join(project, ".agent-org"), { recursive: true });
  writeFileSync(join(project, ".agent-org", "project.json"), JSON.stringify({ schema: 1 }));
  const home = homeHostConfig();
  const { tool: _tool, ...untooled } = ((home as unknown) as Record<string, unknown>);
  const plainHost = (untooled as any);
  const toolHost = ({ ...untooled, projects: [{ id: home.primary, checkout: project }], tool: "/tool" } as any);
  const text = (unit: string, host: any = toolHost) => String(shippedUnitText(unit, { host }));

  test("both units ship and render, and the service is the name the drain excuses (the positive control for every pin below)", { skip: SKIP_FIXTURE }, () => {
    assert.deepEqual(shippedUnits().filter((u) => u.includes("kernel-reboot")).sort(), [SERVICE, TIMER]);
    assert.equal(SERVICE, REBOOT_SERVICE, "whatHolds excuses this name; a rename that misses one of them makes every scheduled run defer");
    assert.match(text(SERVICE), /^\[Service\]$/m);
    assert.match(text(TIMER), /^\[Timer\]$/m);
  });

  test("the service's ExecStart is exactly `--reboot` -- one ExecStart, the module, and no other flag", { skip: SKIP_FIXTURE }, () => {
    const starts = text(SERVICE).split("\n").filter((line) => /^ExecStart=/.test(line));
    assert.equal(starts.length, 1);
    assert.equal(starts[0], "ExecStart=%h/.local/bin/node src/host-kernel.ts --reboot", "the tool form");
    assert.equal(text(SERVICE, plainHost).split("\n").filter((line) => /^ExecStart=/.test(line)).join(), "ExecStart=%h/.local/bin/node packages/agent-org/src/host-kernel.ts --reboot", "the plain form");
    assert.doesNotMatch(text(SERVICE), /^ExecStart.*--(self|row|read-back)/m);
    assert.match(text(SERVICE), /^Type=oneshot$/m);
    assert.doesNotMatch(text(SERVICE), /^\[Install\]/m, "a boot must not start a reboot");
  });

  test("the timer says exactly `ceo`'s hour, and carries no `Requires=`, so `host:install`'s `enable --now` cannot reboot the host", { skip: SKIP_FIXTURE }, () => {
    assert.match(text(TIMER), /^OnCalendar=\*-\*-\* 05:30:00 Europe\/London$/m);
    assert.equal(text(TIMER).split("\n").filter((l) => /^OnCalendar=/.test(l)).length, 1);
    assert.doesNotMatch(text(TIMER), /^Requires=/m);
    assert.doesNotMatch(text(TIMER), /^Persistent=/m, "a catch-up would fire at boot");
    assert.match(text(TIMER), /^WantedBy=timers\.target$/m);
  });

  test("host:check finds the pair CURRENT once installed; a missing, edited or untouched-but-different copy is reported", { skip: SKIP_FIXTURE }, () => {
    const installedDir = join(scratch, "installed");
    mkdirSync(installedDir, { recursive: true });
    const systemctl = (args: string[]) => (args[0] === "is-enabled" ? "enabled" : "active");
    const states = () => [SERVICE, TIMER].map((unit) => unitState(unit, { installedDir, systemctl, host: toolHost }));
    assert.deepEqual(unitDrift(states()).map((d) => `${d.unit}: ${d.problem}`), [`${SERVICE}: NOT INSTALLED`, `${TIMER}: NOT INSTALLED`], "the control: absent is reported");
    for (const unit of [SERVICE, TIMER]) writeFileSync(join(installedDir, unit), text(unit));
    assert.deepEqual(unitDrift(states()), [], "installed from the shipped text, the pair is current");
    writeFileSync(join(installedDir, TIMER), text(TIMER).replace("05:30", "04:30"));
    assert.deepEqual(unitDrift(states()).map((d) => `${d.unit}: ${d.problem}`), [`${TIMER}: STALE`]);
  });
});
