// no-token: none -- pure: the plans the plugin CLI makes, over a catalog of scratch packages and a parsed host file
//
// A11-161: `required` is the reviewer CONCERN's setting, not a plugin's, so it moves with the block from one reviewer plugin to another: a switch and a replacing install keep it, and an uninstall (cli.test.ts) keeps
// it too. Only one reviewer plugin exists in this checkout, so the catalog here has two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { planEnable, planInstall, replacementOf, type PlanContext } from "./manage.ts";
import { buildCatalog, type PackageFiles } from "./registry.ts";

const ROOT = "/checkout";
const NAMES = ["atomic", "second"];
const files: PackageFiles = {
  directories: (path) => (path === `${ROOT}/plugins` ? NAMES : []),
  text: (path) => (NAMES.some((name) => path === `${ROOT}/plugins/${name}/package.json`)
    ? JSON.stringify({ agentOrg: { concern: "reviewer", contract: "1.0", description: "A reviewer.", entry: "index.ts" } }) : null),
  isFile: (path) => path.endsWith("/index.ts"),
};
const catalog = buildCatalog({ root: ROOT, files });
const contextOf = (reviewer: Record<string, unknown>): PlanContext => ({ providers: resolveProviders({ tickets: { providers: { reviewer } } }, catalog), catalog, messaging: { provider: null, why: "no project" } });
const required = (changes: readonly { key: string; value?: unknown }[]) => changes.find(({ key }) => key === "tickets.providers.reviewer.required");

test("A11-161: switching the reviewer to another plugin (enable) keeps `required`, and says nothing of dropping it", () => {
  const plan = planEnable("second", contextOf({ provider: "atomic", required: false }));
  assert.deepEqual(required(plan.changes), { key: "tickets.providers.reviewer.required", value: false });
  assert.match(plan.said, /^switched the reviewer from atomic to second, keeping required$/);
});

test("A11-161: installing another reviewer with --replace drops the replaced plugin's settings and keeps `required`; the page's replacement note does not list it as dropped", () => {
  const context = contextOf({ provider: "atomic", required: true });
  const plan = planInstall("second", { sets: [], replace: true }, context);
  assert.deepEqual(plan.changes.map(({ key }) => key), ["tickets.providers.reviewer", "tickets.providers.reviewer.provider", "tickets.providers.reviewer.enabled", "tickets.providers.reviewer.required"]);
  assert.deepEqual(required(plan.changes), { key: "tickets.providers.reviewer.required", value: true });
  assert.deepEqual(replacementOf("second", context), { replaced: "atomic", dropped: [] });
});

test("A11-161: a block with no `required` writes none on a switch: the default stands", () => {
  const plan = planEnable("second", contextOf({ provider: "atomic" }));
  assert.equal(required(plan.changes), undefined);
});
