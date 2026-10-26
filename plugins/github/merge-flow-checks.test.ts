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

/** What each repository (by `owner/name`) answers: its `autoMergeAllowed` and whether its head holds the arm workflow, or `null` for a repository GitHub would not read. */
type Flows = Readonly<Record<string, Readonly<{ autoMerge: boolean; workflow: boolean; isPrivate?: boolean; bot?: boolean }> | null>>;

/** GitHub's answer to the one query, from the repositories it names in order (`r0`, `r1`, ...). */
function answerOf(query: string, flows: Flows): string {
  const asked = [...query.matchAll(/repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map(([, owner, name]) => `${owner}/${name}`);
  const data = Object.fromEntries(asked.map((repo, n) => {
    const flow = flows[repo];
    return [`r${n}`, flow === null || flow === undefined ? null : { autoMergeAllowed: flow.autoMerge, isPrivate: flow.isPrivate === true, defaultBranchRef: { name: "main" }, object: flow.workflow ? { __typename: "Blob" } : null, bot: flow.bot === true ? { __typename: "Blob" } : null }];
  }));
  return JSON.stringify({ data });
}

/** A machine whose clones (name to `owner/name` remote) answer `flows`, and the calls it was asked. */
function machine(flows: Flows, clones: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(flows).map((repo) => [repo.split("/")[1], repo])), refusal?: ExecResult) {
  const asked: { file: string; args: readonly string[]; options: ExecOptions | undefined }[] = [];
  const exec = (file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
    asked.push({ file, args, options });
    if (file === "git") return { status: 0, stdout: `git@github.com:${clones[args[1].split("/").pop() ?? ""] ?? "a11ign/unknown"}.git\n`, stderr: "" };
    return refusal ?? { status: 0, stdout: answerOf(args.find((arg) => arg.startsWith("query=")) ?? "", flows), stderr: "" };
  };
  return { asked, deps: fakePluginDeps({ exec, clones: Object.fromEntries(Object.keys(clones).map((name) => [name, `/src/${name}`])) }) };
}

const WITH_FLOW = { autoMerge: true, workflow: true };
const WITHOUT_FLOW = { autoMerge: false, workflow: false };

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
    "a11ign/plugin": WITHOUT_FLOW, "a11ign/auth-capture-check": { autoMerge: true, workflow: false }, "a11ign/documents": { autoMerge: false, workflow: true }, "a11ign/lab": WITH_FLOW,
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
  assert.deepEqual([row.ok, row.detail, row.fix], [true, "a11ign/plugin, a11ign/lab have a merge flow (auto-merge and .github/workflows/auto-arm.yml, or, for a private repository, .github/workflows/merge-bot.yml)", null]);
  assert.deepEqual(mergeFlowChecks({}, fakePluginDeps()), []);
});

test("A11-291: a repository the row cannot read fails it, saying so, and is never read as having no flow or as having one", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": null, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /^1 of 2 could not be read: a11ign\/plugin: could not be read$/, "and it is not counted among those with no flow");
  assert.match(row.fix ?? "", /^a11ign\/plugin: run `gh api repos\/a11ign\/plugin --jq \.allow_auto_merge` with the workers' GH_CONFIG_DIR to see why$/);
  const refused = mergeFlowChecks({}, machine({ "a11ign/plugin": WITH_FLOW }, undefined, { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }).deps)[0];
  assert.deepEqual([refused.ok, refused.detail], [false, "1 of 1 could not be read: a11ign/plugin: could not be read"], "a call GitHub refused reads none of them");
});

test("A11-291: every repository is asked in ONE call, as the workers' account, and a repository two clones name is asked once", () => {
  const { asked, deps } = machine({ "a11ign/plugin": WITH_FLOW, "a11ign/lab": WITH_FLOW }, { plugin: "a11ign/plugin", "plugin-copy": "a11ign/plugin", lab: "a11ign/lab" });
  mergeFlowChecks({ gh: WORKERS }, deps);
  const gh = asked.filter(({ file }) => file === "gh");
  assert.equal(gh.length, 1, "doctor's plugin checks run under a time limit, so thirteen repositories are not thirteen calls");
  assert.equal([...(gh[0].args.find((arg) => arg.startsWith("query=")) ?? "").matchAll(/name: "plugin"/g)].length, 1);
  assert.equal((gh[0].options?.env as Record<string, string>)?.GH_CONFIG_DIR, "/home/agent/workers/gh");
});

const PRIVATE_WITH_BOT = { autoMerge: false, workflow: false, isPrivate: true, bot: true };
const PRIVATE_WITHOUT = { autoMerge: false, workflow: false, isPrivate: true };

test("A11-291: a private repository on a plan with no rulesets has a merge flow when it holds the merge bot, and the row says so", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": PRIVATE_WITH_BOT, "a11ign/lab": WITH_FLOW }).deps);
  assert.deepEqual([row.ok, row.fix], [true, null]);
  assert.equal(mergeFlowChecks({}, machine({ "a11ign/plugin": { ...WITH_FLOW, isPrivate: true } }).deps)[0].ok, true, "a private repository that does have the ruleset flow passes by it");
});

test("A11-291: a private repository with no merge bot fails the row, which asks for the bot and not the ruleset or the setting", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": PRIVATE_WITHOUT, "a11ign/lab": WITH_FLOW }).deps);
  assert.deepEqual([row.ok, row.detail], [false, "1 of 2 repositories have no merge flow, so an approved pull request in one waits for a person: a11ign/plugin: no .github/workflows/merge-bot.yml on its default branch (private)"]);
  assert.match(row.fix ?? "", /^a11ign\/plugin: add \.github\/workflows\/merge-bot\.yml with its `gate` check and `\.github\/chainguard\/merge-bot\.sts\.yaml`/);
  assert.doesNotMatch(row.fix ?? "", /merge-queue-main|auto-arm|Allow auto-merge/, "it is not asked for a ruleset, the arm bot or the setting: a private repository on Free can have none");
});

test("A11-291: a PUBLIC repository is not accepted for holding the merge bot: it keeps A11-274's flow", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/lab": { autoMerge: false, workflow: false, bot: true } }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /a11ign\/lab: auto-merge is not allowed, no \.github\/workflows\/auto-arm\.yml/);
});
