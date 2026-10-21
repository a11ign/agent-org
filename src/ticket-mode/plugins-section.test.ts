// no-token: none -- pure: the page's rules for the Plugins section, with no browser
import { test } from "node:test";
import assert from "node:assert/strict";
import { concernOfGroup, CONCERNS, controlsOf, emptyWords, isProviderLine, keyMatches, ofAnotherPlugin, outcomeWords, PLUGIN_GROUPS, rowWords } from "./plugins-section.ts";

test("A11-163: the concerns are listed in the chairman's order, and the five that are blocks are the groups the section draws under them", () => {
  assert.deepEqual(CONCERNS.map(({ title }) => title), ["Tracker", "Code host", "Publisher", "Reviewer", "Exposure", "Messaging"]);
  assert.deepEqual(PLUGIN_GROUPS, ["Tracker", "Code host", "Publisher", "Reviewer", "Exposure"]);
  assert.deepEqual([concernOfGroup("Code host"), concernOfGroup("Workers")], ["codeHost", null]);
});

test("A11-163: a row says its name, version, contract and state in words", () => {
  assert.equal(rowWords({ name: "linear", version: "v0.99.0", contract: "1.1", state: "failed", where: "plugins/linear", description: "d" }), "linear. Version v0.99.0. Contract 1.1. State: failed.");
});

test("A11-163: the plugin and enabled lines are shown by the state and the controls, not as settings", () => {
  assert.deepEqual(["tickets.providers.tracker.provider", "tickets.providers.exposure.enabled", "tickets.providers.exposure.port", "tickets.providers.codeHost.identity.scheduler.mode"].map(isProviderLine), [true, true, false, false]);
});

test("A11-163: a schema key stands for the rows it names, a <name> for one segment of a key", () => {
  assert.equal(keyMatches("tickets.providers.exposure.port", "tickets.providers.exposure.port"), true);
  assert.equal(keyMatches("tickets.providers.exposure.port", "tickets.providers.exposure.portX"), false, "no pattern characters leak");
  assert.equal(keyMatches("tickets.providers.codeHost.identity.<role>.keyPath", "tickets.providers.codeHost.identity.scheduler.keyPath"), true);
  assert.equal(keyMatches("tickets.providers.codeHost.identity.<role>.keyPath", "tickets.providers.codeHost.identity.a.b.keyPath"), false);
});

test("A11-163: a setting only another plugin of the concern declares is not drawn while a plugin runs, and a setting nobody declares always is", () => {
  const local = { installed: true, enabled: true, settingKeys: ["tickets.providers.exposure.port"] };
  const tailscale = { installed: false, enabled: false, settingKeys: ["tickets.providers.exposure.port", "tickets.providers.exposure.tailnetPorts"] };
  assert.equal(ofAnotherPlugin([local, tailscale], "tickets.providers.exposure.tailnetPorts"), true);
  assert.equal(ofAnotherPlugin([local, tailscale], "tickets.providers.exposure.port"), false, "a setting the plugin in force declares too is its own");
  assert.equal(ofAnotherPlugin([local, tailscale], "tickets.port"), false, "an old key is the concern's");
  assert.equal(ofAnotherPlugin([{ ...local, installed: false, enabled: false }, tailscale], "tickets.providers.exposure.tailnetPorts"), true, "and with none running, a plugin's own setting is still not the concern's");
});

test("A11-163: the empty state says what is missing and the command that adds it", () => {
  assert.equal(emptyWords({ text: "No tracker enabled: the board cannot run", commands: ["agent-org plugin enable linear"] }), "No tracker enabled: the board cannot run. Run agent-org plugin enable linear.");
  assert.equal(emptyWords({ text: "None", commands: ["agent-org plugin install slack", "agent-org plugin install atomic"] }), "None. Run agent-org plugin install slack or agent-org plugin install atomic.");
});

test("A11-163: Configure is drawn last, and an action's outcome says what it did and when it is in force", () => {
  assert.deepEqual(controlsOf(["configure", "disable", "uninstall"]), ["disable", "uninstall", "configure"]);
  assert.equal(outcomeWords({ said: "disabled tailscale: the board is served on loopback only", inForce: ["in force after the board restarts."] }), "disabled tailscale: the board is served on loopback only. in force after the board restarts.");
});
