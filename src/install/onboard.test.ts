// no-token: none -- the Keychain, the prompts and the service are stand-ins, and the host file is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { KeySource } from "../ticket-mode/settings.ts";
import { onboard, startServices, type OnboardDeps, type OnboardOptions } from "./onboard.ts";

const KEY = "lin_api_SECRETSECRETSECRET";
const options = (over: Partial<OnboardOptions> = {}): OnboardOptions => ({ repos: [], keychain: undefined, keyFile: undefined, start: true, ...over });

function deps(over: Partial<OnboardDeps> = {}, answers: string[] = []) {
  const home = tmpDir("onboard-");
  const repo = join(home, "src", "nbl-ui-netbox");
  mkdirSync(repo, { recursive: true });
  const stored = new Map<string, string>();
  const printed: string[] = [];
  const started: string[] = [];
  const keyAt = (source: KeySource) => ("keychain" in source ? `keychain:${source.keychain}` : `file:${source.path}`);
  const value: OnboardDeps = {
    env: {}, home, platform: "darwin", interactive: false,
    ask: async () => answers.shift() ?? "", askHidden: async () => KEY,
    readKey: (source) => {
      const key = stored.get(keyAt(source));
      if (key === undefined) throw new Error("no key");
      return key;
    },
    storeInKeychain: (service) => { stored.set(`keychain:${service}`, KEY); },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => {
      if (path.endsWith(".key")) stored.set(`file:${path}`, text.trim());
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    },
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    startService: () => { started.push("instance"); return "started the instance service"; },
    out: { log: (line: string) => printed.push(line) },
    ...over,
  };
  return { deps: value, home, repo, stored, printed, started };
}

test("onboard writes clones and the key source from flags, keeps the host file's other keys, and starts the instance service", async () => {
  const { deps: d, home, repo, stored, printed, started } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  const hostFile = join(home, ".agent-org", "host.json");
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(hostFile, JSON.stringify({ stateDir: "/var/agent-org", tickets: { max: 5 } }));
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear" }), d);
  assert.deepEqual(JSON.parse(readFileSync(hostFile, "utf8")), {
    stateDir: "/var/agent-org", clones: { netbox: repo }, tickets: { max: 5, linearKey: { keychain: "agent-org-linear" } },
  });
  assert.deepEqual(started, ["instance"]);
  assert.ok(printed.some((line) => line === "the Linear key is readable from the Keychain service agent-org-linear"));
});

test("onboard never prints the key: not when it reads one, and not when it stores one from a hidden prompt", async () => {
  for (const source of [{ keychain: undefined, keyFile: undefined }, { keychain: undefined, keyFile: "~/.agent-org/linear.key" }]) {
    const { deps: d, repo, printed, stored } = deps({ interactive: true });
    await onboard(options({ repos: [repo], ...source }), d);
    assert.equal(stored.size, 1, "a key was stored");
    assert.ok(printed.length > 0);
    for (const line of printed) assert.ok(!line.includes(KEY), `printed the key: ${line}`);
  }
});

test("onboard asks for repositories at a terminal, names a bare path after its directory, and does not start with --no-start", async () => {
  const answers: string[] = [];
  const { deps: d, home, repo, started, stored } = deps({ interactive: true }, answers);
  answers.push(repo, "");
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ start: false }), d);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")).clones, { "nbl-ui-netbox": repo });
  assert.deepEqual(started, []);
});

test("onboard refuses no repository, a relative one and a missing one, and says how to store a key it cannot read", async () => {
  const { deps: d, home, repo, printed } = deps();
  await assert.rejects(onboard(options(), d), /give at least one --repo/);
  await assert.rejects(onboard(options({ repos: ["x=relative/path"] }), d), /must be an absolute path/);
  await assert.rejects(onboard(options({ repos: [`x=${join(home, "absent")}`] }), d), /is not a directory/);
  await onboard(options({ repos: [repo], start: false }), d);
  assert.ok(printed.some((line) => line.startsWith("NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password")));
});

test("onboard refuses to write over a host file that is not JSON", async () => {
  const { deps: d, home, repo } = deps();
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(join(home, ".agent-org", "host.json"), "{ not json");
  await assert.rejects(onboard(options({ repos: [repo] }), d), /is not valid JSON, so onboard will not write over it/);
});

test("onboard refuses a Keychain service name a shell would not read as it is", async () => {
  const { deps: d, repo } = deps();
  await assert.rejects(onboard(options({ repos: [repo], keychain: "x; touch pwned" }), d), /is not a Keychain service name/);
});

test("onboard's start starts the instance and the ui service, in that order", () => {
  const started: string[] = [];
  const lines = startServices((name) => {
    started.push(name);
    return { manager: "systemd", id: `agent-org-${name}.service`, path: `/u/agent-org-${name}.service`, text: "", log: null };
  });
  assert.deepEqual(started, ["instance", "ui"]);
  assert.equal(lines, "started the instance service (systemd agent-org-instance.service)\nstarted the ui service (systemd agent-org-ui.service)");
});
