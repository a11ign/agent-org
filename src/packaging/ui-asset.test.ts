// no-token: none -- git runs in a repository this file builds in a temporary directory, `tar` reads a folder it builds, and the two workflows are parsed from this tree; nothing reaches the network
/**
 * THE RELEASE SHIPS THE BOARD UI'S BUILD AS ONE TARBALL AND ITS CHECKSUM (A11-191), AND THE PULL REQUEST DRY-RUNS THE SAME STEP.
 *
 * `scripts/ui-asset.ts` has two commands, and this file runs both:
 *   - `released-tag <sha>`: the shared per-merge workflow declares no output, so the release job finds its tag as the `vX.Y.Z` tag whose commit has `<sha>` as its FIRST PARENT (a git fixture: the tag
 *     cut on top of the merge, a tag on another parent, a pre-release, a push that released nothing, and two tags that make the Release a guess);
 *   - `pack <dist> <tag> <out>`: `agent-org-ui-<tag>.tar.gz` with the build's files at the archive root, entries sorted, owner 0 and mtime 0, the same bytes for the same build, and its `.sha256` in
 *     `sha256sum` format.
 * And two properties of the workflows, each also run on a copy with exactly that thing broken: `ci.yml`'s `ui` job runs the SAME install, build and pack commands as `release.yml`'s `ui-build` (so the
 * dry run on a pull request is the release's build step), and uploads nothing to a Release; and `release.yml`'s `ui-attach` uploads the tarball then the checksum, never with `--clobber`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { assetName, checksumLine, pack, releasedTag, releasedTags } from "../../scripts/ui-asset.ts";

interface Step { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; "working-directory"?: string }
interface Job { needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[] }
interface Workflow { jobs: Record<string, Job> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = `${REPO}scripts/ui-asset.ts`;
const read = (path: string): string => readFileSync(`${REPO}${path}`, "utf8");
const CI = parse(read(".github/workflows/ci.yml")) as Workflow;
const RELEASE = parse(read(".github/workflows/release.yml")) as Workflow;
const GIT_ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

/** A repository with `git` run in it. */
function repository() {
  const dir = tmpDir("ui-asset-git-");
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, env: GIT_ENV, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  let n = 0;
  /** A commit on the current HEAD, and its sha. */
  const commit = (label: string): string => {
    n += 1;
    writeFileSync(join(dir, "file.txt"), `${label} ${n}\n`);
    git("add", "-A");
    git("commit", "--quiet", "-m", label);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

/** The shape the shared workflow leaves: a merge on main, a release commit on top of it that is on no branch, and the tag on the release commit. */
function releaseOnTopOf(repo: ReturnType<typeof repository>, merge: string, tag: string, { annotated = false } = {}): string {
  repo.git("checkout", "--quiet", "--detach", merge);
  const release = repo.commit(`release ${tag}`);
  if (annotated) repo.git("tag", "-a", tag, "-m", tag);
  else repo.git("tag", tag);
  repo.git("checkout", "--quiet", "main");
  return release;
}

test("released-tag finds the release tag cut on top of the push, whether the tag is lightweight or annotated, and nothing for a push that released nothing", () => {
  const repo = repository();
  const first = repo.commit("first merge");
  releaseOnTopOf(repo, first, "v0.1.0");
  const second = repo.commit("second merge");
  releaseOnTopOf(repo, second, "v0.2.0", { annotated: true });
  const third = repo.commit("a merge that releases nothing");
  assert.equal(releasedTag(first, repo.dir), "v0.1.0");
  assert.equal(releasedTag(second, repo.dir), "v0.2.0");
  assert.equal(releasedTag(third, repo.dir), null);
  assert.deepEqual(releasedTags(third, repo.dir), []);
});

test("released-tag takes no tag that is not a release cut on this exact merge: not a tag on another parent, not a pre-release or another name, not a tag on the merge itself", () => {
  const repo = repository();
  const merge = repo.commit("the merge");
  const other = repo.commit("another merge");
  releaseOnTopOf(repo, other, "v7.0.0");
  repo.git("tag", "v1.0.0", merge);
  repo.git("checkout", "--quiet", "--detach", merge);
  repo.commit("release-shaped");
  repo.git("tag", "v1.0.1-rc1");
  repo.git("tag", "latest");
  repo.git("tag", "1.0.2");
  repo.git("checkout", "--quiet", "main");
  assert.equal(releasedTag(merge, repo.dir), null, "v1.0.0 is on the merge, v7.0.0 is on another parent, and the rest are not release tags");
  assert.equal(releasedTag(other, repo.dir), "v7.0.0");
});

/** A merge with one release cut on top of it, v0.1.0. */
function mergeReleasedAsV010() {
  const repo = repository();
  const merge = repo.commit("the merge");
  releaseOnTopOf(repo, merge, "v0.1.0");
  return { repo, merge };
}

test("released-tag refuses two release tags on top of one push: the Release the build belongs to would be a guess", () => {
  const { repo, merge } = mergeReleasedAsV010();
  releaseOnTopOf(repo, merge, "v0.1.1");
  assert.throws(() => releasedTag(merge, repo.dir), /more than one release tag on top of it \(v0\.1\.0, v0\.1\.1\)/);
});

test("released-tag run as the workflow runs it prints the tag, prints nothing and succeeds for a push that released none, and fails on a sha git does not know", () => {
  const { repo, merge } = mergeReleasedAsV010();
  const later = repo.commit("a later merge");
  const run = (sha: string) => spawnSync(process.execPath, [SCRIPT, "released-tag", sha], { cwd: repo.dir, env: GIT_ENV, encoding: "utf8" });
  assert.deepEqual([run(merge).status, run(merge).stdout], [0, "v0.1.0\n"]);
  assert.deepEqual([run(later).status, run(later).stdout], [0, ""]);
  const unknown = run("0".repeat(40));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^ui-asset: /);
});

/** A build as `astro build` leaves it. */
function builtUi(root: string, label = "one"): string {
  const dist = join(root, `dist-${label}`);
  mkdirSync(join(dist, "_astro"), { recursive: true });
  mkdirSync(join(dist, "settings"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<title>${label}</title>\n`);
  writeFileSync(join(dist, "settings", "index.html"), "<title>settings</title>\n");
  writeFileSync(join(dist, "_astro", "b.123.js"), "export const b = 1;\n");
  writeFileSync(join(dist, "_astro", "a.456.css"), "a { color: red }\n");
  return dist;
}

test("pack writes agent-org-ui-<tag>.tar.gz with the build at the archive root, and its checksum in sha256sum format", () => {
  const root = tmpDir("ui-asset-pack-");
  const out = join(root, "out");
  const files = pack(builtUi(root), "v0.5.0", out);
  assert.equal(files.tarball, join(out, "agent-org-ui-v0.5.0.tar.gz"));
  assert.equal(files.tarball, join(out, assetName("v0.5.0")));
  assert.equal(files.checksum, `${files.tarball}.sha256`);
  const entries = execFileSync("tar", ["-tzf", files.tarball], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
  assert.deepEqual(entries, ["./", "./_astro/", "./_astro/a.456.css", "./_astro/b.123.js", "./index.html", "./settings/", "./settings/index.html"], "index.html at the root, the entries sorted");
  const digest = createHash("sha256").update(readFileSync(files.tarball)).digest("hex");
  assert.equal(readFileSync(files.checksum, "utf8"), `${digest}  agent-org-ui-v0.5.0.tar.gz\n`);
  assert.equal(readFileSync(files.checksum, "utf8"), checksumLine(readFileSync(files.tarball), "agent-org-ui-v0.5.0.tar.gz"));
  assert.equal(execFileSync("sha256sum", ["-c", "agent-org-ui-v0.5.0.tar.gz.sha256"], { cwd: out, encoding: "utf8" }).trim(), "agent-org-ui-v0.5.0.tar.gz: OK", "the checksum file is what sha256sum -c reads");
});

test("pack's tarball has owner 0 and mtime 0 and is the same bytes for the same build, whatever the files' times and the second it is made", () => {
  const root = tmpDir("ui-asset-pack-");
  const dist = builtUi(root);
  const first = pack(dist, "v0.5.0", join(root, "first"));
  const listing = execFileSync("tar", ["-tvzf", first.tarball], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  assert.match(listing, /^drwxr-xr-x 0\/0 +0 1970-01-01 00:00 \.\/$/m);
  assert.match(listing, /^-rw-r--r-- 0\/0 +\d+ 1970-01-01 00:00 \.\/index\.html$/m);
  utimesSync(join(dist, "index.html"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  const second = pack(dist, "v0.5.0", join(root, "second"));
  assert.deepEqual(readFileSync(second.tarball), readFileSync(first.tarball));
  assert.equal(readFileSync(second.checksum, "utf8"), readFileSync(first.checksum, "utf8"));
  const other = pack(builtUi(root, "two"), "v0.5.0", join(root, "third"));
  assert.notDeepEqual(readFileSync(other.tarball), readFileSync(first.tarball), "a different build is different bytes");
});

test("pack refuses a folder with no index.html, a tag that is not a release, and says so; `dry-run` is the one other name", () => {
  const root = tmpDir("ui-asset-pack-");
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.throws(() => pack(empty, "v0.5.0", join(root, "out")), /holds no index\.html, so it is not a build of the board UI/);
  assert.throws(() => pack(builtUi(root), "0.5.0", join(root, "out")), /0\.5\.0 is not a release tag/);
  assert.throws(() => pack(builtUi(root), "v0.5.0-rc1", join(root, "out")), /not a release tag/);
  assert.equal(pack(builtUi(root), "dry-run", join(root, "out")).tarball, join(root, "out", "agent-org-ui-dry-run.tar.gz"));
  const cli = spawnSync(process.execPath, [SCRIPT, "pack", empty, "v0.5.0", join(root, "out")], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^ui-asset: .* holds no index\.html/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "frobnicate"], { encoding: "utf8" }).status, 1);
});

// ---- the workflows ------------------------------------------------------------------------------------------------------------------------------------

const runs = (job: Job): string[] => (job.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));
const INSTALL = "pnpm --dir ui install --frozen-lockfile --ignore-scripts";
const BUILD = "pnpm ui:build";
const PACK = 'node scripts/ui-asset.ts pack ui/dist "$ASSET_TAG" "$RUNNER_TEMP/ui-asset"';

/** The release's `ui-build` job and the pull request's `ui` job run the same install, build and pack, in that order, with the same pnpm and Node, and the dry run uploads only a run artifact. */
function dryRunProblems(ci: Workflow, release: Workflow): string[] {
  const dry = ci.jobs["ui"];
  const real = release.jobs["ui-build"];
  const problems: string[] = [];
  if (dry === undefined || real === undefined) return ["ci.yml has no `ui` job or release.yml no `ui-build` job"];
  for (const [what, command] of [["install", INSTALL], ["build", BUILD], ["pack", PACK]] as const) {
    if (!runs(real).includes(command)) problems.push(`release.yml's ui-build does not run the ${what} command \`${command}\``);
    if (!runs(dry).includes(command)) problems.push(`ci.yml's ui job does not run the ${what} command \`${command}\``);
  }
  const order = (job: Job): number[] => [INSTALL, BUILD, PACK].map((command) => runs(job).indexOf(command));
  for (const [where, job] of [["ci.yml's ui", dry], ["release.yml's ui-build", real]] as const) {
    const at = order(job);
    if (at.some((index) => index < 0) || at[0] > at[1] || at[1] > at[2]) problems.push(`${where} does not install, build and pack in that order (${at.join(",")})`);
  }
  const packStep = (job: Job): Step | undefined => job.steps?.find((step) => step.run === PACK);
  if (packStep(dry)?.env?.ASSET_TAG !== "dry-run") problems.push(`ci.yml's pack step packs for ${packStep(dry)?.env?.ASSET_TAG}, not the tag \`dry-run\``);
  if (dry.env?.PNPM_VERSION !== real.env?.PNPM_VERSION) problems.push(`the two jobs install different pnpm versions (${dry.env?.PNPM_VERSION} and ${real.env?.PNPM_VERSION})`);
  const node = (job: Job): unknown => job.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"];
  if (node(dry) !== node(real)) problems.push(`the two jobs run different Node versions (${node(dry)} and ${node(real)})`);
  if (!(dry.steps ?? []).some((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "agent-org-ui-dry-run")) problems.push("ci.yml's ui job archives no `agent-org-ui-dry-run` artifact");
  if (JSON.stringify(dry).includes("gh release") || JSON.stringify(dry).includes("contents\":\"write")) problems.push("ci.yml's ui job writes to a Release");
  return problems;
}

test("the pull request's ui job is the release's build step: the same install, build and pack, then an artifact, and no upload to a Release", () => {
  assert.deepEqual(dryRunProblems(CI, RELEASE), []);
});

test("positive control: each copy with ONE thing broken is refused by the dry-run property", () => {
  const mutants: Array<[string, (ci: Workflow, release: Workflow) => void]> = [
    ["a different build command in the pull request", (ci) => { for (const step of ci.jobs["ui"].steps ?? []) if (step.run === BUILD) step.run = "pnpm --dir ui exec astro build"; }],
    ["a different install in the release", (_ci, release) => { for (const step of release.jobs["ui-build"].steps ?? []) if (step.run === INSTALL) step.run = "pnpm --dir ui install"; }],
    ["no pack in the pull request", (ci) => { ci.jobs["ui"].steps = (ci.jobs["ui"].steps ?? []).filter((step) => step.run !== PACK); }],
    ["pack before build in the release", (_ci, release) => { const steps = release.jobs["ui-build"].steps ?? []; const a = steps.findIndex((s) => s.run === BUILD); const b = steps.findIndex((s) => s.run === PACK); [steps[a], steps[b]] = [steps[b], steps[a]]; }],
    ["the dry run packing for a release tag", (ci) => { for (const step of ci.jobs["ui"].steps ?? []) if (step.run === PACK) step.env = { ASSET_TAG: "v0.1.0" }; }],
    ["another pnpm", (ci) => { ci.jobs["ui"].env = { ...ci.jobs["ui"].env, PNPM_VERSION: "10.0.0" }; }],
    ["another node", (ci) => { for (const step of ci.jobs["ui"].steps ?? []) if (step.uses?.startsWith("actions/setup-node@")) step.with = { "node-version": "22" }; }],
    ["no dry-run artifact", (ci) => { ci.jobs["ui"].steps = (ci.jobs["ui"].steps ?? []).filter((step) => step.with?.name !== "agent-org-ui-dry-run"); }],
    ["an upload to a Release from the pull request", (ci) => { ci.jobs["ui"].steps?.push({ run: 'gh release upload v1 "$RUNNER_TEMP/ui-asset/x"' }); }],
  ];
  for (const [what, mutate] of mutants) {
    const ci = structuredClone(CI);
    const release = structuredClone(RELEASE);
    mutate(ci, release);
    assert.notDeepEqual(dryRunProblems(ci, release), [], `${what}: not refused`);
  }
});

test("positive control: the properties are about something: both jobs exist and each holds the three commands", () => {
  for (const job of [CI.jobs["ui"], RELEASE.jobs["ui-build"]]) for (const command of [INSTALL, BUILD, PACK]) assert.ok(runs(job).includes(command), command);
});
