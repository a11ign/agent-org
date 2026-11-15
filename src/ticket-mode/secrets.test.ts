// no-token: none -- a scratch home folder and host file; the Keychain is a stand-in for `security`, and no plugin is loaded
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { secretPlace } from "../plugins/secret-place.ts";
import { resolveProviders } from "./providers.ts";
import { baseOf } from "./settings-edit.ts";
import { type SecretDeps, SecretRefusal, secretRequestOf, storeSecret } from "./secrets.ts";

const TOKEN = "lin_api_9f8e7d6c5b4a3210SECRET";
const GITHUB = { provider: "github", enabled: true };

/** A scratch home with the agent-org home in it and a host file whose tracker block is `tracker`; the Keychain is a stand-in that records what it was given. */
function machine(tracker: Record<string, unknown>, over: Partial<SecretDeps> = {}) {
  const home = tmpDir("secrets-home-");
  const agentOrgHome = join(home, ".agent-org");
  mkdirSync(agentOrgHome, { recursive: true });
  const hostPath = join(agentOrgHome, "host.json");
  writeFileSync(hostPath, JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: join(home, "state"), tickets: { providers: { tracker: { provider: "linear", enabled: true, ...tracker }, codeHost: GITHUB } } }, null, 2));
  const given: string[] = [];
  const deps: SecretDeps = { hostPath, catalog: defaultCatalog(), home, agentOrgHome, platform: "linux", user: "me", uid: process.getuid?.() ?? -1,
    security: async (input) => { given.push(input); return { status: 0, stdout: "", stderr: "" }; }, ...over };
  return { home, agentOrgHome, hostPath, deps, given };
}

const requestOf = (fields: Record<string, unknown>) => secretRequestOf({ name: "linear", setting: "key.path", value: TOKEN, ...fields });
const modeOf = (path: string) => (lstatSync(path).mode & 0o777).toString(8);
/** Everything a refusal or an answer could carry, as text. */
const textOf = (value: unknown) => (value instanceof Error ? `${value.message} ${String(value)}` : JSON.stringify(value));

async function refusalOf(work: Promise<unknown>): Promise<SecretRefusal> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof SecretRefusal, `refused as a secret is: ${String(error)}`);
    return error;
  }
  return assert.fail("it was stored");
}

test("A11-445: a token is written to the file the setting holds, as a mode-600 file holding only it, and the answer names the file and never the token", async () => {
  const { agentOrgHome, hostPath, deps } = machine({ key: { path: "~/.agent-org/linear.key" } });
  const before = readFileSync(hostPath, "utf8");
  const stored = await storeSecret(requestOf({ value: `  ${TOKEN}\n` }), deps);
  const file = join(agentOrgHome, "linear.key");
  assert.equal(readFileSync(file, "utf8"), `${TOKEN}\n`);
  assert.equal(modeOf(file), "600");
  assert.deepEqual(stored, { said: `stored key.path of linear in the file ${file}`, inForce: [], backup: null });
  assert.doesNotMatch(textOf(stored), /SECRET/);
  assert.equal(readFileSync(hostPath, "utf8"), before, "a setting that names its file is not written");
  assert.deepEqual(readdirSync(agentOrgHome).sort(), ["host.json", "linear.key"], "no temporary file is left");
});

test("A11-445: a setting that names no place is stored where the manifest says, and the setting is pointed at it, checked against the page's base", async () => {
  const { home, hostPath, deps } = machine({});
  const base = await baseOf({ hostPath }, "host.json");
  const stored = await storeSecret(requestOf({ base }), deps);
  const file = join(home, ".config", "agent-org", "linear.key");
  assert.equal(readFileSync(file, "utf8"), `${TOKEN}\n`);
  assert.equal(modeOf(file), "600");
  assert.match(stored.said, new RegExp(`^stored key\\.path of linear in the file ${file}, and pointed tickets\\.providers\\.tracker\\.key at it$`));
  assert.ok(stored.backup !== null, "the host file before the change is kept");
  assert.deepEqual((JSON.parse(readFileSync(hostPath, "utf8")) as { tickets: { providers: { tracker: { key: unknown } } } }).tickets.providers.tracker.key, { path: file });
  assert.doesNotMatch(readFileSync(hostPath, "utf8"), /SECRET/, "the host file names the place, never the token");
});

test("A11-445: a host file changed since the page read it is refused, and nothing is stored", async () => {
  const { home, deps } = machine({});
  const refusal = await refusalOf(storeSecret(requestOf({ base: "stale" }), deps));
  assert.equal(refusal.message, "the file changed since you looked: read it again");
  assert.equal(existsSync(join(home, ".config", "agent-org", "linear.key")), false);
});

test("A11-445: the page writes only a secret-named file directly in the secret folders, and never another of agent-org's files", async () => {
  const outside = tmpDir("secrets-outside-");
  const cases: Readonly<Record<string, RegExp>> = {
    [join(outside, "linear.key")]: /is not directly in .* the only folders this page writes a secret to/,
    "~/.config/agent-org/apps/reviewer.key": /is not directly in/,
    "~/.agent-org/host.json": /is not named as a secret file/,
    "~/.config/agent-org/connections.json": /is not named as a secret file/,
    "~/.agent-org/../.agent-org/../linear.key": /is not directly in/,
  };
  for (const [path, why] of Object.entries(cases)) {
    const { hostPath, deps } = machine({ key: { path } });
    const before = readFileSync(hostPath, "utf8");
    assert.match((await refusalOf(storeSecret(requestOf({}), deps))).message, why, path);
    assert.equal(readFileSync(hostPath, "utf8"), before, `${path}: the host file is untouched`);
  }
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
});

test("A11-445: a file already there is replaced only when it is this user's mode-600 regular file, never through a symbolic link", async () => {
  const { agentOrgHome, deps } = machine({ key: { path: "~/.agent-org/linear.key" } });
  const file = join(agentOrgHome, "linear.key");
  const elsewhere = join(tmpDir("secrets-target-"), "victim");
  writeFileSync(elsewhere, "keep me");
  symlinkSync(elsewhere, file);
  assert.match((await refusalOf(storeSecret(requestOf({}), deps))).message, /is a symbolic link/);
  assert.equal(readFileSync(elsewhere, "utf8"), "keep me");

  const { agentOrgHome: wide, deps: wideDeps } = machine({ key: { path: "~/.agent-org/linear.key" } });
  writeFileSync(join(wide, "linear.key"), "old\n", { mode: 0o644 });
  chmodSync(join(wide, "linear.key"), 0o644);
  assert.match((await refusalOf(storeSecret(requestOf({}), wideDeps))).message, /has mode 0644, not 0600, so it is not replaced/);
  assert.equal(readFileSync(join(wide, "linear.key"), "utf8"), "old\n");

  const { agentOrgHome: other, deps: otherDeps } = machine({ key: { path: "~/.agent-org/linear.key" } }, { uid: 4242 });
  writeFileSync(join(other, "linear.key"), "old\n", { mode: 0o600 });
  assert.match((await refusalOf(storeSecret(requestOf({}), otherDeps))).message, /is owned by uid \d+, not the running user \(uid 4242\)/);

  const { agentOrgHome: own, deps: ownDeps } = machine({ key: { path: "~/.agent-org/linear.key" } });
  writeFileSync(join(own, "linear.key"), "old\n", { mode: 0o600 });
  await storeSecret(requestOf({}), ownDeps);
  assert.equal(readFileSync(join(own, "linear.key"), "utf8"), `${TOKEN}\n`, "a key rotated: the old file is replaced");
});

test("A11-445: on a Mac a Keychain secret goes to `security -i` on its standard input, and a refusal from it is said without the token", async () => {
  const { deps, given } = machine({ key: { keychain: "work-linear" } }, { platform: "darwin" });
  const stored = await storeSecret(requestOf({ setting: "key.keychain" }), deps);
  assert.deepEqual(given, [`add-generic-password -U -a "me" -s "work-linear" -w "${TOKEN}"\n`]);
  assert.equal(stored.said, "stored key.keychain of linear in the Keychain service work-linear");
  const echoing = machine({ key: { keychain: "work-linear" } }, { platform: "darwin", security: async (input) => ({ status: 45, stdout: "", stderr: `security: could not add ${input}` }) });
  const refusal = await refusalOf(storeSecret(requestOf({ setting: "key.keychain" }), echoing.deps));
  assert.match(refusal.message, /^the macOS Keychain did not take it: security: could not add add-generic-password/);
  assert.doesNotMatch(textOf(refusal), /SECRET/);
});

test("A11-445: a Keychain secret is refused off a Mac, and so is a setting the page does not take or a plugin that is not installed", async () => {
  const { deps, given } = machine({}, { platform: "linux" });
  assert.match((await refusalOf(storeSecret(requestOf({ setting: "key.keychain" }), deps))).message, /is a macOS Keychain service, and this machine is not a Mac/);
  assert.deepEqual(given, []);
  assert.match((await refusalOf(storeSecret(requestOf({ setting: "connectors" }), deps))).message, /linear has no secret named connectors/);
  assert.match((await refusalOf(storeSecret(requestOf({ name: "telegram", setting: "tokenFile" }), deps))).message, /telegram is not installed: install it first/);
  assert.match((await refusalOf(storeSecret(requestOf({ name: "nobody" }), deps))).message, /no plugin is named nobody/);
});

test("A11-445: a value that is not one token is refused by its shape, and the refusal never quotes it", () => {
  const shapes: Readonly<Record<string, RegExp>> = {
    "": /value must be the secret, and it is empty/,
    "lin api SECRET": /one line with no space, quote or backslash/,
    "lin\"SECRET": /one line with no space, quote or backslash/,
    "lin\\SECRET": /one line with no space, quote or backslash/,
    "lin\nSECRET": /one line with no space, quote or backslash/,
    [`SECRET${"x".repeat(4096)}`]: /longer than 4096 characters/,
  };
  for (const [value, why] of Object.entries(shapes)) {
    assert.throws(() => secretRequestOf({ name: "linear", setting: "key.path", value }), (error: unknown) => error instanceof SecretRefusal && why.test(error.message) && !/SECRET/.test(error.message), JSON.stringify(value.slice(0, 20)));
  }
  const request = secretRequestOf({ name: "linear", setting: "key.path", value: TOKEN });
  assert.equal(JSON.stringify(request).includes("SECRET"), false, "the request itself prints as <secret>");
  assert.equal(String(request.value), "<secret>");
});

test("A11-445: the place is the plugin's: a request never names a path, and the same rule decides the field the page draws", () => {
  const catalog = defaultCatalog();
  const linear = catalog.plugins.find(({ name }) => name === "linear")!;
  const report = resolveProviders({ tickets: { providers: { tracker: { provider: "linear", key: { keychain: "x" } }, codeHost: GITHUB } } }, catalog).blocks.tracker;
  assert.deepEqual(secretPlace(linear, "key.path", report, "darwin"), { why: "linear reads its secret from key.keychain, not key.path" });
  assert.deepEqual(secretPlace(linear, "key.keychain", report, "darwin"), { kind: "keychain", place: "x", held: true });
  assert.deepEqual(secretPlace(linear, "workingState", report, "darwin"), { why: "linear has no secret named workingState" });
  const telegram = catalog.plugins.find(({ name }) => name === "telegram")!;
  assert.match((secretPlace(telegram, "chairmanFile", report, "linux") as { why: string }).why, /^chairmanFile of telegram is not typed on this page: set it with `agent-org messaging:pair`$/);
});

test("A11-445: a store whose setting cannot then be pointed at the place says the secret is stored and the setting is not", async () => {
  const { home, hostPath, deps } = machine({});
  const base = await baseOf({ hostPath }, "host.json");
  const keyFile = join(home, ".config", "agent-org", "linear.key");
  const original = readFileSync(hostPath, "utf8");
  // A second writer changes the host file once the secret is on disk, between this store's preview and its write.
  const racing = { ...deps, get catalog() {
    if (existsSync(keyFile)) writeFileSync(hostPath, `${original}\n`);
    return deps.catalog;
  } };
  const refusal = await refusalOf(storeSecret(requestOf({ base }), racing));
  assert.match(refusal.message, /^stored key\.path of linear in the file .*linear\.key, but tickets\.providers\.tracker\.key was not pointed at it, so linear does not read it yet: the file changed since you looked/);
  assert.equal(readFileSync(keyFile, "utf8"), `${TOKEN}\n`);
});

test("A11-445: on a Mac a Keychain secret with no service named goes to the manifest's service, and the key is pointed at it as a whole", async () => {
  const { hostPath, deps, given } = machine({}, { platform: "darwin" });
  const stored = await storeSecret(requestOf({ setting: "key.keychain", base: await baseOf({ hostPath }, "host.json") }), deps);
  assert.deepEqual(given, [`add-generic-password -U -a "me" -s "agent-org-linear" -w "${TOKEN}"\n`]);
  assert.equal(stored.said, "stored key.keychain of linear in the Keychain service agent-org-linear, and pointed tickets.providers.tracker.key at it");
  assert.deepEqual((JSON.parse(readFileSync(hostPath, "utf8")) as { tickets: { providers: { tracker: { key: unknown } } } }).tickets.providers.tracker.key, { keychain: "agent-org-linear" });
});
