// no-token: none -- `gh` and `git` are a fake `exec`: no GitHub CLI runs, and no remote is asked of the machine
//
// A11-291: doctor's `merge flow` row. Four of the organisation's thirteen repositories had no merge flow and nothing said so: an approved pull request in one sat for a day. The row asks about every repository of the
// organisations that own a clone of the host whether it allows auto-merge and holds `.github/workflows/auto-arm.yml`, names each one that does not, and says what to add.
// A11-274: the organisation is listed, so a repository no clone names fails too, an archived one is passed over, a cloned repository the listing does not hold is read by name, and the flow includes the merge queue
// ruleset that requires `gate`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";
import { mergeFlowChecks } from "./merge-flow-checks.ts";

const WORKERS = { workers: "/home/agent/workers" };

/** One repository's answer: its `autoMergeAllowed`, whether its head holds the arm workflow, and whether an active ruleset gives it a merge queue and requires `gate`. */
type Flow = Readonly<{ autoMerge: boolean; workflow: boolean; queue?: boolean; gate?: boolean; enforcement?: string; isPrivate?: boolean; bot?: boolean; archived?: boolean }>;

/** What each repository (by `owner/name`) answers, or `null` for a repository whose answer says nothing. */
type Flows = Readonly<Record<string, Flow | null>>;

/** A repository's node as GitHub answers it, named `name`. */
function nodeOf(name: string, flow: Flow | null): unknown {
  if (flow === null) return { name };
  const rules = [...(flow.queue === true ? [{ type: "MERGE_QUEUE", parameters: null }] : []), ...(flow.gate === true ? [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "gate" }] } }] : [])];
  return {
    name, isArchived: flow.archived === true, autoMergeAllowed: flow.autoMerge, isPrivate: flow.isPrivate === true, defaultBranchRef: { name: "main" }, object: flow.workflow ? { __typename: "Blob" } : null,
    bot: flow.bot === true ? { __typename: "Blob" } : null, rulesets: { nodes: rules.length === 0 ? [] : [{ enforcement: flow.enforcement ?? "ACTIVE", rules: { nodes: rules } }] },
  };
}

/** Who answers how, besides `flows`: the owners that are a user's account, the organisations whose listing fails, and the repositories a listing does not hold (moved to another owner). */
type Answers = Readonly<{ people: ReadonlySet<string>; unlistable: ReadonlySet<string>; moved: ReadonlySet<string> }>;

/** GitHub's answer to a query: an organisation's listing, `null` for an owner in `people` (a user's account), or the repositories it names by alias (`r0`, `r1`, ...). */
function answerOf(query: string, flows: Flows, { people, unlistable, moved }: Answers): ExecResult {
  const organisation = /organization\(login: "([^"]+)"\)/.exec(query)?.[1];
  if (organisation !== undefined) {
    if (people.has(organisation)) return { status: 1, stdout: JSON.stringify({ data: { organization: null }, errors: [{ type: "NOT_FOUND" }] }), stderr: "gh: Could not resolve to an Organization" };
    if (unlistable.has(organisation)) return { status: 1, stdout: "", stderr: "gh: HTTP 502" };
    const nodes = Object.entries(flows).filter(([repo]) => repo.startsWith(`${organisation}/`) && !moved.has(repo)).map(([repo, flow]) => nodeOf(repo.split("/")[1], flow));
    return { status: 0, stdout: JSON.stringify({ data: { organization: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }), stderr: "" };
  }
  const asked = [...query.matchAll(/repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map(([, owner, name]) => `${owner}/${name}`);
  return { status: 0, stdout: JSON.stringify({ data: Object.fromEntries(asked.map((repo, n) => [`r${n}`, nodeOf(repo.split("/")[1], flows[repo] ?? null)])) }), stderr: "" };
}

/** A machine whose clones (name to `owner/name` remote) answer `flows`, the owners in `people` being user accounts, those in `unlistable` failing to list, and those in `moved` not listed; and the calls it was asked. */
function machine(flows: Flows, { clones = Object.fromEntries(Object.keys(flows).map((repo) => [repo.split("/")[1], repo])), refusal, people = [], unlistable = [], moved = [] }: Readonly<{
  clones?: Readonly<Record<string, string>>; refusal?: ExecResult; people?: readonly string[]; unlistable?: readonly string[]; moved?: readonly string[];
}> = {}) {
  const asked: { file: string; args: readonly string[]; options: ExecOptions | undefined }[] = [];
  const exec = (file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
    asked.push({ file, args, options });
    if (file === "git") return { status: 0, stdout: `git@github.com:${clones[args[1].split("/").pop() ?? ""] ?? "a11ign/unknown"}.git\n`, stderr: "" };
    return refusal ?? answerOf(args.find((arg) => arg.startsWith("query=")) ?? "", flows, { people: new Set(people), unlistable: new Set(unlistable), moved: new Set(moved) });
  };
  return { asked, deps: fakePluginDeps({ exec, clones: Object.fromEntries(Object.keys(clones).map((name) => [name, `/src/${name}`])) }) };
}

const WITH_FLOW: Flow = { autoMerge: true, workflow: true, queue: true, gate: true };
const WITHOUT_FLOW: Flow = { autoMerge: false, workflow: false };

test("A11-291: a repository with no merge flow fails the row, which names it and says what to add", () => {
  const [row] = mergeFlowChecks({ gh: WORKERS }, machine({ "a11ign/plugin": WITHOUT_FLOW, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.name, "merge flow");
  assert.equal(row.ok, false);
  assert.match(row.detail, /^1 of 2 repositories have no merge flow, so an approved pull request in one waits for a person: a11ign\/plugin: auto-merge is not allowed, no \.github\/workflows\/auto-arm\.yml on its default branch/);
  assert.match(row.fix ?? "", /^a11ign\/plugin: add \.github\/workflows\/auto-arm\.yml with its `gate` check, `\.github\/rulesets\/merge-queue-main\.json` and `\.github\/chainguard\/auto-arm\.sts\.yaml`/);
  assert.match(row.fix ?? "", /turn on "Allow auto-merge" \(https:\/\/github\.com\/a11ign\/plugin\/settings#merge-button-settings, or `gh api -X PATCH repos\/a11ign\/plugin -F allow_auto_merge=true`\)/);
  assert.doesNotMatch(row.detail, /a11ign\/lab/, "a repository that has the flow is not named as failing");
});

test("A11-274: a repository shaped like a11ign.github.io before the fix fails, naming all four parts of the flow it lacks, with the commands that add them", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/a11ign.github.io": WITHOUT_FLOW, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /a11ign\/a11ign\.github\.io: auto-merge is not allowed, no \.github\/workflows\/auto-arm\.yml on its default branch, no active ruleset with a merge queue, `gate` is not a required check$/);
  assert.match(row.fix ?? "", /apply the ruleset: `gh api -X POST repos\/a11ign\/a11ign\.github\.io\/rulesets --input <\(gh api -H "Accept: application\/vnd\.github\.raw" repos\/a11ign\/a11ign\.github\.io\/contents\/\.github\/rulesets\/merge-queue-main\.json\)`/);
  assert.equal((row.fix ?? "").split(" | ").length, 1, "the commands hold no ` | `, which separates one repository's fix from the next");
});

test("A11-274: auto-merge and the arm workflow are not a flow without an active merge queue ruleset that requires `gate`", () => {
  const [row] = mergeFlowChecks({}, machine({
    "a11ign/no-ruleset": { autoMerge: true, workflow: true }, "a11ign/no-gate": { autoMerge: true, workflow: true, queue: true }, "a11ign/no-queue": { autoMerge: true, workflow: true, gate: true },
    "a11ign/evaluate": { ...WITH_FLOW, enforcement: "EVALUATE" }, "a11ign/lab": WITH_FLOW,
  }).deps);
  assert.match(row.detail, /^4 of 5 repositories have no merge flow/);
  assert.match(row.detail, /a11ign\/no-queue: no active ruleset with a merge queue(;|$)/, "a required `gate` with no merge queue is not the flow");
  assert.match(row.detail, /a11ign\/no-ruleset: no active ruleset with a merge queue, `gate` is not a required check(;|$)/);
  assert.match(row.detail, /a11ign\/no-gate: `gate` is not a required check(;|$)/);
  assert.match(row.detail, /a11ign\/evaluate: no active ruleset with a merge queue, `gate` is not a required check(;|$)/, "a ruleset in evaluate mode enforces nothing");
  const fixes = (row.fix ?? "").split(" | ");
  assert.equal(fixes.find((fix) => fix.startsWith("a11ign/no-gate")), "a11ign/no-gate: add `gate` to the merge queue ruleset's required checks");
  assert.doesNotMatch(fixes.find((fix) => fix.startsWith("a11ign/no-ruleset")) ?? "", /Allow auto-merge|auto-arm\.yml/, "it is asked only for what it lacks");
});

test("A11-291: every failing repository is named, and each says only what it lacks", () => {
  const [row] = mergeFlowChecks({}, machine({
    "a11ign/plugin": WITHOUT_FLOW, "a11ign/auth-capture-check": { ...WITH_FLOW, workflow: false }, "a11ign/documents": { ...WITH_FLOW, autoMerge: false }, "a11ign/lab": WITH_FLOW,
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
  assert.deepEqual([row.ok, row.detail, row.fix], [true, "a11ign/plugin, a11ign/lab have a merge flow (auto-merge, the merge queue ruleset requiring `gate` and .github/workflows/auto-arm.yml, or, for a private repository, .github/workflows/merge-bot.yml)", null]);
  assert.deepEqual(mergeFlowChecks({}, fakePluginDeps()), []);
});

test("A11-274: a repository of the organisation that no clone names, a new one, fails the row until it is set up", () => {
  const flows = { "a11ign/lab": WITH_FLOW, "a11ign/new-repository": WITHOUT_FLOW };
  const [row] = mergeFlowChecks({}, machine(flows, { clones: { lab: "a11ign/lab" } }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /^1 of 2 repositories have no merge flow.*: a11ign\/new-repository: auto-merge is not allowed/);
  assert.equal(mergeFlowChecks({}, machine({ ...flows, "a11ign/new-repository": WITH_FLOW }, { clones: { lab: "a11ign/lab" } }).deps)[0].ok, true, "and passes once it has the flow");
});

test("A11-274: an archived repository takes no pull request, so it is passed over", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/lab": WITH_FLOW, "a11ign/zz-throwaway-multiline-4221": { ...WITHOUT_FLOW, archived: true } }, { clones: { lab: "a11ign/lab" } }).deps);
  assert.deepEqual([row.ok, row.detail.includes("zz-throwaway")], [true, false]);
});

test("A11-274: an owner that is a user's account is never listed: only the repositories its clones name are read, by name", () => {
  const { asked, deps } = machine({ "someone/tool": WITHOUT_FLOW, "someone/other": WITHOUT_FLOW, "a11ign/lab": WITH_FLOW }, { clones: { tool: "someone/tool", lab: "a11ign/lab" }, people: ["someone"] });
  const [row] = mergeFlowChecks({}, deps);
  assert.match(row.detail, /^1 of 2 repositories have no merge flow.*: someone\/tool: auto-merge is not allowed/);
  assert.doesNotMatch(row.detail, /someone\/other/, "a repository of the person's that no clone names is not read");
  const queries = asked.filter(({ file }) => file === "gh").map(({ args }) => args.find((arg) => arg.startsWith("query=")) ?? "");
  assert.ok(queries.some((query) => /repository\(owner: "someone", name: "tool"\)/.test(query)));
});

test("A11-291: a repository the row cannot read fails it, saying so, and is never read as having no flow or as having one", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": null, "a11ign/lab": WITH_FLOW }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /^1 of 2 could not be read: a11ign\/plugin: could not be read$/, "and it is not counted among those with no flow");
  assert.match(row.fix ?? "", /^a11ign\/plugin: run `gh api repos\/a11ign\/plugin --jq \.allow_auto_merge` with the workers' GH_CONFIG_DIR to see why$/);
});

test("A11-274: an organisation whose listing GitHub refuses fails the row, naming it and its cloned repositories, and is never a pass", () => {
  const refused = mergeFlowChecks({}, machine({ "a11ign/plugin": WITH_FLOW }, { refusal: { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" } }).deps)[0];
  assert.deepEqual([refused.ok, refused.detail], [false, "1 of 1 could not be read; 1 organisation could not be listed: a11ign/plugin: could not be read; a11ign: its repositories could not be listed"]);
  assert.match(refused.fix ?? "", /a11ign: run `gh api orgs\/a11ign\/repos --jq '\.\[\]\.name'` with the workers' GH_CONFIG_DIR to see why$/);
});

test("A11-291: an organisation is listed in ONE call, as the workers' account, and a repository two clones name is read once", () => {
  const { asked, deps } = machine({ "a11ign/plugin": WITH_FLOW, "a11ign/lab": WITH_FLOW }, { clones: { plugin: "a11ign/plugin", "plugin-copy": "a11ign/plugin", lab: "a11ign/lab" } });
  const [row] = mergeFlowChecks({ gh: WORKERS }, deps);
  const gh = asked.filter(({ file }) => file === "gh");
  assert.equal(gh.length, 1, "doctor's plugin checks run under a time limit, so thirteen repositories are not thirteen calls");
  assert.match(row.detail, /^a11ign\/plugin, a11ign\/lab have/);
  assert.equal((gh[0].options?.env as Record<string, string>)?.GH_CONFIG_DIR, "/home/agent/workers/gh");
});

const PRIVATE_WITH_BOT: Flow = { autoMerge: false, workflow: false, isPrivate: true, bot: true };
const PRIVATE_WITHOUT: Flow = { autoMerge: false, workflow: false, isPrivate: true };

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

test("A11-274: when an organisation cannot be listed, its cloned repositories are still read by name, so the row says what each lacks and that the listing failed", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": WITHOUT_FLOW, "a11ign/lab": WITH_FLOW }, { unlistable: ["a11ign"] }).deps);
  assert.equal(row.ok, false);
  assert.equal(row.detail, "1 of 2 repositories have no merge flow, so an approved pull request in one waits for a person; 1 organisation could not be listed: a11ign/plugin: auto-merge is not allowed, no .github/workflows/auto-arm.yml on its default branch, no active ruleset with a merge queue, `gate` is not a required check; a11ign: its repositories could not be listed");
});

test("A11-274: a cloned repository the organisation's listing does not hold (moved to another owner) is read by name, not dropped", () => {
  const { asked, deps } = machine({ "a11ign/lab": WITH_FLOW, "a11ign/moved": WITHOUT_FLOW }, { moved: ["a11ign/moved"] });
  const [row] = mergeFlowChecks({}, deps);
  assert.match(row.detail, /^1 of 2 repositories have no merge flow.*: a11ign\/moved: auto-merge is not allowed/);
  const queries = asked.filter(({ file }) => file === "gh").map(({ args }) => args.find((arg) => arg.startsWith("query=")) ?? "");
  assert.equal(queries.length, 2, "the listing, then one read of the repositories it did not hold");
  assert.doesNotMatch(queries[1], /name: "lab"/, "a repository the listing held is not read again");
});

test("A11-274: a private repository that holds the arm workflow is judged by the arm flow, and told what of it it lacks, not to add the merge bot", () => {
  const [row] = mergeFlowChecks({}, machine({ "a11ign/plugin": { autoMerge: true, workflow: true, isPrivate: true } }).deps);
  assert.equal(row.ok, false);
  assert.match(row.detail, /a11ign\/plugin: no active ruleset with a merge queue, `gate` is not a required check$/);
  assert.doesNotMatch(row.fix ?? "", /merge-bot/);
});
