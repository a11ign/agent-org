// no-token: gh
//
// Nothing here spawns anything. `shippedUnits`, `unitState`, `unitDrift` and `driftReport` all take their
// filesystem and their `systemctl` injected; `hostUnitsInstall` takes its copier. The only real read is
// of `packages/agent-org/host/`, this repository's own directory, in the last test.

/**
 * #1858: A UNIT FILE IN THE REPOSITORY IS NOT A RUNNING TIMER.
 *
 * Measured 2026-09-21. #1844 shipped the nightly fleet scheduler -- built so the fleet batch would stop
 * depending on a session remembering it -- and merged at 19:22Z. At 19:38Z the chairman asked why nothing
 * was happening: `systemctl --user is-enabled a11ign-fleet-gated-nightly.timer` said `not-found`. The unit
 * had never been copied out of `packages/agent-org/host/`. Installing the scheduler depended on a session
 * remembering, which is the defect the scheduler existed to remove.
 *
 * `a11ign-corpus-snapshot.timer` failed the same hour in the quieter way: installed, `enabled`, and
 * `inactive` on a host up for nine days -- `enable` without `--now`, and nothing ever said so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shippedUnits, unitState, unitDrift, driftReport, hostUnitsInstall, systemdUserAvailable,
  hostUnitDrift, permissionModeDrift, orphanedUnits, SHIPPED_DIR } from "../host-units.mjs";

const SYSTEMD_OK = () => "LANG=C\n";
const NO_SYSTEMD = () => { throw new Error("systemctl: command not found"); };

/** `systemctl` as a lookup table: {verb: {unit: answer}}, throwing like the real one on a non-zero word. */
const systemctlStub = (answers: Record<string, Record<string, string>>) => (args: string[]) => {
  if (args[0] === "show-environment") return "LANG=C\n";
  const word = answers[args[0]]?.[args[1]] ?? "unknown";
  if (word === "active" || word === "enabled") return `${word}\n`;
  // THE REAL SHAPE: systemctl writes the word to stdout AND exits non-zero for inactive/disabled, so
  // execFileSync throws with `.stdout` carrying the answer. A stub that merely returned the string would
  // let a `catch`-less implementation pass and then crash on a real host.
  const error: Error & { stdout?: string } = new Error(`Command failed: systemctl ${args.join(" ")}`);
  error.stdout = `${word}\n`;
  throw error;
};

test("#1858: a shipped unit that was never installed is the finding", () => {
  const state = unitState("a11ign-fleet-gated-nightly.timer", {
    exists: (() => false) as never,
    systemctl: systemctlStub({ "is-enabled": {}, "is-active": {} }),
  });
  assert.equal(state.present, false);
  assert.equal(state.current, null,
    "NULL, not false -- 'there is no copy' and 'the copy differs' need different remedies");
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "NOT INSTALLED");
  assert.match(finding.detail, /It cannot run/);
});

test("#1858: ENABLED BUT NOT RUNNING is its own finding -- the one that actually happened", () => {
  // `enabled` and `active` are separate fields precisely so this state has somewhere to live. A single
  // "is it on?" boolean would have had to pick one of systemd's two answers, and either choice reports
  // a11ign-corpus-snapshot.timer's nine dead days as healthy.
  const state = unitState("a11ign-corpus-snapshot.timer", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).includes("host/") ? "X" : "X")) as never,
    systemctl: systemctlStub({
      "is-enabled": { "a11ign-corpus-snapshot.timer": "enabled" },
      "is-active": { "a11ign-corpus-snapshot.timer": "inactive" },
    }),
  });
  assert.deepEqual([state.enabled, state.active], ["enabled", "inactive"],
    "the word systemd used survives the non-zero exit -- reading only the exit code loses it");
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "ENABLED BUT NOT RUNNING");
  assert.match(finding.detail, /--now/, "and it names the flag whose absence causes it");
});

test("#1858: a timer that is enabled AND active is NOT a finding -- the positive control", () => {
  const state = unitState("a11ign-work-tick.timer", {
    exists: (() => true) as never,
    read: (() => "X") as never,
    systemctl: systemctlStub({
      "is-enabled": { "a11ign-work-tick.timer": "enabled" },
      "is-active": { "a11ign-work-tick.timer": "active" },
    }),
  });
  assert.deepEqual(unitDrift([state]), [],
    "this check must be capable of finding nothing, or every report is noise");
});

test("#1858: an installed copy that DIFFERS from the repository is STALE", () => {
  // They are copies, not symlinks -- the convention already on the host -- so a merged edit does not
  // reach the host until somebody reinstalls. That gap is invisible without this.
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith(SHIPPED_DIR) ? "NEW" : "OLD")) as never,
  });
  assert.equal(state.current, false);
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "STALE");
  assert.match(finding.detail, /does NOT reach the host until it is reinstalled/);
});

test("#1858: a .service is judged on PRESENT and CURRENT only -- a service has no timer's liveness", () => {
  // `systemctl is-active` on a `oneshot` service is `inactive` almost always, and correctly so: it ran
  // and exited. Judging one by liveness would report every healthy oneshot as broken.
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never, read: (() => "X") as never,
    systemctl: (() => { throw new Error("must not be asked about a .service"); }) as never,
  });
  assert.deepEqual([state.enabled, state.active], [null, null]);
  assert.deepEqual(unitDrift([state]), []);
});

test("#1858: NO SYSTEMD REPORTS NOTHING, and says so rather than saying everything is fine", () => {
  // The first version of this file lacked this gate while its own comment claimed the property, and on
  // the Mac it was written on it reported all six shipped units "NOT INSTALLED" -- true, useless, and
  // the fastest possible route to somebody silencing the check that matters.
  assert.equal(systemdUserAvailable(NO_SYSTEMD as never), false);
  assert.equal(systemdUserAvailable(SYSTEMD_OK as never), true);
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD as never }), [],
    "a developer checkout is not a host that failed to install anything");
  assert.match(driftReport([], false), /NOT CHECKED/);
  assert.doesNotMatch(driftReport([], false), /every shipped unit is installed/,
    "NOT ASKED and ALL CORRECT are both an empty list, and the report must never say the second when "
    + "it means the first");
  assert.match(driftReport([], true), /every shipped unit is installed/);
});

test("#1858: the installer uses `enable --now`, never a bare `enable`", () => {
  // MUTATION TARGET. An installer that can reproduce the bug it exists to fix is not an installer:
  // a bare `enable` is exactly what left a11ign-corpus-snapshot.timer enabled and dead for nine days.
  const calls: string[][] = [];
  const copied: string[] = [];
  // The REAL shipped directory, with only the WRITES stubbed: `hostUnitsInstall` discovers units through
  // `shippedUnits`, so a made-up source path finds nothing and the assertions below pass vacuously --
  // which is exactly what the first version of this test did.
  hostUnitsInstall({
    installedDir: "/installed",
    systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
    copy: ((from: string) => { copied.push(String(from)); }) as never,
    mkdir: (() => undefined) as never,
    out: () => undefined,
  });
  assert.ok(copied.length > 0, "it copied the units it found");
  assert.deepEqual(calls[0], ["daemon-reload"], "reload BEFORE enabling, or systemd enables a stale unit");
  const enables = calls.filter((c) => c[0] === "enable");
  assert.ok(enables.length > 0, "and it enabled the timers");
  for (const call of enables) {
    assert.deepEqual(call.slice(0, 2), ["enable", "--now"], `bare enable in ${JSON.stringify(call)}`);
    assert.match(call[2], /\.timer$/, "only timers are enabled -- a oneshot service is pulled by its timer");
  }
});

test("#1858: every unit this repository ships is discovered -- against the real directory", () => {
  const units = shippedUnits();
  assert.ok(units.includes("a11ign-work-tick.timer"), "the tick timer is the one known-good unit");
  assert.ok(units.includes("a11ign-corpus-release-nightly.timer"),
    "and the corpus release nightly, which this check caught shipped-but-uninstalled on its first day");
  // #1941 RETIRED `a11ign-fleet-gated-nightly.*`, which this test originally named as its second example
  // (it was #1858's own case: shipped by #1844 and never installed). Its question -- are there
  // fleet-gated rows to dispatch? -- moved into `work-gate.mjs` as `fleet-batch-due`, because it is a
  // STATE question and `agent-practices.md` forbids putting those on a clock. The units are gone so
  // `host:install` cannot put the timer back beside the gate cause and fire the same batch twice.
  assert.ok(!units.some((u) => u.startsWith("a11ign-fleet-gated-nightly")),
    "the retired nightly must not ship");
  assert.deepEqual(units, [...units].sort(), "sorted, so a report reads the same way twice");
  assert.ok(units.every((u) => u.endsWith(".timer") || u.endsWith(".service")),
    "nothing but units -- a README dropped in that directory must not become a finding");
});

// --- #1863: the org silently reverts to auto mode every time herdr restarts ---------------------------
//
// Measured 2026-09-21. `orchestrator` did every step of the corpus backup, reached the upload, and
// stopped: its permission classifier refused the publish as "Modify Shared Resources". It could not ask
// either -- `agentArgs` removes `AskUserQuestion` (#1744) because a session that stops to ask is one
// herdr reports as `blocked`. Unable to act AND unable to ask, on the operations that matter.
//
// `agentArgs` DOES pass --dangerously-skip-permissions, but only on `herdr agent start`. herdr resumes an
// existing session as a bare `claude --resume <uuid>`, and re-resumes all of them when it restarts: six
// came back at 18:47:27 in one instant, in auto mode. A launch flag cannot hold a posture across a resume.

const settings = (json: string) => ({
  settingsPath: "/home/agent/.claude/settings.json",
  exists: (() => true) as never,
  read: (() => json) as never,
});

test("#1863: bypassPermissions is the only posture that is NOT a finding", () => {
  assert.deepEqual(permissionModeDrift(settings('{"permissions":{"defaultMode":"bypassPermissions"}}')), [],
    "the positive control -- this check must be capable of passing");
});

test("#1863: auto mode is the finding, and the message says WHY it strands a session", () => {
  const [f] = permissionModeDrift(settings('{"permissions":{"defaultMode":"acceptEdits"}}'));
  assert.equal(f.problem, "ORG IS IN AUTO MODE");
  assert.match(f.detail, /acceptEdits/, "it names the mode it found rather than only the one it wants");
  assert.match(f.detail, /cannot ask either/,
    "the compounding half: AskUserQuestion is removed, so the session stops with NO signal at all");
  assert.match(f.detail, /does not survive herdr resuming/,
    "and it says why the launch flag is not the remedy, or the next reader adds the flag again");
});

test("#1863: an ABSENT key and an absent FILE are both findings, neither silently fine", () => {
  const [unset] = permissionModeDrift(settings('{"model":"opus[1m]"}'));
  assert.equal(unset.problem, "ORG IS IN AUTO MODE");
  assert.match(unset.detail, /unset/, "an absent key is auto mode -- that is exactly how this happened");
  const [absent] = permissionModeDrift({ settingsPath: "/nope", exists: (() => false) as never });
  assert.equal(absent.problem, "NO SETTINGS FILE");
});

test("#1863: UNREADABLE is its own verdict -- unknown is not the same as wrong", () => {
  // Reporting broken JSON as "auto mode" would send a reader to change a key in a file that will not
  // load whatever they put in it.
  const [f] = permissionModeDrift(settings("{ this is not json"));
  assert.equal(f.problem, "UNREADABLE");
  assert.match(f.detail, /UNKNOWN rather than wrong/);
  // AND THE PARSER'S OWN MESSAGE SURVIVES. Without this a mutant that drops the cause passed: "the file
  // is unparseable" sends a reader to look at 40 lines of JSON, where the position the parser names
  // sends them to the character. Losing a cause is this repository's most-repaid mistake.
  assert.match(f.detail, /at position \d+/,
    "the JSON parser's own complaint reaches the reader, not just the verdict that it failed. Matched on "
    + "`at position <n>`, which ONLY the parser produces -- my first attempt matched /JSON/ and passed "
    + "against the static words \"Fix the JSON first\", so the mutant that dropped the cause survived");
});

test("#1863: a machine with no user systemd is not told its permissions are wrong", () => {
  // Same gate as the timers, and for the same reason: a laptop told "ORG IS IN AUTO MODE" teaches its
  // owner to ignore this command, which loses the timer finding along with it.
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD as never }), []);
});

test("#1911: the corpus-release unit reads fleet.env, the only place a unit can get A11Y_PVE_KEY", () => {
  // `~/.zshenv` exported it for every shell and for no unit, so the nightly failed every firing. The `-`
  // leaves a missing file to corpus-release-nightly.mjs's own refusal, which names it.
  const unit = readFileSync(join(SHIPPED_DIR, "a11ign-corpus-release-nightly.service"), "utf8");
  assert.match(unit, /^EnvironmentFile=-%h\/\.config\/a11ign\/fleet\.env$/m);
});

// --- #1951: a unit the repo stopped shipping keeps firing, and nothing said so ------------------------
//
// MEASURED 2026-09-22. #1941 retired `a11ign-fleet-gated-nightly.{service,timer}` -- the 01:00 batch
// became work-gate's `fleet-batch-due` cause, and the unit files were DELETED precisely so `host:install`
// could not put the clock back beside the gate cause. The PR merged. And the timer was still installed,
// still enabled, still active, still scheduled:
//
//     Wed 2026-09-23 01:00:00 UTC   a11ign-fleet-gated-nightly.timer
//
// One night from dispatching the same batch twice, from two mechanisms at two cadences. `host:check`
// printed "every shipped unit is installed, current and running" over it, because every check it had
// asked "is what we ship installed?" and none asked "is what is installed still ours?".

const dirs = (shipped: string[], installed: string[]) => ({
  shippedDir: "/shipped",
  installedDir: "/installed",
  readDir: ((d: string) => (String(d) === "/shipped" ? shipped : installed)) as never,
});

test("#1951: a unit the repository no longer ships is ORPHANED, and the message says why it matters", () => {
  const [f] = orphanedUnits(dirs(["a11ign-work-tick.timer"],
    ["a11ign-work-tick.timer", "a11ign-fleet-gated-nightly.timer"]));
  assert.equal(f.unit, "a11ign-fleet-gated-nightly.timer");
  assert.equal(f.problem, "ORPHANED");
  assert.match(f.detail, /does\s+not uninstall itself/,
    "the reader must learn that deleting the file was not enough -- that is the whole misconception");
  assert.match(f.detail, /both are now firing/,
    "and the consequence, which is worse than an idle leftover: a replacement running beside it");
});

test("#1951: ONLY this org's units -- the host runs others and they are not ours to judge", () => {
  // The agent host runs `launchpadlib-cache-clean.timer` and whatever else the distribution ships.
  // Reporting those would be wrong and would train an operator to ignore this command, taking the real
  // finding with it.
  assert.deepEqual(orphanedUnits(dirs([], ["launchpadlib-cache-clean.timer", "systemd-tmpfiles.service"])), []);
  assert.deepEqual(orphanedUnits(dirs([], ["a11ign-gone.timer"])).map((o) => o.unit), ["a11ign-gone.timer"],
    "POSITIVE CONTROL: an a11ign unit in the same position IS reported, so the filter is not just silent");
});

test("#1951: non-unit files in the install directory are not orphans", () => {
  assert.deepEqual(orphanedUnits(dirs([], ["a11ign-notes.md", "a11ign-backup.timer.bak"])), [],
    "only .service and .timer are units; a stray file is not something to disable");
});

test("#1951 POSITIVE CONTROL: a host matching the repository has no orphans", () => {
  const units = ["a11ign-work-tick.service", "a11ign-work-tick.timer"];
  assert.deepEqual(orphanedUnits(dirs(units, units)), [],
    "this check must be capable of finding nothing, or every run is noise");
});

test("#1951: a missing install directory is not a pile of orphans", () => {
  assert.deepEqual(orphanedUnits({
    shippedDir: "/shipped", installedDir: "/nope",
    readDir: ((d: string) => { if (String(d) === "/nope") throw new Error("ENOENT"); return ["a11ign-x.timer"]; }) as never,
  }), [], "nothing installed means nothing orphaned -- the missing-unit half already reports the absence");
});

test("#1951: the installer REMOVES an orphan, disabling the timer before deleting the file", () => {
  // MUTATION TARGET, and the first version of this test could not reach the code it claimed to check:
  // `hostUnitsInstall` hard-wired the real `readdirSync` into its orphan lookup, so with stub directories
  // it found nothing and deleting the ENTIRE removal loop killed zero tests. `read` is injected now.
  //
  // `disable --now` BEFORE the delete is the load-bearing order: removing the file while its
  // `timers.target.wants` symlink stands leaves a dangling want, and systemd warns on every later
  // daemon-reload -- noise that trains an operator to ignore this command's output.
  const calls: string[][] = [];
  const removed: string[] = [];
  hostUnitsInstall({
    shippedDir: "/shipped",
    installedDir: "/installed",
    readDir: ((d: string) => (String(d) === "/shipped"
      ? ["a11ign-work-tick.timer"]
      : ["a11ign-work-tick.timer", "a11ign-fleet-gated-nightly.timer", "a11ign-old.service"])) as never,
    systemctl: ((a: string[]) => { calls.push(a); return ""; }) as never,
    copy: (() => undefined) as never,
    mkdir: (() => undefined) as never,
    rm: ((path: string) => { removed.push(String(path)); }) as never,
    out: () => undefined,
  });

  assert.deepEqual(removed,
    ["/installed/a11ign-fleet-gated-nightly.timer", "/installed/a11ign-old.service"],
    "both orphans are deleted, and the still-shipped unit is NOT");
  assert.deepEqual(calls.filter((c) => c[0] === "disable"),
    [["disable", "--now", "a11ign-fleet-gated-nightly.timer"]],
    "the orphaned TIMER is disabled --now; the orphaned .service has no timer to disable");

  const reloadAt = calls.findIndex((c) => c[0] === "daemon-reload");
  const disableAt = calls.findIndex((c) => c[0] === "disable");
  assert.ok(disableAt >= 0 && disableAt < reloadAt,
    "removal happens BEFORE daemon-reload, so systemd never re-reads a unit on its way out");
  assert.deepEqual(calls.filter((c) => c[0] === "enable"),
    [["enable", "--now", "a11ign-work-tick.timer"]],
    "and the shipped timer is still enabled afterwards -- removal must not skip the install");
});
