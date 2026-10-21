// no-token: none -- the wrapper is rendered and asked about, never run: the template is read from this folder, the minter is a recorded `exec`, and nothing reaches `gh` or the network
//
// THE GITHUB PLUGIN'S ROUTING WRAPPER, as core asks about it (A11-160, contract 1.3's `wrapper`): where it is installed and the text it must hold, why a write of it must be refused (A11-84's rules,
// each with its control), what is wrong with an installed copy, whether the identity block is stale, and whether a role's App mints. Running the wrapper itself is `app-token.test.ts`, and core's writer
// over these rules is `src/packaging/gh-wrapper-guard.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";
import type { WrapperInputs } from "../../src/plugins/contracts/code-host.ts";
import { appRolesOf, appsOfSettings, createWrapper, inputsOfSettings, wrapperIdentity, wrapperRoles } from "./wrapper.ts";

const PLACE: WrapperInputs["place"] = { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name: string) => `/opt/state/${name}` };
const app = (role: string) => ({ mode: "github-apps" as const, appId: `id-${role}`, keyPath: `/opt/keys/${role}.pem`, ...(role === "workers" ? { installationId: "777", slug: "acme-workers" } : {}) });
const users = { mode: "user-accounts" as const };
/** Inputs whose declared Apps are `roles`, every other role on the person's account. */
const inputsOf = (roles: readonly string[], place = PLACE): WrapperInputs => ({
  place, accounts: { workers: "/opt/workers", leads: "/opt/leads" },
  identity: Object.fromEntries(["scheduler", "workers", "managers", "reviewer"].map((role) => [role, roles.includes(role) ? app(role) : users])) as WrapperInputs["identity"],
});

type Exec = (file: string, args: readonly string[], options?: ExecOptions) => ExecResult;
const NO_PROGRAM: Exec = () => ({ status: null, stdout: "", stderr: "no program" });
/** A wrapper reading the template from disk, with `exec` as the minter's run. */
const wrapperWith = (exec: Exec = NO_PROGRAM, readFile: (path: string) => string = (path) => readFileSync(path, "utf8"), env: Record<string, string | undefined> = {}) => createWrapper({ exec, readFile, env });

test("the wrapper is an owned file: installed as <binDir>/gh, executable, holding the template filled from the inputs, no placeholder left", () => {
  const { target, mode, expected } = wrapperWith().file(inputsOf(["workers"]));
  assert.deepEqual([target, mode], ["/opt/host/bin/gh", 0o755]);
  assert.ok(expected !== null && !expected.includes("@@"), "every placeholder the template carries has a value");
  assert.match(expected!, /^GH_REAL=\$\{A11Y_GH_REAL:-\/opt\/host\/bin\/gh-real\}$/m);
  assert.match(expected!, /^WORKERS_DIR=\$\{A11Y_WORKERS_DIR:-\/opt\/workers\}$/m);
  assert.match(expected!, /^LEADS_DIR=\$\{A11Y_LEADS_DIR:-\/opt\/leads\}$/m);
  assert.match(expected!, /^  app_dir=\$\{A11Y_APP_TOKEN_DIR:-\/opt\/state\/app-tokens\}$/m);
  assert.match(expected!, /^  app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-\/opt\/agent-org\/plugins\/github\/app-token\.ts\}$/m, "the minter is the plugin's, in the installed tool");
  assert.match(expected!, /"\$\{A11Y_GH_FLAG_SCRIPT:-\/opt\/agent-org\/plugins\/github\/author-flag\.ts\}" "\$\{A11Y_GH_CANARY_STATE:-\/opt\/state\/machinery-canary\.json\}"/, "the authoring switch's script and the canary state it reads");
  assert.match(expected!, /^    workers\) app_id='id-workers'; app_key='\/opt\/keys\/workers\.pem'; app_inst='777'; app_slug='acme-workers' ;;$/m, "an App's arm, quoted for sh");
});

test("a host whose tool is not installed runs the programs from the primary project's own copy of the tool", () => {
  const { expected } = wrapperWith().file(inputsOf([], { ...PLACE, tool: undefined }));
  assert.match(expected!, /A11Y_APP_TOKEN_SCRIPT:-\/opt\/project\/packages\/agent-org\/plugins\/github\/app-token\.ts\}/);
  assert.match(expected!, /A11Y_GH_FLAG_SCRIPT:-\/opt\/project\/packages\/agent-org\/plugins\/github\/author-flag\.ts\}/);
});

test("an App's id, key and slug are quoted for sh whatever they hold, and a role with none has an empty installation and slug", () => {
  const awkward: WrapperInputs = { ...inputsOf([]), identity: { ...inputsOf([]).identity, reviewer: { mode: "github-apps", appId: "4242", keyPath: "/home/h/it's here/reviewer.pem" } } };
  assert.match(wrapperWith().file(awkward).expected!, /^    reviewer\) app_id='4242'; app_key='\/home\/h\/it'\\''s here\/reviewer\.pem'; app_inst=''; app_slug='' ;;$/m);
});

test("a template that cannot be read is no text (never the empty one), and one with a placeholder no value fills is refused by name", () => {
  assert.equal(wrapperWith(NO_PROGRAM, () => { throw new Error("ENOENT"); }).file(inputsOf([])).expected, null);
  assert.throws(() => wrapperWith(NO_PROGRAM, () => "#!/bin/sh\n@@noSuchValue@@\n").file(inputsOf([])), /gh: `@@noSuchValue@@` is a placeholder no value fills/);
});

test("the roles an App is declared for are the wrapper's role table, in the wrapper's order whatever order they were declared in", () => {
  const wrapper = wrapperWith();
  assert.deepEqual(wrapper.appRoles(inputsOf(["reviewer", "scheduler"])), ["scheduler", "reviewer"]);
  assert.deepEqual(wrapperRoles(wrapper.file(inputsOf(["reviewer", "scheduler"])).expected!), ["scheduler", "reviewer"], "what the text names is what the inputs declare");
  assert.deepEqual(wrapperRoles(wrapper.file(inputsOf([])).expected!), [], "no App declared: an empty table");
  assert.equal(wrapperRoles("#!/bin/sh\nexec /usr/bin/gh \"$@\"\n"), null, "a copy from before #4900 names no table at all");
  assert.deepEqual(appRolesOf(inputsOf(["managers"])), ["managers"]);
});

test("the identity block is the roles line and the app_declared() body, and it moves with the declaration and with nothing else", () => {
  const wrapper = wrapperWith();
  const one = wrapper.file(inputsOf(["workers"])).expected!;
  assert.equal(wrapperIdentity(one), wrapperIdentity(one.replace("# gh identity wrapper.", "# gh identity wrapper. (edited)")), "a comment is not identity");
  assert.notEqual(wrapperIdentity(one), wrapperIdentity(wrapper.file(inputsOf(["workers", "managers"])).expected!));
  assert.equal(wrapperIdentity("#!/bin/sh\n"), null);
  assert.equal(wrapper.identityStale(inputsOf(["workers"]), one), false, "the same declaration is not stale");
  assert.equal(wrapper.identityStale(inputsOf(["workers", "managers"]), one), true, "a role the copy lacks is");
  assert.equal(wrapper.identityStale(inputsOf([]), "#!/bin/sh\nexec /usr/bin/gh\n"), false, "a copy from before #4900 on a host with no App behaves the same: nothing to take effect");
  assert.equal(wrapper.identityStale(inputsOf(["workers"]), "#!/bin/sh\nexec /usr/bin/gh\n"), true, "and on a host with one it is mended");
  assert.equal(wrapperWith(NO_PROGRAM, () => { throw new Error("ENOENT"); }).identityStale(inputsOf(["workers"]), one), false, "an unreadable shipped copy is nothing to write");
  const moved = textFor(["workers"], { ...PLACE, tool: "/opt/older-tool" });
  assert.equal(wrapper.identityStale(inputsOf(["workers"]), moved), true, "the same declaration with its programs where an older tool kept them is stale: they would run nothing");
  assert.equal(wrapper.identityStale(inputsOf([]), textFor([], { ...PLACE, tool: "/opt/older-tool" })), false, "but a host with no App runs none of them, so a moved tool is nothing to mend");
});

// ---- the writing rules, each with its control -------------------------------------------------------------------------------------------

/** A write of `text` the wrapper is asked about, outside a test run's rules unless `under` says so. */
const refusal = (inputs: WrapperInputs, text: string, extra: { installed?: string | null; allowNoApps?: boolean; under?: boolean; realBin?: string; target?: string } = {}) =>
  wrapperWith().refusal({ inputs, target: extra.target ?? "/opt/host/bin/gh", text, installed: extra.installed ?? null, allowNoApps: extra.allowNoApps ?? false, under: extra.under ?? false, realBin: extra.realBin ?? "/nonexistent/real-bin" });
const textFor = (roles: readonly string[], place = PLACE) => wrapperWith().file(inputsOf(roles, place)).expected!;

test("A11-84 POSITIVE: a wrapper that names what the host declares may be written, over nothing and over itself", () => {
  assert.equal(refusal(inputsOf(["workers"]), textFor(["workers"])), null);
  assert.equal(refusal(inputsOf(["workers"]), textFor(["workers"]), { installed: textFor(["workers"]) }), null);
  assert.equal(refusal(inputsOf([]), textFor([])), null, "a host with no App writes a wrapper with none");
});

test("A11-84 REFUSAL 1: an empty role table while the host declares Apps is refused, naming the roles", () => {
  assert.equal(refusal(inputsOf(["workers", "reviewer"]), textFor([])), "host.json declares github-apps roles (workers, reviewer), but the rendered wrapper names none");
});

test("A11-84 REFUSAL 2, THE INCIDENT: a wrapper naming no App over an installed one that names some is refused, unless the host said it really dropped them", () => {
  const installed = textFor(["scheduler", "workers", "managers", "reviewer"]);
  assert.match(refusal(inputsOf([]), textFor([]), { installed }) ?? "", /^the rendered wrapper names no App role and the installed one names scheduler, workers, managers, reviewer: that drops their identity\. `host:install --allow-no-apps` writes it/);
  assert.equal(refusal(inputsOf([]), textFor([]), { installed, allowNoApps: true }), null, "--allow-no-apps is the one way past it");
  assert.equal(refusal(inputsOf([]), textFor([]), { installed: textFor([]) }), null, "CONTROL: an installed copy that names none drops nothing");
  assert.equal(refusal(inputsOf([]), textFor([]), { installed: "#!/bin/sh\nexec /usr/bin/gh\n" }), null, "CONTROL: a copy from before #4900 names none either");
});

test("A11-84 REFUSAL 3: in production a wrapper that runs its minter from /tmp is refused as a scratch checkout's; elsewhere, and in a test run, it is not", () => {
  const scratch = textFor(["workers"], { ...PLACE, tool: "/tmp/claude-1000/scratch/project" });
  assert.match(refusal(inputsOf(["workers"]), scratch) ?? "", /^the wrapper runs \/tmp\/claude-1000\/scratch\/project\/plugins\/github\/app-token\.ts, which is in a temporary directory, so it was rendered from a scratch checkout$/);
  assert.equal(refusal(inputsOf(["workers"]), textFor(["workers"])), null, "CONTROL: the installed tool's path is written");
  assert.equal(refusal(inputsOf(["workers"]), scratch, { under: true }), null, "under a test run a fixture's checkout is a temporary directory by construction");
  assert.match(refusal(inputsOf(["workers"]), textFor(["workers"], { ...PLACE, tool: "/tmp/x" })) ?? "", /which is in a temporary directory/, "the authoring switch's script is as much a program the wrapper runs as the minter is");
});

test("A11-84 REFUSAL 4: a test run may not write the real home's bin directory, and may write a fixture's", () => {
  const inputs = inputsOf(["workers"]);
  assert.equal(refusal(inputs, textFor(["workers"]), { under: true, realBin: "/home/x/.local/bin", target: "/home/x/.local/bin/gh" }), "a test run may not write the real home's bin directory: a test takes its bin directory from a fixture");
  assert.equal(refusal(inputs, textFor(["workers"]), { under: true, realBin: "/home/x/.local/bin", target: "/scratch/bin/gh" }), null);
  assert.equal(refusal(inputs, textFor(["workers"]), { under: false, realBin: "/home/x/.local/bin", target: "/home/x/.local/bin/gh" }), null, "outside a test run the real bin directory is where it goes");
});

test("a text with no role table at all is refused: it is no rendering of this template", () => {
  assert.equal(refusal(inputsOf([]), "#!/bin/sh\nexec /usr/bin/gh \"$@\"\n"), "the rendered text has no App role table to check");
});

// ---- the installed copy -----------------------------------------------------------------------------------------------------------

test("A11-84: the detector says what is wrong with the installed wrapper, and nothing when it is the one the inputs declare", () => {
  const wrapper = wrapperWith();
  const inputs = inputsOf(["workers"]);
  const target = "/opt/host/bin/gh";
  const expected = wrapper.file(inputs).expected!;
  assert.equal(wrapper.divergence(inputs, { target, installed: expected }), null, "POSITIVE: the matching wrapper");
  assert.equal(wrapper.divergence(inputs, { target, installed: null }), `there is no gh wrapper at ${target}`);
  assert.equal(wrapper.divergence(inputs, { target, installed: textFor([]) }), `${target} names no App role, but host.json declares workers, so no App token is minted for any of them`);
  assert.equal(wrapper.divergence(inputs, { target, installed: `${expected}# hand-edited\n` }), `${target} is not the wrapper this repository renders from host.json, though its App roles agree`);
  assert.equal(wrapper.divergence(inputs, { target, installed: textFor(["managers"]) }), `${target} names managers, and host.json declares workers`);
  assert.equal(wrapper.divergence(inputsOf([]), { target, installed: textFor(["managers"]) }), `${target} names managers, and host.json declares no App`);
  assert.equal(wrapperWith(NO_PROGRAM, () => { throw new Error("ENOENT"); }).divergence(inputs, { target, installed: expected }), "the repository's gh wrapper could not be read, so this host cannot be compared to it");
});

// ---- the mint probe ---------------------------------------------------------------------------------------------------------------

test("A11-84: the mint probe runs the minter the wrapper names with the declared App and a token directory of its own, and names the first line the minter printed", () => {
  const calls: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
  const ok: Exec = (file, args, options) => { calls.push({ file, args, env: options?.env }); return { status: 0, stdout: "ghs_token\n", stderr: "" }; };
  const inputs = inputsOf(["workers"]);
  assert.equal(wrapperWith(ok).mintFailure(inputs, "workers"), null, "POSITIVE: it mints");
  assert.deepEqual([calls[0].file, calls[0].args], ["node", ["/opt/agent-org/plugins/github/app-token.ts", "workers"]], "the minter the wrapper names, run for the role");
  assert.deepEqual([calls[0].env?.A11Y_APP_ID, calls[0].env?.A11Y_APP_KEY_PATH, calls[0].env?.A11Y_APP_INSTALLATION_ID], ["id-workers", "/opt/keys/workers.pem", "777"]);
  assert.ok(calls[0].env?.A11Y_APP_TOKEN_DIR !== undefined && !existsSync(calls[0].env.A11Y_APP_TOKEN_DIR), "the scratch token directory is gone afterwards");

  assert.equal(wrapperWith(() => ({ status: 2, stdout: "", stderr: "could not read the key /opt/keys/workers.pem\nand a second line" })).mintFailure(inputs, "workers"), "could not read the key /opt/keys/workers.pem");
  assert.equal(wrapperWith(() => ({ status: 0, stdout: "two words\n", stderr: "" })).mintFailure(inputs, "workers"), "the minter exited 0", "a token is one word; a stdout of two is no token");
  assert.equal(wrapperWith(() => ({ status: 3, stdout: "", stderr: "\n" })).mintFailure(inputs, "workers"), "the minter exited 3");
  assert.equal(wrapperWith(() => { throw new Error("a role the host does not declare is not minted"); }).mintFailure(inputs, "scheduler"), null);
  assert.equal(wrapperWith(ok, undefined, { A11Y_APP_NODE: "sh" }).mintFailure(inputs, "workers"), null);
  assert.equal(calls.at(-1)?.file, "sh", "the interpreter is the one the wrapper's own `A11Y_APP_NODE` names");
});

// ---- the plugin's settings as the inputs ------------------------------------------------------------------------------------------

test("the settings are read into inputs leniently: the host file's reader has refused what is malformed, so an entry that is no App is the person's account", () => {
  const settings = { gh: { workers: "/w", leads: "/l" }, identity: { workers: { mode: "github-apps", appId: 99, keyPath: "/k.pem", installationId: 5, slug: "s" }, reviewer: { mode: "github-apps", appId: "1" }, managers: "nonsense", extra: { mode: "github-apps", appId: "1", keyPath: "/k" } } };
  const inputs = inputsOfSettings(settings, PLACE);
  assert.deepEqual(inputs.accounts, { workers: "/w", leads: "/l" });
  assert.deepEqual(inputs.identity, { scheduler: users, workers: { mode: "github-apps", appId: "99", keyPath: "/k.pem", installationId: "5", slug: "s" }, managers: users, reviewer: users }, "an integer id is its string, an App with no key is none, and a role that is not one is left out");
  assert.deepEqual(inputsOfSettings({}, PLACE).accounts, { workers: "", leads: "" });
  assert.deepEqual(appsOfSettings(settings).map(({ role }) => role), ["workers"]);
  assert.deepEqual(appsOfSettings({}), []);
});

test("the template is shipped beside the renderer, and is the wrapper: a shell script that routes by workspace", () => {
  const text = readFileSync(join(import.meta.dirname, "wrapper", "gh"), "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n# gh identity wrapper."));
  assert.equal([...text.matchAll(/@@([A-Za-z0-9]+)@@/g)].map(([, name]) => name).filter((name, at, all) => all.indexOf(name) === at).sort().join(), "appDeclared,appRoles,appTokenDir,appTokenScript,authorFlagScript,binDir,canaryStateFile,leadsDir,workersDir",
    "the nine values the renderer fills: a tenth would be refused by name when the wrapper is rendered");
});
