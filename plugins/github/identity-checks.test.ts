// no-token: none -- the wrapper is rendered and read from a recorded `readFile`, the minter is a recorded `exec`, and nothing reaches `gh` or the network
//
// THE GITHUB PLUGIN'S IDENTITY ROWS FOR DOCTOR (A11-160), moved from `install/doctor.test.ts` (A11-84's divergence and mint cases, with their words) and grown by the two the plan adds: `wrapper roles`, and
// the rows on a ticket-only host, where they were "not applicable" and a declared App was never asked to mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HostPlaceReading, PluginDeps } from "../../src/plugins/manifest.ts";
import type { WrapperInputs } from "../../src/plugins/contracts/code-host.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { wrapperChecks } from "./identity-checks.ts";
import { createWrapper, inputsOfSettings } from "./wrapper.ts";

const PLACE = { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name: string) => `/opt/state/${name}` };
const APP = (role: string) => ({ mode: "github-apps", appId: `id-${role}`, keyPath: `/opt/keys/${role}.pem` });
const settingsOf = (...roles: string[]) => ({ gh: { workers: "/opt/workers", leads: "/opt/leads" }, identity: Object.fromEntries(roles.map((role) => [role, APP(role)])) });
const INSTALLED = "/opt/host/bin/gh";

/** The wrapper the plugin renders for the settings, as the file an installer would have written. */
const renderedFor = (...roles: string[]): string => createWrapper({ exec: () => ({ status: null, stdout: "", stderr: "" }), readFile: (path) => readFileSync(path, "utf8"), env: {} })
  .file(inputsOfSettings(settingsOf(...roles), PLACE) as WrapperInputs).expected as string;

/** Deps whose disk holds the template and, at the installed path, `installed` (a file that is not there when `null`); the minter answers `mint`. */
function deps(place: HostPlaceReading, installed: string | null, mint: (role: string) => { status: number | null; stdout: string; stderr: string } = () => ({ status: 0, stdout: "ghs_token\n", stderr: "" })): PluginDeps {
  return fakePluginDeps({
    place: async () => place,
    readFile: (path) => {
      if (path === INSTALLED) { if (installed === null) throw new Error(`ENOENT: ${path}`); return installed; }
      return readFileSync(path, "utf8");
    },
    exec: (_file, args) => mint(args[1] ?? ""),
  });
}
const PLACED: HostPlaceReading = { kind: "place", place: PLACE };
const byName = async (...args: Parameters<typeof wrapperChecks>) => Object.fromEntries((await wrapperChecks(...args)).map((check) => [check.name, check]));

test("a wrapper that is the one the host declares passes, with one row per declared role that mints", async () => {
  const rows = await wrapperChecks(settingsOf("scheduler", "workers"), deps(PLACED, renderedFor("scheduler", "workers")));
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["gh wrapper", true], ["wrapper roles", true], ["app token scheduler", true], ["app token workers", true]]);
  assert.equal(rows[0].detail, "the installed wrapper is the one host.json declares");
  assert.equal(rows[1].detail, "the installed wrapper routes scheduler, workers to an App, as host.json declares");
  assert.equal(rows[2].detail, "the scheduler App mints a token");
});

test("a host with no App declares no role, and its wrapper routes none: two passing rows and no mint", async () => {
  const rows = await wrapperChecks(settingsOf(), deps(PLACED, renderedFor()));
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["gh wrapper", true], ["wrapper roles", true]]);
  assert.equal(rows[1].detail, "the installed wrapper routes no role to an App, as host.json declares");
});

test("doctor fails a gh wrapper that diverges from the declaration, naming the fix, and still passes each role that mints", async () => {
  const rows = await byName(settingsOf("scheduler"), deps(PLACED, renderedFor()));
  assert.equal(rows["gh wrapper"].ok, false);
  assert.equal(rows["gh wrapper"].detail, `${INSTALLED} names no App role, but host.json declares scheduler, so no App token is minted for any of them`);
  assert.match(rows["gh wrapper"].fix ?? "", /agent-org host:install/);
  assert.equal(rows["app token scheduler"].ok, true, "a role that mints is a pass, whatever the wrapper says");
});

test("the wrapper roles row names the roles the installed wrapper routes and the roles the host declares, when they differ", async () => {
  const rows = await byName(settingsOf("scheduler", "workers"), deps(PLACED, renderedFor("scheduler")));
  assert.deepEqual([rows["wrapper roles"].ok, rows["wrapper roles"].detail], [false, "the installed wrapper routes scheduler to an App, and host.json declares scheduler, workers"]);
  assert.match(rows["wrapper roles"].fix ?? "", /agent-org host:install/);
  const dropped = await byName(settingsOf(), deps(PLACED, renderedFor("workers")));
  assert.equal(dropped["wrapper roles"].detail, "the installed wrapper routes workers to an App, and host.json declares no role");
});

test("doctor fails a role whose token mint fails, and says the reason the minter printed", async () => {
  const rows = await byName(settingsOf("reviewer"), deps(PLACED, renderedFor("reviewer"), () => ({ status: 2, stdout: "", stderr: "could not read the key /opt/keys/reviewer.pem (exit 2)\nsecond line" })));
  assert.equal(rows["gh wrapper"].ok, true);
  assert.deepEqual([rows["app token reviewer"].ok, rows["app token reviewer"].detail], [false, "the reviewer App's token mint failed: could not read the key /opt/keys/reviewer.pem (exit 2)"]);
  assert.match(rows["app token reviewer"].fix ?? "", /host:install/);
});

test("with no wrapper installed the gh wrapper row says where it is not, and a declared role has nothing routing it", async () => {
  const none = await byName(settingsOf(), deps(PLACED, null));
  assert.deepEqual([none["gh wrapper"].ok, none["gh wrapper"].detail], [false, `there is no gh wrapper at ${INSTALLED}`]);
  assert.deepEqual([none["wrapper roles"].ok, none["wrapper roles"].detail], [true, "no role is declared as an App, and no wrapper is installed"]);
  const declared = await byName(settingsOf("workers"), deps(PLACED, null));
  assert.deepEqual([declared["wrapper roles"].ok, declared["wrapper roles"].detail], [false, "host.json declares workers as Apps, and no wrapper is installed to route them"]);
});

test("a ticket-only host installs no wrapper, and its declared Apps are still asked to mint", async () => {
  const rows = await wrapperChecks(settingsOf("reviewer"), deps({ kind: "no-project" }, null));
  assert.deepEqual(rows.map(({ name, ok, detail }) => [name, ok, detail]), [
    ["gh wrapper", true, "not applicable: host.json declares no project, so this machine installs no wrapper"],
    ["app token reviewer", true, "the reviewer App mints a token"],
  ]);
  const failing = await wrapperChecks(settingsOf("reviewer"), deps({ kind: "no-project" }, null, () => ({ status: 2, stdout: "", stderr: "app token: token: POST answered 401" })));
  assert.deepEqual([failing[1].ok, failing[1].detail], [false, "the reviewer App's token mint failed: app token: token: POST answered 401"]);
  assert.equal((await wrapperChecks(settingsOf(), deps({ kind: "no-project" }, null))).length, 1, "a ticket-only host that declares no App has only the one row, as it always had");
});

test("a caller that runs no machine probes gets no wrapper rows", async () => {
  assert.deepEqual(await wrapperChecks(settingsOf("reviewer"), deps({ kind: "skipped" }, null)), []);
});

test("a host the reader refused is a wrapper that could not be checked, and never a pass", async () => {
  const rows = await wrapperChecks(settingsOf("workers"), deps({ kind: "unreadable", reason: "field `primary` REFUSED: it is missing" }, null));
  assert.deepEqual(rows.map(({ name, ok, detail }) => [name, ok, detail]), [["gh wrapper", false, "cannot be checked: field `primary` REFUSED: it is missing"]]);
  assert.match(rows[0].fix ?? "", /run `agent-org doctor` from the checkout that host.json's `tool` names/);
});

test("a template that cannot be rendered is said by its refusal, and is not thrown into doctor", async () => {
  const broken = fakePluginDeps({ place: async () => PLACED, readFile: (path) => { if (path === INSTALLED) throw new Error("ENOENT"); return "#!/bin/sh\n@@noSuchValue@@\n"; } });
  const rows = await wrapperChecks(settingsOf(), broken);
  assert.deepEqual([rows[0].name, rows[0].ok, rows[0].detail], ["gh wrapper", false, "cannot be checked: gh: `@@noSuchValue@@` is a placeholder no value fills"]);
});
