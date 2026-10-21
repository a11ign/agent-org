// no-token: none -- reads and writes temp directories and the fixture project; the wrapper is rendered, never run, and nothing here reaches `gh`, `herdr` or `git`
// requires: history
// (the tests import `host-units.ts`, which reads git history to say where an orphaned unit came from)
//
// agent-org#790: A MERGED `github.identity` SWITCH TAKES EFFECT ON THE NEXT TICK, AND A DECLARED APP ROLE WITH NO APP CALLS IS AN INCIDENT. Two halves, each with its control:
//   1. the re-render: a wrapper whose identity block lacks what `host.json` declares is written again, ALONE; one whose block already matches is not written at all;
//   2. the detector: a declared role with calls in the window and no `app:<role>` line is returned; the same role with one such line, or with no call, or undeclared, is not.
// The re-render tests live here and not in `packaging/host-units.test.ts` because this row's Region names this file and not that one.
import "./packaging/host-units-project.ts"; // FIRST: it names the fixture project the tool resolves at import
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./packaging/host-units-project.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { APP_ROLE_SILENT, APP_ROLE_SILENT_MS, appRoleSilent, appRoleSilentEvents, type LedgerSource } from "./app-role-silent.ts";
import { parseHostConfig } from "./host-config.ts";
import * as core from "./host-units/gh-wrapper-and-notes.ts";
import type { CodeHostWrapper } from "./plugins/contracts/code-host.ts";
import { wrapperInputsOf } from "./plugins/host-place.ts";
import { createWrapper, wrapperIdentity } from "../plugins/github/wrapper.ts";

/** The GitHub plugin's wrapper, its template read from `template` (the shipped one unless a test says another), so what the tick re-renders is what the plugin renders (A11-160: the renderer is the plugin's). */
const githubWrapper = (read: (path: string) => string = (path) => readFileSync(path, "utf8")): CodeHostWrapper =>
  createWrapper({ exec: () => ({ status: null, stdout: "", stderr: "no program" }), readFile: read, env: {} });
const { tickAppRoleSilent } = core;
const hostIdentityInstall = (deps: Parameters<typeof core.hostIdentityInstall>[0] = {}) => core.hostIdentityInstall({ wrapper: githubWrapper(), ...deps });
const rerenderGhWrapper = (deps: Parameters<typeof core.rerenderGhWrapper>[0] = {}) => core.rerenderGhWrapper({ wrapper: githubWrapper(), ...deps });
const tickRerenderGhWrapper = (deps: Parameters<typeof core.tickRerenderGhWrapper>[0] = {}) => core.tickRerenderGhWrapper({ wrapper: githubWrapper(), ...deps });
/** The wrapper as the plugin renders it for a host. */
const wrapperText = (host: ReturnType<typeof parseHostConfig>) => githubWrapper().file(wrapperInputsOf(host)).expected;

// ---- the detector ---------------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-10T22:30:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MIN = 60_000;
const WORKER_LOGIN = "a11ign-ai-workers";
const LEADS_LOGIN = "a11ign-ai-leads";

/** One ledger line as `plugins/github/wrapper/gh` writes it: time, account, resource, cost, status, command, workspace, caller, session. */
const line = (at: string, account: string, { workspace = "w9", resource = "core", command = "pr list", caller = "node work-gate.ts" } = {}) =>
  [at, account, resource, "", "0", command, workspace, caller, "-"].join("\t");
const workers = (...lines: string[]): LedgerSource => ({ role: "workers", lines });
const managers = (...lines: string[]): LedgerSource => ({ role: "managers", lines });
const names = (found: ReturnType<typeof appRoleSilent>) => found.map((f) => f.role);

test("#790 POSITIVE: a declared role with calls in the window and no `app:<role>` line is silent", () => {
  const found = appRoleSilent([workers(line(ago(2 * MIN), WORKER_LOGIN), line(ago(MIN), WORKER_LOGIN))], ["workers"], NOW);
  assert.deepEqual(found, [{ role: "workers", calls: 2, lastApp: null, mint: null }]);
});

test("#790 NEGATIVE: the same role with one `app:<role>` line in the window is not", () => {
  const found = appRoleSilent([workers(line(ago(2 * MIN), WORKER_LOGIN), line(ago(MIN), "app:workers"), line(ago(MIN / 2), WORKER_LOGIN))], ["workers"], NOW);
  assert.deepEqual(found, []);
});

test("#790 NEGATIVE: a declared role that made NO call at all is not an incident, whether the ledger is empty, missing or only holds older calls", () => {
  assert.deepEqual(appRoleSilent([workers()], ["workers"], NOW), []);
  assert.deepEqual(appRoleSilent([], ["workers"], NOW), []);
  assert.deepEqual(appRoleSilent([workers(line(ago(30 * MIN), WORKER_LOGIN))], ["workers"], NOW), [],
    "a call half an hour ago is not a call in the last ten minutes");
});

test("#790: THE WINDOW IS TEN MINUTES: a call 9:59 ago counts, a call exactly 10:00 ago does not", () => {
  assert.equal(APP_ROLE_SILENT_MS, 10 * MIN);
  assert.deepEqual(names(appRoleSilent([workers(line(ago(10 * MIN - 1000), WORKER_LOGIN))], ["workers"], NOW)), ["workers"]);
  assert.deepEqual(appRoleSilent([workers(line(ago(10 * MIN), WORKER_LOGIN))], ["workers"], NOW), []);
});

test("#790: an app line older than the window does not rescue a role whose calls in the window were none of them as the app, and is named as its last", () => {
  const found = appRoleSilent([workers(line(ago(40 * MIN), "app:workers"), line(ago(MIN), WORKER_LOGIN))], ["workers"], NOW);
  assert.deepEqual(found, [{ role: "workers", calls: 1, lastApp: ago(40 * MIN), mint: null }]);
});

test("#790 NEGATIVE: a role the host declares `user-accounts` is never returned, whatever its calls", () => {
  const ledger = [workers(line(ago(MIN), WORKER_LOGIN), line(ago(MIN), WORKER_LOGIN, { workspace: "-" }))];
  assert.deepEqual(appRoleSilent(ledger, [], NOW), [], "nothing declared, nothing to be silent about");
  assert.deepEqual(names(appRoleSilent(ledger, ["scheduler"], NOW)), ["scheduler"], "and declaring one role returns that one only");
});

test("#790: ROLES ARE TOLD APART BY THE WRAPPER'S OWN RULE: no workspace is the scheduler, the leads' ledger is the managers, every other workspace the workers", () => {
  const ledgers = [
    workers(line(ago(MIN), WORKER_LOGIN, { workspace: "-" }), line(ago(MIN), WORKER_LOGIN, { workspace: "w9" })),
    managers(line(ago(MIN), LEADS_LOGIN, { workspace: "w6" })),
  ];
  const all = appRoleSilent(ledgers, ["scheduler", "workers", "managers"], NOW);
  assert.deepEqual(all.map((f) => [f.role, f.calls]), [["scheduler", 1], ["workers", 1], ["managers", 1]]);
  // One role working as its app does not rescue another: each is its own question.
  const mixed = appRoleSilent([...ledgers, workers(line(ago(MIN), "app:workers"))], ["scheduler", "workers", "managers"], NOW);
  assert.deepEqual(names(mixed), ["scheduler", "managers"]);
});

test("#790: the wrapper's own `incident` line (a failed mint) is not a call, and a half line left by a trim is skipped, not read as one", () => {
  const failedMint = line(ago(MIN), WORKER_LOGIN, { resource: "incident", command: "app-token workers" });
  assert.deepEqual(appRoleSilent([workers(failedMint)], ["workers"], NOW), []);
  assert.deepEqual(appRoleSilent([workers("tail of a trimmed line", `${ago(MIN)}\tshort`)], ["workers"], NOW), []);
  assert.deepEqual(names(appRoleSilent([workers(failedMint, line(ago(MIN), WORKER_LOGIN))], ["workers"], NOW)), ["workers"],
    "and the call that fell back is the one that makes the role silent");
});

test("#790: THE LEDGER REF NAMES THE EPISODE: stable while the role stays silent, new once an app line has shown it work", () => {
  const silentSince = (app: string[]) => appRoleSilentEvents(appRoleSilent([workers(...app, line(ago(MIN), WORKER_LOGIN))], ["workers"], NOW));
  const first = silentSince([]);
  assert.deepEqual(first, [{ classKey: APP_ROLE_SILENT, ref: "workers@never" }]);
  assert.deepEqual(silentSince([]), first, "the next tick sees the same episode, so `recordFailures` writes one line");
  const second = silentSince([line(ago(50 * MIN), "app:workers")]);
  assert.deepEqual(second, [{ classKey: APP_ROLE_SILENT, ref: `workers@${ago(50 * MIN)}` }]);
  assert.notDeepEqual(second, first, "an episode after the app worked is another line");
});

// ---- the tick's caller ------------------------------------------------------------------------------------------------------------

const baseHost = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
const APPS = (roles: string[]) => ({ identity: Object.fromEntries(roles.map((role) => [role, {
  mode: "github-apps", appId: `id-${role}`, keyPath: `/scratch/${role}.pem`, ...(role === "workers" ? { installationId: "777" } : {}),
}])) });
/** A scratch `host.json` (never the live one) with the declared app roles, its account directories under `root`. */
const hostOf = (root: string, roles: string[]) => parseHostConfig(JSON.stringify({
  ...baseHost(), binDir: join(root, "bin"),
  gh: { ...(baseHost().gh as object), workers: join(root, "workers"), leads: join(root, "leads") },
  ...(roles.length === 0 ? {} : { github: APPS(roles) }),
}), "scratch host.json");

const ledgerFiles = (root: string, files: { workers?: string[]; leads?: string[] }) => {
  for (const [dir, lines] of [["workers", files.workers], ["leads", files.leads]] as const) {
    if (lines === undefined) continue;
    mkdirSync(join(root, dir, "gh"), { recursive: true });
    writeFileSync(join(root, dir, "gh", "gh-calls.tsv"), `${lines.join("\n")}\n`);
  }
};

test("#790 tick: a declared role that made calls and none as its app is FILED once, through the ledger writer, with the event its episode names", () => {
  const root = tmpDir("app-role-silent-790-tick-");
  ledgerFiles(root, { workers: [line(ago(MIN), WORKER_LOGIN)], leads: [line(ago(MIN), "app:managers", { workspace: "w6" })] });
  const filed: { logPath: string; events: unknown; now: number }[] = [];
  const said: string[] = [];
  const silent = tickAppRoleSilent({ host: hostOf(root, ["workers", "managers"]), now: NOW, logPath: "/ledger/failure-ledger", err: (l) => said.push(l),
    record: ((tick: { logPath: string; events: unknown; now: number }) => { filed.push(tick); return { appended: 1, skipped: 0, refused: null }; }) as never });
  assert.deepEqual(names(silent), ["workers"], "workers is silent; managers made an app call, so it is not");
  assert.deepEqual(filed, [{ logPath: "/ledger/failure-ledger", events: [{ classKey: APP_ROLE_SILENT, ref: "workers@never" }], now: NOW }]);
  assert.match(said.join(""), /workers is declared github-apps and made 1 call\(s\) in 10 minutes, none as app:workers/);
});

test("#790 tick NEGATIVE: a host that declares no app role reads no ledger and files nothing", () => {
  const root = tmpDir("app-role-silent-790-none-");
  const read = (() => { throw new Error("a host with no app role must not read a ledger"); }) as never;
  const record = (() => { throw new Error("and must not file"); }) as never;
  assert.deepEqual(tickAppRoleSilent({ host: hostOf(root, []), now: NOW, read, record, err: () => {} }), []);
});

test("#790 tick: a ledger that does not exist is no call, one that cannot be read is SAID and files nothing", () => {
  const root = tmpDir("app-role-silent-790-unread-");
  const host = hostOf(root, ["workers"]);
  const record = (() => { throw new Error("nothing was seen, so nothing is filed"); }) as never;
  const said: string[] = [];
  assert.deepEqual(tickAppRoleSilent({ host, now: NOW, record, err: (l) => said.push(l) }), [], "no file: a role that made no call");
  assert.equal(said.length, 0);
  const denied = (() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); }) as never;
  assert.deepEqual(tickAppRoleSilent({ host, now: NOW, read: denied, record, err: (l) => said.push(l) }), []);
  assert.match(said.join(""), /could not read .*workers\/gh\/gh-calls\.tsv: EACCES/);
});

// ---- the mint's reason (agent-org#1682) -------------------------------------------------------------------------------------------

const MINT_CALLER = "app-token workers failed, fell back to the account: could not read the key /scratch/workers.pem (exit 2)";
const mintLine = (at: string, { command = "app-token workers", caller = MINT_CALLER } = {}) => line(at, WORKER_LOGIN, { resource: "incident", command, caller });
/** The stderr the tick prints for one role's ledger, with its incidents and app lines as given. */
const reportOf = (workerLines: string[]) => {
  const root = tmpDir("app-role-silent-mint-reason-");
  ledgerFiles(root, { workers: workerLines });
  const said: string[] = [];
  const silent = tickAppRoleSilent({ host: hostOf(root, ["workers"]), now: NOW, logPath: "/ledger/failure-ledger", err: (l) => said.push(l),
    record: (() => ({ appended: 1, skipped: 0, refused: null })) as never });
  return { silent, said: said.join("") };
};

test("a silent role's report carries the mint's reason", () => {
  // POSITIVE: a failed mint in the window, after the role's last app line, is named with its reason, exit status and time.
  const failed = reportOf([line(ago(2 * MIN), WORKER_LOGIN), mintLine(ago(MIN))]);
  assert.deepEqual(failed.silent.map((s) => s.mint), [{ at: ago(MIN), reason: "could not read the key /scratch/workers.pem", exit: 2 }]);
  assert.ok(failed.said.includes(`the mint failed at ${ago(MIN)}: could not read the key /scratch/workers.pem (exit 2)`), failed.said);

  // NEGATIVE: a failed mint from BEFORE the role's last app line is not this silence's reason, so it is not named.
  const before = reportOf([mintLine(ago(50 * MIN)), line(ago(40 * MIN), "app:workers"), line(ago(MIN), WORKER_LOGIN)]);
  assert.deepEqual(before.silent.map((s) => s.mint), [null]);
  assert.ok(before.said.includes("no app-token incident in the ledger"), before.said);
  assert.ok(!before.said.includes("could not read the key"), before.said);

  // NO INCIDENT: a silent role with no failed mint is said so, which is a reading and not a failure.
  const none = reportOf([line(ago(MIN), WORKER_LOGIN)]);
  assert.deepEqual(none.silent.map((s) => s.mint), [null]);
  assert.ok(none.said.includes("no app-token incident in the ledger"), none.said);

  // CONTROL: an incident naming another role is not this role's mint.
  const other = reportOf([mintLine(ago(MIN), { command: "app-token managers" }), line(ago(MIN), WORKER_LOGIN)]);
  assert.deepEqual(other.silent.map((s) => s.mint), [null]);

  // THE REF IS UNCHANGED: the episode names the role and its last app line, so a failed mint neither adds to it nor moves it.
  const refOf = (workerLines: string[]) => appRoleSilentEvents(appRoleSilent([workers(...workerLines)], ["workers"], NOW));
  assert.deepEqual(refOf([mintLine(ago(2 * MIN)), line(ago(MIN), WORKER_LOGIN)]), [{ classKey: APP_ROLE_SILENT, ref: "workers@never" }]);
  assert.deepEqual(refOf([line(ago(MIN), WORKER_LOGIN)]), [{ classKey: APP_ROLE_SILENT, ref: "workers@never" }]);
  assert.deepEqual(refOf([line(ago(50 * MIN), "app:workers"), mintLine(ago(2 * MIN)), line(ago(MIN), WORKER_LOGIN)]),
    [{ classKey: APP_ROLE_SILENT, ref: `workers@${ago(50 * MIN)}` }]);
});

// ---- the re-render ----------------------------------------------------------------------------------------------------------------

/** A host's bin directory holding the wrapper as `host:install` rendered it for `roles`, plus sentinels in the other places an install writes, to prove they are left alone. */
function installed(roles: string[]) {
  const root = tmpDir("app-role-silent-790-wrapper-");
  const host = (declared: string[]) => hostOf(root, declared);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "workers"), { recursive: true });
  mkdirSync(join(root, "leads"), { recursive: true });
  const target = join(root, "bin", "gh");
  writeFileSync(target, wrapperText(host(roles)) as string, { mode: 0o755 });
  const sentinels = { [join(root, "workers", "README.md")]: "a README somebody edited\n", [join(root, "leads", "workspaces.txt")]: "w1\n", [join(root, "bin", "claude")]: "#!/bin/sh\n" };
  for (const [path, text] of Object.entries(sentinels)) writeFileSync(path, text);
  const untouched = () => Object.entries(sentinels).every(([path, text]) => readFileSync(path, "utf8") === text);
  return { root, host, target, text: () => readFileSync(target, "utf8"), untouched };
}
const armOf = (text: string, role: string) => new RegExp(`^    ${role}\\) app_id='id-${role}'`, "m").test(text);
const rolesLine = (text: string) => /^APP_ROLES=.*$/m.exec(text)?.[0];

test("#790 POSITIVE: a wrapper that lacks `scheduler)` while host.json declares it is re-rendered, and that file only", () => {
  const h = installed([]);
  assert.equal(armOf(h.text(), "scheduler"), false, "the control: the installed wrapper has no scheduler arm");
  const written = rerenderGhWrapper({ host: h.host(["scheduler"]) });
  assert.equal(written, h.target);
  assert.equal(armOf(h.text(), "scheduler"), true);
  assert.equal(h.text(), wrapperText(h.host(["scheduler"])), "byte-identical to what `host:install` renders for this file");
  assert.equal(statSync(h.target).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(h.root, "bin")).sort(), ["claude", "gh"], "no temp file left, and no other file written");
  assert.equal(h.untouched(), true, "every other owned file is as it was");
});

test("#790 NEGATIVE: a wrapper whose values already match the declaration is not written at all", () => {
  const h = installed(["scheduler", "workers"]);
  const before = h.text();
  const noWrite = (() => { throw new Error("a matching wrapper must not be written"); }) as never;
  assert.equal(rerenderGhWrapper({ host: h.host(["scheduler", "workers"]), write: noWrite, rename: noWrite }), null);
  assert.equal(h.text(), before);
});

test("#790 NEGATIVE: a wrapper that differs in a line that is not identity is left for `host:install`, and only an identity difference is mended", () => {
  const h = installed(["workers"]);
  writeFileSync(h.target, `${h.text()}# hand-edited\n`);
  const edited = h.text();
  assert.equal(rerenderGhWrapper({ host: h.host(["workers"]) }), null, "identity matches, so this tick does not race to overwrite it");
  assert.equal(h.text(), edited);
  assert.equal(rerenderGhWrapper({ host: h.host(["workers", "managers"]) }), h.target, "but a declared role it lacks is mended, and the hand edit goes with the rewrite, as with host:install");
  assert.doesNotMatch(h.text(), /# hand-edited/);
});

test("#790 + A11-84: SWITCHING A ROLE TO `user-accounts` AND BACK: the tick REFUSES to drop the app, and `host:install --allow-no-apps` takes the switch (the scratch host.json is the test's, never the live one)", () => {
  const h = installed(["workers"]);
  const seen: string[] = [`declared workers: ${rolesLine(h.text())}`];
  // A11-84: the downgrade is refused by the tick, which names the way past it, and writes nothing.
  assert.throws(() => rerenderGhWrapper({ host: h.host([]) }), /names no App role and the installed one names workers.*--allow-no-apps/);
  assert.equal(armOf(h.text(), "workers"), true, "the refused tick left the app in place");
  hostIdentityInstall({ host: h.host([]), allowNoApps: true, out: () => {}, scriptDir: join(h.root, "bin"), workersDir: join(h.root, "workers"), leadsDir: join(h.root, "leads") });
  seen.push(`switched to user-accounts by host:install --allow-no-apps: ${rolesLine(h.text())}`);
  assert.equal(armOf(h.text(), "workers"), false, "the arm is gone: the app is no longer used");
  assert.equal(rerenderGhWrapper({ host: h.host([]) }), null, "and a second tick changes nothing");
  assert.equal(rerenderGhWrapper({ host: h.host(["workers"]) }), h.target);
  seen.push(`switched back to github-apps: ${rolesLine(h.text())}`);
  assert.equal(armOf(h.text(), "workers"), true);
  // The live reading the row asks for, quoted in the output of the test itself.
  console.log(`#790 re-render, scratch host.json:\n  ${seen.join("\n  ")}`);
});

test("#790 NOT WRITTEN: no wrapper installed, an unreadable shipped copy, and a pre-#4900 wrapper on a host that declares no app", () => {
  const h = installed([]);
  const noWrite = (() => { throw new Error("must not write"); }) as never;
  const missing = tmpDir("app-role-silent-790-nowrapper-");
  assert.equal(rerenderGhWrapper({ host: hostOf(missing, ["workers"]), write: noWrite, rename: noWrite }), null);
  assert.equal(existsSync(join(missing, "bin", "gh")), false, "a tick does not create the file every agent's PATH resolves");
  const unreadable = githubWrapper(() => { throw new Error("ENOENT: the plugin's shipped copy"); });
  const before = h.text();
  assert.equal(rerenderGhWrapper({ host: h.host(["workers"]), wrapper: unreadable, write: noWrite, rename: noWrite }), null);
  assert.equal(h.text(), before, "an empty gh on every PATH is worse than a stale one");
  writeFileSync(h.target, "#!/bin/sh\nexec /usr/bin/gh \"$@\"\n");
  assert.equal(wrapperIdentity(h.text()), null);
  assert.equal(rerenderGhWrapper({ host: h.host([]), write: noWrite, rename: noWrite }), null, "no block and no app declared behave the same");
  assert.equal(rerenderGhWrapper({ host: h.host(["workers"]) }), h.target, "but with an app declared the old copy is mended");
});

test("#790 tick: the re-render is a NOTE, and a template that will not render is said and never thrown into the gate's read", () => {
  const h = installed([]);
  const said: string[] = [];
  const notes = tickRerenderGhWrapper({ host: h.host(["managers"]), err: (l) => said.push(l) });
  assert.deepEqual(notes.map((n) => [n.unit, n.problem]), [[h.target, "RE-RENDERED -- ITS IDENTITY DID NOT MATCH host.json"]]);
  assert.match(said.join(""), /^re-rendered .*\/bin\/gh/);
  assert.deepEqual(tickRerenderGhWrapper({ host: h.host(["managers"]), err: (l) => said.push(l) }), [], "the next tick has nothing to say");
  const broken = githubWrapper(() => "#!/bin/sh\n@@noSuchValue@@\n");
  said.length = 0;
  assert.deepEqual(tickRerenderGhWrapper({ host: h.host(["workers"]), wrapper: broken, err: (l) => said.push(l) }), []);
  assert.match(said.join(""), /could not re-render the gh wrapper: .*noSuchValue/);
});
