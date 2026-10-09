// no-token: none -- herdr is an injected `run` (or a stub on PATH for the one process-level case) and the roster is a fixture file, so nothing here reaches gh
/**
 * #3539: A SEAT THE ROUTING NAMES MUST BE RUNNING. `host:check` fails on an absent persistent seat, and a tick step starts it.
 *
 * On 2026-10-04 the routing sent the chairman's messages to `liaison` the moment its roster entry existed, and nothing had started a process
 * for it: his message was refused. `ceo` started it by hand. These are the two halves that make that impossible to repeat -- the check that
 * names an absent seat, and the step that starts one -- and the tie between the routing's recipient and the roster.
 *
 * THE POSITIVE CONTROL FOR EVERY "NOTHING NAMED / NO WRITE" ASSERTION IS THE ABSENT CASE, which names the seat and writes. The control against
 * over-reading is the non-persistent role absent from the same listing, which is named by nothing and started by nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { absentSeats } from "../herdr-agents.ts";
import { persistentRoles, roleBriefPath } from "../project-roles.ts";
import { startAbsentSeats, SEAT_START_FLAGS, seatFirstPrompt } from "../wake.ts";
import { persistentSeatDrift, persistentSeatNotes, driftReport } from "../host-units.ts";
import { RECIPIENT } from "../messaging/converse.mjs";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

const scratch = tmpDirForFile("seat-3539-");

const BRIEF = ".agent-org/roles/liaison.md";
const CHECKOUT = "/srv/project-checkout";

/** A roster with one persistent seat and the non-persistent roles that must NOT be read as seats. */
function rosterFile(name: string, live: object[]): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({ live }));
  return path;
}
const ROSTER = rosterFile("sessions.json", [
  { name: "ceo", role: "ceo" },
  { name: "orchestrator", role: "orchestrator" },
  { name: "liaison", role: "liaison", persistent: true, brief: BRIEF },
  { name: "worker-capture", role: "engineer" },
  { name: "reviewer-3539", role: "reviewer" },
]);

const STANDING: [string, string][] = [["ceo", "idle"], ["orchestrator", "idle"]];

/** A herdr that remembers: `workspace list` answers what was created, so the read-back is a real one. */
function fakeHerdr(labels: [string, string][], { refuseStart = false } = {}) {
  const calls: string[][] = [];
  const live = new Map(labels);
  const opened = new Map<string, string>();
  const run = (args: string[]): string => {
    calls.push(args);
    const [group, verb] = [args[2], args[3]];
    if (group === "workspace" && verb === "list") {
      return JSON.stringify({ result: { workspaces: [...live].map(([label, agent_status]) => ({ label, agent_status })) } });
    }
    if (group === "workspace" && verb === "create") {
      const label = args[args.indexOf("--label") + 1];
      const id = `w${opened.size + 100}`;
      opened.set(id, label);
      live.set(label, "unknown");
      return JSON.stringify({ result: { workspace: { workspace_id: id }, root_pane: { pane_id: `${id}:p1` } } });
    }
    if (group === "workspace" && verb === "close") {
      live.delete(opened.get(args[4]) ?? "");
      return "{}";
    }
    if (group === "agent" && verb === "start") {
      if (refuseStart) throw new Error("herdr: refused to start");
      live.set(args[4], "idle");
      return "{}";
    }
    throw new Error(`unexpected herdr call ${args.join(" ")}`);
  };
  const writes = () => calls.filter((c) => !(c[2] === "workspace" && c[3] === "list"));
  const of = (group: string, verb: string) => calls.filter((c) => c[2] === group && c[3] === verb);
  return { run, calls, writes, of };
}

const start = (run: (args: string[]) => string, sessionsPath: string | URL = ROSTER) =>
  startAbsentSeats({ run, env: {}, checkout: CHECKOUT, sessionsPath });

// --- done-when 1: absent is named ---------------------------------------------------------------------------------------------------------------

test("1: an absent persistent seat is named, and a non-persistent absent role is not", () => {
  const seats = persistentRoles(ROSTER);
  assert.deepEqual(seats, ["liaison"], "the fixture roster marks exactly one seat persistent");
  // the listing lacks `liaison` AND `worker-capture` / `reviewer-3539`; only the persistent one may be named
  assert.deepEqual(absentSeats(seats, STANDING.map(([label]) => ({ label }))), ["liaison"]);
});

test("1: a seat is present in EVERY status herdr reports, and none of them is named", () => {
  for (const status of ["idle", "working", "blocked", "unknown", "done"]) {
    assert.deepEqual(absentSeats(["liaison"], [{ label: "liaison", status }, ...STANDING.map(([label]) => ({ label }))]), [], status);
  }
});

test("1: the non-persistent roles are never named, however absent", () => {
  const everyRole = ["ceo", "orchestrator", "liaison", "worker-capture", "reviewer-3539"];
  const named = absentSeats(persistentRoles(ROSTER), []);
  assert.deepEqual(named, ["liaison"], "the control: with an empty listing the one persistent seat IS named");
  assert.ok(everyRole.filter((r) => r !== "liaison").every((r) => !named.includes(r)));
});

// --- done-when 2: host:check ----------------------------------------------------------------------------------------------------------------

test("2: the finding names the seat, the report carries the line, and a present seat produces neither", () => {
  const absent = persistentSeatDrift({ seats: ["liaison"], agents: [] });
  assert.equal(absent.length, 1, "the control: an absent seat IS a finding");
  assert.match(driftReport(absent), /seat liaison: PERSISTENT SEAT NOT RUNNING/);
  assert.match(driftReport(absent), /NOT fixed by the remedy below -- it is a process/, "host:install starts no seat, and the report says so");
  const present = persistentSeatDrift({ seats: ["liaison"], agents: [{ label: "liaison", status: "blocked" }] });
  assert.deepEqual(present, []);
});

test("2: an unreadable roster or an unreadable herdr is UNKNOWN by name, never clean", () => {
  const noHerdr = persistentSeatNotes({ seats: ["liaison"], agents: null });
  assert.match(noHerdr[0].detail, /herdr's workspace listing could not be read/);
  const noRoster = persistentSeatNotes({ seats: null, agents: [] });
  assert.match(noRoster[0].detail, /the roster \(sessions\.json\) could not be read/);
  assert.deepEqual(persistentSeatDrift({ seats: null, agents: [] }), [], "an unknown is not a finding to wake anyone for");
  assert.deepEqual(persistentSeatNotes({ seats: ["liaison"], agents: [] }), [], "the control: when both read, there is nothing to note");
});

const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/host-units/", import.meta.url));

/**
 * A project and a machine for `host:check` to read. The project is `host-units.test.ts`'s fixture (its units, scripts and declaration, with the roles directory declared, and the tool linked at
 * `packages/agent-org`) PLUS the roster this file is about, built here and not imported from `host-units-project.ts`, which sets `$AGENT_ORG_HOST` for the whole
 * file and would point the routing test at a project with no roster. The machine is a temp HOME, a `host.json` (the declared one names this host's own paths, which a
 * runner does not have), a `systemctl` that answers (so the check does not depend on a user manager), and a `herdr` whose `workspace list` answers `labels` -- or
 * fails every call when `broken`.
 */
function seatHost(labels: string[], broken = false) {
  const root = tmpDir("project-", scratch);
  const declaration = join(root, ".agent-org");
  mkdirSync(join(declaration, "roles"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "units"), join(declaration, "units"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "package.json"), join(root, "package.json"));
  writeFileSync(join(declaration, "project.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURE_DIR, "project.json"), "utf8")), roles: { dir: ".agent-org/roles" } }));
  cpSync(ROSTER, join(declaration, "roles/sessions.json"));
  mkdirSync(join(root, "packages"));
  symlinkSync(TOOL_ROOT, join(root, "packages/agent-org"), "dir");
  const home = tmpDir("home-", scratch);
  const bin = join(home, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\ncase "$*" in *is-enabled*) echo enabled;; *is-active*) echo active;; *) echo LANG=C;; esac\n', { mode: 0o755 });
  const body = JSON.stringify({ result: { workspaces: labels.map((label) => ({ label, agent_status: "idle" })), agents: [] } });
  writeFileSync(join(bin, "herdr"), broken ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho '${body}'\n`);
  chmodSync(join(bin, "herdr"), 0o755);
  const hostFile = join(declaration, "host.json");
  writeFileSync(hostFile, readFileSync(join(FIXTURE_DIR, "host.json"), "utf8").replace("@@PROJECT@@", root)
    .replace('"/home/agent"', JSON.stringify(home)).replace('"/home/agent/.local/bin"', JSON.stringify(join(home, ".local/bin"))));
  return { PATH: `${bin}:${process.env.PATH}`, HOME: home, AGENT_ORG_HOST: hostFile };
}
function hostCheck(env: ReturnType<typeof seatHost>, ...flags: string[]) {
  const done = spawnSync(process.execPath, [join(TOOL_ROOT, "src/host-units.ts"), ...flags], { encoding: "utf8", env });
  assert.notEqual(done.stdout, "", `host-units.ts ${flags.join(" ")} wrote nothing (exit ${done.status}); stderr: ${done.stderr}`);
  return done;
}

test("2: `host:check` ITSELF fails with a line naming the absent seat, and shows none when every seat is present", () => {
  const absent = hostCheck(seatHost(["ceo", "orchestrator"]));
  assert.match(absent.stdout, /seat liaison: PERSISTENT SEAT NOT RUNNING/, absent.stderr);
  assert.equal(absent.status, 1, "the check's failing exit");
  const present = hostCheck(seatHost(["ceo", "orchestrator", "liaison"]));
  assert.doesNotMatch(present.stdout, /seat liaison/);
  const findings = JSON.parse(hostCheck(seatHost(["ceo", "orchestrator", "liaison"]), "--json").stdout).findings;
  assert.ok(!findings.some((f: { unit: string }) => f.unit === "seat liaison"));
  const unknown = hostCheck(seatHost([], true));
  assert.match(unknown.stdout, /persistent seats: UNKNOWN/);
  assert.doesNotMatch(unknown.stdout, /seat liaison: PERSISTENT SEAT NOT RUNNING/, "an unreadable herdr is not an absent seat");
});

// --- done-when 3: the tick starts it, once ------------------------------------------------------------------------------------------------

test("3: an absent seat gets exactly one workspace create and one agent start, with the label, the checkout and the brief", () => {
  const herdr = fakeHerdr(STANDING);
  const lines = start(herdr.run);
  assert.equal(herdr.of("workspace", "create").length, 1);
  assert.equal(herdr.of("agent", "start").length, 1);
  const create = herdr.of("workspace", "create")[0];
  assert.equal(create[create.indexOf("--label") + 1], "liaison");
  assert.equal(create[create.indexOf("--cwd") + 1], CHECKOUT);
  const startCall = herdr.of("agent", "start")[0];
  assert.equal(startCall[4], "liaison");
  assert.deepEqual(startCall.slice(startCall.indexOf("--") + 1), [seatFirstPrompt("liaison", BRIEF), ...SEAT_START_FLAGS]);
  assert.ok(seatFirstPrompt("liaison", BRIEF).includes(BRIEF));
  assert.match(lines.join("\n"), /SEAT STARTED liaison .* herdr lists it/, "read back: the seat is listed");
  assert.deepEqual(start(herdr.run), [], "the next tick finds it present and says nothing");
});

test("3: a present seat gets no write at all, in ANY status", () => {
  for (const status of ["idle", "working", "blocked", "unknown", "done"]) {
    const herdr = fakeHerdr([...STANDING, ["liaison", status]]);
    assert.deepEqual(start(herdr.run), [], status);
    assert.deepEqual(herdr.writes(), [], `${status}: no create, no start, no prompt, no clear`);
  }
});

test("3: a start herdr refuses is a line that repeats next tick, and the workspace it opened is closed", () => {
  const herdr = fakeHerdr(STANDING, { refuseStart: true });
  const first = start(herdr.run);
  assert.match(first.join("\n"), /SEAT NOT STARTED liaison: herdr refused to start it/);
  assert.equal(herdr.of("workspace", "close").length, 1, "nothing half-open: the workspace created and not started is closed");
  assert.deepEqual(herdr.of("agent", "start").length, 1);
  const second = start(herdr.run);
  assert.match(second.join("\n"), /SEAT NOT STARTED liaison/, "the line repeats, which is what lets the gate offer it");
  assert.equal(herdr.of("workspace", "create").length, 2, "and the next tick tries once more, never two at once");
});

test("3: nothing is started when the tick cannot tell", () => {
  const partial = fakeHerdr([["worker-capture", "working"]]);
  assert.match(start(partial.run).join("\n"), /SEATS NOT STARTED: liaison .* may be partial/);
  assert.deepEqual(partial.writes(), [], "a listing without the standing panes may be partial: a start could be a second seat");
  const dead = (): string => { throw new Error("herdr down"); };
  assert.match(start(dead).join("\n"), /SEATS NOT CHECKED: herdr could not be asked/);
  const rosterless = fakeHerdr(STANDING);
  assert.match(start(rosterless.run, join(scratch, "no-such-roster.json")).join("\n"), /SEATS NOT CHECKED: the roster could not be read/);
  assert.deepEqual(rosterless.writes(), []);
});

test("3: a non-persistent role absent from the listing is never started", () => {
  const herdr = fakeHerdr([...STANDING, ["liaison", "idle"]]);
  start(herdr.run);
  assert.deepEqual(herdr.writes(), [], "worker-capture and reviewer-3539 are absent from this listing and are no seat's business");
});

test("3: a seat that appears between the two readings is present, and nothing is written", () => {
  const herdr = fakeHerdr(STANDING);
  let lists = 0;
  const appears = (args: string[]): string => {
    if (args[2] === "workspace" && args[3] === "list" && ++lists === 2) herdr.run(["--session", "org", "workspace", "create", "--label", "liaison"]);
    return herdr.run(args);
  };
  const lines = start(appears);
  assert.match(lines.join("\n"), /SEAT NOT STARTED liaison: herdr lists it on a second reading/);
  assert.equal(herdr.of("agent", "start").length, 0, "the seat that appeared is not given a second agent");
  const unconfirmed = fakeHerdr(STANDING);
  let reads = 0;
  const failsSecond = (args: string[]): string => { if (args[2] === "workspace" && args[3] === "list" && ++reads === 2) throw new Error("herdr down"); return unconfirmed.run(args); };
  assert.match(start(failsSecond).join("\n"), /could not be confirmed at the moment of the start/);
  assert.deepEqual(unconfirmed.writes(), [], "the control: with no second reading there is no write");
});

// --- done-when 4: one named constant, ceo's values ------------------------------------------------------------------------------------------

test("4: the start flags are ceo's hand-start values, in one constant", () => {
  assert.deepEqual([...SEAT_START_FLAGS], ["--model", "sonnet", "--effort", "medium", "--dangerously-skip-permissions",
    "--disallowedTools", "AskUserQuestion"]);
});

// --- done-when 5: the routing names only seats that are checked --------------------------------------------------------------------------

/** Does the roster mark `recipient` persistent: the tie between the messaging code and the seats the check covers. */
const routesToACheckedSeat = (recipient: string, roster: string): boolean => persistentRoles(roster).includes(recipient);

test("5: the messaging recipient names a roster entry marked persistent", () => {
  assert.ok(routesToACheckedSeat(RECIPIENT, roleBriefPath("sessions.json").absolute), `${RECIPIENT} must be a persistent seat in the roster, or the routing can go live before its seat exists`);
});

test("5: the tie fails when the recipient is not persistent (the control)", () => {
  const demoted = rosterFile("demoted.json", [{ name: "liaison", role: "liaison", brief: BRIEF }]);
  assert.equal(routesToACheckedSeat(RECIPIENT, demoted), false);
  assert.equal(routesToACheckedSeat("nobody", ROSTER), false);
});
