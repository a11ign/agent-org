// no-token: gh -- the manifest is handed in as text and the check is pure; nothing is read from the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Contract, type HostFacts, contractRows, hostFactsOf, readPluginContract, skillRefs } from "./plugin-contract.ts";
import { parseTicketSettings } from "./settings.ts";

const INSTALL = "/cache/a11ign/1.0.0";
/** The contract the a11ign plugin declares, as the record's worked example gives it, with the planner's real skill. */
const DECLARED = {
  contract: "1.0",
  agentOrg: ">=0.258.0 <1.0.0",
  provides: {
    planner: { skill: "a11ign:create-ticket", planFile: "<issue-id>-0001-plan-<slug>.md" },
    writer: { skill: "a11ign:create-ticket" },
    prReview: { skill: "a11ign:clean-code-review" },
    brief: { file: "brief.md" },
  },
  needs: { connectors: ["^mcp__linear__(get|list|search|extract)_"], commands: ["gh"] },
};
/** The host keys this machine has: the a11ign plugin enabled, the planner and writer naming its skill, and the connectors and plan pattern it needs. */
const HOST: HostFacts = {
  plugins: ["a11ign@a11ign-local"],
  connectors: ["^mcp__linear__(get|list|search|extract)_", "^mcp__linear__save_comment$", "^mcp__claude_ai_Linear__(get|list|search|extract)_"],
  plan: "-plan-[^/]*\\.md$",
  prReview: null,
  planner: "Run the a11ign:create-ticket skill with this request: unattended: plan {keys} into {dir}",
  writer: "Run the a11ign:create-ticket skill for this request: {request}. Write each draft under {dir}/drafts.",
};
const manifest = (metadata: unknown, name: unknown = "a11ign") => JSON.stringify({ name, version: "0.1.0", ...(metadata === undefined ? {} : { metadata }) });
const reading = (text: string) => ({ read: () => text });
const missing = { read: () => { throw new Error("ENOENT"); } };
const contractOf = (declared: unknown): Contract => {
  const read = readPluginContract(INSTALL, reading(manifest({ agentOrg: declared })));
  assert.equal(read.kind, "found");
  return (read as { contract: Contract }).contract;
};
/** The rows of the contract `declared` against `host`, with the version and commands the test names. */
const rowsFor = (declared: Record<string, unknown>, { host = HOST, version = "0.260.0", commands = () => true }: { host?: HostFacts; version?: string | null; commands?: (command: string) => boolean } = {}) =>
  contractRows({ entry: "a11ign@a11ign-local", name: "a11ign", contract: contractOf({ ...DECLARED, ...declared }), host, agentOrgVersion: () => version, onPath: commands });
const kindsOf = (rows: { kind: string }[]) => rows.map(({ kind }) => kind);

test("a plugin with no contract declares none: no file, no metadata, no agentOrg, or a manifest that is not JSON", () => {
  assert.deepEqual(readPluginContract(INSTALL, missing), { kind: "none" });
  assert.deepEqual(readPluginContract(INSTALL, reading(manifest(undefined))), { kind: "none" });
  assert.deepEqual(readPluginContract(INSTALL, reading(manifest({ other: 1 }))), { kind: "none" });
  assert.deepEqual(readPluginContract(INSTALL, reading("not json")), { kind: "none" });
});

test("a plugin with no contract declares none, so it has no contract rows of its own", () => {
  assert.equal(readPluginContract(INSTALL, reading(manifest(undefined))).kind, "none");
});

test("a matching contract is read as declared, and what it does not understand is left out", () => {
  assert.deepEqual(readPluginContract(INSTALL, reading(manifest({ agentOrg: DECLARED }))), {
    kind: "found",
    name: "a11ign",
    contract: {
      contract: "1.0",
      agentOrg: ">=0.258.0 <1.0.0",
      provides: { planner: { skill: "a11ign:create-ticket", planFile: "<issue-id>-0001-plan-<slug>.md" }, writer: { skill: "a11ign:create-ticket" }, prReview: { skill: "a11ign:clean-code-review" } },
      needs: { connectors: ["^mcp__linear__(get|list|search|extract)_"], commands: ["gh"] },
    },
  });
});

test("a matching contract against this machine's host keys has no rows", () => {
  assert.deepEqual(rowsFor({}), []);
});

test("a field the reader cannot understand is malformed, and the reason names that field", () => {
  const cases: [unknown, RegExp][] = [
    ["x", /metadata\.agentOrg must be an object/],
    [{ ...DECLARED, contract: "1" }, /metadata\.agentOrg\.contract must be/],
    [{ ...DECLARED, agentOrg: ">=0.258.0" }, /metadata\.agentOrg\.agentOrg must be a version range with an upper bound/],
    [{ ...DECLARED, agentOrg: "^0.258.0" }, /metadata\.agentOrg\.agentOrg must be/],
    [{ ...DECLARED, provides: "x" }, /metadata\.agentOrg\.provides must be an object/],
    [{ ...DECLARED, provides: { writer: { skill: "other:create-ticket" } } }, /metadata\.agentOrg\.provides\.writer\.skill must be `a11ign:<skill>`/],
    [{ ...DECLARED, provides: { planner: { skill: "a11ign:create-ticket", planFile: 3 } } }, /metadata\.agentOrg\.provides\.planner\.planFile/],
    [{ ...DECLARED, needs: "x" }, /metadata\.agentOrg\.needs must be an object/],
    [{ ...DECLARED, needs: { connectors: ["mcp__linear__get_"] } }, /metadata\.agentOrg\.needs\.connectors must be/],
    [{ ...DECLARED, needs: { commands: [1] } }, /metadata\.agentOrg\.needs\.commands must be/],
  ];
  for (const [declared, why] of cases) {
    const read = readPluginContract(INSTALL, reading(manifest({ agentOrg: declared })));
    assert.equal(read.kind, "malformed", JSON.stringify(declared));
    assert.match((read as { why: string }).why, why);
  }
});

test("a manifest with no name is malformed, since its skills cannot be told apart", () => {
  const read = readPluginContract(INSTALL, reading(JSON.stringify({ metadata: { agentOrg: DECLARED } })));
  assert.equal(read.kind, "malformed");
  assert.match((read as { why: string }).why, /no name/);
});

test("a contract of a major this agent-org does not read is the only row", () => {
  const rows = rowsFor({ contract: "2.0", agentOrg: "<0.1.0", needs: { connectors: ["^mcp__nope__"], commands: ["nope"] } }, { commands: () => false });
  assert.deepEqual(kindsOf(rows), ["contract-major"]);
  assert.match(rows[0].why, /declares contract 2\.0, a major this agent-org does not read: update agent-org, or the plugin/);
});

test("a version of agent-org outside the plugin's range is one row, and an unknown version is no mismatch", () => {
  assert.deepEqual(kindsOf(rowsFor({}, { version: "0.257.9" })), ["agent-org-range"]);
  assert.deepEqual(kindsOf(rowsFor({}, { version: "1.0.0" })), ["agent-org-range"], "the upper bound is exclusive");
  assert.deepEqual(rowsFor({}, { version: null }), [], "a checkout at no release is not told apart: no row");
  assert.match(rowsFor({}, { version: "0.257.9" })[0].why, /This agent-org is 0\.257\.9, outside the >=0\.258\.0 <1\.0\.0 that a11ign@a11ign-local works with/);
});

test("a range with an inclusive upper bound and an equality holds where it should", () => {
  assert.deepEqual(rowsFor({ agentOrg: ">=0.258.0 <=0.260.0" }, { version: "0.260.0" }), []);
  assert.deepEqual(kindsOf(rowsFor({ agentOrg: ">=0.258.0 <=0.260.0" }, { version: "0.260.1" })), ["agent-org-range"]);
  assert.deepEqual(rowsFor({ agentOrg: ">0.259.9 =0.260.0 <1.0.0" }, { version: "0.260.0" }), []);
});

test("a connector the plugin needs that tickets.connectors does not allow is one row each, and the fix names the pattern", () => {
  const host = { ...HOST, connectors: [] };
  const rows = rowsFor({}, { host });
  assert.deepEqual(kindsOf(rows), ["connector-need"]);
  assert.match(rows[0].why, /needs the connector tools matched by \^mcp__linear__\(get\|list\|search\|extract\)_, which tickets\.connectors does not allow: add the pattern to tickets\.connectors/);
});

test("a command the plugin needs that is not on the path is one row, and the fix says to install it", () => {
  const rows = rowsFor({}, { commands: () => false });
  assert.deepEqual(kindsOf(rows), ["command-need"]);
  assert.match(rows[0].why, /needs gh on the path, and it is not there: install it/);
});

test("a host key that names a skill the plugin does not provide at that extension point is one row", () => {
  assert.deepEqual(kindsOf(rowsFor({}, { host: { ...HOST, prReview: "a11ign:review-lite" } })), ["skill-not-provided"]);
  assert.deepEqual(rowsFor({}, { host: { ...HOST, prReview: "a11ign:clean-code-review" } }), [], "the skill the plugin provides as prReview");
  assert.deepEqual(kindsOf(rowsFor({}, { host: { ...HOST, writer: "Run the a11ign:write-ticket skill for {request}, {dir}" } })), ["skill-not-provided"]);
  const [why] = rowsFor({}, { host: { ...HOST, planner: "Run the a11ign:other-plan skill with {key} into {dir}" } });
  assert.match(why.why, /tickets\.planner\.run names a11ign:other-plan, which a11ign@a11ign-local does not provide as its planner skill: name a skill it provides, or remove the key\./);
});

test("a host key that names a skill when the contract provides none at that point is one row", () => {
  const provides = { planner: DECLARED.provides.planner, writer: DECLARED.provides.writer };
  assert.deepEqual(kindsOf(rowsFor({ provides }, { host: { ...HOST, prReview: "a11ign:clean-code-review" } })), ["skill-not-provided"]);
});

test("a bare prReview name is compared with the plugin's own prReview skill, by its name without the prefix", () => {
  assert.deepEqual(rowsFor({}, { host: { ...HOST, prReview: "clean-code-review" } }), []);
  assert.deepEqual(kindsOf(rowsFor({}, { host: { ...HOST, prReview: "review" } })), ["skill-not-provided"]);
});

test("A11-139: the readers accept a skill name the plugin does not provide, and contractRows is the check that finds it", () => {
  const named = (tickets: Record<string, unknown>) => hostFactsOf(parseTicketSettings({ clones: { netbox: INSTALL }, tickets: { plugins: ["a11ign@a11ign-local"], connectors: HOST.connectors, ...tickets } }));
  const writer = named({ writer: { run: "Run the a11ign:other skill for this request: {request}, in {dir}." } });
  assert.deepEqual(rowsFor({}, { host: writer }).map(({ kind, why }) => [kind, why]), [["skill-not-provided",
    "tickets.writer.run names a11ign:other, which a11ign@a11ign-local does not provide as its writer skill: name a skill it provides, or remove the key."]]);
  assert.deepEqual(kindsOf(rowsFor({}, { host: named({ prReview: "a11ign:nothing" }) })), ["skill-not-provided"]);
});

test("the plan pattern must match the plan file the planner writes, with a sample ticket's id and slug", () => {
  assert.deepEqual(rowsFor({}, { host: { ...HOST, plan: "-plan-[^/]*\\.md$" } }), []);
  assert.deepEqual(kindsOf(rowsFor({}, { host: { ...HOST, plan: "^PLAN-" } })), ["plan-file"]);
  assert.match(rowsFor({}, { host: { ...HOST, plan: "^PLAN-" } })[0].why, /tickets\.plan does not match the plan file a11ign@a11ign-local's planner writes, such as A11-1-0001-plan-sample\.md/);
  assert.deepEqual(rowsFor({}, { host: { ...HOST, plan: null } }), [], "a host that names no plan pattern has none to match");
});

test("the skill names a host key holds are read from a bare name, and from each plugin:skill a run text names", () => {
  assert.deepEqual(skillRefs({ ...HOST, planner: "Serve on localhost:8080, run step:1 of a11ign:create-ticket", writer: null }), [
    { key: "planner", plugin: "a11ign", skill: "create-ticket" },
  ], "a colon before a port or a step number names no skill");
  assert.deepEqual(skillRefs({ ...HOST, prReview: "a11ign:clean-code-review", planner: "Run the a11ign:create-ticket skill with this request: unattended: see https://x.y/z and {dir}", writer: null }), [
    { key: "prReview", plugin: "a11ign", skill: "clean-code-review" },
    { key: "planner", plugin: "a11ign", skill: "create-ticket" },
  ]);
  assert.deepEqual(skillRefs({ ...HOST, prReview: "review", planner: null, writer: null }), [{ key: "prReview", plugin: null, skill: "review" }]);
});

test("a host key that names a plugin tickets.plugins does not enable is one row, about the named plugin, once a plugin declares a contract", () => {
  const host = { ...HOST, writer: "Run the other:write skill for {request} and {dir}" };
  assert.deepEqual(rowsFor({}, { host }).filter(({ kind }) => kind === "plugin-not-enabled"), [{
    plugin: "other", kind: "plugin-not-enabled", why: "tickets.writer.run names other:write, but tickets.plugins does not enable other: add that plugin to tickets.plugins.",
  }]);
  assert.deepEqual(rowsFor({}, { host: HOST }), []);
});
