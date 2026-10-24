// no-token: gh
// a11ign/a11ign#3965 (earlier #3134, #3187, #3958): this file parses release.yml as YAML and reads what the CALL says; nothing here spawns a process or needs the network.
/**
 * `release.yml` IS A CALLER OF THE SHARED PER-MERGE WORKFLOW, AND WHAT STARTS IT AND WHAT IT MAY HOLD IS PINNED HERE (a11ign/a11ign#3965; chairman, #928, 2026-10-07).
 *
 * The release itself (the gate on the exact sha, the release commit on no branch, the atomic tag push, the Release) is `release-per-merge.yml` in a11ign/toolchain, and its
 * behaviour is tested there. This file used to read the steps of the in-file release job; those steps are gone, so each property it pinned is now pinned on the CALLER or
 * lives in toolchain's tests at the sha this repository pins (`ab856fdd`; `release-parity.test.ts` and `release-per-merge.test.ts`). For EACH old property:
 *   - triggers (`push` on `main` and nothing else) ........................ HERE, `triggerProblems`;
 *   - permissions (`contents: write`, `checks: read`, no `pull-requests`, no shorthand; `id-token: write` on the call ONLY, beside `kind: tag`) ... HERE, `permissionProblems`;
 *   - concurrency (`group: release`, never cancelled in flight) ............ HERE, `concurrencyProblems` (new: the old file had it, and no test did);
 *   - reach (no registry, OIDC, secret; no tag deleted or moved) ........... HERE, `reachProblems`, over the caller's text; the called workflow's own `tag` job holds
 *     `contents: write` and runs no caller code, and `kind: tag` skips its only `id-token` job (toolchain `release-per-merge.test.ts`: the publish job alone holds OIDC). The call
 *     still HOLDS `id-token: write`, because a called workflow's job permissions are checked against the caller's at load, `if:` or not (ceo, review of #352). THE ONE EXCEPTION is A11-191's
 *     `ui-attach`, which ADDS the two UI files to the Release just cut (`gh release upload`, the tarball and then its checksum, never `--clobber`): those two exact lines are the only Release
 *     write allowed, `uiJobProblems` pins the jobs around them, and every other `gh release` write, a changed upload and `--clobber` are still refused;
 *   - writes (the one push is of the tag, atomic, never forced, no `gh api` write) ... toolchain `release-parity.test.ts`, "parity G5: the tag step pushes every tag
 *     atomically and never forced ..." and its mutants "... seen to FAIL on a push that is not atomic, one that is forced ...". The caller has no step to push with, which
 *     `callProblems` in `release-tag-on-merge.test.ts` pins;
 *   - the tag step runs only when the tag is absent, judged by reading the remote ... toolchain G5, the same two tests (an unreadable remote is refused, a tag that
 *     appeared is not moved and gets no Release);
 *   - the guards about what is tagged (gate needed and waited for, `v<version>`, the CHANGELOG entry) ... toolchain G5 (gate), G4 (MAJOR.MINOR.PATCH), G3 (changelog entry),
 *     all in the `version` job, before a tag exists.
 * Each property here is a function over the PARSED workflow returning what is wrong with it, and each is ALSO run on a copy with exactly that thing broken (an emptiness
 * assertion passes on an empty population).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Step { name?: string; uses?: string; run?: string }
interface Job { permissions?: Record<string, string> | string; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; uses?: string; with?: Record<string, unknown>; steps?: Step[]; needs?: string | string[]; if?: string }
interface Workflow { on: unknown; permissions?: Record<string, string> | string; jobs: Record<string, Job> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_TEXT = readFileSync(`${REPO}.github/workflows/release.yml`, "utf8");
const REAL = parse(WORKFLOW_TEXT) as Workflow;

const WRITABLE = ["contents"];
const READABLE = ["contents", "checks"];

const clone = (w: Workflow): Workflow => structuredClone(w);

const UPLOAD_TARBALL = 'gh release upload "$ASSET_TAG" "$tarball" --repo "$GITHUB_REPOSITORY"';
const UPLOAD_CHECKSUM = 'gh release upload "$ASSET_TAG" "$checksum" --repo "$GITHUB_REPOSITORY"';

/** The run text of `ui-attach`'s tarball upload line replaced by `line`. */
function replaceUpload(w: Workflow, line: string): void {
  for (const step of w.jobs["ui-attach"].steps ?? []) if (step.run !== undefined) step.run = step.run.replace(UPLOAD_TARBALL, line);
}

/** The two upload lines of `ui-attach` in the other order. */
function swapUploads(w: Workflow): void {
  for (const step of w.jobs["ui-attach"].steps ?? []) if (step.run !== undefined) step.run = step.run.replace(UPLOAD_TARBALL, "@@").replace(UPLOAD_CHECKSUM, UPLOAD_TARBALL).replace("@@", UPLOAD_CHECKSUM);
}

/** The job that calls the shared workflow and tags: `consumer-check` (a11ign/a11ign#4412) precedes it in the file and holds `contents: read` alone. */
const callJob = (w: Workflow): Job => Object.values(w.jobs).find((j) => j.uses !== undefined) ?? (Object.values(w.jobs)[0] as Job);

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

/**
 * Write access is `contents` only, and present on the call; reads add `checks`; `pull-requests` and the shorthand `write-all` never. `id-token: write` is held by the call and
 * ONLY there, and only beside `kind: tag`: the called file's `publish` job asks for it, so a call without it fails to load, while `kind: npm` with it would be a publish.
 */
function permissionProblems(w: Workflow): string[] {
  const blocks: Array<[string, Job["permissions"], Job | undefined]> = [["workflow", w.permissions, undefined], ...Object.entries(w.jobs).map(([n, j]): [string, Job["permissions"], Job] => [n, j.permissions, j])];
  const problems: string[] = [];
  const written = new Set<string>();
  for (const [where, perms, job] of blocks) {
    if (typeof perms === "string") problems.push(`${where}: permissions is the shorthand "${perms}"`);
    for (const [key, level] of Object.entries(typeof perms === "object" ? perms : {})) {
      if (key === "id-token") problems.push(...idTokenProblems(where, level, job));
      else if (level === "write" && !WRITABLE.includes(key)) problems.push(`${where}: ${key}: write is broader than contents`);
      else if (level !== "write" && ![...READABLE, ...WRITABLE].includes(key)) problems.push(`${where}: ${key}: ${level} is not one of ${[...READABLE, ...WRITABLE]}`);
      if (level === "write" && key !== "id-token") written.add(key);
    }
  }
  const call = callJob(w);
  if (typeof call?.permissions !== "object" || call.permissions["id-token"] !== "write") problems.push("the call does not hold id-token: write, so the called workflow's publish job fails the whole call at load");
  for (const needed of WRITABLE) if (!written.has(needed)) problems.push(`no job holds ${needed}: write`);
  if (JSON.stringify(w.permissions) !== '{"contents":"read"}') problems.push(`workflow permissions are ${JSON.stringify(w.permissions)}, not contents: read alone`);
  return problems;
}

/** `id-token` is `write`, on a job that calls the workflow (not at the top), with `kind: tag`, which skips the one job that would mint a token. */
function idTokenProblems(where: string, level: string, job: Job | undefined): string[] {
  if (job === undefined) return [`${where}: an id-token permission at the top of the workflow, where every job would inherit it`];
  const problems: string[] = [];
  if (level !== "write") problems.push(`${where}: id-token: ${level}, not write (the called publish job asks for write)`);
  if (job.with?.kind !== "tag") problems.push(`${where}: id-token: write beside kind '${String(job.with?.kind)}', which would be a publish`);
  return problems;
}

/** One release at a time, never cancelled in flight: a cancelled release leaves a tag with no Release, and two at once end in a refused push. */
function concurrencyProblems(w: Workflow): string[] {
  const c = callJob(w).concurrency;
  const problems: string[] = [];
  if (c?.group !== "release") problems.push(`the call's concurrency group is '${c?.group}', not 'release'`);
  if (c?.["cancel-in-progress"] !== false) problems.push(`the call's cancel-in-progress is '${c?.["cancel-in-progress"]}', not false`);
  return problems;
}

/** The workflow as text the patterns read: JSON, with the line breaks of a multi-line `run` as line breaks again, so `\b` finds a command that starts a line. */
const textOf = (w: Workflow): string => JSON.stringify(w).replaceAll("\\n", "\n");

/** Nothing in the caller reaches a registry, an OIDC provider or a secret; nothing deletes a tag or a Release, or force-moves one. Comments are not the caller's text. */
function reachProblems(w: Workflow, text: string = textOf(withoutUiUploads(w))): string[] {
  const forbidden: Array<[RegExp, string]> = [
    [/--clobber/, "an upload that replaces a file already on a Release"],
    [/oidc/i, "an OIDC provider or token (the `id-token` permission is `permissionProblems`'s)"],
    [/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/, "a registry token or URL"],
    [/\b(?:npm|pnpm)\s+publish|changeset\s+publish/, "a publish command"],
    [/secrets/, "a secret, or `secrets: inherit`"],
    [/\bgit\s+tag\s+(?:-\w*[df]\w*|--delete|--force)|\bgh\s+release\s+(?:delete|edit|upload)|\bgit\s+update-ref\b|\bgit\s+push\b/, "a command that writes, moves or deletes a ref or a Release"],
  ];
  return forbidden.filter(([re]) => re.test(text)).map(([, what]) => `the workflow holds ${what}`);
}

/**
 * The workflow without the one Release write there is (A11-191): `ui-attach` ADDS the two UI files to the Release just cut, the tarball and then its checksum, never replacing one. Taking exactly those
 * two lines out leaves nothing that may write to a Release, which is what `reachProblems` reads.
 */
function withoutUiUploads(w: Workflow): Workflow {
  const copy = clone(w);
  for (const step of copy.jobs["ui-attach"]?.steps ?? []) if (step.run !== undefined) step.run = step.run.replaceAll(UPLOAD_TARBALL, "").replaceAll(UPLOAD_CHECKSUM, "");
  return copy;
}

/**
 * The UI build is attached by two jobs that follow the call (A11-191): `ui-build` needs the call, runs only when it succeeded, holds `contents: read` and runs the repository's code; `ui-attach` needs
 * `ui-build`, runs only when a tag was found, holds `contents: write`, checks nothing out and runs none of the repository's code, and uploads the tarball and then the checksum.
 */
function uiJobProblems(w: Workflow): string[] {
  const build = w.jobs["ui-build"];
  const attach = w.jobs["ui-attach"];
  if (build === undefined || attach === undefined) return ["the workflow has no ui-build or no ui-attach job"];
  const problems: string[] = [];
  if (build.needs !== "release") problems.push(`ui-build needs ${JSON.stringify(build.needs)}, not the call (release)`);
  if (build.if !== "needs.release.result == 'success'") problems.push(`ui-build runs on ${JSON.stringify(build.if)}, not only when the release succeeded`);
  if (JSON.stringify(build.permissions) !== '{"contents":"read"}') problems.push(`ui-build holds ${JSON.stringify(build.permissions)}, not contents: read alone: it runs the repository's code`);
  if (attach.needs !== "ui-build") problems.push(`ui-attach needs ${JSON.stringify(attach.needs)}, not ui-build`);
  if (attach.if !== "needs.ui-build.outputs.tag != ''") problems.push(`ui-attach runs on ${JSON.stringify(attach.if)}, not only when a tag was found`);
  if (JSON.stringify(attach.permissions) !== '{"contents":"write"}') problems.push(`ui-attach holds ${JSON.stringify(attach.permissions)}, not contents: write alone`);
  for (const step of attach.steps ?? []) {
    if (step.uses?.startsWith("actions/checkout@")) problems.push("ui-attach checks the repository out, and it holds the write token");
    if (/\b(?:pnpm|npm|node|npx)\b/.test(step.run ?? "")) problems.push(`ui-attach runs the repository's or a package's code: ${step.run}`);
  }
  const uploads = (attach.steps ?? []).flatMap((step) => (step.run ?? "").split("\n").filter((line) => line.includes("gh release upload")).map((line) => line.trim()));
  if (JSON.stringify(uploads) !== JSON.stringify([UPLOAD_TARBALL, UPLOAD_CHECKSUM])) problems.push(`ui-attach uploads ${JSON.stringify(uploads)}, not the tarball and then the checksum`);
  return problems;
}

const PROPERTIES: Array<[string, (w: Workflow) => string[]]> = [
  ["triggers", triggerProblems], ["permissions", permissionProblems], ["concurrency", concurrencyProblems], ["reach", (w) => reachProblems(w)], ["ui", uiJobProblems],
];
const problemsOf = (w: Workflow): string[] => PROPERTIES.flatMap(([name, check]) => check(w).map((p) => `${name}: ${p}`));

test("the real release.yml has no trigger, permission, concurrency or reach problem", () => {
  assert.deepEqual(problemsOf(REAL), []);
});

test("positive control: the properties are about something (one push trigger, one call job that writes contents, and a concurrency block to read)", () => {
  assert.equal(Object.keys(REAL.on as object).length, 1);
  assert.deepEqual(Object.keys(REAL.jobs), ["consumer-check", "release", "ui-build", "ui-attach"], "the consumer-check job, the call, and the two jobs that build and attach the UI (A11-191)");
  assert.equal((callJob(REAL).permissions as Record<string, string>)["contents"], "write");
  assert.equal(callJob(REAL).concurrency?.group, "release");
  assert.equal((callJob(REAL).permissions as Record<string, string>)["id-token"], "write");
  assert.equal(callJob(REAL).with?.kind, "tag");
  assert.ok(WORKFLOW_TEXT.includes("uses: a11ign/toolchain/"), "the file is not the call these properties were written for");
});

test("positive control: each copy with ONE thing broken is refused by the property that owns it, naming it", () => {
  const mutants: Array<[string, string, (w: Workflow) => void]> = [
    ["triggers", "a pull_request trigger", (w) => { w.on = { push: { branches: ["main"] }, pull_request: {} }; }],
    ["triggers", "a workflow_dispatch trigger", (w) => { w.on = { push: { branches: ["main"] }, workflow_dispatch: {} }; }],
    ["triggers", "every branch", (w) => { w.on = { push: { branches: ["*"] } }; }],
    ["triggers", "a tags filter beside the branches", (w) => { w.on = { push: { branches: ["main"], tags: ["v*"] } }; }],
    ["triggers", "the bare `on: push` shorthand", (w) => { w.on = "push"; }],
    ["permissions", "no id-token: write on the call (the call would fail to load)", (w) => { delete (callJob(w).permissions as Record<string, string>)["id-token"]; }],
    ["permissions", "id-token: read on the call", (w) => { (callJob(w).permissions as Record<string, string>)["id-token"] = "read"; }],
    ["permissions", "id-token: write at the top of the workflow", (w) => { w.permissions = { contents: "read", "id-token": "write" }; }],
    ["permissions", "id-token: write beside kind: npm", (w) => { callJob(w).with = { ...callJob(w).with, kind: "npm" }; }],
    ["permissions", "pull-requests: write", (w) => { (callJob(w).permissions as Record<string, string>)["pull-requests"] = "write"; }],
    ["permissions", "the write-all shorthand", (w) => { callJob(w).permissions = "write-all"; }],
    ["permissions", "no contents: write", (w) => { callJob(w).permissions = { contents: "read", checks: "read" }; }],
    ["permissions", "workflow-wide write", (w) => { w.permissions = { contents: "write" }; }],
    ["concurrency", "no concurrency block", (w) => { delete callJob(w).concurrency; }],
    ["concurrency", "another group", (w) => { callJob(w).concurrency = { group: "other", "cancel-in-progress": false }; }],
    ["concurrency", "cancel-in-progress true", (w) => { callJob(w).concurrency = { group: "release", "cancel-in-progress": true }; }],
    ["reach", "inherited secrets", (w) => { (callJob(w) as Record<string, unknown>)["secrets"] = "inherit"; }],
    ["reach", "an npm publish step", (w) => { callJob(w).steps = [{ run: "pnpm publish" }]; }],
    ["reach", "a force push of a tag", (w) => { callJob(w).steps = [{ run: "git push --force origin HEAD:refs/tags/v1.0.0" }]; }],
    ["reach", "a Release deleted", (w) => { (w.jobs["ui-attach"].steps ??= []).push({ run: 'gh release delete "$ASSET_TAG" --yes' }); }],
    ["reach", "a Release edited", (w) => { (w.jobs["ui-attach"].steps ??= []).push({ run: 'gh release edit "$ASSET_TAG" --notes x' }); }],
    ["reach", "an upload from the call job", (w) => { callJob(w).steps = [{ run: UPLOAD_TARBALL }]; }],
    // An upload that is not exactly one of the two lines is a Release write `reach` refuses, and the `ui` property refuses the changed upload too: both own it.
    ["reach+ui", "an upload that replaces (--clobber)", (w) => { replaceUpload(w, `${UPLOAD_TARBALL} --clobber`); }],
    ["reach+ui", "an upload of another file", (w) => { replaceUpload(w, 'gh release upload "$ASSET_TAG" ./other.txt --repo "$GITHUB_REPOSITORY"'); }],
    ["ui", "ui-build waiting on nothing", (w) => { delete w.jobs["ui-build"].needs; }],
    ["ui", "ui-build running whatever the release did", (w) => { delete w.jobs["ui-build"].if; }],
    ["ui", "ui-build given the write token", (w) => { w.jobs["ui-build"].permissions = { contents: "write" }; }],
    ["ui", "ui-attach running with no tag", (w) => { delete w.jobs["ui-attach"].if; }],
    ["ui", "ui-attach given read only", (w) => { w.jobs["ui-attach"].permissions = { contents: "read" }; }],
    ["ui", "ui-attach checking the repository out", (w) => { (w.jobs["ui-attach"].steps ??= []).unshift({ uses: "actions/checkout@v7" }); }],
    ["ui", "ui-attach running the repository's code", (w) => { (w.jobs["ui-attach"].steps ??= []).push({ run: "pnpm install" }); }],
    ["ui", "the checksum uploaded before the tarball", swapUploads],
    ["permissions+ui", "ui-attach given pull-requests: write", (w) => { w.jobs["ui-attach"].permissions = { contents: "write", "pull-requests": "write" }; }],
  ];
  for (const [owners, what, mutate] of mutants) {
    const broken = clone(REAL);
    mutate(broken);
    const found = problemsOf(broken);
    for (const owner of owners.split("+")) assert.ok(found.some((p) => p.startsWith(`${owner}:`)), `${what}: not refused by the ${owner} property (${JSON.stringify(found)})`);
    assert.ok(found.every((p) => owners.split("+").some((owner) => p.startsWith(`${owner}:`))), `${what}: refused by a property that does not own it (${JSON.stringify(found)})`);
  }
});

test("the real release.yml attaches the two UI files and nothing else to a Release: the reach property sees the uploads only when they are not exactly the two lines", () => {
  assert.deepEqual(reachProblems(REAL), []);
  assert.equal(WORKFLOW_TEXT.split("\n").filter((line) => line.trim() === UPLOAD_TARBALL || line.trim() === UPLOAD_CHECKSUM).length, 2);
  assert.deepEqual(reachProblems(REAL, textOf(REAL)).length > 0, true, "with the two lines left in, the pattern notices a Release write: the exception is what lets them through");
});

test("positive control, the other direction: the header comments name the registry and OIDC to refuse them, so the pattern WOULD notice them in text, and the parsed call has none", () => {
  assert.notDeepEqual(reachProblems(REAL, WORKFLOW_TEXT), [], "the header no longer names what it refuses, or the pattern no longer notices a word it should");
  assert.deepEqual(reachProblems(REAL), []);
});
