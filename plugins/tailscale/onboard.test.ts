// no-token: none -- `tailscale` is a stand-in that holds a serve config in memory
//
// THE ONBOARD STEPS AND THE RELEASE OF THE TAILSCALE PLUGIN (A11-162).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { OnboardStepDeps, PluginDeps } from "../../src/plugins/manifest.ts";
import { NOT_ON_PATH, ONBOARD_STEPS, release, restore } from "./onboard.ts";
import { createTailscale, freshState, type TailscaleState } from "./stub.ts";

const NAME = "agents.tail1234.ts.net";
const SETTINGS = { uiPort: 4801, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}" };

const depsOf = (state: TailscaleState): PluginDeps => fakePluginDeps({ exec: createTailscale(state), env: { USER: "agent" } });
const stepDeps = (deps: PluginDeps): OnboardStepDeps => ({ ...deps, interactive: false, answered: true, ask: async () => "", askSecret: async () => "", writeFile: () => undefined, platform: "linux", home: "/home/agent", agentOrgHome: "/home/agent/.agent-org", flags: {} });
/** A Tailscale that serves this board's two entries, the page and the terminal, on the default tailnet ports. */
function boardServed(): TailscaleState {
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  return state;
}
const step = (name: string) => ONBOARD_STEPS.find((candidate) => candidate.name === name)!;

test("the plugin onboards in three steps, each with its explanation", () => {
  assert.deepEqual(ONBOARD_STEPS.map(({ name }) => name), ["tailscale installed", "tailscale operator", "tailnet ports"]);
  for (const each of ONBOARD_STEPS) assert.ok(each.explain.length > 0, each.name);
});

test("onboard says Tailscale is not on PATH, in the words it had, and says nothing when it is", async () => {
  const absent = fakePluginDeps({ exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }) });
  assert.deepEqual(await step("tailscale installed").run({}, stepDeps(absent)), { ok: true, detail: NOT_ON_PATH });
  assert.match(NOT_ON_PATH, /^tailscale is not on PATH: the board and the terminal are served on the tailnet once Tailscale is installed and `tailscale up` has run/);
  assert.deepEqual(await step("tailscale installed").run({}, stepDeps(depsOf(freshState()))), { ok: true, detail: "" });
});

test("onboard says the operator command when Tailscale refuses this user's serve config, and nothing otherwise", async () => {
  const exec = createTailscale(freshState());
  const refusing = fakePluginDeps({ env: { USER: "agent" }, exec: (file, args) => (args[0] === "serve" && args[1] === "status" ? { status: 1, stdout: "", stderr: "Access denied: serve config denied" } : exec(file, args)) });
  const denied = await step("tailscale operator").run({}, stepDeps(refusing));
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /agent is not the operator of this machine's Tailscale.*run `sudo tailscale set --operator=agent`/);
  assert.deepEqual(await step("tailscale operator").run({}, stepDeps(depsOf(freshState()))), { ok: true, detail: "" });
  assert.deepEqual(await step("tailscale operator").run({}, stepDeps(fakePluginDeps({ exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }) }))), { ok: true, detail: "" }, "no Tailscale: the first step already said so");
});

test("the ports step writes the default tailnetPorts when the block names none, keeps the block's own, and says a port that is taken", async () => {
  const answered = (deps: PluginDeps, over: Partial<OnboardStepDeps> = {}): OnboardStepDeps => ({ ...stepDeps(deps), ...over });
  const written = await step("tailnet ports").run({}, answered(depsOf(freshState())));
  assert.deepEqual(written, { ok: true, detail: "", settings: { tailnetPorts: { ui: 9443, terminal: 9444 } } }, "a profile has the defaults written out, as it always did");
  const interactive = await step("tailnet ports").run({}, answered(depsOf(freshState()), { answered: false }));
  assert.deepEqual(interactive, { ok: true, detail: "", settings: {} }, "an interactive onboard leaves a block that names none alone, so a re-onboard changes no host file's meaning");
  const kept = await step("tailnet ports").run({ tailnetPorts: { ui: 9500 } }, stepDeps(depsOf(freshState())));
  assert.deepEqual(kept, { ok: true, detail: "", settings: {} }, "a block that names ports keeps them");
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
  const taken = await step("tailnet ports").run(SETTINGS, stepDeps(depsOf(state)));
  assert.equal(taken.ok, false);
  assert.match(taken.detail, /port 9443 already serves http:\/\/127\.0\.0\.1:9999 on the tailnet/);
  const absent = await step("tailnet ports").run({}, stepDeps(fakePluginDeps({ exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }) })));
  assert.deepEqual(absent, { ok: true, detail: "", settings: { tailnetPorts: { ui: 9443, terminal: 9444 } } }, "defaults are written for a profile whether or not Tailscale is installed yet");
});

test("release takes this board's two entries off the tailnet and no other, and says which", () => {
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  state.web[`${NAME}:8443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } };
  state.web[`${NAME}:443`] = { Handlers: { "/webhook": { Proxy: "http://127.0.0.1:8787" } } };
  state.funnel[`${NAME}:443`] = true;
  const result = release(SETTINGS, depsOf(state));
  assert.deepEqual(result, { ok: true, detail: "took this board's tailscale serve entries off the tailnet: ui (port 9443), terminal (port 9444)", settings: { released: [{ service: "ui", port: 9443, local: 4801 }, { service: "terminal", port: 9444, local: 7318 }] } });
  assert.deepEqual(Object.keys(state.web), [`${NAME}:8443`, `${NAME}:443`], "the trace pages and the event feed's Funnel are not this board's");
  assert.equal(state.funnel[`${NAME}:443`], true);
  assert.deepEqual(state.calls.filter((args) => args.includes("off")), [["serve", "--https=9443", "off"], ["serve", "--https=9444", "off"]], "each removal names one port");
});

test("release leaves a port that is free or another's alone, and says nothing when it removed nothing", () => {
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
  assert.deepEqual(release(SETTINGS, depsOf(state)), { ok: true, detail: "" });
  assert.deepEqual(Object.keys(state.web), [`${NAME}:9443`], "another entry on the port is not removed");
  assert.equal(state.calls.some((args) => args.includes("off")), false);
});

test("release is refused by name when Tailscale cannot say what it serves, and removes nothing", () => {
  const stopped = freshState({ backend: "Stopped" });
  stopped.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  const result = release(SETTINGS, depsOf(stopped));
  assert.equal(result.ok, false);
  assert.match(result.detail, /cannot take the ui entry on tailnet port 9443 off: Tailscale is not Running/);
  assert.equal(Object.keys(stopped.web).length, 1);
  const missing = release(SETTINGS, fakePluginDeps({ exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }) }));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /tailscale is not on PATH/);
});

test("release is refused with the operator fix when Tailscale will not let this user remove the entry", () => {
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  const exec = createTailscale(state);
  const refusing: PluginDeps["exec"] = (file, args) => (args.includes("off") ? { status: 1, stdout: "", stderr: "Access denied: serve config denied" } : exec(file, args));
  const result = release(SETTINGS, fakePluginDeps({ exec: refusing, env: { USER: "agent" } }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /cannot take the ui entry on tailnet port 9443 off: .*run `sudo tailscale set --operator=agent`/);
});

test("restore serves again exactly what release took off, so a change refused after the release leaves the tailnet as it was", () => {
  const state = boardServed();
  const before = structuredClone(state.web);
  const released = release(SETTINGS, depsOf(state));
  assert.deepEqual(Object.keys(state.web), [], "released");
  const back = restore(SETTINGS, depsOf(state), released);
  assert.equal(back.ok, true, back.detail);
  assert.match(back.detail, /put this board's tailscale serve entries back on the tailnet: ui \(port 9443\), terminal \(port 9444\)/);
  assert.deepEqual(state.web, before);
});

test("restore has nothing to serve when release removed nothing, and says nothing", () => {
  const state = freshState();
  assert.deepEqual(restore(SETTINGS, depsOf(state), release(SETTINGS, depsOf(state))), { ok: true, detail: "" });
  assert.equal(state.calls.some((args) => args.includes("--https=9443") && !args.includes("status")), false);
});

test("release that cannot remove the second entry puts the first back, so a refusal leaves the tailnet as it was", () => {
  const state = boardServed();
  const before = structuredClone(state.web);
  const exec = createTailscale(state);
  const refusing: PluginDeps["exec"] = (file, args) => (args.includes("--https=9444") && args.includes("off") ? { status: 1, stdout: "", stderr: "busy" } : exec(file, args));
  const result = release(SETTINGS, fakePluginDeps({ exec: refusing, env: { USER: "agent" } }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /cannot take the terminal entry on tailnet port 9444 off: .*; the entries already removed were put back/);
  assert.deepEqual(state.web, before);
});
