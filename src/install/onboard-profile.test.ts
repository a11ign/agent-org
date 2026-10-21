// no-token: none -- a profile is parsed from text and answered by a stand-in question; no file is read and no network is used
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Catalog, CatalogPlugin } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { askProfile, parseProfile, profilePathOf, profileText, ProfileRefusal, providerBlocksOf } from "./onboard-profile.ts";

/** A complete profile with invented names, as the README's example shows one. */
const PROFILE = {
  schema: 1,
  tracker: { provider: "linear", pick: { team: "ZZ" }, workingState: "In Progress", plannedState: "Planned" },
  codeHost: { provider: "github", reviewerApp: { slug: "example-reviewer", appId: 111, installationId: 222 } },
  publish: { provider: "none" },
  reviewer: { provider: "atomic" },
  exposure: { provider: "tailscale" },
  conventions: { plugin: "example@example-marketplace", marketplace: "example-org/example-plugin" },
  repos: [{ name: "example-app", remote: "example-org/example-app", path: "~/repos/example-app" }],
};
const text = (over: Record<string, unknown> = {}) => JSON.stringify({ ...PROFILE, ...over });

test("a profile is a name under the agent-org home, or a path with a slash; a relative path and a bad name are refused", () => {
  const env = { AGENT_ORG_HOME: "/state/agent-org" };
  assert.equal(profilePathOf("laptop", env, "/home/me"), "/state/agent-org/profiles/laptop.json");
  assert.equal(profilePathOf("~/copies/laptop.json", {}, "/home/me"), "/home/me/copies/laptop.json");
  assert.equal(profilePathOf("/abs/laptop.json", {}, "/home/me"), "/abs/laptop.json");
  assert.throws(() => profilePathOf("relative/laptop.json", {}, "/home/me"), /must be an absolute path/);
  assert.throws(() => profilePathOf("bad name", {}, "/home/me"), ProfileRefusal);
});

test("a profile parses, and each refusal names the field it is about", () => {
  assert.equal(parseProfile(text()).tracker.provider, "linear");
  assert.throws(() => parseProfile(text({ extra: 1 })), /extra is not a profile key/);
  assert.throws(() => parseProfile(text({ schema: 2 })), /schema must be 1/);
  assert.throws(() => parseProfile(text({ tracker: { provider: "jira" } })), /tracker\.provider must be one of "linear"/);
  assert.throws(() => parseProfile(text({ reviewer: "atomic" })), /reviewer must be an object with a provider/);
  assert.throws(() => parseProfile(text({ repos: [] })), /repos must list at least one repository/);
  assert.throws(() => parseProfile(text({ repos: [{ name: "a b", path: "/x" }] })), /repos\[0\]\.name is a clone's name/);
  assert.throws(() => parseProfile(text({ codeHost: { provider: "github", reviewerApp: { slug: "s", appId: 0, installationId: 1 } } })), /codeHost\.reviewerApp\.appId/);
  assert.throws(() => parseProfile(text({ conventions: { plugin: "no-marketplace", marketplace: "o/r" } })), /conventions\.plugin is the plugin/);
  assert.throws(() => parseProfile("{ not json"), /is not valid JSON/);
});

test("the provider blocks a profile names are the host file's: pick moves to tickets, the App's identity is kept apart, and tailscale takes the default ports", () => {
  const blocks = providerBlocksOf(parseProfile(text()));
  assert.deepEqual(blocks.tracker, { provider: "linear", workingState: "In Progress", plannedState: "Planned" });
  assert.deepEqual(blocks.pick, { team: "ZZ" });
  assert.deepEqual(blocks.reviewerApp, { slug: "example-reviewer", appId: 111, installationId: 222 });
  assert.deepEqual(blocks.codeHost, { provider: "github" });
  assert.deepEqual(blocks.exposure, { provider: "tailscale" }, "a plugin's own defaults are written by its onboard step (A11-162), not by the profile");
});

test("a profile is written as copyable JSON, and never holds a secret: the answers are the only text in it", async () => {
  const answers = ["ZZ", "example@example-marketplace", "atomic", "none", "local", "example-reviewer", "111", "222", "example-org/example-plugin"];
  const profile = await askProfile({ ask: async () => answers.shift() ?? "" }, [{ name: "example-app", path: "/src/example-app" }]);
  assert.deepEqual(profile.conventions, { plugin: "example@example-marketplace", marketplace: "example-org/example-plugin" });
  assert.deepEqual(profile.codeHost.reviewerApp, { slug: "example-reviewer", appId: 111, installationId: 222 });
  const written = profileText(profile);
  assert.ok(!/key|token|secret|\.pem/i.test(written), "no secret field is written");
  assert.deepEqual(parseProfile(written), profile, "what is written reads back the same");
});

test("the questions take their defaults on an empty answer, and a publisher other than none is refused", async () => {
  const profile = await askProfile({ ask: async () => "" }, [{ name: "example-app", path: "/src/example-app" }]);
  assert.equal(profile.conventions, undefined, "no conventions plugin by default");
  assert.deepEqual(profile.exposure, { provider: "local" });
  assert.deepEqual(profile.reviewer, { provider: "atomic" });
  await assert.rejects(askProfile({ ask: async (question) => (question.startsWith("Publisher") ? "slack" : "") }, []), /publish: onboard asks only for none/);
});

// The profile committed for the live check holds invented names and fake paths only, and it reads as a profile onboard accepts.
test("the example profile committed for the live check parses, and names no secret", () => {
  const text = readFileSync(new URL("./fixtures/onboard-profile.example.json", import.meta.url), "utf8");
  assert.equal(parseProfile(text).conventions?.plugin, "example@example-marketplace");
  assert.ok(!/key|token|secret|\.pem/i.test(text), "no secret field or key path is named");
});

// ---- A11-163: a profile names plugins of the registry

/** The catalog a test reads: this checkout's, with `plugin` added to it and no concern pinned to core's built-in. */
const catalogWith = (plugin: Partial<CatalogPlugin> & Pick<CatalogPlugin, "name" | "concern">): Catalog => {
  const base = defaultCatalog();
  return { ...base, pins: {}, plugins: [...base.plugins, { contract: "1.1", description: "A plugin.", entry: "index.ts", settings: {}, tooling: { mcpServers: [], connectors: [], skills: [] }, where: "bundled", dir: "/checkout/plugins/x", movedBy: null, ...plugin }] };
};

test("A11-163: a block's provider is checked against the registry: a bundled plugin of the concern is named by the profile, with no list written in the profile reader", () => {
  const catalog = catalogWith({ name: "jira", concern: "tracker" });
  assert.equal(parseProfile(text({ tracker: { provider: "jira" } }), catalog).tracker.provider, "jira");
  assert.throws(() => parseProfile(text({ tracker: { provider: "jira" } })), /tracker\.provider must be one of "linear", not "jira"/, "the real catalog has no jira");
  assert.equal(parseProfile(text({ exposure: { provider: "local" } })).exposure.provider, "local");
  assert.equal(parseProfile(text({ publish: { provider: "slack" } })).publish.provider, "slack", "slack is the publisher core runs");
});

test("A11-163: a profile that names a fake, a plugin of another concern or an unknown plugin is refused by the field and the name", () => {
  assert.throws(() => parseProfile(text({ tracker: { provider: "fake-tracker" } })), /tracker\.provider must be one of "linear", not "fake-tracker"/);
  assert.throws(() => parseProfile(text({ tracker: { provider: "github" } })), /tracker\.provider must be one of "linear", not "github"/);
  assert.throws(() => parseProfile(text({ reviewer: { provider: "codex" } })), /reviewer\.provider must be one of "atomic", "none", not "codex"/);
  assert.throws(() => parseProfile(text({ exposure: { provider: "ngrok" } })), /exposure\.provider must be one of "local", "tailscale", not "ngrok"/);
  assert.throws(() => parseProfile(text({ codeHost: { provider: "gitlab" } })), /codeHost\.provider must be one of "github", not "gitlab"/);
  const refused = { ...defaultCatalog(), plugins: defaultCatalog().plugins.filter(({ name }) => name !== "tailscale"), refusals: [{ plugin: "tailscale", why: "plugin tailscale: package.json is not valid JSON" }] };
  assert.throws(() => parseProfile(text(), refused), /exposure\.provider must be one of "local", not "tailscale"/, "a plugin the registry refused is not one to name");
  assert.throws(() => parseProfile(text({ messaging: { provider: "telegram" } })), /messaging is not a profile key: the keys are schema, tracker, codeHost, publish, reviewer, exposure, conventions, repos, notes/, "messaging is a project's key, not a laptop's");
});

test("A11-163: a profile saved before this release still reads, with its schema and block shape unchanged", () => {
  const saved = readFileSync(new URL("./fixtures/onboard-profile.example.json", import.meta.url), "utf8");
  const profile = parseProfile(saved);
  assert.equal(profile.schema, 1);
  assert.deepEqual([profile.tracker.provider, profile.codeHost.provider, profile.publish.provider, profile.reviewer.provider, profile.exposure.provider], ["linear", "github", "none", "atomic", "local"]);
  assert.deepEqual(parseProfile(profileText(profile)), profile);
});

test("A11-163: the questions offer each concern's plugins from the registry, and an answer outside them is refused by the field", async () => {
  const asked: string[] = [];
  const catalog = catalogWith({ name: "codex-review", concern: "reviewer" });
  await askProfile({ ask: async (question) => { asked.push(question); return ""; } }, [{ name: "example-app", path: "/src/example-app" }], catalog);
  assert.ok(asked.includes("Reviewer: atomic or codex-review or none [atomic]: "), asked.join("\n"));
  assert.ok(asked.includes("Exposure: local or tailscale [local]: "));
  const profile = await askProfile({ ask: async (question) => (question.startsWith("Reviewer") ? "codex-review" : "") }, [{ name: "example-app", path: "/src/example-app" }], catalog);
  assert.equal(profile.reviewer.provider, "codex-review", "a plugin the registry gained is offered and accepted with no change to the profile reader");
  await assert.rejects(askProfile({ ask: async (question) => (question.startsWith("Exposure") ? "ngrok" : "") }, [{ name: "example-app", path: "/src/example-app" }]), /exposure\.provider must be one of "local", "tailscale", not "ngrok"/);
});
