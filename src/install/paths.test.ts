// no-token: none -- every file is in a temporary HOME, and the one child process is `node` running `ticket:remote-info` with an empty environment
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { programEnv } from "../bin.ts";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath } from "../ticket-mode/board-key.ts";
import { hostFilePath, hostGhConfigDir, unitHostFile } from "./paths.ts";
import { unitFor, type ServiceDeps } from "./service.ts";

const HOME = "/home/me";
const files = (entries: Record<string, string>) => (path: string) => entries[path] ?? null;
const SYSTEMD_UNIT = join(HOME, ".config", "systemd", "user", "agent-org-instance.service");
const POINTER = join(HOME, ".agent-org", "host-file");

// A11-68: a shell with no AGENT_ORG_HOST finds the host file the services use.
test("the host file is AGENT_ORG_HOST, then onboard's record, then the instance unit's, then ~/.agent-org/host.json", () => {
  const unit = `[Service]\nEnvironment="AGENT_ORG_HOST=/srv/from-unit.json"\n`;
  assert.equal(hostFilePath({ AGENT_ORG_HOST: "/srv/env.json" }, HOME, files({ [POINTER]: "/srv/pointer.json\n", [SYSTEMD_UNIT]: unit })), "/srv/env.json");
  assert.equal(hostFilePath({}, HOME, files({ [POINTER]: "/srv/pointer.json\n", [SYSTEMD_UNIT]: unit })), "/srv/pointer.json");
  assert.equal(hostFilePath({}, HOME, files({ [SYSTEMD_UNIT]: unit })), "/srv/from-unit.json");
  assert.equal(hostFilePath({}, HOME, files({})), join(HOME, ".agent-org", "host.json"));
  assert.equal(hostFilePath({ AGENT_ORG_HOST: "" }, HOME, files({})), join(HOME, ".agent-org", "host.json"), "an empty variable is unset");
});

test("a recorded path that is not absolute is passed over, and AGENT_ORG_HOME moves the record and the default", () => {
  assert.equal(hostFilePath({}, HOME, files({ [POINTER]: "relative/host.json" })), join(HOME, ".agent-org", "host.json"));
  assert.equal(hostFilePath({ AGENT_ORG_HOME: "/opt/ao" }, HOME, files({ "/opt/ao/host-file": "/srv/h.json" })), "/srv/h.json");
  assert.equal(hostFilePath({ AGENT_ORG_HOME: "/opt/ao" }, HOME, files({})), "/opt/ao/host.json");
});

test("the instance unit's AGENT_ORG_HOST is read back exactly as service.ts wrote it, from systemd's unit and from launchd's plist", () => {
  const host = "/srv/a b/$x%y\"z.json";
  for (const platform of ["linux", "darwin"] as const) {
    const deps: ServiceDeps = {
      platform, env: { AGENT_ORG_HOST: host, PATH: "/usr/bin" }, home: HOME, uid: 501, node: "/n/node", toolRoot: "/opt/agent-org", commands: COMMANDS, user: "alice",
      run: () => ({ status: 0, stdout: "", stderr: "" }), exists: () => false, read: () => null, write: () => {},
    };
    assert.equal(unitHostFile(unitFor("instance", deps).text), host, platform);
  }
  assert.equal(unitHostFile("[Service]\nEnvironment=\"PATH=/usr/bin\"\n"), null);
});

test("a ticket:* program is handed the resolved host file when AGENT_ORG_HOST is unset, and no other program is", () => {
  const resolve = () => "/srv/pointer.json";
  assert.equal(programEnv("ticket:remote-info", {}, resolve).AGENT_ORG_HOST, "/srv/pointer.json");
  assert.equal(programEnv("ticket:serve", { AGENT_ORG_HOST: "" }, resolve).AGENT_ORG_HOST, "/srv/pointer.json");
  assert.equal(programEnv("ticket:serve", { AGENT_ORG_HOST: "/srv/env.json" }, resolve).AGENT_ORG_HOST, "/srv/env.json");
  assert.equal(programEnv("row-claim", {}, resolve).AGENT_ORG_HOST, undefined, "a project command resolves its project from that variable");
});

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");
/** `agent-org ticket:remote-info` as a non-interactive ssh runs it: HOME and nothing else that names agent-org. */
const remoteInfo = (home: string) => spawnSync(process.execPath, [BIN, "ticket:remote-info"], {
  encoding: "utf8", env: { HOME: home, PATH: dirname(process.execPath) }, stdio: ["ignore", "pipe", "pipe"],
});

test("ticket:remote-info with an empty environment reads the host file onboard recorded, not ~/.agent-org/host.json", () => {
  const home = tmpDir("host-file-");
  const stateDir = join(home, "state");
  const hostFile = join(home, "repos", "witness", ".agent-org", "host.json");
  mkdirSync(dirname(hostFile), { recursive: true });
  writeFileSync(hostFile, JSON.stringify({ clones: { a: home }, stateDir, tickets: { port: 4999 } }));
  boardKey(boardKeyPath(stateDir));
  const before = remoteInfo(home);
  assert.equal(before.status, 1, "positive control: with no record, it reads the default and refuses");
  assert.match(before.stderr, /\.agent-org\/host\.json, which cannot be read/);
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host-file"), `${hostFile}\n`);
  const after = remoteInfo(home);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).port, 4999);
});

// The gh identity: a ticket:* command and a service read GitHub as the account the host file declares for workers.
test("a ticket:* program gets the workers' GH_CONFIG_DIR the host file declares, unless the caller named one", () => {
  const host = JSON.stringify({ gh: { workers: "/home/agent/workers" } });
  assert.equal(hostGhConfigDir(host), "/home/agent/workers/gh");
  assert.equal(hostGhConfigDir(JSON.stringify({ clones: {} })), null);
  assert.equal(hostGhConfigDir(JSON.stringify({ gh: { workers: "relative" } })), null);
  assert.equal(hostGhConfigDir(null), null);
  const read = (path: string) => (path === "/srv/h.json" ? hostGhConfigDir(host) : null);
  assert.equal(programEnv("ticket:review", {}, () => "/srv/h.json", read).GH_CONFIG_DIR, "/home/agent/workers/gh");
  assert.equal(programEnv("ticket:review", { AGENT_ORG_HOST: "/srv/h.json", GH_CONFIG_DIR: "/mine/gh" }, () => "/x", read).GH_CONFIG_DIR, "/mine/gh");
  assert.equal(programEnv("pr:open", {}, () => "/srv/h.json", read).GH_CONFIG_DIR, undefined);
});

test("the instance unit carries the host file's GH_CONFIG_DIR, and none when neither the host file nor the caller names one", () => {
  const base = (hostText: string | null, env: Record<string, string> = {}): ServiceDeps => ({
    platform: "linux", env: { AGENT_ORG_HOST: "/srv/h.json", PATH: "/usr/bin", ...env }, home: HOME, uid: 501, node: "/n/node", toolRoot: "/opt/agent-org", commands: COMMANDS, user: "alice",
    run: () => ({ status: 0, stdout: "", stderr: "" }), exists: () => false, read: (path) => (path === "/srv/h.json" ? hostText : null), write: () => {},
  });
  const declared = JSON.stringify({ gh: { workers: "/home/agent/workers" } });
  assert.match(unitFor("instance", base(declared, { GH_CONFIG_DIR: "/admin/gh" })).text, /^Environment="GH_CONFIG_DIR=\/home\/agent\/workers\/gh"$/m);
  assert.match(unitFor("auto-update", base(declared)).companion?.text ?? "", /^Environment="GH_CONFIG_DIR=\/home\/agent\/workers\/gh"$/m);
  assert.match(unitFor("ui", base("{}", { GH_CONFIG_DIR: "/mine/gh" })).text, /^Environment="GH_CONFIG_DIR=\/mine\/gh"$/m);
  assert.doesNotMatch(unitFor("instance", base("{}")).text, /GH_CONFIG_DIR/);
});
