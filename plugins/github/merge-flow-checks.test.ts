// no-token: none -- `gh` and `git` are a fake `exec`: no GitHub CLI runs, and no remote is asked of the machine
//
// A11-291: doctor's `merge flow` row. Four of the organisation's thirteen repositories had no merge flow and nothing said so: an approved pull request in one sat for a day. The row asks every GitHub repository a clone of the host names whether it
// allows auto-merge and holds `.github/workflows/auto-arm.yml`, names each one that does not, and says what to add.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";
import { mergeFlowChecks } from "./merge-flow-checks.ts";

const WORKERS = { workers: "/home/agent/workers" };
const NOT_FOUND: ExecResult = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const HAS: ExecResult = { status: 0, stdout: "file\n", stderr: "" };

/** What each repository (by `owner/name`) answers: its `allow_auto_merge`, and whether its default branch holds the arm workflow. */
type Flows = Readonly<Record<string, Readonly<{ autoMerge: string | ExecResult; workflow: ExecResult }>>>;

/** A machine whose clones (name to `owner/name` remote) answer `flows`, and the calls it was asked. */
function machine(flows: Flows, clones: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(flows).map((repo) => [repo.split("/")[1], repo]))) {
  const asked: { file: string; args: readonly string[]; options: ExecOptions | undefined }[] = [];
  const exec = (file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
    asked.push({ file, args, options });
    if (file === "git") return { status: 0, stdout: `git@github.com:${clones[args[1].split("/").pop() ?? ""] ?? "a11ign/unknown"}.git\n`, stderr: "" };
    const repo = args[1].split("/").slice(1, 3).join("/");
    const flow = flows[repo];
    if (flow === undefined) return NOT_FOUND;
    if (args.includes(".allow_auto_merge")) return typeof flow.autoMerge === "string" ? { status: 0, stdout: `${flow.autoMerge}\n`, stderr: "" } : flow.autoMerge;
    return flow.workflow;
  };
  return { asked, deps: fakePluginDeps({ exec, clones: Object.fromEntries(Object.keys(clones).map((name) => [name, `/src/${name}`])) }) };
}

const WITH_FLOW = { autoMerge: "true", workflow: HAS };
const WITHOUT_FLOW = { autoMerge: "false", workflow: NOT_FOUND };

test("A11-291: a repository with no merge flow fails the row, which names it and says what to add", () => {
  const [row] = mergeFlowChecks({ gh: WORKERS }, machine({ "a11ign/plugin": WITHOUT_FLOW, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.name, "merge flow");
  assert.equal(row.ok, false);
  assert.equal(row.detail, "1 of 2 repositories have no merge flow, so an approved pull request in one waits for a person: a11ign/plugin: auto-merge is not allowed, no .github/workflows/auto-arm.yml on its default branch");
  assert.match(row.fix ?? "", /^a11ign\/plugin: add \.github\/workflows\/auto-arm\.yml with its `gate` check, `\.github\/rulesets\/merge-queue-main\.json` and `\.github\/chainguard\/auto-arm\.sts\.yaml`/);
  assert.match(row.fix ?? "", /turn on "Allow auto-merge" \(https:\/\/github\.com\/a11ign\/plugin\/settings#merge-button-settings\), and apply the ruleset/);
  assert.doesNotMatch(row.detail, /a11ign\/lab/, "a repository that has the flow is not named as failing");
});

test("A11-291: every failing repository is named, and each says only what it lacks", () => {
  const [row] = mergeFlowChecks({}, machine({
    "a11ign/plugin": WITHOUT_FLOW, "a11ign/auth-capture-check": { autoMerge: "true", workflow: NOT_FOUND }, "a11ign/documents": { autoMerge: "false", workflow: HAS }, "a11ign/lab": WITH_FLOW,
  }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /^3 of 4 repositories have no merge flow/);
  assert.match(row.detail, /a11ign\/plugin: auto-merge is not allowed, no \.github\/workflows\/auto-arm\.yml/);
  assert.match(row.detail, /a11ign\/auth-capture-check: no \.github\/workflows\/auto-arm\.yml on its default branch(;|$)/);
  assert.match(row.detail, /a11ign\/documents: auto-merge is not allowed(;|$)/);
  const fixes = (row.fix ?? "").split(" | ");
  assert.equal(fixes.length, 3);
  assert.doesNotMatch(fixes.find((fix) => fix.startsWith("a11ign/auth-capture-check")) ?? "", /Allow auto-merge/, "it already allows auto-merge");
  assert.doesNotMatch(fixes.find((fix) => fix.startsWith("a11ign/documents")) ?? "", /auto-arm\.yml/, "it already has the arm workflow");
});

test("A11-291: the row passes, naming the repositories, when every one has the flow; and it adds no row on a host with no GitHub clone", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": WITH_FLOW, "a11ign/lab": WITH_FLOW }).deps);
  assert.deepEqual([row.ok, row.detail, row.fix], [true, "a11ign/plugin, a11ign/lab allow auto-merge and hold .github/workflows/auto-arm.yml", null]);
  assert.deepEqual(mergeFlowChecks({}, fakePluginDeps()), []);
});

test("A11-291: a repository the row cannot read fails it, saying so, and is never read as having no flow or as having one", () => {
  const unreadable = { autoMerge: { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" } as ExecResult, workflow: HAS };
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": unreadable, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /^1 of 2 could not be read: a11ign\/plugin: could not be read$/, "and it is not counted among those with no flow");
  assert.match(row.fix ?? "", /^a11ign\/plugin: run `gh api repos\/a11ign\/plugin --jq \.allow_auto_merge` with the workers' GH_CONFIG_DIR to see why$/);
});

test("A11-291: each repository is asked once, as the workers' account, and a repository two clones name is asked once", () => {
  const { asked, deps } = machine({ "a11ign/plugin": WITH_FLOW }, { plugin: "a11ign/plugin", "plugin-copy": "a11ign/plugin" });
  mergeFlowChecks({ gh: WORKERS }, deps);
  const gh = asked.filter(({ file }) => file === "gh");
  assert.equal(gh.length, 2, "the setting and the file, for the one repository");
  assert.ok(gh.every(({ options }) => (options?.env as Record<string, string>)?.GH_CONFIG_DIR === "/home/agent/workers/gh"));
});
