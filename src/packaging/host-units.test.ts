// no-token: gh
//
// Nothing here spawns `gh`, and nothing here reaches the network. `shippedUnits`, `unitState`,
// `unitDrift` and `driftReport` all take their filesystem and their `systemctl` injected;
// `hostUnitsInstall` takes its copier; `orphanedUnits` takes its `git` (#1993), so a stub directory
// never reaches a real `git` and is never answered about a path outside the repository. The real reads
// are of `host/`, the tool's own directory, of a fixture PROJECT (`host-units-project.ts`, #3233: the project's units,
// its `package.json` and its declaration) and of a two-commit git repository this file BUILDS in a temp directory
// and deletes -- never of a11ign's checkout, which changes under it, and never of any checkout's own history,
// which is as deep as whoever cloned chose to make it.

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
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, statSync,
  existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PROJECT_ROOT, TOOL_ROOT } from "./host-units-project.ts";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { shippedUnits, unitState, unitDrift, driftReport, hostUnitsInstall, systemdUserAvailable,
  hostUnitDrift, permissionModeDrift, orphanedUnits, SHIPPED_DIR, execCommands,
  entriesFromCommand, ghSpawnReachedFrom, identityDrift, unitsSpendingGh, opaqueCommands, humanLoginOnHost, HUMAN_LOGIN_ON_HOST,
  retiredHere, addedOnSomeRef, orphanOrigin, shellCommandWords, shellSpawnsGh, shippedHostScripts,
  supersededHostScripts, unitEntryPoints, missingUnitPrograms, workingDirectoryOf,
  programCandidates, hostIdentityDrift, hostIdentityNotes, hostIdentityInstall, ownedIdentityFiles, reviewerDoorInstall, compileCacheNotes,
  WORKERS_README, HUMAN_ACCOUNT_ALLOWED, compileCacheDrift, declaredCompileCache, PROJECT_UNITS_DIR, shippedUnitText,
  shippedScriptText, leadsListText, modelEffortDrift, sessionModelDrift, sessionModelNotes, lastModelIn,
  liveClaudeSessions, codexTrustDrift, codexTrustedProjects, OPTIONAL_UNITS, TOOL_ENTRIES, toolForm, LONG_RUNNING_TEMPLATES, unclassifiedEntries, declaredProjectKeys, windowEnd, windowEndNotes, workTickToolForm } from "../host-units.mjs";
import { DECLARED_CLAUDE_MODELS, PROFILES, CLAUDE_EFFORTS } from "../worker-profile.mjs";
import { HostConfigRefusal, homeHostConfig, parseBeforeTick, parseHostConfig, readUnitsDeclaration, renderTemplate, renderedName, templateValues } from "../host-config.mjs";

/**
 * The keys of a project that has NOT turned the chairman-messaging units on (#2901). The tests that pin "the units the tool ships" hand it as `declaredKeys`
 * instead of reading the fixture project's `project.json`, so the day the fixture declares `messaging` none of them goes red for it:
 * the optional trio has its own tests below, and a pin that reads the real declaration is a pin on somebody else's file.
 */
const WITHOUT_MESSAGING = new Set(["causes", "units"]);

/**
 * #2620: ONE SHIPPED UNIT AS IT INSTALLS -- the tool's three are rendered from `host/*.in` templates and the project's own are read
 * verbatim from `.agent-org/units/`, so a test that wants a unit's text asks for it by its installed name and not by a directory.
 */
const shippedText = (unit: string): string => {
  const text = shippedUnitText(unit);
  assert.ok(text !== null, `nothing ships a unit named ${unit}`);
  return text;
};

/** Whether a unit holds this exact line: the fixture project's checkout is a temp path, so a line naming it is matched whole and not as a pattern. */
const hasLine = (unit: string, line: string): boolean => unit.split("\n").includes(line);

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
    declaredKeys: WITHOUT_MESSAGING,
    systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
    write: ((to: string) => { copied.push(String(to)); }) as never,
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
  // (#3233) The project's own unit is the fixture's: a project clock was listed beside the tool's, which is what this check caught on its first day.
  assert.ok(units.includes("a11ign-corpus-release-nightly.timer"),
    "and the project's own nightly, read from `.agent-org/units/` beside the tool's templates");
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

/** A host `settings.json` that satisfies EVERY settings check: the permission posture and the declared effort entries (#2783). */
const SATISFIED_SETTINGS = JSON.stringify({ permissions: { defaultMode: "bypassPermissions" },
  modelSettings: Object.fromEntries(Object.values(DECLARED_CLAUDE_MODELS).map((m) => [m.id, { effortLevel: m.effortLevel }])) });

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

// ---------------------------------------------------------------------------------------------------------------------
// #2783: A MODEL CHANGE REACHES ONLY FRESH SESSIONS, AND THE EFFORT THAT GOES WITH IT IS HOST STATE.
//
// 2026-09-29: the chairman moved the org to Sonnet 5.5. `ceo`, `product-manager` and `orchestrator`, restarted with
// `--resume`, came back on Sonnet 5 (a resume keeps the SAVED model; herdr resumes as a bare `claude --resume <uuid>`, so
// no flag holds it), and `modelSettings.claude-sonnet-5-5.effortLevel: high` existed only because it was added by hand.
// ---------------------------------------------------------------------------------------------------------------------

const withEffort = (entries: Record<string, { effortLevel: string }>) =>
  settings(JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, modelSettings: entries }));

test("#2783: the repo records the effort the org depends on for the CURRENT model (the row's open-check)", () => {
  assert.deepEqual(DECLARED_CLAUDE_MODELS.sonnet, { id: "claude-sonnet-5-5", effortLevel: "high" });
});

test("#2783: a host with the declared entry is clean, and MORE effort than declared is not a finding either", () => {
  assert.deepEqual(modelEffortDrift(withEffort({ "claude-sonnet-5-5": { effortLevel: "high" } })), [],
    "the positive control -- this check must be capable of passing");
  assert.deepEqual(modelEffortDrift(withEffort({ "claude-sonnet-5-5": { effortLevel: "xhigh" } })), []);
});

test("#2783: a MISSING entry is the finding, and it names the model, the value to add and that it cannot fix", () => {
  // The 2026-09-29 state before the chairman's hand edit: entries for the OLD models only.
  const [f] = modelEffortDrift(withEffort({ "claude-sonnet-5": { effortLevel: "high" } }));
  assert.equal(f.problem, "EFFORT NOT SET FOR claude-sonnet-5-5");
  assert.match(f.detail, /has no entry/);
  assert.match(f.detail, /"claude-sonnet-5-5": \{ "effortLevel": "high" \}/, "the line to add, not only the complaint");
  assert.match(f.detail, /cannot fix/, "it says it only checks");
});

test("#2783: a LOWER or unrecognised effort is a finding, and a file with no modelSettings at all is a missing one", () => {
  const [lower] = modelEffortDrift(withEffort({ "claude-sonnet-5-5": { effortLevel: "medium" } }));
  assert.match(lower.detail, /is "medium"/);
  const [typo] = modelEffortDrift(withEffort({ "claude-sonnet-5-5": { effortLevel: "hgih" } }));
  assert.match(typo.detail, /is "hgih"/, "a value outside the vocabulary must not compare as 'not lower'");
  const [none] = modelEffortDrift(settings('{"model":"sonnet"}'));
  assert.match(none.detail, /has no entry/);
});

test("#2783: an absent or unparseable file is permissionModeDrift's finding and is NOT repeated here", () => {
  assert.deepEqual(modelEffortDrift({ settingsPath: "/nope", exists: (() => false) as never }), []);
  assert.deepEqual(modelEffortDrift(settings("{ this is not json")), []);
  assert.equal(permissionModeDrift(settings("{ this is not json"))[0].problem, "UNREADABLE",
    "the emptiness above is only honest because the sibling check DOES report the same fixture");
});

test("#2783: the declaration is tied to PROFILES -- every claude alias the org runs is declared, at the highest effort asked", () => {
  const asked = new Map<string, number>();
  for (const p of Object.values(PROFILES) as { kind: string, model: string, effort: string }[]) {
    if (p.kind !== "claude") continue;
    asked.set(p.model, Math.max(asked.get(p.model) ?? -1, CLAUDE_EFFORTS.indexOf(p.effort)));
  }
  assert.ok(asked.size > 0, "the population is not empty: PROFILES has claude causes");
  for (const [alias, rank] of asked) {
    const declared = (DECLARED_CLAUDE_MODELS as Record<string, { effortLevel: string }>)[alias];
    assert.ok(declared, `PROFILES runs \`${alias}\` and DECLARED_CLAUDE_MODELS does not declare it`);
    assert.ok(CLAUDE_EFFORTS.includes(declared.effortLevel),
      "a declared effort outside the vocabulary would rank -1 and make every host entry compare as satisfying it");
    assert.ok(CLAUDE_EFFORTS.indexOf(declared.effortLevel) >= rank,
      `${alias} is declared at ${declared.effortLevel}, below an effort a PROFILES cause asks for`);
  }
});

test("#2783: hostUnitDrift carries it -- a host with the permission posture but no effort entry has the finding", () => {
  const host = hostWithOneUnit("");
  const clean = hostUnitDrift(host).filter((d) => /EFFORT/.test(d.problem));
  assert.deepEqual(clean, [], "SATISFIED_SETTINGS satisfies it");
  writeFileSync(host.settingsPath, '{"permissions":{"defaultMode":"bypassPermissions"}}');
  assert.deepEqual(hostUnitDrift(host).filter((d) => /EFFORT/.test(d.problem)).map((d) => d.problem),
    ["EFFORT NOT SET FOR claude-sonnet-5-5"]);
});

/** One transcript line as Claude Code writes it: an assistant message carries the model that produced it. */
const answered = (model: string) => JSON.stringify({ type: "assistant", message: { model, role: "assistant" } });

test("#2783: lastModelIn reads the LAST assistant answer, ignores <synthetic>, and survives a record cut in half", () => {
  const text = ["}, cut mid-record", answered("claude-sonnet-5"), '{"type":"user","message":{"role":"user"}}',
    answered("claude-sonnet-5-5"), answered("<synthetic>"), '{"type":"last-prompt"}', '{"half":'].join("\n");
  assert.equal(lastModelIn(text), "claude-sonnet-5-5", "the newest real model, not the first and not the placeholder");
  assert.equal(lastModelIn('{"type":"user"}\n'), null, "no answer is null, never a guess");
});

const sessionsDir = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "host-units-2783-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};

test("#2783: a session on the declared model is clean; one still on the OLD model is the finding, with its remedy", () => {
  const projectsDir = sessionsDir({
    "-home-agent-repos-a11y-witness/aaa.jsonl": `${answered("claude-sonnet-5-5")}\n`,
    "-home-agent-repos-a11y-witness/bbb.jsonl": `${answered("claude-sonnet-5")}\n`,
    "-home-agent-repos-wt-2783/ccc.jsonl": `${answered("claude-sonnet-5-5")}\n`,
  });
  try {
    const sessions = [
      { name: "ceo", cwd: "/home/agent/repos/a11y-witness", sessionId: "aaa" },
      { name: "product-manager", cwd: "/home/agent/repos/a11y-witness", sessionId: "bbb" },
      { name: "worker-2783", cwd: "/home/agent/repos/wt-2783", sessionId: "ccc" },
    ];
    const drift = sessionModelDrift({ sessions, projectsDir });
    assert.deepEqual(drift.map((d) => d.unit), ["session product-manager"],
      "only the resumed one; the transcript directory is the cwd with `/` and `.` turned into `-`");
    assert.equal(drift[0].problem, "SESSION ON AN UNDECLARED MODEL");
    assert.match(drift[0].detail, /`claude-sonnet-5`/, "it names what it found");
    assert.match(drift[0].detail, /\/model <alias>/, "and the in-place remedy");
    assert.match(drift[0].detail, /cannot switch/, "and says it only reads");
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test("#2783: a session with no answer yet is a NOTE, never a finding and never silently clean", () => {
  const projectsDir = sessionsDir({ "-home-agent-repos-a11y-witness/fresh.jsonl": '{"type":"mode"}\n' });
  try {
    const sessions = [{ name: "orchestrator", cwd: "/home/agent/repos/a11y-witness", sessionId: "fresh" },
      { name: "no-file", cwd: "/home/agent/repos/a11y-witness", sessionId: "missing" }];
    assert.deepEqual(sessionModelDrift({ sessions, projectsDir }), [],
      "the gate wakes a session on any finding, and 'has not answered yet' is nothing to wake anybody for");
    assert.deepEqual(sessionModelNotes({ sessions, projectsDir }).map((n) => [n.unit, n.problem]),
      [["session orchestrator", "MODEL UNKNOWN"], ["session no-file", "MODEL UNKNOWN"]]);
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test("#2783: only the TAIL of a transcript is read, so a multi-megabyte one costs a bounded read", () => {
  const filler = `${JSON.stringify({ type: "user", pad: "x".repeat(1000) })}\n`.repeat(600);  // ~600 KB, past the tail
  const projectsDir = sessionsDir({
    "-home-agent-repos-a11y-witness/big.jsonl": `${answered("claude-sonnet-5")}\n${filler}${answered("claude-sonnet-5-5")}\n`,
  });
  try {
    const sessions = [{ name: "ceo", cwd: "/home/agent/repos/a11y-witness", sessionId: "big" }];
    assert.deepEqual(sessionModelDrift({ sessions, projectsDir }), [], "the newest answer wins across the real file read");
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});

test("#2783: liveClaudeSessions takes herdr's listing, drops codex, and answers null -- not [] -- when herdr cannot be asked", () => {
  const listing = JSON.stringify({ result: { agents: [
    { agent: "claude", name: "ceo", cwd: "/x", agent_session: { value: "u1" } },
    { agent: "codex", name: "reviewer-9", cwd: "/y", agent_session: { value: "u2" } },
    { agent: "claude", name: "no-session", cwd: "/z" },
  ] } });
  assert.deepEqual(liveClaudeSessions(() => listing), [{ name: "ceo", cwd: "/x", sessionId: "u1" }]);
  assert.equal(liveClaudeSessions(() => { throw new Error("herdr: not running"); }), null);
  assert.equal(liveClaudeSessions(() => "not json"), null);
  assert.equal(liveClaudeSessions(() => "{}"), null);
  assert.deepEqual(sessionModelDrift({ sessions: null }), [], "not asked reads as no findings, and the caller knows it was not asked");
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

// --- #2458: the compile cache is written under the system temp directory unless a unit says otherwise -----
//
// MEASURED 2026-09-25 (worker-15), each under a private TMPDIR so only that command's writes were counted:
// `npm run lint` left 895 files in `<TMPDIR>/node-compile-cache`, `eslint --version` 194, `rstest --version` 28,
// `changeset --version` 14, `tsc --version` 4, `node -e 1` none. The keying is source text AND path: one file
// copied to two directories made two entries, which is how one checkout per row reaches 141,353 inodes.

/** A shipped-directory stub: `read` answers from the table, so no real unit file is involved. */
const stubUnits = (units: Record<string, string>) => ({
  shippedDir: "/stub",
  readDir: (() => Object.keys(units)) as never,
  read: ((p: string) => units[basename(String(p))]) as never,
});

test("#2458: every shipped service puts the compile cache under a home's .cache", () => {
  // THE POPULATION, NAMED: emptiness below is worth what this says about its input. The directory is read
  // two ways (a plain listing, and `shippedUnits`, which is what `compileCacheDrift` walks) and they must
  // agree on a non-empty list; the positive control for "a unit lacking the line is a finding" is the next test.
  // An OPTIONAL template (#2901) is not shipped unless the project asks, so it is not this population; its own test is below.
  const listed = [...readdirSync(SHIPPED_DIR).filter((f) => f.endsWith(".service.in") && !Object.hasOwn(OPTIONAL_UNITS, f)).map((f) => `a11ign-${f.slice(0, -".in".length)}`),
    ...readdirSync(PROJECT_UNITS_DIR).filter((f) => f.endsWith(".service"))].sort();
  const services = listed;
  assert.deepEqual(services, shippedUnits(SHIPPED_DIR, { declaredKeys: WITHOUT_MESSAGING }).filter((unit) => unit.endsWith(".service")));
  assert.notDeepEqual(services, [], "nothing ships, so the emptiness below would prove nothing");
  assert.deepEqual(compileCacheDrift({ declaredKeys: WITHOUT_MESSAGING }), []);
  for (const service of services) {
    assert.equal(declaredCompileCache(shippedText(service)),
      "%h/.cache/node-compile-cache", `${service} declares a different directory from the others`);
  }
});

test("#2458 NEGATIVE CONTROL: a unit that says nothing, or names /tmp, or resets the line, IS a finding", () => {
  const line = "Environment=NODE_COMPILE_CACHE=%h/.cache/node-compile-cache";
  const findings = compileCacheDrift(stubUnits({
    "a11ign-silent.service": "[Service]\nExecStart=/usr/bin/npm run x\n",
    "a11ign-tmp.service": "[Service]\nEnvironment=NODE_COMPILE_CACHE=/tmp/node-compile-cache\n",
    "a11ign-commented.service": `[Service]\n# ${line}\n`,
    "a11ign-reset.service": `[Service]\n${line}\nEnvironment=\n`,
    "a11ign-elsewhere.service": "[Service]\nEnvironment=NODE_COMPILE_CACHE=/var/cache/node\n",
    "a11ign-percent-h.service": `[Service]\n${line}\n`,
    "a11ign-absolute.service": "[Service]\nEnvironment=NODE_COMPILE_CACHE=/home/agent/.cache/node-compile-cache\n",
    "a11ign-quoted.service": `[Service]\nEnvironment=PATH=/bin "NODE_COMPILE_CACHE=%h/.cache/node-compile-cache"\n`,
    "a11ign-timer-only.timer": "[Timer]\nOnCalendar=daily\n",
  }));
  assert.deepEqual(findings.map((f) => f.unit).sort(), [
    "a11ign-commented.service", "a11ign-elsewhere.service", "a11ign-reset.service",
    "a11ign-silent.service", "a11ign-tmp.service"]);
  assert.match(findings.find((f) => f.unit === "a11ign-silent.service")?.detail ?? "", /declares no/);
  assert.match(findings.find((f) => f.unit === "a11ign-tmp.service")?.detail ?? "", /\/tmp\/node-compile-cache/);
});

test("#2458: the last declaration wins, as in systemd, and a cache in a different variable is not one", () => {
  assert.equal(declaredCompileCache("Environment=NODE_COMPILE_CACHE=/a\nEnvironment=NODE_COMPILE_CACHE=/b\n"), "/b");
  assert.equal(declaredCompileCache("Environment=GH_CONFIG_DIR=/x\n"), null);
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

/**
 * A REAL THREE-COMMIT REPOSITORY, built here: one commit ships two units, the next deletes one of them,
 * and a third -- on a branch `main` has NOT merged -- adds one more.
 *
 * A FIXTURE AND NOT THIS CHECKOUT, which is the whole lesson of the first CI run. `retiredHere` was
 * asserted against this repository's own history ("#1941 deleted the fleet-gated nightly's units") --
 * true on the agent host, FALSE in the acceptance job, which checks out at the default depth on purpose.
 * A history bounded by whoever cloned cannot be a fixture; commits made here can.
 *
 * THE UNMERGED BRANCH IS ON THE SAME HISTORY AS THE RETIREMENT ON PURPOSE (#2013). The two questions --
 * "did a commit delete this" and "does any ref add this" -- are both TRUE of `a11ign-gone.timer`, so the
 * precedence between them can only be tested where both answers exist at once. A second fixture holding
 * one shape each could not have caught the ordering.
 * @returns {{ dir: string, git: (args: string[]) => string, pendingSha: string }}
 */
const repoWithARetirement = () => {
  const dir = mkdtempSync(join(tmpdir(), "host-units-retirement-"));
  const git = (args: string[]) =>
    // `sandboxGitEnv()` for the same reason the production spawn uses it: an inherited `GIT_DIR` from a
    // hook or a merge worktree would aim every one of these at somebody else's repository.
    String(execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() }));
  const host = join(dir, "packages/agent-org/host");
  mkdirSync(host, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "fixture"]);
  writeFileSync(join(host, "a11ign-gone.timer"), "[Timer]\nOnCalendar=daily\n");
  writeFileSync(join(host, "a11ign-stays.timer"), "[Timer]\nOnCalendar=daily\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "ship both units"]);
  rmSync(join(host, "a11ign-gone.timer"));
  git(["add", "-A"]);
  git(["commit", "-qm", "retire one of them"]);
  // AND A BRANCH THIS `main` HAS NOT MERGED, which is the state every host-unit row passes through
  // between installing a unit and merging the PR that ships it. `switch` back at the end, so the
  // working tree a test reads is `main`'s -- the unit must be ABSENT from it, or it is not an orphan.
  git(["switch", "-qc", "pending"]);
  writeFileSync(join(host, "a11ign-pending.timer"), "[Timer]\nOnCalendar=daily\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "ship a unit on a branch"]);
  const pendingSha = git(["rev-parse", "HEAD"]).trim();
  git(["switch", "-q", "main"]);
  return { dir, git, pendingSha };
};

/**
 * `git log --diff-filter=D` as a stub, in the two answers that mean different things (#1993). INJECTED
 * IN EVERY CASE below, so this file still spawns nothing and a stub directory never reaches a real
 * `git` that would answer about a path outside the repository.
 */
const RETIRED_HERE = () => "cafe1234cafe1234cafe1234cafe1234cafe1234\n";
const NEVER_SHIPPED_HERE = () => "";

// `git` IS TYPED BY THE REAL SIGNATURE, not inferred from whichever stub happened to be the default: the
// two #1993 stubs ignore their argument, so the inferred type was `() => string` and a stub that READS
// its argv -- which #2013's must, since the whole defect is a missing flag -- would not typecheck.
const dirs = (shipped: string[], installed: string[],
  git: (args: string[]) => string = NEVER_SHIPPED_HERE) => ({
  shippedDir: "/shipped",
  installedDir: "/installed",
  readDir: ((d: string) => (String(d) === "/shipped" ? shipped : installed)) as never,
  git,
});

test("#1951: a unit the repository RETIRED is ORPHANED, and the message says why it matters", () => {
  const [f] = orphanedUnits(dirs(["a11ign-work-tick.timer"],
    ["a11ign-work-tick.timer", "a11ign-fleet-gated-nightly.timer"], RETIRED_HERE));
  assert.equal(f.unit, "a11ign-fleet-gated-nightly.timer");
  assert.equal(f.problem, "ORPHANED -- RETIRED HERE");
  assert.match(f.detail, /does not\s+uninstall it/,
    "the reader must learn that deleting the file was not enough -- that is the whole misconception");
  assert.match(f.detail, /both are now firing/,
    "and the consequence, which is worse than an idle leftover: a replacement running beside it");
  assert.match(f.detail, /pnpm run host:install` removes it/,
    "and for a unit a commit deliberately deleted, the remedy IS the remedy");
  assert.notEqual(f.removesUnit, true, "this is the branch where deleting it is the intent");
});

// --- #1993: "not shipped" has two causes and the check used to know only one ------------------------
//
// MEASURED 2026-09-22. `a11ign-board-report.{service,timer}` -- the LIVE daily board dispatch, firing at
// 07:10 every morning since at least 2026-09-19 -- were hand-installed on 2026-09-18 and never
// committed. `orphanedUnits` had ONE BIT, "installed and not in the tree", and spelled it *NO LONGER
// SHIPPED*: an inference about the past that the bit cannot carry. So `host:check` printed the one
// remedy it has, `pnpm run host:install`, which DELETES an orphan -- and nothing would have reported the
// loss except a board edition that never arrived.

test("#1993: a unit NO COMMIT HERE EVER SHIPPED is not a retirement, and must not be offered for deletion", () => {
  const [f] = orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE));
  assert.equal(f.problem, "ORPHANED -- NEVER SHIPPED HERE");
  assert.equal(f.removesUnit, true, "which is what puts the DELETION on the remedy line");
  assert.match(f.detail, /DO NOT reach for `pnpm run host:install`/,
    "the one remedy this report has is the wrong one here, and saying so is the whole fix");
  assert.match(f.detail, /ship it under packages\/agent-org\/host\/ or\s+confirm it is dead/,
    "a refusal nobody can follow is a refusal nobody acts on: both exits are named");
});

test("#1993: a history it CANNOT read is UNKNOWN, and falls to the careful branch rather than the tidy one", () => {
  // A `git` that cannot answer -- no pack, a stub path, a checkout without the history -- would
  // otherwise land in whichever branch the `catch` picked. If it picked RETIRED, the check would
  // recommend deleting a live unit for a second, quieter reason.
  const [f] = orphanedUnits(dirs([], ["a11ign-board-report.timer"],
    (() => { throw new Error("fatal: not a git repository"); }) as never));
  assert.equal(f.problem, "ORPHANED -- HISTORY UNREADABLE");
  assert.equal(f.removesUnit, true);
  assert.match(f.detail, /whether it was ever ours is UNKNOWN/,
    "NOT ASKED and ALL CLEAR must not read the same, which is this repository's most-repeated defect");
});

test("#1993: `retiredHere` reads a real deletion out of a real history, through the real argv", () => {
  // AGAINST REAL `git`, and against a repository built here rather than against this checkout.
  //
  // The first version asserted on THIS tree ("#1941 deleted the fleet-gated nightly's units"), which is
  // true on the agent host and FALSE IN CI: `reusable-acceptance.yml` checks out at the default depth on
  // purpose, so `--diff-filter=D` saw no commits and the assertion failed on the first CI run. A history
  // bounded by whoever cloned is not a fixture. This one is: two commits, one of which deletes a file.
  const { dir, git } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.equal(retiredHere("a11ign-gone.timer", deps), true,
      "a commit deleted it, so `--diff-filter=D` finds that commit -- and a stub could not have caught a "
      + "wrong flag or a path form git rejects, which is why this one runs the real thing");
    assert.equal(retiredHere("a11ign-stays.timer", deps), false,
      "POSITIVE CONTROL: a file still in the tree answers false, not true -- the filter is not matching "
      + "every commit that touched the path");
    assert.equal(retiredHere("a11ign-never-existed.timer", deps), false,
      "and a name no commit ever carried answers false, not null: the question was asked and answered, "
      + "which is a different thing from being unanswerable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1993: a SHALLOW clone cannot say `never`, and must not answer as though it could", () => {
  // THE DEFECT CI FOUND, pinned. An empty `git log` means "no deletion IN WHAT I CAN SEE", and how much
  // that is was chosen by whoever cloned. Answering `false` there reports a RETIRED unit as one this
  // repository never shipped -- the careful branch, so the direction is safe, but wrong and silent.
  const shallow = (args: string[]) => (args[0] === "rev-parse" ? "true\n" : "");
  assert.equal(retiredHere("a11ign-gone.timer", { git: shallow }), null,
    "UNKNOWN, not `false` -- NOT ASKED and ANSWERED NO are the substitution this repository keeps "
    + "re-learning");
  const whole = (args: string[]) => (args[0] === "rev-parse" ? "false\n" : "");
  assert.equal(retiredHere("a11ign-gone.timer", { git: whole }), false,
    "POSITIVE CONTROL: on a complete history the same empty log IS evidence, or this branch would make "
    + "the answer `null` for everything and the RETIRED finding unreachable");
});

// --- #2013: "no commit deleted it" was being read as "no commit ever shipped it" --------------------
//
// MEASURED 2026-09-22 21:05Z from the primary checkout, with `agent/worktree-prune-unit-2000` pushed and
// unmerged. `host:check` said `a11ign-worktree-prune.service` was ORPHANED -- NEVER SHIPPED HERE, "so it
// was installed by hand and this tree has never been able to see what it does". `git log --all --oneline
// -- packages/agent-org/host/a11ign-worktree-prune.service`, in the same checkout seconds later, named
// d77e47a29 shipping it. `retiredHere`'s `false` is true of THREE worlds -- never here, shipped on an
// unmerged ref, shipped and present -- and the middle one had no case, so it was reported as the first.
// The overstatement landed in the one message whose job is to STOP somebody acting.

/** `git log --diff-filter=D` empty, a whole history, and an ADD on some ref: the third world, as a stub. */
const SHIPPED_ON_A_REF = (sha = "d77e47a29d77e47a29d77e47a29d77e47a29d77e") => (args: string[]) => {
  if (args[0] === "rev-parse") return "false\n";
  return args.includes("--all") ? `${sha}\n` : "";
};

test("#2013: a unit added by a commit on an unmerged ref is SHIPPED, not a hand-installed mystery", () => {
  const [f] = orphanedUnits(dirs([], ["a11ign-worktree-prune.service"], SHIPPED_ON_A_REF()));
  assert.equal(f.problem, "ORPHANED -- SHIPPED ON AN UNMERGED REF d77e47a29d77",
    "the sha is IN the one-line problem: a reader with three findings needs to know which ref to go to "
    + "without reading three details");
  assert.doesNotMatch(f.detail, /NO COMMIT ON ANY REF HERE EVER SHIPPED IT/);
  assert.doesNotMatch(f.detail, /nobody here knows about/,
    "THE DONE-WHEN: the finding must stop telling the reader the remedy would delete something the "
    + "repository has never seen, when the repository has a commit that ships it");
  assert.match(f.detail, /it is\s+about to be ours/);
  assert.match(f.detail, /The remedy here is to MERGE/,
    "the remedy is INVERTED, not reworded -- merge the ref, rather than read a journal and decide "
    + "whether it is dead");
  assert.match(f.detail, /git branch -a --contains d77e47a29d77/,
    "and names the command that turns a sha into the ref carrying it, or `merge that` has no object");
  assert.notEqual(f.removesUnit, true,
    "`removesUnit` prints `this repository has no record of ever shipping it` on the REMEDY LINE, which "
    + "is the same overstatement one seam out -- sharing the flag would have moved it, not fixed it");
});

test("#2013: it still says DO NOT RUN THE REMEDY -- `host:install` would delete a unit mid-flight", () => {
  // The finding is not a downgrade to harmless. The unit is absent from THIS tree, so the one remedy
  // this report names would still delete it -- and the PR that ships it is open, so the deletion undoes
  // work already done. What changes is WHY, and therefore what the reader should do next.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-worktree-prune.service"], SHIPPED_ON_A_REF())));
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-worktree-prune\.service would be DELETED, and commit d77e47a29d77 ships it/);
  assert.match(report, /Merge that ref first/);
  assert.doesNotMatch(report, /no record of ever\n\s+shipping it/,
    "the remedy line is where the careless reader ends up, so it is where the wrong claim did the "
    + "damage -- #1993 put it there deliberately and #2013 is why it needed a third paragraph");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("pnpm run host:install\n"),
    "ABOVE the command, as #1993's own is");
});

test("#2013: `addedOnSomeRef` reads a real unmerged branch out of a real history, through the real argv", () => {
  // AGAINST REAL `git` and a repository built here, for the reason the `retiredHere` twin gives: a stub
  // cannot catch a wrong flag, and `--all` is precisely the flag whose absence caused this row.
  const { dir, git, pendingSha } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.equal(addedOnSomeRef("a11ign-pending.timer", deps), pendingSha,
      "the unit is absent from main's tree and added by a commit only `pending` reaches -- so HEAD's own "
      + "log, which is what `retiredHere` asks, is the one history that CANNOT answer this");
    assert.equal(addedOnSomeRef("a11ign-never-existed.timer", deps), "",
      "POSITIVE CONTROL: a name no commit ever carried answers `` and not a sha, so `--all` is not "
      + "matching every commit in the repository");
    assert.equal(addedOnSomeRef("a11ign-stays.timer", deps), git(["rev-list", "--max-parents=0", "HEAD"]).trim(),
      "and a unit still in the tree names the commit that ADDED it, not the tip -- `--diff-filter=A` is "
      + "doing the work rather than the pathspec alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2013: DELETION DECIDES -- a retired unit was also ADDED once, and must not read as pending", () => {
  // THE ORDERING CONTROL, and the one assertion that fails if the two questions are asked the other way
  // round. Every retired unit has an adding commit still reachable from `--all`; verified against this
  // repository's own history, where `a11ign-fleet-gated-nightly.timer` answers both (added by 8dacbc254,
  // deleted by b65b874a8). Asking the addition question first would relabel EVERY retirement as
  // shipped-on-an-unmerged-ref -- and that finding's remedy is "merge it", which would send a reader off
  // to merge a deletion that already happened.
  const { dir, git, pendingSha } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.notEqual(addedOnSomeRef("a11ign-gone.timer", deps), "",
      "THE CONFOUND ITSELF, asserted rather than assumed: some commit DOES add the retired unit, so the "
      + "two questions really are both true here and the precedence really is being exercised");
    assert.deepEqual(orphanOrigin("a11ign-gone.timer", deps), { state: "retired" });
    assert.deepEqual(orphanOrigin("a11ign-pending.timer", deps), { state: "unmerged", sha: pendingSha });
    assert.deepEqual(orphanOrigin("a11ign-never-existed.timer", deps), { state: "never" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2013: a SHALLOW clone cannot say `no ref adds it` either, and `orphanOrigin` keeps the UNKNOWN", () => {
  // `retiredHere` refuses to answer `never` on a bounded history (#1993). The addition question is bounded
  // the same way and by the same clone, so answering it confidently there would put the honest UNKNOWN
  // back into a confident NEVER through the new door.
  const shallow = (args: string[]) => (args[0] === "rev-parse" ? "true\n" : "");
  assert.equal(addedOnSomeRef("a11ign-pending.timer", { git: shallow }), null);
  assert.deepEqual(orphanOrigin("a11ign-pending.timer", { git: shallow }), { state: "unreadable" },
    "and it surfaces as HISTORY UNREADABLE rather than NEVER SHIPPED -- NOT ASKED and ANSWERED NO are "
    + "the substitution this file exists to stop");
  const whole = (args: string[]) => (args[0] === "rev-parse" ? "false\n" : "");
  assert.deepEqual(orphanOrigin("a11ign-pending.timer", { git: whole }), { state: "never" },
    "POSITIVE CONTROL: on a complete history the same empty log IS evidence, or `never` would be "
    + "unreachable and the #1993 finding dead");
});

test("#2013 POSITIVE CONTROL: the two #1993 states are unchanged, and were not weakened to fit", () => {
  // The done-when names these as the controls to keep passing. The new state must come from a question
  // that was not being asked, never from softening the two answers that were already right.
  const [never] = orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE));
  assert.equal(never.problem, "ORPHANED -- NEVER SHIPPED HERE");
  assert.equal(never.removesUnit, true);
  assert.equal(never.shippedOnRef, undefined);
  const [retired] = orphanedUnits(dirs([], ["a11ign-fleet-gated-nightly.timer"], RETIRED_HERE));
  assert.equal(retired.problem, "ORPHANED -- RETIRED HERE");
  assert.equal(retired.shippedOnRef, undefined);
  assert.notEqual(retired.removesUnit, true);
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
    git: RETIRED_HERE,
    read: (() => "[Unit]\n") as never,
    write: (() => undefined) as never,
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

// --- #1974: a unit that spawns `gh` and never says as whom gets a person's account -------------------
//
// MEASURED 2026-09-22. `a11ign-work-tick.service` ran with no `GH_CONFIG_DIR`, so the work gate
// authenticated as `DanBeckDev` -- a PERSON -- and spent that human account's 5,000 GraphQL requests.
// The gate then refused correctly and SILENTLY ("CANNOT ASK: neither the pull-request list nor the Ready
// rows could be read"), which from inside the org is indistinguishable from a quiet queue.
//
// The routing lives in `~/.local/bin/gh` and keys on `HERDR_WORKSPACE_ID` -- which every org session has
// and no systemd unit does. A unit that does not DECLARE its account cannot get the right one, and the
// repository could not see the choice being made at all: `GH_CONFIG_DIR` appeared nowhere in this tree.

test("#1974: every shipped unit that spawns `gh` declares which account -- over the units on disk", () => {
  // (#3233) THE UNITS ON DISK are the tool's three templates and the FIXTURE project's one: the walk's own behaviour is the tool's, and whether
  // a11ign's units declare an account is a question about a11ign's tree and is asked there.
  // THE POSITIVE CONTROL COMES FIRST, and it is load-bearing rather than decorative. `identityDrift()`
  // derives its population from a real directory walk and a real import closure: a wrong `shippedDir`, a
  // package.json whose scripts do not resolve, or a glob that matches nothing all yield an EMPTY
  // population, and an empty population has no undeclared members. The assertion below would pass over a
  // check that had stopped working, which is the failure this repository keeps re-learning.
  const spending = unitsSpendingGh({ declaredKeys: WITHOUT_MESSAGING });
  assert.ok(spending.length >= 3,
    `the population must not be empty or this check passes vacuously; found ${JSON.stringify(spending)}`);
  // THE FLOOR IS RAISED RATHER THAN LEFT WHERE IT WAS (#1993). `>= 2` held at 2 and would have held at
  // 3, so the day the board dispatch joined the population nothing would have said whether it did. The
  // units it names are the assertion that it did: a floor is a bound on the count, and these are the
  // members.
  assert.deepEqual(spending.map((u) => u.unit).sort(),
    ["a11ign-board-report.service", "a11ign-corpus-release-nightly.service", "a11ign-trace-publish.service", "a11ign-trace-weekly.service", "a11ign-work-tick.service",
      "a11ign-worktree-prune.service"],
    "every shipped .service that can reach `gh` -- the project's own, which reaches it only through the script it spawns, "
    + "and the dispatcher's, which was charged on UNKNOWN until its script was shipped");
  assert.deepEqual(identityDrift({ declaredKeys: WITHOUT_MESSAGING }), [],
    "a unit reaching a `gh` spawn with no Environment=GH_CONFIG_DIR= line inherits `~/.config/gh` -- a "
    + "person's account -- and spends a human's rate limit until it runs out");
});

test("#1974 NEGATIVE CONTROL: an undeclared gh-spawning unit IS a finding, and names its entry point", () => {
  // The assertion above is an emptiness assertion, so this is where it is shown capable of failing.
  // Stub directories, so the finding is produced by the rule rather than by the repository's own state.
  const unit = "[Service]\nExecStart=/usr/bin/node packages/agent-org/src/work-tick.mjs\n";
  const [f] = identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-spends.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? unit : "execFileSync(\"gh\", [])")) as never,
  });
  assert.equal(f.unit, "a11ign-spends.service");
  assert.equal(f.problem, "NO IDENTITY DECLARED");
  assert.match(f.detail, /work-tick\.mjs/, "it names the entry point, not just the unit");
  assert.match(f.detail, /Environment=GH_CONFIG_DIR=/,
    "and the line to add -- a refusal nobody can follow is a refusal nobody acts on");
  assert.deepEqual(identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-spends.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped")
      ? `${unit}Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n`
      : "execFileSync(\"gh\", [])")) as never,
  }), [], "and the SAME unit with the line is not a finding -- the rule reads the declaration");
});

test("#1974: a `.timer` is not asked for an identity -- it starts a service, it spawns nothing", () => {
  assert.deepEqual(identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-x.timer"]) as never,
    read: (() => "[Timer]\nOnUnitActiveSec=2min\n") as never,
  }), [], "charging a timer for its service's spawns would demand the line in two places");
});

test("#1974: systemd's Exec prefixes are stripped, or `-npm` resolves to nothing and the unit reads clean", () => {
  // `ExecStartPre=-/usr/bin/npm run primary:update` -- the `-` means "ignore failure", not a program
  // called `-/usr/bin/npm`. A parser that kept it finds no entry point, and a unit whose only gh-spawning
  // command carried a prefix would pass while spending a person's pool.
  assert.deepEqual(execCommands("[Service]\nExecStartPre=-/usr/bin/npm run primary:update\n"
    + "ExecStart=/usr/bin/node a.mjs\nEnvironment=HOME=/home/agent\n"),
  ["/usr/bin/npm run primary:update", "/usr/bin/node a.mjs"]);
  assert.deepEqual(execCommands("[Service]\nExecStop=@/bin/true stop\n"), ["/bin/true stop"],
    "`@` (argv[0] override) too, and ExecStop -- every Exec directive, so a fourth kind is not a fourth incident");
});

test("#1974: `npm run <script>` is followed through package.json to the file it actually starts", () => {
  // `ExecStart=/usr/bin/npm run corpus:snapshot` is a path to a .mjs with one hop in between. A check
  // that stopped at the word `npm` would find no entry point in two of this repo's three units.
  const entries = entriesFromCommand("/usr/bin/npm run work:tick", {
    repoRoot: "/repo",
    scripts: { "work:tick": "node packages/agent-org/src/work-gate.mjs | node packages/agent-org/src/wake.mjs" },
    exists: (() => true) as never,
  });
  assert.deepEqual(entries,
    ["/repo/packages/agent-org/src/work-gate.mjs", "/repo/packages/agent-org/src/wake.mjs"],
    "and BOTH sides of the pipeline -- `work:tick` is two programs and either of them can spend the pool");
  assert.deepEqual(entriesFromCommand("/usr/bin/npm run nope",
    { repoRoot: "/repo", scripts: {}, exists: (() => true) as never }), [],
  "an unknown script resolves to nothing rather than to a guess");
});

test("#2892: `pnpm run <script>` is followed exactly as `npm run` is, so a unit that moved is not scored opaque", () => {
  // The host's units moved from `/usr/bin/npm run` to `%h/.local/bin/pnpm run`. A parser that knew only the
  // first would return no entry point for all four, and `unitsSpendingGh` reads no entry point as "spends
  // nothing" -- the unit leaves the population and every suite stays green.
  const deps = { repoRoot: "/repo", scripts: { "lab:watch": "node packages/lab/scripts/lab-watch.mjs" },
    exists: (() => true) as never };
  assert.deepEqual(entriesFromCommand("%h/.local/bin/pnpm run lab:watch -- --post", deps),
    ["/repo/packages/lab/scripts/lab-watch.mjs"]);
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=%h/.local/bin/pnpm run lab:watch -- --post\n", deps), [],
    "a followable pnpm command is not opaque");
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=%h/.local/bin/yarn run lab:watch\n", deps),
    ["%h/.local/bin/yarn run lab:watch"],
    "NEGATIVE CONTROL: a package manager the parser does not know stays opaque, so the answer above is pnpm's alone");
});

test("#1974: the `npm run` edge inside CODE is followed -- an import walk alone reports this unit clean", () => {
  // A nightly reaches `gh` ONLY through `spawnSync("npm", ["run", "corpus:release"])`. There is no import
  // edge to follow, so a closure walk that knew only about imports returned NO gh for it -- measured,
  // before this edge existed -- and the nightly would have shipped undeclared while the check said it was
  // fine. (#3233) The fixture project's nightly has that shape, so the walk is read on a file this file owns.
  const nightly = join(PROJECT_ROOT, "scripts/release-nightly.mjs");
  const hit = ghSpawnReachedFrom(nightly);
  assert.ok(hit, "the nightly reaches a `gh` spawn");
  assert.match(String(hit), /release\.mjs$/,
    "through the script it SPAWNS, which no import of its own names");
  assert.equal(ghSpawnReachedFrom(join(TOOL_ROOT, "src/worktree-owner.mjs")), null,
    "POSITIVE CONTROL: a unit entry point that does NOT touch `gh` is not charged for one");
});

// --- #1974, the trap: the remedy every finding names is the thing that re-breaks it ------------------
//
// The units are COPIES, so `host:install` writes the repository over the host. On 2026-09-22 the host
// carried the identity fix and the repository did not, while two unrelated ORPHANED units sat in the
// same report under the same one-line remedy. The next session to clear the orphans would have run the
// recommended command and silently reverted the work gate's account in the same breath.

const staleWithIdentity = () => unitState("a11ign-work-tick.service", {
  exists: (() => true) as never,
  read: ((p: string) => (String(p).startsWith(SHIPPED_DIR)
    ? "[Service]\nEnvironment=HOME=/home/agent\n"
    : "[Service]\nEnvironment=HOME=/home/agent\nEnvironment=GH_CONFIG_DIR=/home/agent/workers/gh\n")) as never,
});

test("#1974: a STALE whose diff is an identity the HOST has and the repo lacks is its own problem", () => {
  const state = staleWithIdentity();
  assert.deepEqual(state.identityRevert, ["Environment=GH_CONFIG_DIR=/home/agent/workers/gh"],
    "the line itself survives to the message -- a reader has to be able to paste it back");
  const [f] = unitDrift([state]);
  assert.equal(f.problem, "STALE -- REINSTALLING WOULD REVERT AN IDENTITY",
    "its own problem word, not a detail on the ordinary STALE: a reader scanning for urgency reads these");
  assert.equal(f.revertsIdentity, true);
  assert.match(f.detail, /would DELETE that line/);
  assert.match(f.detail, /host\/ FIRST/, "and says what to do instead of the remedy");
});

test("#1974: the DIRECTION matters -- repo-has/host-lacks is the drift the remedy FIXES", () => {
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith(SHIPPED_DIR)
      ? "[Service]\nEnvironment=GH_CONFIG_DIR=/home/agent/workers/gh\n"
      : "[Service]\n")) as never,
  });
  assert.deepEqual(state.identityRevert, []);
  const [f] = unitDrift([state]);
  assert.equal(f.problem, "STALE",
    "this is exactly what `host:install` is for; shouting here would train a reader to ignore the shout");
});

test("#1974: the REMEDY LINE carries the warning, because the reader is there for the orphans", () => {
  // The trap is not that `host:install` is wrong for the orphans -- it is right for them. It is that a
  // session clearing two harmless ORPHANED units runs the same command, having scrolled past a finding
  // that was not theirs. So the stop has to be where every reader ends up.
  const report = driftReport([
    ...unitDrift([staleWithIdentity()]),
    { unit: "a11ign-board-report.timer", problem: "ORPHANED", detail: "no longer shipped." },
  ]);
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-work-tick\.service is installed with a `GH_CONFIG_DIR`/,
    "and names WHICH unit, so a reader with three findings knows which one is the live wire");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("pnpm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
});

test("#1974 POSITIVE CONTROL: ordinary findings still get the plain one-line remedy", () => {
  const report = driftReport([{ unit: "a11ign-x.timer", problem: "ORPHANED", detail: "no longer shipped." }]);
  assert.match(report, /Remedy for all of them: pnpm run host:install/);
  assert.doesNotMatch(report, /DO NOT RUN/,
    "a warning on every report is a warning on no report");
});

// --- #1993: an ExecStart this repository cannot read, and the two units it was about to delete -------
//
// MEASURED 2026-09-22 on the agent host. `a11ign-board-report.{service,timer}` fired at 07:10 that
// morning and every morning back to at least 2026-09-19, dispatching the board edition `ceo` reads --
// and `git log --all -- 'packages/agent-org/host/a11ign-board-report*'` was EMPTY. Hand-installed on
// 2026-09-18, never committed. Two consequences, and this row is both of them:
//
//   `host:check` read "installed and not shipped" as RETIRED and offered `pnpm run host:install`, which
//   DELETES an orphan -- so the one remedy the report has would have stopped the daily edition, and the
//   only thing that would ever have reported it is an edition that did not arrive.
//
//   The unit declared no PATH, so the script's bare `gh` resolved to /usr/bin/gh -- the routing wrapper
//   at ~/.local/bin/gh was not merely unconfigured, it was never executed -- and its ~/.config/gh is the
//   HUMAN account. `unitsSpendingGh` could not see it either: `unitEntryPoints` follows `node <file>`
//   and `npm run <script>`, and an out-of-tree shell script yields NEITHER, which scored identically to
//   a unit that genuinely spawns nothing.

test("#1993: an Exec command this repository cannot follow is OPAQUE, not clean", () => {
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n"),
    ["/home/agent/.local/bin/board-report-dispatch.sh"]);
  assert.deepEqual(opaqueCommands("[Service]\nExecStartPre=-/usr/bin/npm run primary:update\n"
    + "ExecStart=/usr/bin/node packages/agent-org/src/work-tick.mjs\n"), [],
  "POSITIVE CONTROL: `npm` and `node` are exactly the two this repository CAN follow into a file, so "
  + "charging them here would put the warning on every unit and therefore on none");
});

test("#1993: a unit whose ExecStart is an unshipped script must still DECLARE its account", () => {
  const opaque = "[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n";
  const stub = (unit: string) => ({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-opaque.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? unit : "")) as never,
  });
  const [spending] = unitsSpendingGh(stub(opaque));
  assert.equal(spending.opaque, true, "the reach was NOT RULED OUT rather than READ, and the field says so");
  const [f] = identityDrift(stub(opaque));
  assert.equal(f.problem, "NO IDENTITY DECLARED");
  assert.match(f.detail, /board-report-dispatch\.sh/, "it names the command, not just the unit");
  assert.match(f.detail, /UNKNOWN rather than no/,
    "and says WHY it is charged -- a reader who thinks the check read the script will go looking for a "
    + "`gh` in it and conclude the check is broken");
  assert.deepEqual(identityDrift(stub(`${opaque}Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n`)), [],
    "and the SAME unit with the line is not a finding -- the rule reads the declaration");
});

test("#1993: a unit that starts nothing at all is still not charged", () => {
  // The conservative reading must stay attached to something the unit actually runs. A `.service` with
  // no Exec at all reaches nothing and cannot spend anything, and charging it would be the noise that
  // gets this whole check ignored.
  assert.deepEqual(unitsSpendingGh({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-quiet.service"]) as never,
    read: (() => "[Unit]\nDescription=nothing\n[Service]\nType=oneshot\n") as never,
  }), []);
});

test("#1993: the REMEDY LINE names the DELETION, because that is what silently stops something", () => {
  // The same seam #1974 used for the identity revert, and for the same reason: the reader who gets hurt
  // is the one who scrolled past the finding that was not theirs. `host:install` is the only command
  // this report names, so the stop has to be where every reader ends up.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE)));
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-board-report\.timer would be DELETED/,
    "and names WHICH unit -- a reader with three findings has to know which one is the live wire");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("pnpm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
});

test("#1993 POSITIVE CONTROL: a RETIRED orphan still gets the plain one-line remedy", () => {
  // The warning has to be capable of not firing, or it is a warning on every report and therefore on
  // none. A unit a commit here deliberately deleted is exactly what `host:install` is for.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-fleet-gated-nightly.timer"], RETIRED_HERE)));
  assert.match(report, /Remedy for all of them: pnpm run host:install/);
  assert.doesNotMatch(report, /DO NOT RUN/);
});

test("#1993: the board dispatch is SHIPPED, and faithful to the pair that actually runs", () => {
  // The whole row in one assertion: a unit that fires daily and appears nowhere in the tree cannot be
  // checked, reviewed or reasoned about by anything here. These values are read from the installed pair
  // on the agent host, 2026-09-22 -- the schedule and the program must not drift in the act of
  // committing them.
  const service = shippedText("a11ign-board-report.service");
  const timer = shippedText("a11ign-board-report.timer");
  assert.match(service, /^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/board-report-dispatch\.sh$/m,
    "#1998: the SHIPPED program, named the way the other code-running units name theirs. It read "
    + "`/home/agent/.local/bin/board-report-dispatch.sh` until then -- 31 lines of bash carried by no "
    + "commit anywhere, so every property above was a property of a file nobody here could read");
  assert.ok(hasLine(service, `WorkingDirectory=${PROJECT_ROOT}`),
    "and the checkout that repository-relative path resolves against (the project's, from `host.json`), or systemd starts nothing");
  assert.match(timer, /^OnCalendar=\*-\*-\* 07:10:00 Europe\/London$/m,
    "London in the expression, not resolved once into a UTC hour that drifts at each BST boundary");
  assert.match(timer, /^Persistent=true$/m, "a host asleep at 07:10 still publishes");
  assert.doesNotMatch(service, /^\[Install\]$/m,
    "and the .service has NO [Install]: `WantedBy=default.target` would dispatch another board edition "
    + "at every boot. The timer is the only thing that may start it");
});

test("#1993: the board dispatch declares the PATH that reaches this host's `gh`, and whose account", () => {
  // Measured on the agent host 2026-09-22: the user manager's PATH does not contain
  // /home/agent/.local/bin, so the script's bare `gh` was /usr/bin/gh and the routing wrapper never ran.
  // Declaring the account as well as the path is what makes the choice visible to this repository --
  // the wrapper keys on HERDR_WORKSPACE_ID, which no systemd unit has.
  const service = shippedText("a11ign-board-report.service");
  assert.match(service, /^Environment=PATH=\/home\/agent\/\.local\/bin:/m,
    "the wrapper's directory FIRST, or the declaration changes nothing");
  assert.match(service, /^Environment=GH_CONFIG_DIR=\/home\/agent\/workers\/gh$/m,
    "the workers account: `a11ign-ai-workers` has push on a11ign/a11ign and has already dispatched four "
    + "workflow_dispatch runs there, and `board-report.yml` runs on `github.token` under its own "
    + "permissions block, so the edition does not depend on who dispatched it");
});

// --- #2000: the prune existed for 13 days and no clock ever called it --------------------------------
//
// MEASURED ON THE AGENT HOST 2026-09-22. `prune-worktrees.mjs` shipped 2026-09-09 with 45k of measured
// refusals, and `crontab -l`, `systemctl --user list-timers` and a grep of `.github/` and `work-gate.mjs`
// all came back with nothing that runs it. What that cost: 143 worktrees, 133 carrying a trailing row
// number, 124 of those belonging to CLOSED rows, `~/repos` at 16G, and the oldest leaked tree 9 days old
// rather than ancient debris. `row-claim claim` makes a worktree per claim (#1432) and about 7% were ever
// removed.
//
// The third instance of one shape in a day, after the fleet scheduler (#1858) and the corpus release
// nightly: built, tested, shipped, never wired. These tests are the wiring's own check -- `shippedUnits`
// reads the directory rather than a list, so a file in `packages/agent-org/host/` IS the installable unit.

test("#2000: the worktree prune ships as a pair, so `host:install` has something to install", () => {
  const units = shippedUnits();
  assert.ok(units.includes("a11ign-worktree-prune.service"),
    "the service, or `host:install` copies nothing and the 16G stands");
  assert.ok(units.includes("a11ign-worktree-prune.timer"),
    "and the timer, which is the only half that makes it recur -- `hostUnitsInstall` enables `.timer` "
    + "units and nothing else, so a service shipped alone is installed, inert and reported as fine");
});

test("#2000: the unit passes `--apply`, or the clock runs a REPORT and the backlog stands", () => {
  // THE HIGHEST-VALUE ASSERTION IN THIS FILE'S #2000 SET, because its failure is invisible everywhere
  // else: a unit running the bare script is installed, enabled, active, current, exits 0, writes a full
  // breakdown to the journal every hour and removes nothing. Every other check here would be green.
  //
  // The dry run is the DEFAULT deliberately (2026-09-09: a session ran `pnpm run worktrees:prune` to read
  // the breakdown before writing a row about worktree accounting, and removed three other sessions'
  // trees), so the flag has to be in the unit, and something has to say that it is.
  const service = shippedText("a11ign-worktree-prune.service");
  assert.match(service, /^ExecStart=%h\/\.local\/bin\/pnpm run worktrees:prune -- --apply$/m);
  assert.deepEqual(entriesFromCommand(execCommands(service)[0]),
    [join(TOOL_ROOT, "src/prune-worktrees.mjs")],
    "and the command resolves through package.json to the script itself -- a renamed npm script leaves "
    + "the unit syntactically perfect and starting nothing");
  assert.ok(hasLine(service, `WorkingDirectory=${PROJECT_ROOT}`),
    "the PRIMARY checkout: `pruneWorktrees` identifies the tree it must never remove structurally, as "
    + "the one whose `.git` is a directory, so pointed at a linked worktree it would protect that one "
    + "and offer the fleet-driving checkout up instead");
  assert.doesNotMatch(service, /^\[Install\]$/m,
    "and the service has NO [Install]: `WantedBy=default.target` would also prune at boot, while `herdr` "
    + "is restoring sessions into trees that have by definition been git-quiet for longer than "
    + "ACTIVITY_WINDOW_MS. Install and the calendar are the two entry points; boot is not one of them");
});

test("#2782: the prune's API spend is ONE claim read per removable tree, declared under the workers' account, and READ rather than assumed", () => {
  // `ceo`'s 2026-09-22 ruling on #1950 refused a `work-gate.mjs` cause for this chore because it cost no API budget and needed
  // no judgment. THE FIRST HALF STOPPED BEING TRUE ON #2782: `wt-2623` was deleted under its live claim twice, and the only
  // fact that could have stopped it is the `session:` label on the row, which is on GitHub. The second half stands -- no model
  // turn, no judgment -- and that is the half that puts it on a clock. This test is the collision the previous version of
  // itself predicted ("THIS ASSERTION IS MEANT TO COLLIDE"), resolved by reading what the spend IS instead of deleting the check.
  const entry = join(TOOL_ROOT, "src/prune-worktrees.mjs");
  // THE POSITIVE CONTROL, and it is the whole reason a non-null below means anything: the same function, on a file known not
  // to reach `gh`, answers null -- so the walk can tell the two apart.
  assert.equal(ghSpawnReachedFrom(join(TOOL_ROOT, "src/worktree-owner.mjs")), null,
    "control: the import walk answers null for a closure that is clean, so the answer below is a reading");
  assert.match(String(ghSpawnReachedFrom(entry)), /worktree-removal\.mjs$/,
    "the spend is in the ONE file every remover asks, so it is a single, nameable read rather than a scatter of `gh` calls");
  const spending = unitsSpendingGh().find((u) => u.unit === "a11ign-worktree-prune.service");
  assert.ok(spending, "the unit is charged for an identity, so it cannot quietly spend the person's pool");
  assert.equal(spending.declared, true, "and it declares which account");
  // AND THE ACCOUNT IS THE WORKERS', never the person's: the same line `work-tick.service` carries.
  const service = shippedText("a11ign-worktree-prune.service");
  const accountOf = (text: string) => /^Environment=GH_CONFIG_DIR=(\S+)$/m.exec(text)?.[1];
  assert.ok(accountOf(service), "control: the line is found in the prune unit at all, so the comparison below is not undefined === undefined");
  assert.equal(accountOf(service), accountOf(shippedText("a11ign-work-tick.service")));
});

test("#2000: the prune timer is a CALENDAR timer, so `Persistent=` is not inert", () => {
  const timer = shippedText("a11ign-worktree-prune.timer");
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:07:00$/m,
    "hourly: ~15 trees a day accumulate, one per claim, and a full pass measured 88s over 143 of them -- "
    + "and a tree cannot become removable for the 10 minutes ACTIVITY_WINDOW_MS makes it wait anyway, so "
    + "anything finer buys nothing. :07 rather than :00 for #965's reason -- the top of the hour is where "
    + "every other clock fires");
  assert.doesNotMatch(timer, /^OnBootSec=/m,
    "and NOT a boot-relative delay. The first version paired OnBootSec=15min with a comment promising the "
    + "box would settle first; measured on this host (up 9 days), a monotonic boot delay is long expired, "
    + "so the timer fired the instant `enable --now` ran. A settling claim that cannot hold is worse than "
    + "no claim");
  // PINNED SEPARATELY from the no-inert-`Persistent=` check below, because that one is satisfied by
  // DELETING the line and this one is not: an hour missed while the box was down should prune at the next
  // opportunity rather than wait for the following :07. A skipped prune is invisible -- the backlog it
  // leaves looks exactly like the backlog a working prune refused.
  assert.match(timer, /^Persistent=true$/m,
    "and the catch-up the comment claims, which only a calendar timer can actually perform");
});

// --- #2011's review, generalised: THE DIRECTIVE WAS INERT AND THE TEST ASSERTED ITS TEXT ----------------
//
// `reviewer` on #2011: "`Persistent=true` has effect for `OnCalendar` timers, not these monotonic
// triggers ... The new test only checks the directive's text and therefore passes while the behavior is
// absent." Correct, and `systemd.timer(5)` says it outright: Persistent= "only has an effect on timers
// configured with OnCalendar=".
//
// THE CHECK READS THE DIRECTORY RATHER THAN THE ONE UNIT THE REVIEW NAMED, and that is how it earns its
// place: asked of every shipped timer it immediately found `a11ign-work-tick.timer` carrying the identical
// pairing, with a comment claiming a catch-up systemd was never going to perform. A test written only
// against the prune timer would have fixed the instance and left the class.
test("#2000: no shipped timer pairs `Persistent=` with monotonic-only triggers", () => {
  const timers = shippedUnits().filter((u) => u.endsWith(".timer"));
  // THE POSITIVE CONTROL. `shippedUnits` reads a real directory, so a wrong path yields an empty list and
  // an empty list has no offenders -- the assertion below would pass over a check that had stopped working.
  assert.ok(timers.length >= 5,
    `the population must not be empty or this passes vacuously; found ${JSON.stringify(timers)}`);
  const offenders = timers
    .map((unit) => ({ unit, text: shippedText(unit) }))
    .filter(({ text }) => /^Persistent=/m.test(text) && !/^OnCalendar=/m.test(text))
    .map(({ unit }) => unit);
  assert.deepEqual(offenders, [],
    "`Persistent=` has effect only on a timer configured with `OnCalendar=` (systemd.timer(5)). On a "
    + "monotonic-only timer the line is inert, and it is worse than absent: it states a catch-up the unit "
    + "does not perform, which is exactly what a reader checking whether a missed window is covered will "
    + "believe. Either give the timer an OnCalendar= expression or drop the line");
  // AND THE CONTROL IN THE OTHER DIRECTION: the rule must be capable of firing. A monotonic timer that
  // carries the line IS an offender -- asserted against a fixture, so the repository's own compliance is
  // not what makes this pass.
  const monotonicWithPersistent = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=2min\nPersistent=true\n";
  assert.equal(/^Persistent=/m.test(monotonicWithPersistent)
    && !/^OnCalendar=/m.test(monotonicWithPersistent), true,
    "NEGATIVE CONTROL: the predicate flags the exact shape a11ign-work-tick.timer carried before #2000");
  const calendarWithPersistent = "[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n";
  assert.equal(/^Persistent=/m.test(calendarWithPersistent)
    && !/^OnCalendar=/m.test(calendarWithPersistent), false,
    "and does NOT flag a calendar timer, or every nightly in this directory would be a finding");
});

// --- #2011's review, round two: THE UNIT NAMED A CAUSE IT HAD NOT DISTINGUISHED -----------------------
//
// The first answer to this blocker said the prune that ran the instant `enable --now` was issued was
// `OnBootSec=` counting from a boot 9 days earlier. Forty minutes later the same unit -- now a calendar
// timer with no `OnBootSec` anywhere in it -- ran a prune the instant it was installed again, so the
// sentence the PR shipped was known-false in the file it shipped. `product-manager`, 2026-09-22: "a
// why-comment carrying a superseded mechanism is a defect in the artefact, not prose around it."
//
// WHAT DISTINGUISHES IT, measured 22:23Z: two fresh throwaway units, identical calendar expression and
// `Persistent=true`, neither carrying a stamp file, differing ONLY in `Requires=`. The one with it ran its
// service in the same second as `enable --now`; the one without never ran its service. The two earlier
// probes could not perform that experiment, because both of them carried an expired `OnBootSec=`, which
// fires on activation by itself and masks whatever else would have.
//
// AND IT IS A CLASS RATHER THAN THIS UNIT'S QUIRK. `hostUnitsInstall` runs `enable --now` over EVERY
// shipped `.timer`, so `Requires=` in a timer silently appends "and runs once at every `host:install`" to
// its service's contract -- true of a project's own nightly (the fixture's, #3233) as much as of
// the prune. This test is what makes adding it to a fifth timer a decision somebody makes rather than a
// consequence nobody reads.
test("#2000: which shipped timers run their service at `host:install`, and which do not", () => {
  const timers = shippedUnits(SHIPPED_DIR, { declaredKeys: WITHOUT_MESSAGING }).filter((u) => u.endsWith(".timer"));
  const requiring = timers
    .filter((unit) => /^Requires=/m.test(shippedText(unit))).sort();
  // NEITHER SIDE OF THIS PARTITION IS AN EMPTINESS ASSERTION, which is why it needs no fixture control:
  // both lists are non-empty populations read from the real directory, so a `shippedUnits` that stopped
  // working fails both halves rather than passing vacuously.
  assert.deepEqual(requiring, [
    "a11ign-corpus-release-nightly.timer",
    // #2867: the shadow window's timer. Its service runs once at `host:install` and is a DORMANT NO-OP until `shadow-window.mjs --arm` creates the
    // marker (no marker, nothing read, exit 0), which the unit's own comments say; that is why a fifth entry here is a decision made and not one missed.
    "a11ign-shadow-window.timer",
    // a11ign/a11ign#3515: the trace pages' timer. Its service runs once at `host:install` and DECIDES whether anything moved: a first install publishes, a re-install on an unmoved head does nothing.
    "a11ign-trace-publish.timer",
    "a11ign-work-tick.timer",
    "a11ign-worktree-prune.timer",
  ], "`Requires=` in a timer's [Unit] is an ordinary start dependency, so `enable --now` on the timer "
    + "starts the service too -- once, at install time, whether or not the timer was already running. "
    + "Adding another entry here means that service now runs during `host:install`: say so in the unit, "
    + "and check it is a run you want unattended at an operator's keystroke");
  assert.deepEqual(timers.filter((u) => !requiring.includes(u)), [
    "a11ign-board-report.timer",
    // a11ign/a11ign#3627: the weekly token-efficiency post, on the board edition's side for the board edition's reason: it POSTS A REPORT.
    "a11ign-trace-weekly.timer",
  ], "THE CONTROL, and a measured one rather than a fixture: at the 2026-09-22 21:03Z `host:install` the "
    + "four above each started their service in that second and board-report did not, though the same run "
    + "reinstalled it. It activates its service by name alone, ON PURPOSE: it dispatches a board edition, "
    + "and a firing at every `host:install` would publish one at an operator's keystroke rather than on the clock. "
    + "The weekly report's timer is the second member: its service comments on the record issue");
  // AND THE INSTALL-TIME START IS NOT HYPOTHETICAL. The partition above only matters because the installer
  // really does issue that start job for every shipped timer; asserted through the same injected
  // `systemctl` the #1858 test uses, against the REAL shipped directory.
  const calls: string[][] = [];
  hostUnitsInstall({
    installedDir: "/installed",
    systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
    write: (() => undefined) as never,
    mkdir: (() => undefined) as never,
    out: () => undefined,
  });
  const enabled = calls.filter((c) => c[0] === "enable").map((c) => c[2]);
  for (const unit of requiring) {
    assert.ok(enabled.includes(unit),
      `${unit} declares Requires= but the installer never starts it, so the partition above means nothing`);
  }
});

// (#3233) The #2230 tests -- a11ign's two watcher units ship as pairs, run with `--post`, fire hourly off the org-watch minute, and every script
// exporting `ORG_READING_ISSUE` has a caller in a unit or a workflow -- asserted a11ign's own units, scripts and workflows, and left this file.

// --- #1998: the unit shipped here and the program it starts did not ----------------------------------
//
// MEASURED ON THE AGENT HOST 2026-09-22, at `874948280`. #1993 put the two board-dispatch units under
// `packages/agent-org/host/` so the daily edition stopped being invisible to this repository, and scoped
// itself to the units. Its `ExecStart` was `/home/agent/.local/bin/board-report-dispatch.sh`:
//
//     git log --oneline --all -- '**/board-report-dispatch*'   ->  (empty)
//     wc -l /home/agent/.local/bin/board-report-dispatch.sh    ->  31
//     grep -cE '\bgh (workflow run|run list)\b' <that file>    ->  2
//
// So the unit was reviewable and the thing it ran was not. Every property #1993 declared on the unit --
// which `gh` is on the PATH, which account it spends -- was a property of a `gh` call inside a file
// nobody here could read, and the next edit to it reached production with no diff, no review and no test.
//
// THE PROGRAM IS NOT COPIED ANYWHERE, and that is the answer to the CURRENT question rather than a gap
// in it. The units live in `~/.config/systemd/user` because systemd will not read them out of the tree;
// nothing makes that demand of a script, so the tree copy IS the program and a merged edit is live at
// the next firing. A second copy would re-create #1858's own defect one level down. What that leaves is
// the leftover at `~/.local/bin`, which `supersededHostScripts` reports until somebody removes it.

/**
 * WHERE THE UNIT'S RELATIVE `ExecStart` PATH LANDS in the project the file runs against (#3233): the project holds the tool at `packages/agent-org`,
 * so the dispatcher is read through that link. The first assertion below is the link's own control -- that this path IS the shipped file -- so
 * every comparison against it is a comparison against the tool under test.
 */
const DISPATCH = join(PROJECT_ROOT, "packages/agent-org/host/board-report-dispatch.sh");

test("#1998: the dispatch ships here, and it is the program that actually runs", () => {
  assert.equal(realpathSync(DISPATCH), join(SHIPPED_DIR, "board-report-dispatch.sh"),
    "the project's `packages/agent-org` is this tool, so the path the unit names is the file this tool ships");
  assert.ok(shippedHostScripts().includes("board-report-dispatch.sh"),
    "in the same directory as the unit that starts it -- the whole row in one assertion");
  const script = shippedText("board-report-dispatch.sh");
  assert.match(script, /^set -euo pipefail$/m,
    "byte-faithful to the installed copy, whose own first act this is: a dispatch that swallowed a "
    + "failed `gh workflow run` would log a run id it never created");
  assert.equal(shellCommandWords(script).filter((w) => w === "gh").length, 2,
    "both `gh` calls, which is what the host measured: one `gh workflow run` and one `gh run list`. "
    + "The second is inside `$(...)` on an assignment line, and a reader counting line-leading words "
    + "would find one and charge the unit for half of what it spends");
  assert.match(script, /gh workflow run "\$\{WORKFLOW\}" --repo "\$\{REPO\}"/,
    "the dispatch itself, quoted from the file that has fired at 07:10 every morning since 2026-09-18");
});

test("#1998: the board dispatch's `gh` is READ, not merely not-ruled-out", () => {
  // THE DONE-WHEN, AND IT HAS TO FAIL FOR THE RIGHT REASON. `opaque: false` is also what a unit that
  // left the population reports -- by having no `Exec`, by not ending in `.service`, by a `shippedDir`
  // typo. So membership is asserted FIRST and the entry point that produced the answer is asserted by
  // name: this is green only when the script resolved and was read.
  const spending = unitsSpendingGh();
  const board = spending.find((u) => u.unit === "a11ign-board-report.service");
  assert.ok(board, "still IN the population -- `opaque` going quiet by the unit leaving is the one way "
    + "this assertion could pass while the row is undone");
  assert.equal(board.opaque, false, "the `gh` spawn was read out of the script, not inferred from a "
    + "path this repository cannot follow");
  assert.equal(board.via, DISPATCH,
    "and `via` names the file it was read from -- the entry point RESOLVED, which is the reason the "
    + "opaque branch stopped firing");
  assert.equal(board.declared, true, "#1993's identity line still stands");
  assert.deepEqual(spending.filter((u) => u.opaque), [],
    "no shipped unit starts anything this repository cannot read");
  assert.ok(spending.length >= 3, "the population is NOT EMPTY -- an emptiness assertion over a "
    + "`shippedDir` typo would read as compliance");
});

test("#1998: `unitEntryPoints` follows a shell interpreter exactly as it follows `node`", () => {
  const service = shippedText("a11ign-board-report.service");
  assert.deepEqual(unitEntryPoints(service), [DISPATCH]);
  assert.deepEqual(entriesFromCommand("/usr/bin/bash packages/agent-org/host/board-report-dispatch.sh"),
    [DISPATCH],
    "RELATIVE TO THIS CHECKOUT and not to the `WorkingDirectory` the unit names, or the answer would be "
    + "right in the primary checkout and wrong in every worktree and in CI");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash -c 'gh workflow run x'"), [],
    "NEGATIVE CONTROL: `-c` is not a file, so it resolves to nothing and is correctly left unread "
    + "rather than guessed at");
});

test("#1998 NEGATIVE CONTROL: a shell script OUT of the tree is still OPAQUE", () => {
  // The branch #1993 added must still be reachable, or this row replaced a conservative reading with a
  // silent pass. `bash` is deliberately NOT in `ANALYSABLE_TOOLS`: an interpreter is followable only
  // when the PATH it is handed lands inside this repository.
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/usr/bin/bash /opt/vendor/dispatch.sh\n"),
    ["/usr/bin/bash /opt/vendor/dispatch.sh"]);
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n"),
    ["/home/agent/.local/bin/board-report-dispatch.sh"],
    "the exact command this unit carried until this row, still unreadable and still charged");
  assert.deepEqual(
    opaqueCommands("[Service]\nExecStart=/usr/bin/bash packages/agent-org/host/board-report-dispatch.sh\n"),
    [], "POSITIVE CONTROL: the same interpreter, a path this repository ships, and it is readable");
});

test("#1998: a shell script spawns `gh` as a WORD, which the JavaScript pattern cannot see", () => {
  assert.equal(ghSpawnReachedFrom(join(SHIPPED_DIR, "board-report-dispatch.sh")),
    join(SHIPPED_DIR, "board-report-dispatch.sh"));
  assert.deepEqual(shellCommandWords('RUN_ID="$(gh run list --repo x)"'), ["gh", "\""],
    "the `(` split: the line's own first word is an assignment, skipped, and the call sits one "
    + "substitution in. The trailing `\"` is the OVER-APPROXIMATION this reader is allowed -- splitting "
    + "on separators without matching quotes can name a fragment that is not a command, and the only "
    + "question asked of the list is whether `gh` is in it, which no dangling quote can answer yes");
  assert.deepEqual(shellCommandWords('echo "at $(date -u +%FT%TZ)"'), ["echo", "date", "\""],
    "a substitution is a command position wherever it sits, including inside a quoted argument");
  assert.equal(shellSpawnsGh('ISSUE="a11ign#1998"; gh issue view "$ISSUE"\n'), true,
    "THE WORD BOUNDARY ON THE COMMENT STRIP, and its failure direction is the dangerous one: a `#` "
    + "mid-word is an issue reference, a fragment or an anchor, and stripping from it to end-of-line "
    + "deletes a REAL `gh` call further along -- a false NEGATIVE, which here reads as a unit that "
    + "spends nobody's pool");
  assert.equal(shellSpawnsGh("# gh workflow run x\necho done\n"), false,
    "NEGATIVE CONTROL: a `gh` in a COMMENT is not a spawn -- the shape that charged row-file.mjs for a "
    + "note about the guard that read it (#804)");
  assert.equal(shellSpawnsGh("git push origin agent/gh-wrapper-1974\n"), false,
    "nor is `gh` inside a branch name, a path or a jq filter -- #1860 is this repository's own record "
    + "of `\\bgh\\b` over a whole file costing a file named after the thing it fixed");
  assert.equal(shellSpawnsGh("gh-real auth status\n"), false, "nor a DIFFERENT binary starting `gh`");
  assert.equal(shellSpawnsGh("if [ -n x ]; then /usr/bin/gh pr list; fi\n"), true,
    "POSITIVE CONTROL: past a keyword, past a separator, and by basename");
});

test("#1998: a leftover copy at ~/.local/bin is a finding, and says which way it differs", () => {
  const scripts = (hostText: string | null) => ({
    shippedDir: "/shipped",
    scriptDir: "/home/agent/.local/bin",
    readDir: (() => ["board-report-dispatch.sh", "a11ign-x.service"]) as never,
    exists: ((p: string) => hostText !== null || !String(p).startsWith("/home/agent")) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "shipped\n" : hostText)) as never,
  });
  assert.deepEqual(supersededHostScripts(scripts(null)), [],
    "POSITIVE CONTROL: no copy on the host is the correct state and must not be a finding, or this "
    + "check fires for ever and gets the whole report ignored");
  const [same] = supersededHostScripts(scripts("shipped\n"));
  assert.equal(same.problem, "SUPERSEDED COPY -- IDENTICAL FOR NOW");
  assert.equal(same.unit, "/home/agent/.local/bin/board-report-dispatch.sh");
  assert.match(same.detail, /matches the shipped file TODAY/,
    "identical is not safe, it is unchecked -- there is nothing holding the two together");
  const [drifted] = supersededHostScripts(scripts("edited by hand\n"));
  assert.equal(drifted.problem, "SUPERSEDED COPY -- ALREADY DIVERGED");
  assert.match(drifted.detail, /Read the diff before removing it/,
    "which of the two holds the change is a question this file cannot answer");
});

test("#1998: `host:check` ACTUALLY ASKS -- the check is wired, not merely written", () => {
  // THE SURVIVING MUTANT THIS TEST EXISTS FOR: deleting `...supersededHostScripts(deps)` from
  // `hostUnitDrift` killed nothing, because every other assertion here calls the function directly.
  // That is the shape this file's own #2000 block is about -- built, tested, shipped, never wired --
  // and it is the third time in this repository, so it gets an assertion rather than a habit.
  const drift = hostUnitDrift({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin", systemctl: SYSTEMD_OK,
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "a\n" : "b\n")) as never,
  });
  assert.ok(drift.some((d) => d.problem.startsWith("SUPERSEDED COPY")),
    "the command a reader actually runs is `host:check`, and it reaches `hostUnitDrift` -- a finding "
    + "no report can print is a finding nobody gets");
  assert.deepEqual(hostUnitDrift({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin", systemctl: NO_SYSTEMD,
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never, read: (() => "a\n") as never,
  }), [], "POSITIVE CONTROL: and a machine with no user systemd is told nothing about its ~/.local/bin "
    + "either -- a laptop that gets this finding is a laptop that silences the whole command");
});

test("#1998: the REMEDY LINE says the shared remedy does NOT fix it", () => {
  // The same seam #1974 and #1993 used, for the same reason: every other finding here ends at
  // `pnpm run host:install`, and a reader told that four times reads it the fifth time too.
  const report = driftReport(supersededHostScripts({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin",
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "a\n" : "b\n")) as never,
  }));
  assert.match(report, /is NOT fixed by the remedy below/);
  assert.ok(report.indexOf("NOT fixed by the remedy") < report.indexOf("pnpm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
  assert.match(report, /nothing in ~\/\.local\/bin/,
    "and says WHY `host:install` leaves it alone: this repository owns the a11ign-* units and owns "
    + "nothing in a directory that also holds `gh`, `gh-real` and `herdr`");
  assert.doesNotMatch(report, /DO NOT RUN THE REMEDY YET/,
    "NOT the destructive warning: running `host:install` here is harmless, it simply does not help");
});

/**
 * #2174 CONSTRAINT 3: "INSTALLED AND CURRENT" IS NOT THE CLAIM "THE PROGRAM IT NAMES EXISTS".
 *
 * `ExecStart` is repository-RELATIVE and resolves against the unit's own `WorkingDirectory=` -- a
 * DIFFERENT TREE from the one anybody installed from. So every other check in this file is structurally
 * blind to it: `unitDrift` compares shipped text against installed text, and a unit copied perfectly
 * from the tree agrees on both sides while the file it starts is absent.
 *
 * MEASURED, and it is why this exists. Closing #2173 the primary checkout happened to sit at `518de0e32`
 * and carried `board-report-dispatch.sh`, so the 06:10Z board edition would run. Had it been left at the
 * `72c8fbcd5` it held earlier that day, every reading taken that afternoon would have been IDENTICAL and
 * the firing would still have failed on a missing file.
 */
const installedStub = (units: Record<string, string>) => ({
  installedDir: "/installed",
  readDir: (() => Object.keys(units)) as never,
  read: ((path: string) => {
    const hit = units[String(path).split("/").pop() as string];
    if (hit === undefined) throw new Error(`ENOENT: ${path}`);
    return hit;
  }) as never,
});
const UNIT_WITH = (program: string) =>
  `[Service]\nWorkingDirectory=/repo\nExecStart=/usr/bin/bash ${program}\n`;

test("#2174 POSITIVE CONTROL: a unit naming a program that is not there is REPORTED", () => {
  const found = missingUnitPrograms({
    ...installedStub({ "a11ign-board-report.service": UNIT_WITH("host/gone.sh") }),
    exists: () => false,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].unit, "a11ign-board-report.service");
  assert.equal(found[0].problem, "PROGRAM MISSING");
  assert.equal(found[0].missingProgram, "/repo/host/gone.sh",
    "resolved against the unit's OWN WorkingDirectory, which is the whole point");
  assert.match(found[0].detail, /WorkingDirectory=\/repo/,
    "the finding names the directory it resolved against, so a reader can check the right tree");
});

test("#2174: a unit whose program IS there is not reported -- the matched pair", () => {
  // THE SAME UNIT TEXT, differing in exactly one thing: whether the file exists. Without this the test
  // above passes against a function that reports every unit it can see.
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "a11ign-board-report.service": UNIT_WITH("host/there.sh") }),
    exists: () => true,
  }), []);
});

test("#2174: it is a SEPARATE finding from STALE, and the shared remedy says it cannot fix it", () => {
  const [finding] = missingUnitPrograms({
    ...installedStub({ "a11ign-work-tick.service": UNIT_WITH("src/work-tick.mjs") }),
    exists: () => false,
  });
  const report = driftReport([finding]);
  // THE REMEDY LOOKS LIKE IT SHOULD WORK, which is what makes this worse than the superseded-script case:
  // `host:install` copies the unit, this unit is ALREADY correct, so re-running it changes nothing and
  // the reader is left believing it did.
  assert.match(report, /NOT fixed by the remedy below either/,
    "a reader who runs host:install on this and sees no change must have been told why beforehand");
  assert.match(report, /re-installing an already-correct unit will not create it/);
  assert.match(report, /\/repo\/src\/work-tick\.mjs/, "and it names the file that is missing");
});

/**
 * #2184, FOUND IN REVIEW: "THE PROGRAM IS MISSING" AND "THE UNIT MATCHES THE REPOSITORY" ARE TWO CLAIMS,
 * AND ONLY THE FIRST ONE WAS MEASURED.
 *
 * `missingUnitPrograms` runs independently of `unitDrift`, so on a unit that is BOTH stale and naming a
 * program that is not there the host gets two findings -- and the second one asserted *"the unit is
 * installed and matches the repository"* off a comparison it never made. Its remedy was wrong in the
 * same breath: *"re-installing copies the same correct unit again"* is false of a stale unit, whose text
 * `host:install` overwrites with a repository copy that may name a program that IS there. The reader is
 * then talked out of the one command that might fix it.
 *
 * INTEGRATED, THROUGH `hostUnitDrift`, because the falsehood only exists when the two checks meet: each
 * one alone is right about its own question. `permissionModeDrift` is pinned to a satisfied settings
 * file so the drift here is exactly the pair under test.
 */
/**
 * A HOST WHOSE IDENTITY FILES ARE IN SYNC, built by the REAL installer over temp directories -- so the
 * fixture is what `host:install` produces, not a hand-typed copy of what it should produce.
 * @returns the deps `hostIdentityDrift` takes
 */
const identityHost = (where: { shippedDir: string, scriptDir: string, workersDir: string,
  leadsDir: string, gitConfigPath: string }) => {
  // The leads list is rendered from `host.json`, so only the wrapper is a file to put in the fixture's shipped directory.
  writeFileSync(join(where.shippedDir, "gh"), shippedScriptText("gh") as string);
  mkdirSync(where.scriptDir, { recursive: true });
  hostIdentityInstall({ ...where, out: () => {} });
  // PINNED SATISFIED TOO (#3316): `hostUnitDrift` now compares the reviewers' door, and an unpinned one reads the real host's.
  const reviewerBin = join(dirname(where.scriptDir), "reviewer-bin");
  reviewerDoorInstall({ reviewerBin, out: () => {} });
  writeFileSync(where.gitConfigPath, `[credential "https://github.com"]\n\thelper = \n`
    + `\thelper = !${where.scriptDir}/gh auth git-credential\n`);
  return { ...where, reviewerBin };
};

const UNIT_BODY = (workingDir: string) => "[Unit]\nDescription=board report\n[Service]\n"
  + `WorkingDirectory=${workingDir}\nExecStart=/usr/bin/bash host/dispatch.sh\n`
  // DECLARED, because `hostUnitDrift` now asks `identityDrift` too and this unit's opaque `ExecStart` is
  // charged on UNKNOWN (#1993): an undeclared one would add a third finding to every pair asserted below.
  + "Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n";
const trustingEvery = (paths: string[]) => paths.map((path) => `[projects."${path}"]\ntrust_level = "trusted"\n`).join("\n");

/**
 * A REAL SHIPPED DIRECTORY AND A REAL INSTALLED ONE, because `hostUnitDrift` discovers the shipped set
 * with `shippedUnits(dir, {})` -- the real `readdirSync`, not the injected `readDir`. A stub `shippedDir`
 * reads as an EMPTY shipped set, `unitDrift` then has nothing to compare, and the integrated pair this
 * test exists for never forms. The first version of this test asserted two findings and got one.
 * @returns the deps bag, and the installed unit's path so a test can rewrite it
 */
const hostWithOneUnit = (installedSuffix: string) => {
  const root = mkdtempSync(join(tmpdir(), "host-units-2184-"));
  const dirs = Object.fromEntries(["shipped", "installed", "bin", "repo", "workers", "leads"]
    .map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const settingsPath = join(root, "settings.json");
  // PINNED SATISFIED, so the drift under test is exactly the pair and not three findings deep.
  writeFileSync(settingsPath, SATISFIED_SETTINGS);
  const unit = "a11ign-board-report.service";
  writeFileSync(join(dirs.shipped, unit), UNIT_BODY(dirs.repo));
  // THE SAME `ExecStart`, so the missing program is not an artefact of the staleness -- the only
  // difference is a line that changes nothing about what runs, which is exactly the comment drift
  // #2174 measured twice on this host. `repo/host/dispatch.sh` is never written, so the program the
  // unit names is genuinely absent on both readings.
  writeFileSync(join(dirs.installed, unit), UNIT_BODY(dirs.repo) + installedSuffix);
  // PINNED SATISFIED TOO (#2332): the identity files are installed and the helper is the wrapper.
  const identity = identityHost({ shippedDir: dirs.shipped, scriptDir: dirs.bin, workersDir: dirs.workers,
    leadsDir: dirs.leads, gitConfigPath: join(root, "gitconfig") });
  // PINNED SATISFIED TOO (#2896): a `pnpm` on the fixture PATH at the version the fixture project declares, so the real host's PATH is not read.
  writeFileSync(join(dirs.bin, "pnpm"), "");
  writeFileSync(join(dirs.repo, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));
  // PINNED SATISFIED TOO (#3643): `hostUnitDrift` now reads `~/.config/gh`, and an unpinned one reads whoever is logged in on the machine running the suite.
  const readGhHosts = (() => { throw Object.assign(new Error("no hosts.yml"), { code: "ENOENT" }); }) as never;
  // PINNED SATISFIED TOO (#3702): `hostUnitDrift` now reads `~/.codex/config.toml` against the real `host.json`'s clones, so an unpinned one reads the machine's.
  const readCodexConfig = () => trustingEvery(Object.values(homeHostConfig().clones ?? {}));
  return { ...identity, installedDir: dirs.installed, readGhHosts, readCodexConfig,
    settingsPath, systemctl: SYSTEMD_OK, program: join(dirs.repo, "host/dispatch.sh"),
    pnpm: { path: dirs.bin, repoRoot: dirs.repo, version: () => "10.0.0\n" } };
};

test("#2184 INTEGRATED CONTROL: a STALE unit whose program is missing gets BOTH findings, and the "
  + "second does not claim the unit matches the repository", () => {
  const host = hostWithOneUnit("# installed by hand, never merged\n");
  const drift = hostUnitDrift(host);
  assert.deepEqual(drift.map((d) => d.problem), ["STALE", "PROGRAM MISSING"],
    "two findings, because there are two faults -- neither one is folded into the other");
  const [missing] = drift.filter((d) => d.missingProgram);
  assert.equal(missing.installedCopy, "stale",
    "the comparison is MEASURED and carried, rather than assumed by the sentence that prints it");
  assert.equal(missing.missingProgram, host.program);
  assert.doesNotMatch(missing.detail, /matches the repository/,
    "it does not match the repository -- `unitDrift` says so in the finding directly above this one");
  assert.doesNotMatch(missing.detail, /THE SHARED REMEDY DOES NOT FIX THIS/,
    "and the remedy it cannot promise is the one this stale unit most likely needs");
  assert.match(missing.detail, /MAY be fixed by\s+the shared remedy/,
    "re-installing REPLACES this text, and the repository's copy can name a program that is there");
  const report = driftReport(drift);
  assert.doesNotMatch(report, /NOT fixed by the remedy below either/,
    "`uncovered` must not warn a reader off `host:install` on the one shape where it may work");
  assert.match(report, /Remedy for all of them: pnpm run host:install/,
    "and the remedy is still offered, which is what the paragraph above would have withdrawn");
});

test("#2896: a host with no `pnpm` on its PATH gets the finding through `hostUnitDrift`, and the matched host does not", () => {
  const host = hostWithOneUnit("");
  assert.equal(hostUnitDrift(host).some((d) => d.unit === "pnpm"), false, "the matched fixture has pnpm at the declared version: no finding");
  const missing = hostUnitDrift({ ...host, pnpm: { ...host.pnpm, path: join(host.pnpm.repoRoot, "nowhere") } }).filter((d) => d.unit === "pnpm");
  assert.deepEqual(missing.map((d) => d.problem), ["NOT ON THE PATH"], "the same host with the PATH moved is the one change that produces it");
  assert.match(driftReport(missing), /pnpm is NOT fixed by the remedy below -- it is a program the host must have/,
    "and the report says `host:install` does not fix it, as it says for the dotfile it also cannot write");
});

test("#2184 THE MATCHED PAIR: the same unit CURRENT keeps both the claim and the remedy warning", () => {
  // THE POSITIVE CONTROL FOR THE TWO `doesNotMatch` ASSERTIONS ABOVE. Change one thing -- the installed
  // text now equals the shipped text -- and every sentence they assert is absent must come back, or the
  // test above passes against a function that simply stopped saying anything.
  const drift = hostUnitDrift(hostWithOneUnit(""));
  assert.deepEqual(drift.map((d) => d.problem), ["PROGRAM MISSING"],
    "no STALE now: the unit is byte-identical to the one this repository ships");
  assert.equal(drift[0].installedCopy, "current");
  assert.match(drift[0].detail, /the unit is installed and matches the repository/);
  assert.match(drift[0].detail, /THE SHARED REMEDY DOES NOT FIX THIS/);
  assert.match(driftReport(drift), /NOT fixed by the remedy below either/,
    "#2174's whole point, unchanged: on a CURRENT unit the remedy looks like it should work and does "
    + "nothing, so the reader has to be told beforehand");
});

test("#2184: an installed unit this repository does not ship gets NEITHER sentence", () => {
  // The third state, and it is not "stale": an orphan has no repository copy to match OR differ from,
  // so a boolean would have had to print one of the two sentences at a unit both are false of.
  const [finding] = missingUnitPrograms({
    shippedDir: "/shipped",
    ...installedStub({ "a11ign-hand-placed.service": UNIT_WITH("host/gone.sh") }),
    // `installedStub`'s `read` answers on BASENAME, so it would hand the same text back for the shipped
    // path and read as CURRENT. This is the read that makes the shipped copy genuinely absent.
    read: ((path: string) => {
      if (String(path).startsWith("/shipped")) throw new Error(`ENOENT: ${path}`);
      return UNIT_WITH("host/gone.sh");
    }) as never,
    exists: () => false,
  });
  assert.equal(finding.installedCopy, "unshipped");
  assert.doesNotMatch(finding.detail, /matches the repository/);
  assert.doesNotMatch(finding.detail, /MAY be fixed by the shared remedy/,
    "the remedy DELETES an a11ign-* unit the repository does not ship; it does not repair this path");
  assert.match(finding.detail, /does not ship\s+this unit at all/);
  assert.doesNotMatch(driftReport([finding]), /NOT fixed by the remedy below either/,
    "and `orphanedUnits` owns what to do about it");
});

test("#2174: a unit with NO WorkingDirectory is SKIPPED, never guessed at", () => {
  // A relative path would then resolve against systemd's own default, and inventing a base directory to
  // check against is how a checker starts reporting faults that are really its own.
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "a11ign-x.service": "[Service]\nExecStart=/usr/bin/bash host/gone.sh\n" }),
    exists: () => false,
  }), []);
});

test("#2174: only this repository's units are examined", () => {
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "someone-elses.service": UNIT_WITH("host/gone.sh") }),
    exists: () => false,
  }), [], "the host runs others; those are not ours to have an opinion about");
});

test("#2174: an unreadable installed directory reports nothing rather than inventing findings", () => {
  assert.deepEqual(missingUnitPrograms({
    installedDir: "/nope",
    readDir: (() => { throw new Error("ENOENT"); }) as never,
    read: (() => "") as never,
    exists: () => false,
  }), [], "a reader that never got to look must not report a clean host OR a drifting one");
});

test("#2174: workingDirectoryOf follows systemd's own last-wins rule, and an empty value RESETS", () => {
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\n"), "/a");
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\nWorkingDirectory=/b\n"), "/b",
    "systemd takes the last of a repeated directive; a first-match read would check against a "
    + "directory the service manager has already discarded");
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\nWorkingDirectory=\n"), null,
    "an empty assignment resets it to the default, which is a unit that declares no base directory");
  assert.equal(workingDirectoryOf("[Service]\nExecStart=/usr/bin/true\n"), null);
  assert.equal(workingDirectoryOf(""), null);
  assert.equal(workingDirectoryOf(null as unknown as string), null);
});

/**
 * #2174: `programCandidates` IS `entriesFromCommand` WITHOUT THE `exists` FILTER, and that filter is
 * exactly why the older function structurally cannot answer this row -- a unit naming a program that is
 * not there returns `[]` from it, indistinguishable from a unit naming no repository file at all.
 */
test("#2174: the split preserves entriesFromCommand's behaviour and exposes what it filtered away", () => {
  const deps = { repoRoot: "/repo", scripts: {} };
  assert.deepEqual(programCandidates("/usr/bin/bash host/gone.sh", deps), ["/repo/host/gone.sh"],
    "the candidate is resolved whether or not it exists");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash host/gone.sh", { ...deps, exists: () => false }), [],
    "while entriesFromCommand still answers its own question -- files that are really there");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash host/gone.sh", { ...deps, exists: () => true }),
    ["/repo/host/gone.sh"], "and is unchanged when they are");
  // `npm run <script>` is followed through the WorkingDirectory's OWN package.json, which is what makes
  // `ExecStart=/usr/bin/npm run corpus:snapshot` a path rather than the opaque word `npm`.
  assert.deepEqual(programCandidates("/usr/bin/npm run snap",
    { repoRoot: "/repo", scripts: { snap: "node packages/lab/scripts/snap.mjs" } }),
  ["/repo/packages/lab/scripts/snap.mjs"]);
  assert.deepEqual(programCandidates("/usr/bin/bash -c 'something opaque'", deps), [],
    "an opaque command yields no candidate and is correctly not charged as missing");
});

test("#2174: hostUnitDrift asks the new question too, and stays silent where it always did", () => {
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD }), [],
    "no user systemd manager is still NOT CHECKED -- the gate that keeps this whole file honest");
});

/**
 * #2174, OVER THE REAL SHIPPED UNITS rather than a fixture -- the regression test for the latent false
 * positive above. Two of the five shipped services run `/usr/bin/bash` or `/usr/bin/npm`, and one of the
 * ways a unit can be written is `bash -c`. A fixture would have let the `-c` bug survive here.
 */
test("#2174: no shipped unit is falsely charged, and every one of them is charged when it should be", () => {
  const units = Object.fromEntries(shippedUnits().map((u) =>
    [u, shippedText(u)]));
  const stub = {
    installedDir: "/installed",
    readDir: (() => Object.keys(units)) as never,
    read: ((path: string) => units[String(path).split("/").pop() as string]) as never,
  };
  assert.deepEqual(missingUnitPrograms({ ...stub, exists: () => true }), [],
    "with every program present, the real shipped set is clean -- if this fails, something resolves an "
    + "option or a flag as a path");
  // THE CONTROL, and it is what makes the line above mean anything: the same real units, with nothing
  // on disk, must produce findings. An emptiness assertion over a population that resolves to nothing
  // passes for the wrong reason.
  const charged = missingUnitPrograms({ ...stub, exists: () => false });
  assert.ok(charged.length > 0,
    "the real shipped units DO name programs, so a reader that finds none is broken rather than lucky");
  for (const finding of charged) {
    assert.ok(!finding.missingProgram?.split("/").pop()?.startsWith("-"),
      `an option was resolved as a path: ${finding.missingProgram}`);
  }
});

/**
 * #2174, FOUND BY MUTATION: the `text === null` skip in `missingForUnit` survived deletion, because no
 * test had a unit that `readDir` LISTS and `read` cannot open. That is a real state -- a unit removed
 * between the listing and the read, or one this process may not read -- and it is `unitDrift`'s finding
 * rather than this one's. Without the skip, `workingDirectoryOf(null)` returns null and the unit is
 * silently dropped anyway, so the mutant is invisible until `workingDirectoryOf` changes; this pins the
 * behaviour at the boundary that owns it instead.
 */
test("#2174: a unit that is listed but cannot be READ yields no finding and does not throw", () => {
  const found = missingUnitPrograms({
    installedDir: "/installed",
    readDir: (() => ["a11ign-vanished.service"]) as never,
    read: (() => { throw new Error("ENOENT: it went away between the listing and the read"); }) as never,
    exists: () => false,
  });
  assert.deepEqual(found, [],
    "an unreadable unit is `unitDrift`'s finding -- guessing at what it starts would report a second "
    + "fault for one cause");
});

// --- #2332: THE `gh` IDENTITY WRAPPER, ITS LEADS LIST AND THE CREDENTIAL HELPER ----------------------
//
// THE WRAPPER IS RUN, NOT READ. A regex over `packages/agent-org/host/gh` would pass on a file whose
// branches were in the wrong order; these tests put a stub `gh-real` behind it and ask which account the
// stub was started as. The three paths it can be pointed elsewhere by (`A11Y_GH_REAL`, `A11Y_WORKERS_DIR`,
// `A11Y_LEADS_DIR`) are environment variables with the production values as defaults, so nothing here
// touches the real host.

/** The wrapper AS IT INSTALLS (#2620: `host/gh.in` is a template), rendered once into a temp directory so it can be RUN. */
const WRAPPER = (() => {
  const rendered = join(mkdtempSync(join(tmpdir(), "gh-wrapper-render-")), "gh");
  writeFileSync(rendered, shippedScriptText("gh") as string, { mode: 0o755 });
  return rendered;
})();
const STUB_EXIT = 7; // a status nothing else here returns, so it can only have come from the stub
const EXECUTABLE = 0o111;
const PERMISSION_BITS = 0o777;
const RWX_R_X_R_X = 0o755;
/** The leads list as it installs (#2620: host data now, rendered from `host.json`'s `gh.leadsWorkspaces`). */
const LEADS_LIST_TEXT = leadsListText();

/** The ids on a list file's own lines: not comments, not blanks. */
const listedIds = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/**
 * A stub `gh-real` that says which config it was started with and leaves a marker: THE POSITIVE CONTROL for
 * every "reached gh-real" assertion below, since a wrapper that exits before the stub also prints nothing.
 */
const wrapperHost = ({ workers = true, leads = true, list = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "gh-wrapper-2332-"));
  const workersDir = join(root, "workers");
  const leadsDir = join(root, "leads");
  const marker = join(root, "reached");
  const stub = join(root, "gh-real");
  writeFileSync(stub, `#!/bin/sh\necho "reached $*" > "${marker}"\necho "CONFIG=<\${GH_CONFIG_DIR-UNSET}>"\nexit ${STUB_EXIT}\n`,
    { mode: 0o755 });
  for (const [present, dir] of [[workers, workersDir], [leads, leadsDir]] as const) {
    mkdirSync(dir, { recursive: true });
    if (!present) continue;
    mkdirSync(join(dir, "gh"));
    writeFileSync(join(dir, "gh", "hosts.yml"), "github.com: {}\n");
  }
  // THE RENDERED LIST, not a fixture of one: the file under review is the file that decides. (#3233) It is rendered from the fixture host's
  // `gh.leadsWorkspaces`, the same renderer `host:install` writes `~/leads/workspaces.txt` with.
  if (list) writeFileSync(join(leadsDir, "workspaces.txt"), LEADS_LIST_TEXT);
  const run = (env: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: workersDir,
      A11Y_LEADS_DIR: leadsDir, ...env } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, reached: existsSync(marker),
      reachedWith: existsSync(marker) ? readFileSync(marker, "utf8").trim() : null };
  };
  return { root, workersDir, leadsDir, run };
};

test("#2332: an agent workspace that is NOT on the leads list gets the workers account", () => {
  const { root, workersDir, run } = wrapperHost();
  try {
    for (const id of ["w3", "w9", "wD", "w-unknown"]) {
      const r = run({ HERDR_WORKSPACE_ID: id }, "api", "user");
      assert.match(r.stdout, new RegExp(`CONFIG=<${workersDir}/gh>`), `${id} must be routed to the workers account`);
      assert.equal(r.reachedWith, "reached api user", "the stub PROVES it ran, with the caller's arguments");
      assert.equal(r.status, STUB_EXIT, "and gh-real's own exit status is the wrapper's");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: the three decision-holders get the LEADS account -- an explicit config, never the person's default", () => {
  const { root, leadsDir, run } = wrapperHost();
  try {
    for (const id of ["w6", "w2", "w5"]) {
      const r = run({ HERDR_WORKSPACE_ID: id });
      assert.match(r.stdout, new RegExp(`CONFIG=<${leadsDir}/gh>`), `${id} is on the leads list, so it acts as a11ign-ai-leads`);
      assert.doesNotMatch(r.stdout, /CONFIG=<UNSET>/,
        "UNSET is what the human account looks like from here, and no agent workspace may be it");
      assert.ok(r.reached, "POSITIVE CONTROL: the stub ran, so the config it printed is the one it was started with");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: an explicit GH_CONFIG_DIR is passed through UNCHANGED, whatever the workspace is", () => {
  const { root, run } = wrapperHost();
  try {
    for (const id of ["w9", "w6"]) {
      const r = run({ HERDR_WORKSPACE_ID: id, GH_CONFIG_DIR: "/somewhere/else" });
      assert.match(r.stdout, /CONFIG=<\/somewhere\/else>/, `${id}: a unit or a spawn that DECLARES its account wins`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3642: a shell with NO workspace id and NO GH_CONFIG_DIR is refused, never left alone as the human (it was, until #3642)", () => {
  const { root, run } = wrapperHost();
  try {
    const r = run({});
    assert.equal(r.reached, false, "gh-real never ran, so nothing acted as the human");
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /CONFIG=<UNSET>/, "UNSET is the human account from here");
    assert.match(r.stderr, /no workspace id and no GH_CONFIG_DIR/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: an agent workspace whose account is MISSING refuses and never reaches gh-real", () => {
  const noWorkers = wrapperHost({ workers: false });
  const noLeads = wrapperHost({ leads: false });
  try {
    const worker = noWorkers.run({ HERDR_WORKSPACE_ID: "w9" }, "api", "user");
    assert.notEqual(worker.status, 0);
    assert.match(worker.stderr, /must not act as the human account/);
    assert.equal(worker.reached, false, "the whole point: it does NOT fall through to the human's login");
    assert.equal(worker.stdout, "");
    // THE SAME FOR A LEAD: a missing leads config is a refusal and not a quiet fall-back to the workers
    // account (which would spend the pool the chairman gave the leads their own to avoid) or the person.
    const lead = noLeads.run({ HERDR_WORKSPACE_ID: "w6" }, "api", "user");
    assert.notEqual(lead.status, 0);
    assert.match(lead.stderr, new RegExp(`${noLeads.leadsDir}/gh/hosts\\.yml`), "and names the file that is missing");
    assert.equal(lead.reached, false);
    // THE CONTROLS: each missing account stops only the workspaces that route to it.
    assert.ok(noWorkers.run({ HERDR_WORKSPACE_ID: "w6" }).reached, "a lead does not need the workers config");
    assert.ok(noLeads.run({ HERDR_WORKSPACE_ID: "w9" }).reached, "a worker does not need the leads config");
  } finally {
    rmSync(noWorkers.root, { recursive: true, force: true });
    rmSync(noLeads.root, { recursive: true, force: true });
  }
});

test("#2332: the list is matched by WHOLE LINE, and a missing list fails toward the workers account", () => {
  const { root, run } = wrapperHost();
  try {
    // `w66` contains `w6` and `w` contains nothing: a substring match would hand either the leads account.
    for (const id of ["w66", "w", "6"]) {
      assert.match(run({ HERDR_WORKSPACE_ID: id }).stdout, /CONFIG=<.*\/workers\/gh>/, `${id} is NOT w6`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const noList = wrapperHost({ list: false });
  try {
    assert.match(noList.run({ HERDR_WORKSPACE_ID: "w6" }).stdout, /CONFIG=<.*\/workers\/gh>/,
      "no list file means NO lead, so even w6 gets the workers account -- and never the person's");
  } finally { rmSync(noList.root, { recursive: true, force: true }); }
});

test("#2332: the leads list renders EXACTLY the declared decision-holders, each with its role, and no exception", () => {
  // (#3233) The fixture host declares three, so this is the renderer's behaviour; that a11ign's own `host.json` declares exactly its three is
  // an assertion about a11ign's tree, and a fourth id there needs a ruling, not an edit.
  const text = LEADS_LIST_TEXT;
  assert.deepEqual(listedIds(text), ["w6", "w2", "w5"], "every declared workspace, in the order declared, and no other");
  for (const [id, role] of [["w6", "ceo"], ["w2", "product-manager"], ["w5", "orchestrator"]]) {
    assert.match(text, new RegExp(`^# ${id} ${role}\\n${id}$`, "m"), `${id} carries its role on the line above it`);
  }
  assert.doesNotMatch(text, /TEMPORARY/i,
    "there is no exception any more (#2333): nothing on this list is waiting to be removed");
  assert.ok(!existsSync(join(SHIPPED_DIR, "gh-human-account-workspaces.txt")), "and the human list is gone from the tree");
});

const identityDeps = () => {
  const root = mkdtempSync(join(tmpdir(), "host-identity-2332-"));
  const where = { shippedDir: join(root, "shipped"), scriptDir: join(root, "bin"),
    workersDir: join(root, "workers"), leadsDir: join(root, "leads"), gitConfigPath: join(root, "gitconfig") };
  mkdirSync(where.shippedDir);
  return { root, where, ...where, host: identityHost(where) };
};

test("#2332: an in-sync host reads clean, and the installer wrote a runnable, executable wrapper", () => {
  const { root, where } = identityDeps();
  try {
    assert.deepEqual(hostIdentityDrift(where), [], "the control every DIVERGED case below is a one-change mutation of");
    assert.equal(statSync(join(where.scriptDir, "gh")).mode & EXECUTABLE, EXECUTABLE, "gh is executable");
    assert.equal(readFileSync(join(where.workersDir, "README.md"), "utf8"), WORKERS_README);
    assert.doesNotMatch(WORKERS_README, /everything else uses the default \(human\) config/,
      "the sentence #1950 made false must not survive in the file host:install writes");
    assert.doesNotMatch(WORKERS_README, /Only a shell with no workspace id is a person/,
      "#3665: the wrapper refuses a call with no workspace id and no GH_CONFIG_DIR (#3642), it does not use the default config");
    assert.match(WORKERS_README, /neither a workspace id nor GH_CONFIG_DIR is REFUSED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: `host:check` reports DIVERGED for ~/.local/bin/gh when its bytes differ, and NOT INSTALLED when absent", () => {
  const { root, where } = identityDeps();
  try {
    writeFileSync(join(where.scriptDir, "gh"), "#!/bin/sh\nexec /usr/bin/gh \"$@\"\n");
    const [finding, ...rest] = hostIdentityDrift(where);
    assert.deepEqual(rest, [], "exactly one file drifted, so exactly one finding");
    assert.equal(finding.unit, join(where.scriptDir, "gh"));
    assert.equal(finding.problem, "DIVERGED");
    assert.notEqual(finding.manualFix, true, "host:install DOES fix a copied file, so the remedy line is honest for it");
    rmSync(join(where.scriptDir, "gh"));
    assert.deepEqual(hostIdentityDrift(where).map((d) => d.problem), ["NOT INSTALLED"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: the leads list and the README each report DIVERGED too, and host:install repairs all three", () => {
  const { root, where } = identityDeps();
  try {
    writeFileSync(join(where.leadsDir, "workspaces.txt"), "w6\nw2\nw5\nw9\n");
    writeFileSync(join(where.workersDir, "README.md"), "everything else uses the default (human) config\n");
    writeFileSync(join(where.scriptDir, "gh"), "stale\n");
    assert.deepEqual(hostIdentityDrift(where).map((d) => `${d.unit.split("/").pop()}:${d.problem}`),
      ["gh:DIVERGED", "workspaces.txt:DIVERGED", "README.md:DIVERGED"]);
    hostIdentityInstall({ ...where, out: () => {} });
    assert.deepEqual(hostIdentityDrift(where), [], "the shared remedy clears every file finding it names");
    assert.deepEqual(readdirSync(where.scriptDir), ["gh"], "the atomic write left no temp file behind");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: an unreadable shipped copy is a finding and an install REFUSES, never writing an empty gh", () => {
  const { root, where } = identityDeps();
  try {
    rmSync(join(where.shippedDir, "gh"));
    assert.ok(hostIdentityDrift(where).some((d) => d.problem === "SHIPPED COPY UNREADABLE"));
    const before = readFileSync(join(where.scriptDir, "gh"), "utf8");
    assert.throws(() => hostIdentityInstall({ ...where, out: () => {} }), /shipped copy could not be read/);
    assert.equal(readFileSync(join(where.scriptDir, "gh"), "utf8"), before,
      "the installed wrapper is untouched: an empty gh on every agent's PATH is worse than a stale one");
    assert.equal(ownedIdentityFiles(where).find((f) => f.label === "gh")?.expected, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const helperFile = (lines: string[]) => `[credential "https://github.com"]\n${lines.map((l) => `\thelper = ${l}\n`).join("")}`;

test("#2332: `host:check` reports DIVERGED for the global gitconfig when the github.com helper is not the wrapper", () => {
  const { root, where } = identityDeps();
  const wrapper = `!${where.scriptDir}/gh auth git-credential`;
  const check = (lines: string[] | null) => {
    if (lines !== null) writeFileSync(where.gitConfigPath, helperFile(lines));
    else rmSync(where.gitConfigPath, { force: true });
    return hostIdentityDrift(where).filter((d) => d.unit === where.gitConfigPath);
  };
  try {
    assert.deepEqual(check(["", wrapper]), [], "CONTROL: an empty reset then the wrapper is the correct shape");
    assert.deepEqual(check([wrapper]), [], "and the wrapper alone is too");
    for (const [name, lines] of Object.entries({
      "the REAL binary (the measured defect)": ["", "!/usr/bin/gh auth git-credential"],
      "the wrapper's own name with no reset, after another helper": ["!/usr/bin/gh auth git-credential", wrapper],
      "the wrapper followed by a second helper": ["", wrapper, "cache"],
      "a reset that FORGETS the wrapper": [wrapper, ""],
      "no helper at all": [],
    })) {
      const [finding, ...rest] = check(lines);
      assert.deepEqual(rest, [], name);
      assert.equal(finding?.problem, "DIVERGED", name);
      assert.equal(finding?.manualFix, true, `${name}: host:install writes no line of a person's dotfile`);
    }
    assert.equal(check(null)[0]?.problem, "DIVERGED", "a missing global gitconfig has no helper, so it is not the wrapper");
    assert.equal(hostIdentityDrift({ ...where, gitConfig: () => null })
      .find((d) => d.unit === where.gitConfigPath)?.problem, "UNREADABLE", "unknown is not wrong, and not fine");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: the report says a diverged global gitconfig is NOT fixed by the remedy printed under it", () => {
  const { root, where } = identityDeps();
  try {
    writeFileSync(where.gitConfigPath, helperFile(["", "!/usr/bin/gh auth git-credential"]));
    const report = driftReport(hostIdentityDrift(where));
    assert.match(report, /!! .*gitconfig is NOT fixed by the remedy below/);
    assert.match(report, /Remedy for all of them: pnpm run host:install/);
    writeFileSync(join(where.scriptDir, "gh"), "stale\n");
    assert.doesNotMatch(driftReport(hostIdentityDrift(where).filter((d) => d.unit.endsWith("/gh"))),
      /NOT fixed by the remedy below/, "CONTROL: a copied file's finding does not carry the warning");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2332: `host:check` is WIRED to the identity check, and a machine with no user systemd is told nothing", () => {
  // THE MUTANT: deleting `...hostIdentityDrift(deps)` from `hostUnitDrift` kills every direct call above
  // and none of the command a reader runs.
  const host = hostWithOneUnit("");
  writeFileSync(join(host.scriptDir, "gh"), "stale\n");
  assert.ok(hostUnitDrift(host).some((d) => d.unit === join(host.scriptDir, "gh") && d.problem === "DIVERGED"));
  assert.deepEqual(hostUnitDrift({ ...host, systemctl: NO_SYSTEMD }), [],
    "a laptop has no ~/.local/bin/gh of ours and is not an agent host");
});

test("#2332: a person's global user.name/user.email is a NOTE -- reported, never counted, never a failure", () => {
  const { root, where } = identityDeps();
  const config = (text: string) => { writeFileSync(where.gitConfigPath, text); return hostIdentityNotes(where); };
  try {
    const [note, ...rest] = config("[user]\n\tname = Dan Beck\n\temail = 46429371+DanBeckDev@users.noreply.github.com\n");
    assert.deepEqual(rest, []);
    assert.equal(note.problem, "GLOBAL GIT IDENTITY IS A PERSON'S");
    assert.match(note.detail, /user\.name = Dan Beck, user\.email = 46429371\+DanBeckDev@/);
    assert.deepEqual(config(""), [], "CONTROL: nothing set, nothing to report");
    assert.deepEqual(config("[user]\n\tname = github-actions[bot]\n\temail = a11ign-ai-workers@example.org\n"), [],
      "a machine's identity is not a person's");
    const report = driftReport([], true, hostIdentityNotes({ ...where, gitConfig: () => ["Dan Beck"] }));
    assert.match(report, /^host units: every shipped unit is installed/, "notes never turn a clean host into problems");
    assert.match(report, /notes \(not failures\):/);
    assert.doesNotMatch(report, /problem\(s\)/);
    assert.doesNotMatch(driftReport([], true, []), /notes/, "and with none there is no heading");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2552: THE INTERACTIVE HALF OF THE COMPILE CACHE, which `compileCacheDrift` cannot see ------------

test("#2552: a .zshenv that does not export NODE_COMPILE_CACHE under $HOME/.cache is ONE note, never a failure", () => {
  const home = "/home/agent";
  const notes = (zshenv: string | null) => compileCacheNotes({ home, zshenvPath: `${home}/.zshenv`,
    read: ((path: string) => {
      if (zshenv === null) throw new Error(`ENOENT: ${path}`);
      return zshenv;
    }) as never });
  assert.equal(notes("export PATH=/usr/local/bin:$PATH\n").length, 1, "no such line");
  assert.equal(notes("export NODE_COMPILE_CACHE=/tmp/node-compile-cache\n").length, 1, "pointing at /tmp");
  assert.equal(notes("# export NODE_COMPILE_CACHE=\"$HOME/.cache/x\"\n").length, 1, "a comment is not an export");
  assert.equal(notes(null).length, 1, "a missing file is the regression itself");
  assert.equal(notes('export NODE_COMPILE_CACHE="$HOME/.cache/node-compile-cache"\n\nexport X=1\n').length, 0,
    "CONTROL: the shipped spelling reads clean");
  assert.equal(notes("export NODE_COMPILE_CACHE=${HOME}/.cache/nc\n").length, 0, "braced HOME");
  assert.equal(notes("export NODE_COMPILE_CACHE=/home/agent/.cache/nc\n").length, 0, "the literal home");
  assert.equal(notes('export NODE_COMPILE_CACHE="$HOME/.cache/nc"\nexport NODE_COMPILE_CACHE=/tmp/x\n').length, 1,
    "the LAST export is the one in force");
  const [note] = notes(null);
  assert.equal(note.problem, "INTERACTIVE SHELLS GET NO COMPILE CACHE UNDER THE HOME");
  assert.equal(note.unit, `${home}/.zshenv`);
  const report = driftReport([], true, [note]);
  assert.match(report, /^host units: every shipped unit is installed/, "a note never turns a clean host into problems");
  assert.doesNotMatch(report, /problem\(s\)/);
  assert.equal(compileCacheNotes({ home: "", read: (() => "export NODE_COMPILE_CACHE=/.cache/x\n") as never }).length, 1,
    "an unset HOME cannot make `/.cache` count as under the home");
});

test("#2332: END TO END -- `host:install` then `host:check --json` on a temp HOME: files match, notes are NOT findings", () => {
  // The real entry point, so `main`'s wiring (install writes the files; --json carries `notes` apart from
  // `findings`, which is what the gate wakes a session on) is exercised rather than assumed.
  const home = mkdtempSync(join(tmpdir(), "host-e2e-2332-"));
  try {
    const bin = join(home, "stub-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\ncase "$*" in *is-enabled*) echo enabled;; *is-active*) echo active;; *) echo LANG=C;; esac\n',
      { mode: 0o755 });
    writeFileSync(join(home, ".gitconfig"), helperFile(["", `!${home}/.local/bin/gh auth git-credential`])
      + "[user]\n\tname = Dan Beck\n");
    writeFileSync(join(home, ".zshenv"), 'export NODE_COMPILE_CACHE="$HOME/.cache/node-compile-cache"\n');
    // #2620: THE MACHINE'S PATHS COME FROM `host.json`, so a temp HOME needs a temp host declaration -- `AGENT_ORG_HOST` says which. Without
    // it this test would install the host's real `~/leads/workspaces.txt` and `~/workers/README.md` from a "temp" run.
    const declared = JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8"));
    const hostFile = join(home, "host.json");
    writeFileSync(hostFile, JSON.stringify({ ...declared, home, binDir: join(home, ".local/bin"),
      projects: [{ id: declared.primary, checkout: PROJECT_ROOT }],
      gh: { ...declared.gh, workers: join(home, "workers"), leads: join(home, "leads") } }));
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, AGENT_ORG_HOST: hostFile };
    const entry = join(TOOL_ROOT, "src/host-units.mjs");
    const run = (...args: string[]) => {
      const done = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env });
      assert.notEqual(done.stdout, "", `host-units.mjs ${args.join(" ")} wrote nothing; stderr: ${done.stderr}`);
      return done;
    };
    const identityFindings = (out: string) => JSON.parse(out).findings
      .filter((f: { unit: string }) => f.unit.startsWith(home) && /\/(gh|workspaces\.txt|README\.md|\.gitconfig)$/.test(f.unit));
    assert.ok(identityFindings(run("--json").stdout).length >= 3, "before the install: gh, the leads list and the README are all absent");
    const install = run("--install");
    assert.match(install.stdout, /installed .*\/\.local\/bin\/gh/);
    const after = JSON.parse(run("--json").stdout);
    assert.deepEqual(identityFindings(JSON.stringify(after)), [], "after the install every identity file matches");
    // #3539: THE TEMP PROJECT HOLDS NO ROSTER AND THE TEMP HOME NO HERDR, so `host:check` adds its own `persistent seats: UNKNOWN` note; this test is about the identity files
    // and the compile cache, so the seat note is set aside here and read by `persistent-seat-running.test.ts`.
    const notSeats = <N extends { unit: string }>(notes: N[]) => notes.filter((n) => n.unit !== "persistent seats");
    assert.equal(notSeats(after.notes).length, 1, "the person's user.name is carried as a note, and the correct .zshenv adds none");
    rmSync(join(home, ".zshenv"));
    const without = JSON.parse(run("--json").stdout);
    assert.deepEqual(notSeats<{ unit: string, problem: string }>(without.notes).map((n: { problem: string }) => n.problem).sort(),
      ["GLOBAL GIT IDENTITY IS A PERSON'S", "INTERACTIVE SHELLS GET NO COMPILE CACHE UNDER THE HOME"],
      "WIRING: `host:check --json` carries the compile-cache note when the account's .zshenv is gone");
    assert.ok(without.findings.every((f: { unit: string }) => !f.unit.endsWith(".zshenv")), "and never as a finding");
    assert.ok(after.findings.every((f: { problem: string }) => !/GLOBAL GIT IDENTITY/.test(f.problem)),
      "and NEVER as a finding, because the gate wakes a session on findings");
    assert.equal(statSync(join(home, ".local/bin/gh")).mode & PERMISSION_BITS, RWX_R_X_R_X);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- #2332 / #2333: NO UNIT ACTS AS THE HUMAN ACCOUNT, AND `host:check` SAYS SO -----------------------
//
// The corpus release was the last thing that did, by a comment that called it "the right answer": the
// workers account could not push to `a11ign/corpus-backups`. `a11ign-ai-leads` can (`push: true, admin:
// false` on it and on `a11ign/a11ign`, read back 2026-09-24), so the unit moved and the exception with it.
// The refusal below is what keeps the next unit from reintroducing one by an `Environment=` line nobody
// reads: it is asserted over the units ON DISK and it runs inside `host:check`, not only in this suite.

/** A one-unit shipped directory and the deps `identityDrift` takes for it. */
const oneUnit = (body: string, extra: Record<string, unknown> = {}) => ({
  shippedDir: "/shipped",
  readDir: (() => ["a11ign-x.service"]) as never,
  read: ((p: string) => (String(p).startsWith("/shipped") ? body : "execFileSync(\"gh\", [])")) as never,
  ...extra,
});

test("#2332: nothing shipped declares the person's account", () => {
  // THE POPULATION, NAMED: the emptiness assertion below is only worth what this says about its input.
  const declared = shippedUnits().filter((f) => f.endsWith(".service"))
    .map((f) => [f, /^Environment=GH_CONFIG_DIR=(.*)$/m.exec(shippedText(f))?.[1] ?? null]);
  assert.ok(declared.filter(([, dir]) => dir !== null).length >= 5, `too few units declare an account: ${JSON.stringify(declared)}`);
  assert.deepEqual(declared.filter(([, dir]) => dir !== null && /\.config\/gh/.test(String(dir))), [],
    "no shipped unit declares the person's config");
  assert.deepEqual(HUMAN_ACCOUNT_ALLOWED, {}, "and nothing is exempted: an entry needs `ceo`'s ruling");
});

test("#2332 NEGATIVE CONTROL: a unit that declares the person's config IS a finding, however it spells the home", () => {
  for (const dir of ["/home/agent/.config/gh", "/home/agent/.config/gh/", "%h/.config/gh", "$HOME/.config/gh",
    "~/.config/gh", ""]) {
    const [f, ...rest] = identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\nEnvironment=GH_CONFIG_DIR=${dir}\n`));
    assert.deepEqual(rest, [], `${JSON.stringify(dir)}: one finding`);
    assert.equal(f?.problem, "DECLARES THE HUMAN ACCOUNT", `${JSON.stringify(dir)} is the person`);
    assert.equal(f?.unit, "a11ign-x.service");
    assert.match(f.detail, /HUMAN_ACCOUNT_ALLOWED/, "and says how a ruled exception is recorded");
  }
  // ...EVEN IF IT SPAWNS NOTHING: the unit above runs `/usr/bin/true`, so the check reads the declaration.
  for (const dir of ["/home/agent/workers/gh", "/home/agent/leads/gh"]) {
    assert.deepEqual(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\nEnvironment=GH_CONFIG_DIR=${dir}\n`)), [],
      `CONTROL: ${dir} is an org account`);
  }
  // A path that merely CONTAINS the person's config is not it: `/x/.config/gh-workers` is somebody's own dir.
  assert.deepEqual(identityDrift(oneUnit("[Service]\nExecStart=/usr/bin/true\nEnvironment=GH_CONFIG_DIR=/home/agent/.config/gh-bot\n")), []);
});

test("#2332: the LAST declaration wins, as in systemd, and a named allow-entry is honoured", () => {
  const human = "Environment=GH_CONFIG_DIR=/home/agent/.config/gh\n";
  const leads = "Environment=GH_CONFIG_DIR=/home/agent/leads/gh\n";
  assert.deepEqual(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${human}${leads}`)), [],
    "the person's line overridden by a later org one is the org account");
  assert.equal(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${leads}${human}`)).length, 1,
    "and the reverse order IS the person, whatever the first line said");
  assert.deepEqual(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${human}`,
    { humanAllowed: { "a11ign-x.service": "ceo ruled it, #0000" } })), [], "a named entry exempts exactly that unit");
  assert.equal(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${human}`,
    { humanAllowed: { "a11ign-y.service": "another unit's ruling" } })).length, 1, "and no other");
});

test("#2332 (review): systemd's OTHER `Environment=` spellings declare the person's account too, and are refused", () => {
  // The reviewer's two, and the rest of what systemd's word splitting accepts: quotes may open anywhere in
  // a word, several assignments share a line, a backslash continues a line, and an EMPTY `Environment=`
  // resets everything before it. A matcher anchored on `Environment=GH_CONFIG_DIR=` read none of these.
  const human = "/home/agent/.config/gh";
  for (const line of [`Environment="GH_CONFIG_DIR=${human}"`, `Environment=PATH=/usr/bin GH_CONFIG_DIR=${human}`,
    `Environment=GH_CONFIG_DIR="${human}"`, `Environment='GH_CONFIG_DIR=${human}'`,
    `Environment="PATH=/a b" "GH_CONFIG_DIR=${human}" X=1`, `Environment=PATH=/usr/bin \\\n  GH_CONFIG_DIR=${human}`,
    `Environment = GH_CONFIG_DIR=${human}`, `   Environment=GH_CONFIG_DIR=${human}`]) {
    const [f, ...rest] = identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${line}\n`));
    assert.deepEqual(rest, [], `${JSON.stringify(line)}: one finding`);
    assert.equal(f?.problem, "DECLARES THE HUMAN ACCOUNT", `${JSON.stringify(line)} is the person`);
    assert.match(f.detail, new RegExp(`GH_CONFIG_DIR=${human.replaceAll("/", "\\/")}`), "and names the value it read");
  }
});

test("#2332 (review): those spellings are also DECLARATIONS -- a gh-reaching unit using one is not 'undeclared'", () => {
  // The other half of the same blind spot: `unitsSpendingGh` said `declared: false` for a unit that named
  // an org account in a quoted or shared line, so a CORRECT unit would have been refused as undeclared.
  for (const line of ['Environment="GH_CONFIG_DIR=/home/agent/leads/gh"', "Environment=PATH=/usr/bin GH_CONFIG_DIR=/home/agent/workers/gh"]) {
    assert.deepEqual(identityDrift(oneUnit(`[Service]\nExecStart=/home/agent/.local/bin/opaque.sh\n${line}\n`)), [],
      `${line}: an org account, declared`);
    const [u] = unitsSpendingGh(oneUnit(`[Service]\nExecStart=/home/agent/.local/bin/opaque.sh\n${line}\n`));
    assert.equal(u?.declared, true, `${line} counts as a declaration`);
  }
  // CONTROL: the parser does not invent one from a lookalike, a comment, or a value of another variable.
  for (const line of ["Environment=NOT_GH_CONFIG_DIR=/home/agent/.config/gh", "# Environment=GH_CONFIG_DIR=/home/agent/.config/gh",
    "Environment=PATH=/home/agent/.config/gh", 'Environment="X=GH_CONFIG_DIR=/home/agent/.config/gh"',
    "Environment=GH_CONFIG_DIR=/home/agent/.config/gh\nEnvironment="]) {
    assert.deepEqual(identityDrift(oneUnit(`[Service]\nExecStart=/usr/bin/true\n${line}\n`))
      .filter((f) => f.problem === "DECLARES THE HUMAN ACCOUNT"), [], `${JSON.stringify(line)} declares no human account`);
  }
  const [none] = unitsSpendingGh(oneUnit("[Service]\nExecStart=/home/agent/.local/bin/opaque.sh\nEnvironment=GH_CONFIG_DIR=/home/agent/.config/gh\nEnvironment=\n"));
  assert.equal(none?.declared, false, "an empty `Environment=` resets the list, so the earlier line is no declaration");
});

test("#2332: `host:check` REFUSES an undeclared gh unit and a human-declaring one -- the check is wired in", () => {
  // THE MUTANT: dropping `...identityDrift(deps)` from `hostUnitDrift` leaves every direct call above green
  // and the command a reader runs silent about both.
  const clean = hostWithOneUnit("");
  assert.deepEqual(hostUnitDrift(clean).filter((d) => /IDENTITY|HUMAN/.test(d.problem)), [],
    "CONTROL: the declaring fixture unit reads clean, so what follows is the unit's doing");
  const unit = "a11ign-board-report.service";
  const body = (line: string) => UNIT_BODY(join(clean.shippedDir, "..", "repo")).replace(
    "Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n", line);
  for (const [line, problem] of [["", "NO IDENTITY DECLARED"],
    ["Environment=GH_CONFIG_DIR=/home/agent/.config/gh\n", "DECLARES THE HUMAN ACCOUNT"]] as const) {
    writeFileSync(join(clean.shippedDir, unit), body(line));
    writeFileSync(join(clean.installedDir, unit), body(line));
    assert.ok(hostUnitDrift(clean).some((d) => d.problem === problem && d.unit === unit),
      `${problem}: \`host:check\` reports it against the unit`);
  }
});

// --- #3643: A UNIT THAT SPAWNS NOTHING STILL HAS TO SAY WHOSE ACCOUNT IT IS, AND THE HOST MUST NOT HOLD A PERSON'S LOGIN ---------------
//
// Reach analysis answers "does this unit spend a rate limit TODAY". `a11ign-corpus-snapshot.service` reached no `gh` spawn and declared
// nothing, so it passed both checks while the wrapper's rule 5 sent it to `~/.config/gh`, logged in as the org owner with admin.

test("#3643: a shipped unit that declares no GH_CONFIG_DIR is a finding EVEN WHERE NO `gh` SPAWN IS REACHABLE", () => {
  const silent = oneUnit("[Service]\nType=oneshot\n");
  // THE CASE IS WHAT IT SAYS IT IS: reach analysis finds nothing, so the finding below is the new rule's doing and not the old one's.
  assert.deepEqual(unitsSpendingGh(silent), [], "the unit reaches no gh spawn and starts no command at all");
  const [f, ...rest] = identityDrift(silent);
  assert.deepEqual(rest, [], "one finding");
  assert.equal(f?.problem, "NO IDENTITY DECLARED");
  assert.equal(f?.unit, "a11ign-x.service");
  assert.match(f.detail, /reaches no `gh` spawn/, "and says why it is a finding anyway");
  assert.match(f.detail, /\/home\/agent\/workers\/gh/, "the remedy names the workers dir");
  assert.match(f.detail, /\/home\/agent\/leads\/gh/, "and the leads dir");
  assert.match(f.detail, /pnpm run host:install/, "and the command that lands the unit");
  // CONTROL: the same unit WITH the declaration reads clean, so the finding above is the missing line and nothing else.
  assert.deepEqual(identityDrift(oneUnit("[Service]\nType=oneshot\nEnvironment=GH_CONFIG_DIR=/home/agent/workers/gh\n")), []);
  // A unit that DOES reach a spawn is still ONE finding and keeps its own reason, not a second one for the same missing line.
  const spawning = identityDrift(oneUnit("[Service]\nExecStart=/home/agent/.local/bin/opaque.sh\n"));
  assert.equal(spawning.length, 1);
  assert.match(spawning[0].detail, /UNKNOWN rather than no/);
});

/** A host whose `~/.config/gh` and two bot configs hold exactly the `hosts.yml` texts given (`null` writes nothing). */
const ghHost = (files: { person: string | null, workers?: string | null, leads?: string | null }) => {
  const root = mkdtempSync(join(tmpdir(), "host-units-3643-"));
  const dirs = { person: join(root, "home", ".config", "gh"), workers: join(root, "workers", "gh"), leads: join(root, "leads", "gh") };
  for (const [name, text] of Object.entries({ workers: "user: workers-bot\n", leads: "user: leads-bot\n", ...files })) {
    if (text === null) continue;
    const dir = dirs[name as keyof typeof dirs];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.yml"), text);
  }
  return { host: { ...homeHostConfig(), home: join(root, "home"), gh: { ...homeHostConfig().gh, workers: join(root, "workers"), leads: join(root, "leads") } } as never, dirs };
};

const hostsYml = (user: string) => `github.com:\n    users:\n        ${user}:\n            oauth_token: gho_x\n    git_protocol: https\n    user: ${user}\n`;

test("#3643: a human login in ~/.config/gh is a finding, however the person is named", () => {
  for (const user of ["DanBeckDev", "somebody-renamed"]) {
    const { host, dirs } = ghHost({ person: hostsYml(user), workers: hostsYml("a11ign-ai-workers"), leads: hostsYml("a11ign-ai-leads") });
    const [f, ...rest] = humanLoginOnHost({ host });
    assert.deepEqual(rest, [], `${user}: one finding`);
    assert.equal(f?.problem, HUMAN_LOGIN_ON_HOST);
    assert.equal(f?.unit, dirs.person);
    assert.equal(f?.manualFix, true, "`host:install` writes no line of it");
    assert.match(f.detail, new RegExp(`\`${user}\``), "and names the login it read");
    assert.match(f.detail, /\/workers\/gh/);
    assert.match(f.detail, /\/leads\/gh/);
  }
  // THE OLD, SINGLE-ACCOUNT LAYOUT (no `users:` block) is read too.
  assert.equal(humanLoginOnHost(ghHost({ person: "github.com:\n    user: DanBeckDev\n    oauth_token: x\n" })).length, 1);
  // A multi-account file names only the person, and the token under a login is not a login.
  const mixed = ghHost({ person: "github.com:\n    users:\n        workers-bot:\n            oauth_token: x\n        DanBeckDev:\n            oauth_token: y\n    user: workers-bot\n" });
  const [m] = humanLoginOnHost(mixed);
  assert.match(m.detail, /`DanBeckDev`/);
  assert.doesNotMatch(m.detail, /workers-bot|oauth_token/);
});

test("#3643 CONTROLS: a bot login passes, a missing ~/.config/gh passes, an empty one passes", () => {
  assert.deepEqual(humanLoginOnHost(ghHost({ person: hostsYml("workers-bot") })), [], "the workers account");
  assert.deepEqual(humanLoginOnHost(ghHost({ person: hostsYml("leads-bot") })), [], "the leads account");
  assert.deepEqual(humanLoginOnHost(ghHost({ person: null })), [], "no ~/.config/gh is a pass, not an unknown");
  assert.deepEqual(humanLoginOnHost(ghHost({ person: "" })), [], "a hosts.yml with no login in it");
  assert.deepEqual(humanLoginOnHost(ghHost({ person: "github.com:\n    users: {}\n" })), []);
});

test("#3643: an UNREADABLE ~/.config/gh is a finding that says it does not know, and an unreadable bot config says the bot logins are incomplete", () => {
  const { host, dirs } = ghHost({ person: null });
  mkdirSync(join(dirs.person, "hosts.yml"), { recursive: true }); // a directory where the file should be: EISDIR, not ENOENT
  const [f, ...rest] = humanLoginOnHost({ host });
  assert.deepEqual(rest, []);
  assert.equal(f?.problem, "HOST GH LOGIN UNREADABLE");
  assert.match(f.detail, /UNKNOWN rather than no/, "it is never read as clean");
  const noBots = ghHost({ person: hostsYml("DanBeckDev"), workers: null });
  const [g] = humanLoginOnHost(noBots);
  assert.equal(g?.problem, HUMAN_LOGIN_ON_HOST);
  assert.match(g.detail, /could not be read, so the bot logins are incomplete/);
});

test("#3643: `host:check` REFUSES a human login on the host -- the check is wired in", () => {
  // THE MUTANT: dropping `...humanLoginOnHost(deps)` from `hostUnitDrift` leaves every direct call above green.
  const clean = hostWithOneUnit("");
  assert.deepEqual(hostUnitDrift(clean).filter((d) => d.problem === HUMAN_LOGIN_ON_HOST), [], "CONTROL: the pinned fixture reads clean");
  const { host } = ghHost({ person: hostsYml("DanBeckDev") });
  assert.ok(hostUnitDrift({ ...clean, host, readGhHosts: undefined }).some((d) => d.problem === HUMAN_LOGIN_ON_HOST),
    "`host:check` reports it");
});

test("#2332: a shipped unit that changes the account is a reviewed change, NOT 'installed identity the repo lacks'", () => {
  // The corpus release moving from the person's config to leads is exactly this: installed has one line,
  // shipped has a different one. `host:install` carries the decision out; "DO NOT RUN THE REMEDY" printed
  // above the one command that lands it would be the false alarm that trains a reader to ignore the true one.
  const state = unitState("a11ign-corpus-release-nightly.service", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith(SHIPPED_DIR)
      ? "[Service]\nEnvironment=GH_CONFIG_DIR=/home/agent/leads/gh\n"
      : "[Service]\nEnvironment=GH_CONFIG_DIR=/home/agent/.config/gh\n")) as never,
  });
  assert.deepEqual(state.identityRevert, []);
  assert.equal(unitDrift([state])[0].problem, "STALE");
  // CONTROL: the original direction still fires -- shipped declares NOTHING, so the install would delete it.
  assert.deepEqual(staleWithIdentity().identityRevert, ["Environment=GH_CONFIG_DIR=/home/agent/workers/gh"]);
});

// --- #2901: THE CHAIRMAN-MESSAGING WATCHER IS OPTIONAL, AND OFF BY DEFAULT ----------------------------------------------------------
//
// A template that ships only when `.agent-org/project.json` carries the key that asks for it. Absent, `host:check` is silent about it and
// `host:install` writes nothing; present, it is installed like any other. EVERY TEST BELOW HANDS `declaredKeys` RATHER THAN READING THE PROJECT,
// so the day a project configures `messaging` none of them goes red: the one assertion about the project's own declaration is a biconditional.

const isChairmanWatch = (unit: string) => unit.startsWith("a11ign-chairman-watch.");
// #2907: the listener is the pair's third unit (a service with no timer), on the same key, so "the messaging units" is both.
const isChairmanListen = (unit: string) => unit === "a11ign-chairman-listen.service";
const isChairmanMessaging = (unit: string) => isChairmanWatch(unit) || isChairmanListen(unit);
const WITH_MESSAGING = new Set(["causes", "units", "messaging"]);

test("#2901: the chairman-watch pair and the listener are listed only when the project declares `messaging`, and nothing else moves", () => {
  const without = shippedUnits(SHIPPED_DIR, { declaredKeys: WITHOUT_MESSAGING });
  const withKey = shippedUnits(SHIPPED_DIR, { declaredKeys: WITH_MESSAGING });
  assert.deepEqual(withKey.filter(isChairmanWatch), ["a11ign-chairman-watch.service", "a11ign-chairman-watch.timer"],
    "POSITIVE CONTROL: with the key the pair IS listed, so the absence below is the key's doing and not a pair that never ships");
  assert.deepEqual(without.filter(isChairmanWatch), []);
  assert.deepEqual(withKey.filter(isChairmanListen), ["a11ign-chairman-listen.service"],
    "POSITIVE CONTROL (#2907): with the key the listener's service IS listed too, and it has no timer");
  assert.deepEqual(without.filter(isChairmanListen), []);
  assert.deepEqual(withKey.filter((unit) => !isChairmanMessaging(unit)), without, "the key adds the trio and changes nothing else");
  assert.deepEqual(Object.values(OPTIONAL_UNITS), ["messaging", "messaging", "messaging"], "all three templates are asked for by the one key");
  assert.equal(declaredProjectKeys().has("units"), true, "CONTROL (#3233): the default reads the fixture project's declaration, so the answer below is a reading of it");
  assert.equal(shippedUnits().some(isChairmanMessaging), declaredProjectKeys().has("messaging"),
    "and the project the tool serves gets the trio exactly when its declaration holds the key");
});

test("#2901: `declaredProjectKeys` reads presence, and an unreadable declaration is a throw, never 'none'", () => {
  assert.deepEqual([...declaredProjectKeys("/x", (() => JSON.stringify({ schema: 1, messaging: {} })) as never)].sort(), ["messaging", "schema"]);
  assert.deepEqual([...declaredProjectKeys("/x", (() => "[]") as never)], []);
  assert.throws(() => declaredProjectKeys("/x", (() => "{ not json") as never), /cannot tell which optional units it asks for/);
  assert.throws(() => declaredProjectKeys("/x", (() => { throw new Error("EACCES"); }) as never), /EACCES/);
});

test("#2901: `host:check` does not report the pair as NOT INSTALLED when `messaging` is absent, and does when it is present", () => {
  const nothingInstalled = (declaredKeys: Set<string>) => unitDrift(shippedUnits(SHIPPED_DIR, { declaredKeys }).map((unit) =>
    unitState(unit, { exists: (() => false) as never, systemctl: systemctlStub({ "is-enabled": {}, "is-active": {} }) })));
  const absent = nothingInstalled(WITHOUT_MESSAGING);
  assert.ok(absent.length >= 10, "POSITIVE CONTROL: every other shipped unit IS reported on this empty host, so silence about the pair is not a check that reports nothing");
  assert.deepEqual(absent.filter((finding) => isChairmanWatch(finding.unit)), []);
  assert.deepEqual(nothingInstalled(WITH_MESSAGING).filter((finding) => isChairmanWatch(finding.unit)).map((finding) => finding.problem),
    ["NOT INSTALLED", "NOT INSTALLED"]);
});

test("#2901: `host:install` writes and enables the pair only when `messaging` is declared", () => {
  const install = (declaredKeys: Set<string>) => {
    const written: string[] = [];
    const calls: string[][] = [];
    hostUnitsInstall({
      declaredKeys, installedDir: "/installed",
      systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
      write: ((to: string) => { written.push(basename(String(to))); }) as never,
      mkdir: (() => undefined) as never,
      out: () => undefined,
    });
    return { written, enabled: calls.filter((call) => call[0] === "enable").map((call) => call[2]) };
  };
  const off = install(WITHOUT_MESSAGING);
  assert.ok(off.written.length >= 10, "POSITIVE CONTROL: the other units are written");
  assert.deepEqual([...off.written, ...off.enabled].filter(isChairmanWatch), []);
  const on = install(WITH_MESSAGING);
  assert.deepEqual(on.written.filter(isChairmanWatch), ["a11ign-chairman-watch.service", "a11ign-chairman-watch.timer"]);
  assert.deepEqual(on.enabled.filter(isChairmanWatch), ["a11ign-chairman-watch.timer"], "`enable --now` on the timer only");
});

test("#2901: an installed pair is an ORPHAN once the key is removed, so deleting the key is the off switch", () => {
  const installed = ["a11ign-chairman-watch.service", "a11ign-chairman-watch.timer", "a11ign-work-tick.timer"];
  const orphans = (declaredKeys: Set<string>) => orphanedUnits({
    declaredKeys, installedDir: "/installed", readDir: ((dir: string) => (dir === "/installed" ? installed : readdirSync(dir))) as never,
    git: (() => "") as never,
  }).map((finding) => finding.unit);
  assert.deepEqual(orphans(WITHOUT_MESSAGING), ["a11ign-chairman-watch.service", "a11ign-chairman-watch.timer"]);
  assert.deepEqual(orphans(WITH_MESSAGING), [], "CONTROL: declared, the same installed pair is the shipped one and not an orphan");
});

// --- #3025: THE LISTENER IS A SERVICE NO CLOCK STARTS, SO `host:install` ENABLES THE SERVICE AND `host:check` ASKS IT BOTH QUESTIONS ----------
//
// Every case runs on a TEMP HOME (a shipped directory, an installed directory) and a `systemctl` that REMEMBERS what it was told, so "started" is
// something the fake answers for afterwards and not a call count. The template here is a stand-in: the real one ships from `a11ign/agent-org`
// (#2907), and these tests must pass the day it is, and the day before.

const LISTENER = "a11ign-chairman-listen.service";
const LISTENER_TEMPLATE = "[Unit]\nDescription=stand-in listener\n[Service]\nType=simple\nExecStart=/bin/true\nRestart=on-failure\n[Install]\nWantedBy=default.target\n";
const PRUNE_TIMER = "a11ign-worktree-prune.timer";
const PRUNE_TIMER_TEMPLATE = "[Unit]\nDescription=stand-in timer\n[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n";

/** A `systemctl` that keeps what `enable`/`disable` did, and answers `is-enabled` and `is-active` from it the way the real one does (non-zero, word on stdout). */
function rememberingSystemctl() {
  const calls: string[][] = [];
  const enabled = new Set<string>();
  const active = new Set<string>();
  const run = (args: string[]) => {
    calls.push(args);
    const [verb, ...rest] = args;
    const unit = rest[rest.length - 1];
    const now = rest.includes("--now");
    if (verb === "enable") { enabled.add(unit); if (now) active.add(unit); return ""; }
    if (verb === "disable") { enabled.delete(unit); if (now) active.delete(unit); return ""; }
    if (verb !== "is-enabled" && verb !== "is-active") return "";
    const answers = (members: Set<string>, word: string) => Object.fromEntries([...members].map((member) => [member, word]));
    return systemctlStub({ "is-enabled": answers(enabled, "enabled"), "is-active": answers(active, "active") })(args);
  };
  return { run, calls, enabled, active };
}

function withListenerHome(body: (home: { shippedDir: string, installedDir: string, install: (keys: Set<string>) => string[],
  deps: (keys: Set<string>) => Record<string, unknown>, systemctl: ReturnType<typeof rememberingSystemctl> }) => void) {
  const root = mkdtempSync(join(tmpdir(), "host-units-3025-"));
  try {
    const shippedDir = join(root, "host");
    const installedDir = join(root, ".config/systemd/user");
    mkdirSync(shippedDir, { recursive: true });
    writeFileSync(join(shippedDir, "chairman-listen.service.in"), LISTENER_TEMPLATE);
    writeFileSync(join(shippedDir, "worktree-prune.timer.in"), PRUNE_TIMER_TEMPLATE);
    const systemctl = rememberingSystemctl();
    const deps = (declaredKeys: Set<string>) => ({ shippedDir, installedDir, declaredKeys, projectUnitsDir: null, systemctl: systemctl.run as never,
      git: (() => "") as never, out: () => undefined });
    body({ shippedDir, installedDir, systemctl, deps, install: (keys) => hostUnitsInstall(deps(keys) as never) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("#3025: the listener's template is classified as the tool's and optional on `messaging`, so it is never UNCLASSIFIED", () => {
  assert.ok(TOOL_ENTRIES.includes("chairman-listen.service.in"));
  assert.equal(OPTIONAL_UNITS["chairman-listen.service.in"], "messaging");
  assert.deepEqual(LONG_RUNNING_TEMPLATES, ["chairman-listen.service.in"]);
  withListenerHome(({ shippedDir }) => {
    assert.deepEqual(unclassifiedEntries({ shippedDir, projectUnitsDir: null }), []);
    writeFileSync(join(shippedDir, "stray-listener.service.in"), LISTENER_TEMPLATE);
    assert.deepEqual(unclassifiedEntries({ shippedDir, projectUnitsDir: null }).map((finding) => finding.unit), ["stray-listener.service.in"],
      "POSITIVE CONTROL: the same directory with a file nobody classified IS refused, so the empty list above is a classification and not a check that reads nothing");
  });
});

test("#3025: `host:install` with `messaging` writes the listener and runs `enable --now` on the SERVICE; without it, none of the three happens", () => {
  withListenerHome(({ installedDir, install, systemctl }) => {
    const absent = install(WITHOUT_MESSAGING);
    assert.deepEqual(absent, [PRUNE_TIMER], "POSITIVE CONTROL: the timer next to it IS installed, so the listener's absence is the key's doing");
    assert.equal(existsSync(join(installedDir, LISTENER)), false);
    assert.deepEqual(systemctl.calls.filter((call) => call.includes(LISTENER)), []);
    assert.deepEqual([...systemctl.enabled], [PRUNE_TIMER]);

    const present = install(WITH_MESSAGING);
    assert.deepEqual(present, [LISTENER, PRUNE_TIMER].sort());
    assert.equal(readFileSync(join(installedDir, LISTENER), "utf8"), LISTENER_TEMPLATE, "written as the template renders it");
    assert.ok(systemctl.calls.some((call) => call.join(" ") === `enable --now ${LISTENER}`), "`enable --now` on the SERVICE");
    assert.ok(systemctl.calls.filter((call) => call[0] === "enable").every((call) => call[1] === "--now"), "never a bare `enable`");
    assert.ok(systemctl.enabled.has(LISTENER) && systemctl.active.has(LISTENER), "and the fake systemd now says it is enabled and running");
  });
});

test("#3025: `host:check` reads an installed listener that is not enabled, or enabled and not running, as findings in their own words", () => {
  withListenerHome(({ shippedDir, installedDir, install, systemctl, deps }) => {
    const findings = (keys: Set<string>) => unitDrift(shippedUnits(shippedDir, { declaredKeys: keys, projectUnitsDir: null })
      .map((unit) => unitState(unit, deps(keys) as never))).filter((finding) => finding.unit === LISTENER);
    assert.deepEqual(findings(WITH_MESSAGING).map((finding) => finding.problem), ["NOT INSTALLED"]);
    assert.deepEqual(findings(WITHOUT_MESSAGING), [], "no key: not listed, so not missed");

    install(WITH_MESSAGING);
    assert.deepEqual(findings(WITH_MESSAGING), [], "POSITIVE CONTROL: installed, enabled --now and running is the healthy host, and says nothing");

    systemctl.enabled.delete(LISTENER);
    systemctl.active.delete(LISTENER);
    const [notEnabled] = findings(WITH_MESSAGING);
    assert.equal(notEnabled.problem, "LISTENER NOT ENABLED");
    assert.match(notEnabled.detail, /no clock starts this service/);

    systemctl.enabled.add(LISTENER);
    const [notRunning] = findings(WITH_MESSAGING);
    assert.equal(notRunning.problem, "LISTENER ENABLED BUT NOT RUNNING");
    assert.match(notRunning.detail, /journalctl --user -u a11ign-chairman-listen\.service/, "and it says where the reason is");
    assert.equal(existsSync(join(installedDir, LISTENER)), true);
  });
});

test("#3025: an installed listener is an ORPHAN once the key is removed, and the install removes it AND disables it", () => {
  withListenerHome(({ installedDir, install, systemctl, deps }) => {
    install(WITH_MESSAGING);
    assert.deepEqual(orphanedUnits(deps(WITH_MESSAGING) as never), [], "CONTROL: declared, the installed listener is the shipped one");
    assert.deepEqual(orphanedUnits(deps(WITHOUT_MESSAGING) as never).map((finding) => finding.unit), [LISTENER]);

    install(WITHOUT_MESSAGING);
    assert.equal(existsSync(join(installedDir, LISTENER)), false, "removed");
    assert.ok(systemctl.calls.some((call) => call.join(" ") === `disable --now ${LISTENER}`), "disabled and stopped, not left running on a deleted file");
    assert.equal(systemctl.enabled.has(LISTENER) || systemctl.active.has(LISTENER), false);
    assert.ok(systemctl.enabled.has(PRUNE_TIMER), "and the timer beside it is untouched");
  });
});

test("#2901: the rendered pair holds the properties every other shipped unit is held to, and no secret", () => {
  // The universal guards above read `shippedUnits()`, which does not include the pair while `messaging` is absent, so they are restated for it here.
  const service = shippedUnitText("a11ign-chairman-watch.service") ?? "";
  const timer = shippedUnitText("a11ign-chairman-watch.timer") ?? "";
  assert.notEqual(service, "", "the service renders");
  assert.equal(declaredCompileCache(service), "%h/.cache/node-compile-cache");
  assert.match(service, /^Environment=GH_CONFIG_DIR=\/home\/agent\/workers\/gh$/m, "the workers account, never the person's");
  assert.doesNotMatch(service, /^\[Install\]/m, "the timer starts it");
  assert.doesNotMatch(service + timer, /^(Environment|EnvironmentFile)=.*(TOKEN|SECRET|PASSWORD)/im, "no secret is passed in a unit; the program reads the file by reference");
  assert.doesNotMatch(timer, /^Requires=/m, "no install-time start: this unit messages a person");
  assert.match(timer, /^OnCalendar=/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^\[Install\]\s*$/m);
  assert.doesNotMatch(service + timer, /@@/, "every placeholder was rendered");
});

// --- #2971: a timer that ENDED ITSELF is expected-disabled, read from the window's own record -------------------------------------------

const WINDOW_TIMER = "a11ign-shadow-window.timer";
const STOP_ROW = '{"kind":"stop","cause":"cancelled-by-chairman-ruling","ticks":355,"at":"2026-10-02T06:52:12.000Z"}';
const TICK_ROW = '{"tickMs":1,"tick":"t","differences":[]}';
const MARKER_PATH = "/nowhere/shadow-window-open";
/** An installed directory that exists on no machine: the fixture serves the SHIPPED text for it, so the copy is current on a CI runner as on a host. */
const FAKE_INSTALLED_DIR = "/nowhere/installed";

/** The REAL shipped pair, with only the record and the marker faked: where the record lives is read off the rendered service, not typed here. */
const windowHost = ({ record, marker, enabled }: { record: string | null; marker: string | null; enabled: "enabled" | "disabled" }) => {
  const read = ((path: string) => {
    if (String(path).endsWith("diff-record.jsonl")) { if (record === null) throw new Error("ENOENT"); return record; }
    if (path === MARKER_PATH) { if (marker === null) throw new Error("ENOENT"); return marker; }
    if (String(path).startsWith(`${FAKE_INSTALLED_DIR}/`)) return shippedUnitText(basename(String(path))) ?? "";
    return readFileSync(path, "utf8");
  }) as never;
  return { read, markerPath: MARKER_PATH, installedDir: FAKE_INSTALLED_DIR, exists: (() => true) as never,
    systemctl: systemctlStub({ "is-enabled": { [WINDOW_TIMER]: enabled }, "is-active": { [WINDOW_TIMER]: "active" } }) };
};

const REARMED = '{"schema":1,"t0":"2026-10-02T09:00:00.000Z"}';
const STALE_MARKER = '{"schema":1,"t0":"2026-10-01T06:00:00.000Z"}';

test("#2971: the cross product -- (stop | no stop | stop then re-armed) x (enabled | disabled) -- and only the DISABLED, ENDED one is quiet", () => {
  const cases = [
    { name: "no stop row, disabled: today's finding, the positive control", record: TICK_ROW, marker: null, enabled: "disabled", problem: "NOT ENABLED" },
    { name: "no record at all, disabled", record: null, marker: null, enabled: "disabled", problem: "NOT ENABLED" },
    { name: "stop row, disabled", record: `${TICK_ROW}\n${STOP_ROW}\n`, marker: null, enabled: "disabled", problem: undefined },
    { name: "stop row, marker left over from the SAME window, disabled", record: `${STOP_ROW}\n`, marker: STALE_MARKER, enabled: "disabled", problem: undefined },
    { name: "stop row then a LATER marker, disabled", record: `${STOP_ROW}\n`, marker: REARMED, enabled: "disabled", problem: "NOT ENABLED" },
    { name: "no stop row, enabled", record: TICK_ROW, marker: null, enabled: "enabled", problem: undefined },
    { name: "stop row, enabled", record: `${STOP_ROW}\n`, marker: null, enabled: "enabled", problem: undefined },
    { name: "stop row then a LATER marker, enabled", record: `${STOP_ROW}\n`, marker: REARMED, enabled: "enabled", problem: undefined },
  ] as const;
  for (const c of cases) {
    const found = unitDrift([unitState(WINDOW_TIMER, windowHost(c))]).map((f) => f.problem);
    assert.deepEqual(found, c.problem === undefined ? [] : [c.problem], c.name);
  }
});

test("#2971: it is NAMED, not silent -- the ended window is a note with its cause, and a re-armed one is not", () => {
  const [note] = windowEndNotes(windowHost({ record: `${STOP_ROW}\n`, marker: null, enabled: "disabled" }));
  assert.equal(note.unit, WINDOW_TIMER);
  assert.equal(note.problem, "EXPECTED DISABLED -- ITS WINDOW ENDED");
  assert.match(note.detail, /cancelled-by-chairman-ruling, 355 ticks/);
  assert.deepEqual(windowEndNotes(windowHost({ record: `${STOP_ROW}\n`, marker: REARMED, enabled: "disabled" })), []);
  assert.deepEqual(windowEndNotes(windowHost({ record: `${STOP_ROW}\n`, marker: null, enabled: "enabled" })), [],
    "a timer that is enabled has nothing to explain");
});

// --- #3484: the installer declines the one timer whose window ended on purpose, exactly as the checker above excuses it ---------------

/** `hostUnitsInstall` over the REAL shipped directory, the window timer's state and record faked, every systemctl call kept and every line it printed. */
const installOver = (host: { record: string | null; marker: string | null; enabled: "enabled" | "disabled" }) => {
  const base = windowHost(host);
  const calls: string[][] = [];
  const lines: string[] = [];
  const systemctl = (args: string[]) => {
    calls.push(args);
    return ["is-enabled", "is-active"].includes(args[0]) ? base.systemctl(args) : "";
  };
  hostUnitsInstall({ ...base, systemctl: systemctl as never, declaredKeys: WITHOUT_MESSAGING, write: (() => undefined) as never,
    mkdir: (() => undefined) as never, out: (l: string) => { lines.push(l); } } as never);
  return { enables: calls.filter((c) => c[0] === "enable"), lines };
};
const enablesWindowTimer = (enables: string[][]) => enables.some((c) => c[2] === WINDOW_TIMER);

test("#3484: a disabled timer with a `stop` row gets NO enable and is SKIPPED with the cause; the same install without the row DOES enable it", () => {
  const ended = installOver({ record: `${TICK_ROW}\n${STOP_ROW}\n`, marker: null, enabled: "disabled" });
  assert.equal(enablesWindowTimer(ended.enables), false, "the ended window is not restarted");
  assert.ok(ended.lines.some((l) => l.startsWith(`SKIPPED ${WINDOW_TIMER} -- its window ended (cancelled-by-chairman-ruling, 355 ticks, 2026-10-02T06:52:12.000Z)`)), ended.lines.join(""));
  assert.ok(ended.enables.length > 0, "CONTROL: it skips ONE timer and still enables the others");
  const control = installOver({ record: TICK_ROW, marker: null, enabled: "disabled" });
  assert.equal(enablesWindowTimer(control.enables), true, "POSITIVE CONTROL: no stop row, the same timer is enabled --now");
  assert.ok(!control.lines.some((l) => l.startsWith("SKIPPED")), "and nothing is reported skipped");
  assert.equal(control.enables.length, ended.enables.length + 1, "the skip declines exactly one timer");
});

test("#3484: the other two cases are enabled as before -- no record at all (a deliberate stop), and a stop that a LATER marker superseded", () => {
  assert.equal(enablesWindowTimer(installOver({ record: null, marker: null, enabled: "disabled" }).enables), true, "no window record: not this installer's to decide, so enabled");
  assert.equal(enablesWindowTimer(installOver({ record: `${STOP_ROW}\n`, marker: REARMED, enabled: "disabled" }).enables), true, "re-armed after the stop: enabled");
  assert.equal(enablesWindowTimer(installOver({ record: `${STOP_ROW}\n`, marker: null, enabled: "enabled" }).enables), true,
    "an enabled timer keeps its idempotent enable --now, which is what restarts one that is enabled but dead (#1858)");
});

test("#3484: no enable the installer makes is bare, skip or not -- and the checker's note says what the installer does", () => {
  for (const enables of [installOver({ record: `${STOP_ROW}\n`, marker: null, enabled: "disabled" }).enables, installOver({ record: null, marker: null, enabled: "disabled" }).enables]) {
    for (const call of enables) assert.deepEqual(call.slice(0, 2), ["enable", "--now"], `bare enable in ${JSON.stringify(call)}`);
  }
  const [note] = windowEndNotes(windowHost({ record: `${STOP_ROW}\n`, marker: null, enabled: "disabled" }));
  assert.doesNotMatch(note.detail, /would restart it/, "the installer no longer restarts it");
  assert.match(note.detail, /`host:install` skips it/);
});

test("#2971: a record or marker that cannot be read keeps the finding -- could-not-tell is not ended", () => {
  const unparsable = windowHost({ record: `${STOP_ROW}\nnot json\n`, marker: null, enabled: "disabled" });
  assert.equal(windowEnd(WINDOW_TIMER, unparsable), null, "a record with a line nobody can parse is not read");
  const garbledMarker = windowHost({ record: `${STOP_ROW}\n`, marker: "{", enabled: "disabled" });
  assert.equal(windowEnd(WINDOW_TIMER, garbledMarker), null, "a marker with no readable T0 may be a re-arm, so the stop is not trusted");
  assert.deepEqual(unitDrift([unitState(WINDOW_TIMER, garbledMarker)]).map((f) => f.problem), ["NOT ENABLED"]);
});

test("#2971: no other timer is excused -- one that names no record reads NOT ENABLED whatever file exists, and the record is found, not named", () => {
  const ended = windowHost({ record: `${STOP_ROW}\n`, marker: null, enabled: "disabled" });
  const others = shippedUnits().filter((u: string) => u.endsWith(".timer") && u !== WINDOW_TIMER);
  assert.ok(others.length > 0, "CONTROL: there are other shipped timers to check");
  for (const unit of others) {
    assert.equal(windowEnd(unit, ended), null, `${unit} names no window record`);
    const disabled = { ...ended, systemctl: systemctlStub({ "is-enabled": { [unit]: "disabled" }, "is-active": { [unit]: "inactive" } }) };
    assert.deepEqual(unitDrift([unitState(unit, disabled)]).map((f) => f.problem), ["NOT ENABLED"], unit);
  }
  assert.match(shippedText(WINDOW_TIMER), /^Requires=\S*shadow-window\.service$/m, "the pair is what the reader walks");
  assert.match(shippedText("a11ign-shadow-window.service"), /--record=\S+diff-record\.jsonl/, "and the service is where the record is named");
});

// --- #3443: THE HOST RUNS ONE AGENT-ORG VERSION -- `toolVersion` pins it, and every unit that runs agent-org code runs the one tool checkout ---------------
// The tool checkout follows release TAGS (`update-tool.test.mjs` is that half). This half is the host's declaration of which one, and the units: the chairman
// listener and watcher ran `pnpm run messaging:*` from the PROJECT's checkout, which is the version its lockfile pins, so the host ran two versions at once.

const TOOL_3443 = "/srv/tools/agent-org";
const fixtureHostJson = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
const hostWith = (extra: Record<string, unknown>) => parseHostConfig(JSON.stringify({ ...fixtureHostJson(), ...extra }), "toolVersion test host.json");
const refusedField = (extra: Record<string, unknown>): string | undefined => {
  try {
    hostWith(extra);
  } catch (err) {
    assert.ok(err instanceof HostConfigRefusal, `a refusal, not a crash: ${String(err)}`);
    return err.field;
  }
  return undefined;
};

test("#3443 (5): `toolVersion` is `latest` or one release tag, every other value is refused BY NAME, and it rides with `tool`", () => {
  assert.equal(hostWith({ tool: TOOL_3443 }).toolVersion, "latest", "absent means latest");
  assert.equal(hostWith({ tool: TOOL_3443, toolVersion: "latest" }).toolVersion, "latest");
  assert.equal(hostWith({ tool: TOOL_3443, toolVersion: "v0.7.8" }).toolVersion, "v0.7.8", "a pin is read as written");
  assert.equal(hostWith({ tool: TOOL_3443, toolVersion: "v0.7.10" }).toolVersion, "v0.7.10");
  for (const bad of ["main", "0.7.8", "", "v0.7", "v0.7.8-rc1", "v01.2.3", "latest ", null, 7]) {
    assert.equal(refusedField({ tool: TOOL_3443, toolVersion: bad }), "toolVersion", `${JSON.stringify(bad)} must be refused naming the field`);
  }
  assert.equal(refusedField({ toolVersion: "v0.7.8" }), "toolVersion", "a pin on a host with no `tool` pins nothing, so it is refused rather than ignored");
  assert.equal(Object.hasOwn(hostWith({}), "toolVersion"), false, "and a host with no `tool` carries no `toolVersion` key, as it carries no `tool`");
});

/** The fixture host moved into tool form: the same machine, with the tool installed beside the project. */
const toolHost3443 = () => hostWith({ tool: TOOL_3443 });
const plainHost3443 = () => hostWith({});

test("#3443 (6): the chairman listener and watcher render `node <tool>/src/...` with AGENT_ORG_HOST in tool form, and today's bytes without a tool", () => {
  const units = readUnitsDeclaration();
  const checkout = PROJECT_ROOT;
  for (const [template, script, pnpmLine] of [
    ["chairman-listen.service.in", "src/messaging/listen.mjs", "ExecStart=%h/.local/bin/pnpm run messaging:listen"],
    ["chairman-watch.service.in", "src/messaging/watch.mjs", "ExecStart=%h/.local/bin/pnpm run messaging:watch"],
  ] as const) {
    const unit = renderedName(template, units.prefix);
    const plain = shippedUnitText(unit, { host: plainHost3443() }) ?? "";
    const todays = renderTemplate(readFileSync(join(SHIPPED_DIR, template), "utf8"), templateValues(plainHost3443(), units), unit);
    assert.equal(plain, todays, `${unit}: with no tool the unit is today's bytes, unchanged`);
    assert.ok(hasLine(plain, pnpmLine), `POSITIVE CONTROL: today's form runs ${pnpmLine}`);

    const installed = shippedUnitText(unit, { host: toolHost3443() }) ?? "";
    assert.ok(hasLine(installed, `ExecStart=/usr/bin/node ${script}`), `${unit} runs the tool's script: ${execCommands(installed).join(" | ")}`);
    assert.ok(hasLine(installed, `WorkingDirectory=${TOOL_3443}`), `${unit} runs from the tool checkout`);
    assert.ok(hasLine(installed, `Environment=AGENT_ORG_HOST=${checkout}/.agent-org/host.json`), `${unit} says where the host's declaration is`);
    assert.doesNotMatch(installed, /^ExecStart=.*pnpm/m, `${unit} no longer runs the project's pinned copy through pnpm`);
    assert.ok(existsSync(join(TOOL_ROOT, script)), `and the script it names exists in the tool: ${script}`);
  }
});

/** The wrapper a project's declared `beforeTick` is run in: its own checkout, since a unit cannot set a directory per line. The command after it is checked like any other. */
const IN_PROJECT_CHECKOUT = (command: string) => command.replace(/^\/usr\/bin\/env -C \S+ /, "");

test("#3443 + #3464: THE PROPERTY -- every shipped service in tool form runs agent-org code from the one tool checkout, and NOTHING is exempt", () => {
  const units = readUnitsDeclaration();
  const { beforeTick } = JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/project.json"), "utf8")) as { beforeTick: string };
  assert.equal(beforeTick, "agent-org primary:update", "POSITIVE CONTROL: the project declares a TOOL command, not `pnpm run`, so there is a beforeTick for the walk to reach");
  const templates = readdirSync(SHIPPED_DIR).filter((name: string) => name.endsWith(".service.in"));
  assert.ok(templates.includes("chairman-listen.service.in") && templates.includes("work-tick.service.in"), `POSITIVE CONTROL: the walk sees the services (${templates.join(", ")})`);
  for (const template of templates) {
    const unit = renderedName(template, units.prefix);
    const installed = shippedUnitText(unit, { host: toolHost3443() }) ?? "";
    assert.ok(hasLine(installed, `WorkingDirectory=${TOOL_3443}`), `${unit} runs from the tool checkout`);
    assert.ok(hasLine(installed, `Environment=AGENT_ORG_HOST=${PROJECT_ROOT}/.agent-org/host.json`), `${unit} resolves its project from the host's declaration`);
    for (const command of execCommands(installed).map(IN_PROJECT_CHECKOUT)) {
      assert.doesNotMatch(command, /\bpnpm\b|\bnpm\b|packages\/agent-org/, `${unit} runs ${command}, which is not the tool checkout's code`);
      const [program, ...args] = command.split(/\s+/);
      const script = args.find((arg) => !arg.startsWith("-"));
      assert.ok(program === "/usr/bin/node" || program === "/usr/bin/bash", `${unit}: ${command} is run by an interpreter this walk knows`);
      assert.ok(script !== undefined && existsSync(script.startsWith("/") ? script.replace(TOOL_3443, TOOL_ROOT) : join(TOOL_ROOT, script)),
        `${unit}: ${command} names a script of the tool that exists there`);
    }
  }
  const workTick = shippedUnitText(renderedName("work-tick.service.in", units.prefix), { host: toolHost3443() }) ?? "";
  assert.ok(hasLine(workTick, `ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} /usr/bin/node ${TOOL_3443}/src/update-primary.mjs`),
    "POSITIVE CONTROL: the project's beforeTick is rendered, and it is the tool's own update-primary");
});

test("#3464: a `beforeTick` naming a tool command runs it from the tool, one that does not is the project's own, and an unknown or foreign one REFUSES", () => {
  const rendered = renderTemplate(readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8"), templateValues(plainHost3443(), readUnitsDeclaration()), "work-tick");
  const pre = (command: string) => workTickToolForm(rendered, TOOL_3443, [{ checkout: PROJECT_ROOT, command }]).split("\n").filter((line) => line.startsWith("ExecStartPre=")).slice(1);
  assert.deepEqual(pre("agent-org primary:update"), [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} /usr/bin/node ${TOOL_3443}/src/update-primary.mjs`]);
  assert.deepEqual(pre("agent-org primary:update --drift"), [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} /usr/bin/node ${TOOL_3443}/src/update-primary.mjs --drift`], "arguments follow");
  assert.deepEqual(pre("agent-org host:install"), [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} /usr/bin/node ${TOOL_3443}/src/host-units.mjs --install`], "the table's own fixed arguments come first, as in bin.mjs");
  assert.deepEqual(pre("npm run widgets:update"), [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} npm run widgets:update`], "a command of the project's own is run as written");
  assert.throws(() => pre("agent-org no:such-command"), HostConfigRefusal, "an unknown tool command refuses");
  assert.throws(() => pre("agent-org"), HostConfigRefusal, "and so does a bare `agent-org`");
});

test("#3464: a tool command is the same command however its words are separated -- a tab or a run of spaces is accepted by parseBeforeTick, so it must not fall back to the project's pinned copy", () => {
  const rendered = renderTemplate(readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8"), templateValues(plainHost3443(), readUnitsDeclaration()), "work-tick");
  const pre = (command: string) => workTickToolForm(rendered, TOOL_3443, [{ checkout: PROJECT_ROOT, command }]).split("\n").filter((line) => line.startsWith("ExecStartPre=")).slice(1);
  const viaTool = [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} /usr/bin/node ${TOOL_3443}/src/update-primary.mjs`];
  for (const spelling of ["agent-org\tprimary:update", "agent-org  primary:update", "agent-org \t primary:update"]) {
    const declared = JSON.stringify({ schema: 1, beforeTick: spelling });
    assert.equal(parseBeforeTick(declared), spelling, `POSITIVE CONTROL: parseBeforeTick ACCEPTS ${JSON.stringify(spelling)}, so the rendering below is what decides`);
    assert.deepEqual(pre(spelling), viaTool, `${JSON.stringify(spelling)} runs from the tool`);
  }
  assert.deepEqual(pre("agent-org  primary:update   --drift"), [`${viaTool[0]} --drift`], "arguments are split the same way, and joined by one space");
  assert.throws(() => pre("agent-org\tno:such-command"), HostConfigRefusal, "an unknown tool command refuses however it is spelt");
  assert.deepEqual(pre("npm\trun widgets:update"), [`ExecStartPre=-/usr/bin/env -C ${PROJECT_ROOT} npm\trun widgets:update`], "a project's own command is still run as written");
});

// a11ign/a11ign#3627: here and not in trace-weekly-post.test.ts, which must not import this module (that would charge it `History: full`, work-gate.test.ts #2174).
test("#3627: installed as the tool, the weekly report's service runs the script from the tool and is told where the project's declaration is", () => {
  const rendered = readFileSync(join(SHIPPED_DIR, "trace-weekly.service.in"), "utf8")
    .replaceAll("@@checkout@@", "/p").replaceAll("@@binDir@@", "/b").replaceAll("@@home@@", "/h").replaceAll("@@workersDir@@", "/w");
  const installed = toolForm("trace-weekly.service.in", rendered, { tool: "/tool", checkout: "/project", beforeTicks: [] });
  assert.match(installed, /^WorkingDirectory=\/tool$/m);
  assert.match(installed, /^Environment=AGENT_ORG_PROJECT=\/project\/\.agent-org\/project\.json$/m);
  assert.match(installed, /^ExecStart=\/usr\/bin\/bash host\/trace-weekly-post\.sh$/m);
});

test("#3515: installed as the tool, the trace pages' service runs publish.mjs from the tool and is told where the host's declaration is", () => {
  const rendered = readFileSync(join(SHIPPED_DIR, "trace-publish.service.in"), "utf8")
    .replaceAll("@@checkout@@", "/p").replaceAll("@@binDir@@", "/b").replaceAll("@@home@@", "/h").replaceAll("@@workersDir@@", "/w");
  assert.match(rendered, /^ExecStart=\/usr\/bin\/node packages\/agent-org\/src\/trace\/publish\.mjs$/m, "POSITIVE CONTROL: the shipped form is the one the tool form rewrites");
  const installed = toolForm("trace-publish.service.in", rendered, { tool: "/tool", checkout: "/project", beforeTicks: [] });
  assert.match(installed, /^WorkingDirectory=\/tool$/m);
  assert.match(installed, /^Environment=AGENT_ORG_HOST=\/project\/\.agent-org\/host\.json$/m);
  assert.match(installed, /^ExecStart=\/usr\/bin\/node src\/trace\/publish\.mjs$/m);
  assert.match(installed, /^Environment=GH_CONFIG_DIR=\/w\/gh$/m, "it spends the workers account, never the person's");
});

// --- #3702: A CLONE `host.json` DECLARES MUST BE ONE THE REVIEWER'S CODEX TRUSTS -----------------------------------------------------------
//
// `toolchain`'s clone was declared by #3578 and `~/.codex/config.toml` had no entry for it, so `reviewer-toolchain-1` was refused at startup
// on 30 consecutive ticks and a pull request had no reviewer. Nothing said a new clone needs the entry; `host:check` now does, and writes nothing.

const cloneHost = (clones: Record<string, string> | undefined) => ({ ...homeHostConfig(), home: "/h", ...(clones === undefined ? {} : { clones }) } as never);
const CLONES = { "agent-org": "/r/agent-org", toolchain: "/r/toolchain" };

test("#3702: a declared clone with no trusted table is a finding naming the clone, and the remedy edits nothing", () => {
  const host = cloneHost(CLONES);
  const readCodexConfig = () => trustingEvery(["/r/agent-org", "/r/other"]);
  const [f, ...rest] = codexTrustDrift({ host, readCodexConfig });
  assert.deepEqual(rest, [], "only the clone without an entry");
  assert.equal(f?.unit, "/r/toolchain");
  assert.equal(f.problem, "CLONE NOT TRUSTED BY CODEX");
  assert.equal(f.manualFix, true, "the grant is a ruling, so `host:install` is not offered as the fix");
  assert.match(f.detail, /\[projects\."\/r\/toolchain"\]/, "it names the exact table to add");
  assert.match(f.detail, /edits nothing/);
  // CONTROL (the other direction): once the table is there, the finding stops.
  assert.deepEqual(codexTrustDrift({ host, readCodexConfig: () => trustingEvery(["/r/agent-org", "/r/toolchain"]) }), []);
});

test("#3702: `trust_level` counts only inside the clone's own table, and only when it is \"trusted\"", () => {
  const host = cloneHost({ toolchain: "/r/toolchain" });
  const drift = (text: string) => codexTrustDrift({ host, readCodexConfig: () => text }).length;
  assert.equal(drift('[projects."/r/toolchain"]\ntrust_level = "untrusted"\n'), 1, "a table that says untrusted is not trust");
  assert.equal(drift('[projects."/r/toolchain"]\nother = 1\n[projects."/r/else"]\ntrust_level = "trusted"\n'), 1, "a neighbour's line is not this clone's");
  assert.equal(drift('[projects."/r/toolchain/sub"]\ntrust_level = "trusted"\n'), 1, "a child path is not the clone: nothing wider");
  assert.equal(drift('trust_level = "trusted"\n[projects."/r/toolchain"]\n'), 1, "a line above the table is not inside it");
  assert.equal(drift("[projects.'/r/toolchain']  # added by hand\ntrust_level = 'trusted' # ruled\n"), 0, "single quotes and trailing comments are TOML too");
  assert.deepEqual([...codexTrustedProjects(trustingEvery(["/a", "/b"]))], ["/a", "/b"]);
});

test("#3702: an absent or unreadable config says which, and no `clones` means nothing to check", () => {
  const host = cloneHost({ toolchain: "/r/toolchain" });
  const refuse = (code: string) => () => { throw Object.assign(new Error("boom"), { code }); };
  const [absent] = codexTrustDrift({ host, readCodexConfig: refuse("ENOENT") });
  assert.match(absent?.detail ?? "", /it does not exist/, "absent is a finding, not 'trusts everything'");
  const [unreadable] = codexTrustDrift({ host, readCodexConfig: refuse("EACCES") });
  assert.match(unreadable?.detail ?? "", /could not be read \(boom\)/, "unreadable is a finding that says it does not know");
  assert.deepEqual(codexTrustDrift({ host: cloneHost(undefined), readCodexConfig: refuse("ENOENT") }), [], "no clones declared: nothing to trust");
});

test("#3702: `host:check` REPORTS an untrusted clone -- the check is wired in", () => {
  // THE MUTANT: dropping `...codexTrustDrift(deps)` from `hostUnitDrift` leaves every direct call above green. The fixture host declares
  // no clones, so this one DECLARES them: a population of zero would make both assertions pass whether or not the check is wired.
  const clean = hostWithOneUnit("");
  const host = { ...homeHostConfig(), clones: CLONES } as never;
  const flagged = (readCodexConfig: () => string) => hostUnitDrift({ ...clean, host, readCodexConfig }).filter((d) => d.problem === "CLONE NOT TRUSTED BY CODEX");
  assert.deepEqual(flagged(() => trustingEvery(Object.values(CLONES))), [], "CONTROL: every declared clone trusted reads clean");
  assert.deepEqual(flagged(() => "").map((d) => d.unit).sort(), Object.values(CLONES).sort(), "a config trusting nothing flags every declared clone");
});
