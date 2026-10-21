// no-token: none -- a profile is parsed from text and answered by a stand-in question; no file is read and no network is used
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
