// no-token: gh
// a11ign/a11ign#3134: this file parses release.yml as YAML and reads what its steps WOULD run; the `gh` in the workflow text and in the assertion messages is what
// charged it, and nothing here spawns `gh` or needs the network.
/**
 * A MERGE TO `main` THAT CARRIES A CHANGESET RELEASES ITSELF, AND THE WAYS THAT COULD GO WRONG ARE EACH A PROPERTY OF `release.yml` (a11ign/a11ign#3134, #3187; ceo,
 * a11ign/a11ign#3175; chairman, #928, 2026-10-03).
 *
 * `release.yml` starts on `push` to `main` and, when a changeset no tag has consumed is present, builds a release commit on top of the merge and pushes it as the tag and
 * creates the Release. The ruling keeps every guard that is about WHAT is tagged and removes both the typed confirmation and the version pull request, so what must be pinned
 * is that nothing started by a push can do more than that. Each property below is a function over the PARSED workflow returning what is wrong with it, and each is ALSO run
 * on a fixture with exactly that thing broken (an emptiness assertion passes on an empty population, and "no step pushes to main" passes on a workflow with no push):
 *   - triggers: `push` on `main` and nothing else;
 *   - writes: the one push is of `HEAD` to the tag the job computed, never forced, never to a branch; no `gh api` call writes;
 *   - the tag step runs only when `v<version>` does not exist, judged by a step that READS the remote's tags;
 *   - the guards about what is tagged are in the job that tags: `gate` needed, the version-named tag, the CHANGELOG entry;
 *   - permissions: `contents: write` and nothing broader (no `pull-requests`), no `id-token`;
 *   - nothing reaches a registry, an OIDC provider or a secret, and nothing deletes or force-moves a tag.
 * What the steps DO across two merges is `release-tag-on-merge.test.ts`.
 *
 * What `release-safety.test.ts` keeps is how the steps BEHAVE when run. Of the six pins it held for the dispatch-only workflow it DROPPED three at #3134, because the ruling
 * removed what they were about: "`workflow_dispatch` only" (replaced by the trigger property here), "`dry-run` defaults to true" and "the cut needs the typed
 * confirmation" (there is neither input now). It KEPT the gate on the exact sha, the refusal of an existing tag (now: left alone, and never moved) and the
 * `v<version>` plus CHANGELOG-entry pair. #3187 moved this file's pins on the version pull request: the bot-branch push is gone (the one push is the tag's), and
 * `pull-requests: write` is now REFUSED where it was required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { needs?: string | string[]; permissions?: Record<string, string> | string; env?: Record<string, string>; steps: Step[] }
interface Workflow { on: unknown; permissions?: Record<string, string> | string; jobs: Record<string, Job> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const REAL = parse(readFileSync(`${REPO}.github/workflows/release.yml`, "utf8")) as Workflow;

const TAG_PUSH = 'origin HEAD:refs/tags/$TAG';
const WRITABLE = ["contents"];
const READABLE = ["contents", "checks"];

const clone = (w: Workflow): Workflow => structuredClone(w);
const scriptLines = (step: Step): string[] => (step.run ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
const allSteps = (w: Workflow): Array<{ job: string; step: Step }> =>
  Object.entries(w.jobs).flatMap(([job, body]) => body.steps.map((step) => ({ job, step })));
const allLines = (w: Workflow): Array<{ job: string; line: string }> =>
  allSteps(w).flatMap(({ job, step }) => scriptLines(step).map((line) => ({ job, line })));

/** `on:` must be a mapping holding `push` limited to branch `main`, and nothing else. Fails closed on `on: push` and `on: [push]`. */
function triggerProblems(w: Workflow): string[] {
  const on = w.on;
  if (typeof on !== "object" || on === null || Array.isArray(on)) return ["`on` is not a mapping, so its triggers are not read"];
  const problems: string[] = [];
  const keys = Object.keys(on);
  if (keys.join() !== "push") problems.push(`triggers are [${keys}], not only push`);
  const pushed = (on as Record<string, unknown>).push;
  const push = typeof pushed === "object" && pushed !== null ? (pushed as Record<string, unknown>) : {};
  if (JSON.stringify(push.branches) !== '["main"]' || Object.keys(push).length !== 1) problems.push(`push is not limited to branches: [main] (${JSON.stringify(pushed)})`);
  return problems;
}

/** What a `git push` line names besides its flags: the remote and the refspecs, quotes removed. */
function pushArguments(line: string): string[] {
  const words = line.slice(line.search(/\bgit\s+push\b/)).split(/\s+/).slice(2);
  return words.filter((word) => !word.startsWith("-")).map((word) => word.replace(/^"/, "").replace(/"$/, ""));
}

/** The only push is of `HEAD` to the tag the job computed, with no force and no flag that reaches other refs; no `gh api` call writes (it could move a ref). */
function writeProblems(w: Workflow): string[] {
  const problems: string[] = [];
  for (const { job, line } of allLines(w)) {
    if (/\bgit\s+push\b/.test(line)) {
      const named = pushArguments(line);
      if (named.length < 2) problems.push(`${job}: a push naming no refspec: ${line}`);
      else if (named.join(" ") !== TAG_PUSH) problems.push(`${job}: a push to [${named.slice(1)}], not only the release tag: ${line}`);
      if (/--force|-f\b|--mirror|--delete|\s-d\s/.test(line)) problems.push(`${job}: a forced push, which can move a tag, or one that can delete a ref: ${line}`);
      if (/--tags/.test(line)) problems.push(`${job}: a push that can reach every tag: ${line}`);
    }
    if (/\bgh\s+api\b/.test(line) && /(?:-X|--method)\s*\S*(?:POST|PATCH|PUT|DELETE)|\s-[fF]\s|--field|--raw-field/i.test(line)) problems.push(`${job}: a \`gh api\` call that writes: ${line}`);
  }
  return problems;
}

/** A step that makes a tag: `gh release create`, `git tag <name>` (not a listing), a push of a tag ref, or an API call under `git/refs`. Reading the remote's tags is not one. */
const TAG_CREATORS = /gh\s+release\s+create|\bgit\s+tag\s+(?!-l\b|--list)\S|git\s+push[^\n]*refs\/tags|git\/refs/;

/** The steps of the job that creates the tag. */
function publishing(w: Workflow): { name: string; job?: Job; creators: Step[] } {
  const name = Object.keys(w.jobs).find((n) => w.jobs[n]?.steps.some((s) => /gh\s+release\s+create/.test(s.run ?? ""))) ?? "";
  const job = w.jobs[name];
  return { name, job, creators: (job?.steps ?? []).filter((s) => TAG_CREATORS.test(s.run ?? "")) };
}

/** The tag is created only when a step that READS the remote's tags found `v<version>` absent. */
function tagGuardProblems(w: Workflow): string[] {
  const { job, creators } = publishing(w);
  if (!job) return ["no job creates a Release"];
  if (creators.length !== 1) return [`${creators.length} steps create a tag or Release, not one`];
  const creator = creators[0] as Step;
  const named = /^steps\.([\w-]+)\.outputs\.exists == 'false'$/.exec((creator.if ?? "").trim());
  if (!named) return [`the tag-creating step's if is "${creator.if ?? ""}", not that a tag step's \`exists\` is 'false' (the tag-exists guard)`];
  const reader = job.steps.find((s) => s.id === named[1]);
  const reads = /git\s+ls-remote\s+--exit-code\s+--tags\s+origin\s+"refs\/tags\/\$TAG"/.test(reader?.run ?? "");
  const before = reader !== undefined && job.steps.indexOf(reader) < job.steps.indexOf(creator);
  return reads && before ? [] : [`the step "${named[1]}" that the tag guard names does not read the remote's tags before the tag is created`];
}

/** What the tag is, and what must have passed, are in the job that tags (not in another that could be skipped). */
function guardProblems(w: Workflow): string[] {
  const { name, job } = publishing(w);
  if (!job) return ["no job creates a Release"];
  const problems: string[] = [];
  const needs = ([] as string[]).concat(job.needs ?? []);
  const gateScripts = needs.flatMap((n) => w.jobs[n]?.steps ?? []).map((s) => s.run ?? "").join("\n");
  if (needs.length === 0 || !gateScripts.includes("check_name=gate")) problems.push(`${name} does not need a job that reads ci.yml's \`gate\` check-run`);
  if (!gateScripts.includes("success) exit 0")) problems.push("the gate job does not exit 0 on success alone");
  if (!gateScripts.includes('"$GITHUB_REF" != refs/heads/main')) problems.push("the gate job does not refuse a ref other than main");
  const text = job.steps.map((s) => s.run ?? "").join("\n");
  if (!text.includes('"tag=v$version"')) problems.push(`${name} does not name the tag v plus the package.json version`);
  // The step that READS the entry (the release commit step also names CHANGELOG.md, to carry the last tag's forward, and refuses nothing).
  const changelog = job.steps.find((s) => /awk[^\n]*CHANGELOG\.md/.test(s.run ?? ""));
  if (!changelog || !/\bexit 1\b/.test(changelog.run ?? "")) problems.push(`${name} does not refuse a version with no CHANGELOG entry`);
  return problems;
}

/** Write access is `contents` only, and present; reads add `checks`; `pull-requests`, `id-token` and the shorthand `write-all` never. */
function permissionProblems(w: Workflow): string[] {
  const blocks: Array<[string, Record<string, string> | string | undefined]> = [["workflow", w.permissions], ...Object.entries(w.jobs).map(([n, j]): [string, Job["permissions"]] => [n, j.permissions])];
  const problems: string[] = [];
  const written = new Set<string>();
  for (const [where, perms] of blocks) {
    if (typeof perms === "string") problems.push(`${where}: permissions is the shorthand "${perms}"`);
    for (const [key, level] of Object.entries(typeof perms === "object" ? perms : {})) {
      if (key === "id-token") problems.push(`${where}: an id-token permission (${level})`);
      else if (level === "write" && !WRITABLE.includes(key)) problems.push(`${where}: ${key}: write is broader than contents`);
      else if (level !== "write" && ![...READABLE, ...WRITABLE].includes(key)) problems.push(`${where}: ${key}: ${level} is not one of ${[...READABLE, ...WRITABLE]}`);
      if (level === "write") written.add(key);
    }
  }
  for (const needed of WRITABLE) if (!written.has(needed)) problems.push(`no job holds ${needed}: write`);
  return problems;
}

/** Nothing reaches a registry, an OIDC provider or a secret; nothing deletes a tag or a Release, or force-moves one. */
function reachProblems(w: Workflow): string[] {
  const text = JSON.stringify(w).replace(/\\n/g, " "); // a newline escaped by JSON would otherwise glue itself to the word after it
  const forbidden: Array<[RegExp, string]> = [
    [/id-token|oidc/i, "an OIDC permission or token"],
    [/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/, "a registry token or URL"],
    [/\b(?:npm|pnpm)\s+publish|changeset\s+publish/, "a publish command"],
    [/secrets\.(?!GITHUB_TOKEN)/, "a secret other than the job's own token"],
  ];
  const commands = allLines(w).map(({ line }) => line);
  const moves: Array<[RegExp, string]> = [
    [/\bgit\s+tag\s+(?:-\w*[df]\w*|--delete|--force)/, "git tag with delete or force"],
    [/\bgh\s+release\s+(?:delete|edit|upload)/, "a Release deleted or edited"],
    [/\bgit\s+update-ref\b/, "git update-ref"],
  ];
  return [
    ...forbidden.filter(([re]) => re.test(text)).map(([, what]) => `the workflow holds ${what}`),
    ...moves.filter(([re]) => commands.some((c) => re.test(c))).map(([, what]) => `the workflow moves or deletes a tag: ${what}`),
  ];
}

const PROPERTIES: Array<[string, (w: Workflow) => string[]]> = [
  ["triggers", triggerProblems], ["writes", writeProblems], ["tag guard", tagGuardProblems],
  ["guards", guardProblems], ["permissions", permissionProblems], ["reach", reachProblems],
];

test("the real release.yml has no trigger, write, tag-guard, guard, permission or reach problem", () => {
  for (const [label, check] of PROPERTIES) assert.deepEqual(check(REAL), [], label);
});

test("positive control: the properties are about something (one push, one tag-creating step, a release commit made by `changeset version`)", () => {
  assert.equal(allLines(REAL).filter(({ line }) => /\bgit\s+push\b/.test(line)).length, 1, "the real workflow pushes the tag once, so the write check ran on a push");
  assert.equal(publishing(REAL).creators.length, 1);
  assert.equal(publishing(REAL).name, "release");
  assert.deepEqual(Object.keys(REAL.jobs).sort(), ["gate", "release"]);
  assert.match(JSON.stringify(REAL.jobs.release), /changeset version/);
});

function mutated(edit: (w: Workflow) => void): Workflow {
  const w = clone(REAL);
  edit(w);
  assert.notDeepEqual(w, REAL, "the fixture changed nothing");
  return w;
}
const step = (w: Workflow, job: string, match: RegExp): Step => {
  const found = w.jobs[job]?.steps.find((s) => match.test(`${s.name ?? ""}\n${s.run ?? ""}`));
  assert.ok(found, `no ${job} step matches ${match}`);
  return found;
};

test("positive control: each fixture with ONE thing broken is refused by the property that owns it, naming it", () => {
  const cases: Array<[string, Workflow, (w: Workflow) => string[], RegExp]> = [
    ["no push trigger", mutated((w) => { w.on = { workflow_dispatch: null }; }), triggerProblems, /not only push/],
    ["a dispatch trigger beside push", mutated((w) => { w.on = { push: { branches: ["main"] }, workflow_dispatch: null }; }), triggerProblems, /not only push/],
    ["a schedule trigger", mutated((w) => { w.on = { schedule: [{ cron: "0 0 * * *" }] }; }), triggerProblems, /not only push/],
    ["push on every branch", mutated((w) => { w.on = { push: { branches: ["**"] } }; }), triggerProblems, /not limited to branches/],
    ["push on tags too", mutated((w) => { w.on = { push: { branches: ["main"], tags: ["v*"] } }; }), triggerProblems, /not limited to branches/],
    ["`on: [push]`", mutated((w) => { w.on = ["push"]; }), triggerProblems, /not a mapping/],
    ["a push to main", mutated((w) => { step(w, "release", /git push/).run = 'git push origin HEAD:refs/heads/main'; }), writeProblems, /not only the release tag/],
    ["a push to main beside the tag's", mutated((w) => { step(w, "release", /git push/).run = 'git push origin "HEAD:refs/tags/$TAG" HEAD:refs/heads/main'; }), writeProblems, /not only the release tag/],
    ["a push of the tag with --force", mutated((w) => { step(w, "release", /git push/).run = 'git push --force origin "HEAD:refs/tags/$TAG"'; }), writeProblems, /forced push/],
    ["a push of the tag with a leading plus", mutated((w) => { step(w, "release", /git push/).run = 'git push origin "+HEAD:refs/tags/$TAG"'; }), writeProblems, /not only the release tag/],
    ["a push of a tag other than the computed one", mutated((w) => { step(w, "release", /git push/).run = 'git push origin "HEAD:refs/tags/v0.1.0"'; }), writeProblems, /not only the release tag/],
    ["a push of HEAD:main by the short name", mutated((w) => { step(w, "release", /git push/).run = 'git push origin HEAD:main'; }), writeProblems, /not only the release tag/],
    ["a push naming no refspec", mutated((w) => { step(w, "release", /git push/).run = "git push"; }), writeProblems, /naming no refspec/],
    ["a push that deletes a tag", mutated((w) => { step(w, "release", /Cut the tag/).run += '\ngit push origin :refs/tags/v0.1.0\n'; }), writeProblems, /not only the release tag/],
    ["a push of every tag", mutated((w) => { step(w, "release", /git push/).run += '\ngit push --tags origin\n'; }), writeProblems, /reach every tag/],
    ["a gh api call that moves a ref", mutated((w) => { step(w, "release", /Cut the tag/).run += '\ngh api -X PATCH repos/o/r/git/refs/tags/v0.1.0 -f sha=abc\n'; }), writeProblems, /gh api. call that writes/],
    ["the tag-exists guard removed", mutated((w) => { delete step(w, "release", /Cut the tag/).if; }), tagGuardProblems, /tag-exists guard/],
    ["a guard on something other than the tag's absence", mutated((w) => { step(w, "release", /Cut the tag/).if = "github.ref == 'refs/heads/main'"; }), tagGuardProblems, /tag-exists guard/],
    ["a guard naming a step that does not read the remote", mutated((w) => { step(w, "release", /Does the tag exist/).run = "echo exists=false >> $GITHUB_OUTPUT"; }), tagGuardProblems, /does not read the remote's tags/],
    ["a second tag-creating step", mutated((w) => { w.jobs.release?.steps.push({ name: "Sneak", run: "git tag v9.9.9" }); }), tagGuardProblems, /2 steps create/],
    ["the publishing job not needing gate", mutated((w) => { delete w.jobs.release?.needs; }), guardProblems, /does not need a job that reads/],
    ["a gate that does not read the result", mutated((w) => { const s = step(w, "gate", /check_name/); s.run = s.run?.replace("check_name=gate", "check_name=lint"); }), guardProblems, /does not need a job that reads/],
    ["a gate that accepts a conclusion other than success", mutated((w) => { const s = step(w, "gate", /check_name/); s.run = s.run?.replace("success) exit 0 ;;", "success|failure) exit 0 ;;"); }), guardProblems, /exit 0 on success alone/],
    ["a gate that accepts any ref", mutated((w) => { const s = step(w, "gate", /GITHUB_REF/); s.run = s.run?.replace("refs/heads/main", "refs/heads/zzz"); }), guardProblems, /ref other than main/],
    ["a tag that is not v plus the version", mutated((w) => { const s = step(w, "release", /The version/); s.run = s.run?.replace('"tag=v$version"', '"tag=$version"'); }), guardProblems, /v plus the package.json version/],
    ["no CHANGELOG refusal", mutated((w) => { const s = step(w, "release", /CHANGELOG entry/); s.run = s.run?.replace("exit 1", "exit 0"); }), guardProblems, /no CHANGELOG entry/],
    ["an id-token permission", mutated((w) => { w.jobs.release!.permissions = { contents: "write", "id-token": "write" }; }), permissionProblems, /id-token/],
    ["a wider write permission", mutated((w) => { w.jobs.release!.permissions = { contents: "write", packages: "write" }; }), permissionProblems, /packages: write is broader/],
    ["checks: write", mutated((w) => { w.jobs.gate!.permissions = { contents: "read", checks: "write" }; }), permissionProblems, /checks: write is broader/],
    ["an unlisted read permission", mutated((w) => { w.jobs.gate!.permissions = { contents: "read", "security-events": "read" }; }), permissionProblems, /security-events: read is not one of/],
    ["write-all", mutated((w) => { w.permissions = "write-all"; }), permissionProblems, /shorthand/],
    ["a pull-requests: write permission", mutated((w) => { w.jobs.release!.permissions = { contents: "write", "pull-requests": "write" }; }), permissionProblems, /pull-requests: write is broader/],
    ["no contents: write anywhere", mutated((w) => { w.jobs.release!.permissions = { contents: "read" }; }), permissionProblems, /no job holds contents: write/],
    ["npm publish", mutated((w) => { step(w, "release", /Cut the tag/).run += "\nnpm publish\n"; }), reachProblems, /publish command/],
    ["a registry token", mutated((w) => { step(w, "release", /Cut the tag/).env!.NPM_TOKEN = "x"; }), reachProblems, /registry token/],
    ["a secret", mutated((w) => { step(w, "release", /Cut the tag/).env!.GH_TOKEN = "${{ secrets.A11IGN_BOT_TOKEN }}"; }), reachProblems, /secret other than/],
    ["a tag force-moved", mutated((w) => { step(w, "release", /Cut the tag/).run += "\ngit tag -f v0.1.0\n"; }), reachProblems, /git tag with delete or force/],
    ["a tag deleted", mutated((w) => { step(w, "release", /Cut the tag/).run += "\ngit tag --delete v0.1.0\n"; }), reachProblems, /git tag with delete or force/],
    ["a Release deleted", mutated((w) => { step(w, "release", /Cut the tag/).run += "\ngh release delete v0.1.0 --yes\n"; }), reachProblems, /Release deleted or edited/],
  ];
  for (const [label, fixture, check, expected] of cases) assert.match(check(fixture).join("\n"), expected, `${label}: the owning property did not notice`);
});

test("positive control, the other direction: the real push of the tag and a read-only `gh api` are not refused, and neither is a second push of the same tag", () => {
  const w = mutated((fixture) => { step(fixture, "release", /git push/).run += '\ngit push origin "HEAD:refs/tags/$TAG"\n'; });
  assert.deepEqual(writeProblems(w), []);
  assert.deepEqual(writeProblems(REAL), []);
  assert.ok(allLines(REAL).some(({ line }) => /\bgit\s+push\b/.test(line)), "the tag's own push is in the population the write check looked at");
  assert.ok(allLines(REAL).some(({ line }) => /\bgh\s+api\b/.test(line)), "the gate's own `gh api` read is in the population the write check looked at");
});
