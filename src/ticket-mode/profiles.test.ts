// no-token: gh -- parses JSON handed in, and reads files under a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseProfiles, profilesPath, readProfiles } from "./profiles.ts";

test("the profiles file is under XDG_CONFIG_HOME when that is an absolute path, and under ~/.config otherwise", () => {
  assert.equal(profilesPath({ XDG_CONFIG_HOME: "/x/config" }, "/home/me"), "/x/config/agent-org/profiles.json");
  assert.equal(profilesPath({ XDG_CONFIG_HOME: "relative" }, "/home/me"), "/home/me/.config/agent-org/profiles.json", "the XDG rule ignores a relative path");
  assert.equal(profilesPath({}, "/home/me"), "/home/me/.config/agent-org/profiles.json");
});

test("a profiles file names this board as local and other machines by ssh target, in its order, with agent-org as the remote command unless named", () => {
  assert.deepEqual(parseProfiles({ work: { local: true }, personal: { ssh: "agents" }, aws: { ssh: "me@10.0.0.4", agentOrg: "/home/me/repos/agent-org/host/agent-org" } }), [
    { name: "work", local: true },
    { name: "personal", local: false, ssh: "agents", agentOrg: "agent-org" },
    { name: "aws", local: false, ssh: "me@10.0.0.4", agentOrg: "/home/me/repos/agent-org/host/agent-org" },
  ]);
  assert.equal((parseProfiles({ w: { local: true }, u: { ssh: "ssh://me@host:2222" } })[1] as { ssh: string }).ssh, "ssh://me@host:2222");
});

test("a profiles file is refused by the rule it breaks", () => {
  const refused: [unknown, RegExp][] = [
    [[], /JSON object of profile name/],
    [{ personal: { ssh: "agents" } }, /exactly one profile must be \{ "local": true \}.*0 are/],
    [{ a: { local: true }, b: { local: true } }, /exactly one.*2 are/],
    [{ "bad name": { local: true } }, /profile name "bad name"/],
    [{ "-x": { local: true } }, /profile name "-x"/],
    [{ w: { local: true }, p: "agents" }, /profile p must be an object/],
    [{ w: { local: true }, p: { ssh: "agents", port: 22 } }, /field no profile takes: port/],
    [{ w: { local: false } }, /local must be true, or left out/],
    [{ w: { local: true, ssh: "agents" } }, /is local, so it takes no ssh/],
    [{ w: { local: true }, p: {} }, /ssh must be an ssh target/],
    [{ w: { local: true }, p: { ssh: "-oProxyCommand=touch /tmp/x" } }, /ssh must be an ssh target.*not starting with -/],
    [{ w: { local: true }, p: { ssh: "agents;id" } }, /ssh must be an ssh target/],
    [{ w: { local: true }, p: { ssh: "$(id)" } }, /ssh must be an ssh target/],
    [{ w: { local: true }, p: { ssh: "agents host" } }, /ssh must be an ssh target/],
    [{ w: { local: true }, p: { ssh: "agents", agentOrg: "agent-org;id" } }, /agentOrg must be a plain path/],
    [{ w: { local: true }, p: { ssh: "agents", agentOrg: "-x" } }, /agentOrg must be a plain path/],
  ];
  for (const [value, reason] of refused) assert.throws(() => parseProfiles(value), reason, JSON.stringify(value));
});

test("no profiles file reads as no profiles and no refusal, so the board is as it was", () => {
  assert.deepEqual(readProfiles(join(tmpDir("profiles-none-"), "profiles.json")), { profiles: [], refusal: null });
});

test("a profiles file that is not JSON, breaks a rule or cannot be read is refused naming why, and leaves no profiles", () => {
  const dir = tmpDir("profiles-bad-");
  const path = join(dir, "profiles.json");
  writeFileSync(path, "{ work: ");
  assert.deepEqual(readProfiles(path), { profiles: [], refusal: `${path} is refused, so only this board is shown: it is not valid JSON` });
  writeFileSync(path, JSON.stringify({ personal: { ssh: "agents" } }));
  assert.match(String(readProfiles(path).refusal), /is refused, so only this board is shown: exactly one profile/);
  mkdirSync(join(dir, "dir.json"));
  const unreadable = readProfiles(join(dir, "dir.json"));
  assert.deepEqual(unreadable.profiles, []);
  assert.match(String(unreadable.refusal), /dir\.json cannot be read/);
  writeFileSync(path, JSON.stringify({ work: { local: true }, personal: { ssh: "agents" } }));
  assert.deepEqual(readProfiles(path), { profiles: [{ name: "work", local: true }, { name: "personal", local: false, ssh: "agents", agentOrg: "agent-org" }], refusal: null });
});
