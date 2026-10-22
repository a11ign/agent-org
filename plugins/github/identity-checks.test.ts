// no-token: none -- the wrapper is rendered and read from a recorded `readFile`, the minter is a recorded `exec`, and nothing reaches `gh` or the network
//
// THE GITHUB PLUGIN'S IDENTITY ROWS FOR DOCTOR (A11-160), moved from `install/doctor.test.ts` (A11-84's divergence and mint cases, with their words) and grown by the two the plan adds: `wrapper roles`, and
// the rows on a ticket-only host, where they were "not applicable" and a declared App was never asked to mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CodeHostPolicy, HostPlaceReading, PluginDeps } from "../../src/plugins/manifest.ts";
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

// ---- A11-172: the identities the review claim uses, each asked whether it can write (or list) a commit status ----

const REVIEW_CLAIM: CodeHostPolicy["claimIdentities"] = [
  { role: "reviewer", access: "write", env: { AGENT_ORG_GH_ROLE: "reviewer", GH_CONFIG_DIR: "/home/agent/reviewer/gh" } },
  { role: "scheduler", access: "read", env: { AGENT_ORG_GH_ROLE: "scheduler" } },
];

/** What an App's installation prints through the minter's `permissions` mode: the permissions it holds, its slug, and its page. */
const grantOf = (permissions: Record<string, string>, slug: string) => ({ status: 0, stdout: JSON.stringify({ permissions, appSlug: slug, htmlUrl: `https://github.com/organizations/a11ign/settings/installations/${slug}` }), stderr: "" });

/** Deps whose minter mints for every role and whose `permissions` mode answers `permissions(role)`; the policy names the review claim's identities unless `claim` says otherwise. */
function claimDeps(place: HostPlaceReading, installed: string | null, permissions: (role: string) => { status: number | null; stdout: string; stderr: string }, claim: CodeHostPolicy["claimIdentities"] = REVIEW_CLAIM) {
  const ran: string[][] = [];
  const base = deps(place, installed, () => ({ status: 0, stdout: "ghs_token\n", stderr: "" }));
  const fake = fakePluginDeps({ ...base, policy: { ...base.policy, claimIdentities: claim }, exec: (file, args) => {
    ran.push([file, ...args]);
    return args[1] === "permissions" ? permissions(args[2] ?? "") : { status: 0, stdout: "ghs_token\n", stderr: "" };
  } });
  return { deps: fake, ran };
}

test("A11-172: the reviewer App's installation without Commit statuses write fails `commit statuses reviewer`, naming the App and the exact permission to grant", async () => {
  const { deps: d } = claimDeps(PLACED, renderedFor("scheduler", "reviewer"), (role) => grantOf(role === "reviewer" ? { contents: "read", statuses: "read" } : { statuses: "read" }, `a11ign-${role}`));
  const rows = await byName(settingsOf("scheduler", "reviewer"), d);
  assert.equal(rows["commit statuses reviewer"].ok, false);
  assert.equal(rows["commit statuses reviewer"].detail, `the a11ign-reviewer App's installation has no "Commit statuses" write permission (it has: read)`);
  assert.equal(rows["commit statuses reviewer"].fix, `grant the a11ign-reviewer App "Commit statuses: Read and write" (Repository permissions) and accept the change on its installation (https://github.com/organizations/a11ign/settings/installations/a11ign-reviewer), then run \`agent-org doctor\``);
  const none = await byName(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"), (role) => grantOf({ contents: "read" }, `a11ign-${role}`)).deps);
  assert.match(none["commit statuses reviewer"].detail, /\(it has: none\)$/, "an installation with no statuses permission at all has: none");
});

test("A11-172: the scheduler App, which only lists the claim, needs Commit statuses read: none fails with the read permission to grant, read passes, and write passes", async () => {
  const outcome = async (granted: Record<string, string>) => (await byName(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"),
    (role) => grantOf(role === "scheduler" ? granted : { statuses: "write" }, `a11ign-${role}`)).deps))["commit statuses scheduler"];
  const missing = await outcome({ contents: "read" });
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, `the a11ign-scheduler App's installation has no "Commit statuses" read permission (it has: none)`);
  assert.match(missing.fix ?? "", /^grant the a11ign-scheduler App "Commit statuses: Read-only" \(Repository permissions\) and accept the change on its installation/);
  assert.equal((await outcome({ statuses: "read" })).ok, true);
  assert.equal((await outcome({ statuses: "write" })).ok, true);
});

test("A11-172: each identity passes with the write permission, and the row says the App and the access it has", async () => {
  const rows = await byName(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"), (role) => grantOf({ statuses: "write" }, `a11ign-${role}`)).deps);
  assert.deepEqual([rows["commit statuses reviewer"].ok, rows["commit statuses scheduler"].ok], [true, true]);
  assert.equal(rows["commit statuses reviewer"].detail, `the a11ign-reviewer App's installation has the "Commit statuses" write permission the review claim needs (write)`);
  assert.equal(rows["commit statuses scheduler"].fix, null);
});

test("A11-172: the permission is read from the installation and never tried: no token is minted for it, and the minter is asked for `permissions` once per identity", async () => {
  const { deps: d, ran } = claimDeps(PLACED, renderedFor("scheduler", "reviewer"), (role) => grantOf({ statuses: "write" }, `a11ign-${role}`));
  await wrapperChecks(settingsOf("scheduler", "reviewer"), d);
  const permissionCalls = ran.filter((call) => call[2] === "permissions");
  assert.deepEqual(permissionCalls.map((call) => call[3]), ["reviewer", "scheduler"], "one dry read per identity the claim uses, in core's order");
  assert.ok(ran.every((call) => call[0] !== "gh"), "and no gh call tries a write");
});

test("A11-172: a machine that starts no reviewer has no claim, so no commit status row is shown", async () => {
  const rows = await wrapperChecks(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"), () => grantOf({}, "x"), []).deps);
  assert.deepEqual(rows.map(({ name }) => name), ["gh wrapper", "wrapper roles", "app token scheduler", "app token reviewer"]);
});

test("A11-172: an installation that cannot be read fails its row with the reason, pointing at the mint row, and never passes", async () => {
  const rows = await byName(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"), () => ({ status: 1, stdout: "", stderr: "app token: installation: GET /app/installations/42 answered 401: Bad credentials\nmore" })).deps);
  assert.equal(rows["commit statuses reviewer"].ok, false);
  assert.equal(rows["commit statuses reviewer"].detail, "the reviewer App's installation permissions could not be read: app token: installation: GET /app/installations/42 answered 401: Bad credentials");
  assert.match(rows["commit statuses reviewer"].fix ?? "", /see the app token reviewer row/);
  const garbled = await byName(settingsOf("scheduler", "reviewer"), claimDeps(PLACED, renderedFor("scheduler", "reviewer"), () => ({ status: 0, stdout: "not json", stderr: "" })).deps);
  assert.equal(garbled["commit statuses reviewer"].detail, "the reviewer App's installation permissions could not be read: the minter printed something that is not JSON");
});

test("A11-172: a ticket-only host, which loads no gate and so starts no reviewer, has no claim and no commit status row, though its Apps are still asked to mint", async () => {
  const { deps: d, ran } = claimDeps({ kind: "no-project" }, null, () => grantOf({ statuses: "read" }, "a11ign-x"));
  const rows = await wrapperChecks(settingsOf("scheduler", "reviewer"), d);
  assert.deepEqual(rows.map(({ name }) => name), ["gh wrapper", "app token scheduler", "app token reviewer"]);
  assert.equal(ran.some((call) => call[2] === "permissions"), false, "and no installation is read");
});

test("A11-172: a role that is a user account is asked for its access to the first GitHub repository a clone names: push to write, pull to list", async () => {
  const calls: { file: string; args: readonly string[]; env: Record<string, string> | undefined }[] = [];
  const accountDeps = (permissions: Record<string, boolean>) => fakePluginDeps({ place: async () => PLACED, clones: { agent: "/repos/agent-org" }, policy: { ...fakePluginDeps().policy, claimIdentities: REVIEW_CLAIM },
    readFile: (path) => { if (path === INSTALLED) return renderedFor(); return readFileSync(path, "utf8"); },
    exec: (file, args, options) => {
      calls.push({ file, args, env: options?.env as Record<string, string> | undefined });
      if (file === "git") return { status: 0, stdout: "git@github.com:a11ign/agent-org.git\n", stderr: "" };
      return { status: 0, stdout: JSON.stringify(permissions), stderr: "" };
    } });
  const passing = await byName(settingsOf(), accountDeps({ pull: true, push: true }));
  assert.deepEqual([passing["commit statuses reviewer"].ok, passing["commit statuses scheduler"].ok], [true, true]);
  const reviewerCall = calls.find((call) => call.file === "gh" && call.env?.AGENT_ORG_GH_ROLE === "reviewer");
  assert.deepEqual(reviewerCall?.args, ["api", "repos/a11ign/agent-org", "--jq", ".permissions"]);
  assert.equal(reviewerCall?.env?.GH_CONFIG_DIR, "/home/agent/reviewer/gh", "asked as the reviewer's own account");
  const pullOnly = await byName(settingsOf(), accountDeps({ pull: true, push: false }));
  assert.equal(pullOnly["commit statuses reviewer"].ok, false, "pull access cannot write a status");
  assert.equal(pullOnly["commit statuses reviewer"].detail, "the reviewer account has no push access to a11ign/agent-org, which writing a commit status needs");
  assert.match(pullOnly["commit statuses reviewer"].fix ?? "", /^give the reviewer account \(\/home\/agent\/reviewer\/gh\) push access to a11ign\/agent-org/);
  assert.equal(pullOnly["commit statuses scheduler"].ok, true, "and pull access is all the reader needs");
});
