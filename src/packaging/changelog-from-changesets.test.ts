// no-token: gh
// A11-441 (step 2 of 2): this file runs the repository's own `changeset version` over scratch git repositories; nothing here needs the network or a token.
/**
 * EACH RELEASE ADDS ITS OWN SECTION TO CHANGELOG.md, LISTING EVERY CHANGESET IT CONSUMED (A11-441, idea O1 of A11-429).
 *
 * The release is cut by the shared `release-per-merge.yml` in a11ign/toolchain (see `release.yml`'s header). Its `version` job puts the last tag's version and
 * CHANGELOG.md back, removes the changesets a tag already consumed, and runs this repository's own `changeset version` (the lockfile's `@changesets/cli`) on a release
 * commit on no branch. `main` is never written (chairman, a11ign/a11ign#928), which is why `main`'s CHANGELOG.md stops at 0.2.0 while every tag's carries every release.
 * The restore and the subtraction are toolchain's and tested there (`release-per-merge.test.ts`). What only THIS repository can get wrong is the input to the last step:
 * `.changeset/config.json`'s `changelog` generator and the `@changesets/cli` the lockfile installs. So this runs exactly that pair over the tree a release commit starts
 * from (the tag's version and CHANGELOG.md, plus 14 unreleased changesets) and reads the section it writes.
 *
 * The control: the same tree with the real config's `changelog` turned off gains no section at all, and the reading below sees that as a failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-sandbox";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = JSON.parse(readFileSync(`${REPO}.changeset/config.json`, "utf8")) as Record<string, unknown>;
const CHANGESET_BIN = `${REPO}node_modules/@changesets/cli/bin.js`;
const PACKAGE_NAME = (JSON.parse(readFileSync(`${REPO}package.json`, "utf8")) as { name: string }).name;

const LAST_TAG_VERSION = "0.343.0";
const NEXT_VERSION = "0.344.0";
const LAST_TAG_SECTION = `## ${LAST_TAG_VERSION}\n\n### Minor Changes\n\n- 10a2cba: The section the last tag's release wrote.\n`;
const CHANGESET_COUNT = 14;

const SCRATCH = tmpDirForFile("changelog-from-changesets-");
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
let counter = 0;

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv(GIT_ENV) });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
}

/** One unreleased change per changeset: the first is a minor, the rest patches, so the section has both headings and the version moves by a minor. */
function changesetSummaries(): string[] {
  return Array.from({ length: CHANGESET_COUNT }, (_, i) => `Unreleased change number ${i + 1} of ${CHANGESET_COUNT}.`);
}

function changesetFile(summary: string, bump: "minor" | "patch"): string {
  return `---\n"${PACKAGE_NAME}": ${bump}\n---\n\n${summary}\n`;
}

/** The tree a release commit starts from: the last tag's version and CHANGELOG.md, this repository's changeset config, and the unreleased changesets, each committed on its own as a merge would carry it. */
function releaseTree(config: Record<string, unknown>): string {
  const dir = join(SCRATCH, `tree-${counter++}`);
  mkdirSync(join(dir, ".changeset"), { recursive: true });
  // `changeset version` resolves the config's `changelog` module from the tree it runs in, so the tree sees the repository's own installed packages.
  symlinkSync(`${REPO}node_modules`, join(dir, "node_modules"), "dir");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: LAST_TAG_VERSION })}\n`);
  writeFileSync(join(dir, "CHANGELOG.md"), `# ${PACKAGE_NAME}\n\n${LAST_TAG_SECTION}`);
  writeFileSync(join(dir, ".changeset/config.json"), `${JSON.stringify(config)}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `Release v${LAST_TAG_VERSION}`);
  changesetSummaries().forEach((summary, i) => {
    writeFileSync(join(dir, ".changeset", `change-${i + 1}.md`), changesetFile(summary, i === 0 ? "minor" : "patch"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `change ${i + 1}`);
  });
  return dir;
}

function changesetVersion(dir: string): void {
  const ran = spawnSync(process.execPath, [CHANGESET_BIN, "version"], { cwd: dir, encoding: "utf8", timeout: 120_000, env: sandboxGitEnv({ ...GIT_ENV, CI: "true" }) });
  assert.equal(ran.status, 0, `changeset version: ${ran.stdout}${ran.stderr}`);
}

/** The text under `## <version>`, up to the next version's heading. */
function sectionOf(changelog: string, version: string): string | undefined {
  const parts = changelog.split(/^## /m);
  const section = parts.find((part) => part.startsWith(`${version}\n`));
  return section === undefined ? undefined : `## ${section}`;
}

/** What is wrong with the CHANGELOG.md a release wrote, for the summaries it consumed; empty when the new section lists each of them once and the older section is kept. */
function changelogProblems(changelog: string, summaries: string[]): string[] {
  const section = sectionOf(changelog, NEXT_VERSION);
  if (section === undefined) return [`no "## ${NEXT_VERSION}" section`];
  const problems: string[] = [];
  const entries = section.split("\n").filter((line) => line.startsWith("- "));
  if (entries.length !== summaries.length) problems.push(`the ${NEXT_VERSION} section lists ${entries.length} changes, not ${summaries.length}`);
  for (const summary of summaries) {
    const hits = entries.filter((entry) => entry.endsWith(summary)).length;
    if (hits !== 1) problems.push(`"${summary}" is listed ${hits} times`);
  }
  const kept = changelog.indexOf(LAST_TAG_SECTION);
  if (kept < 0) problems.push(`the ${LAST_TAG_VERSION} section the last tag wrote is not kept`);
  else if (changelog.indexOf(`## ${NEXT_VERSION}`) > kept) problems.push(`the ${NEXT_VERSION} section is not above ${LAST_TAG_VERSION}`);
  return problems;
}

test("the repository's own `@changesets/cli` is installed, so the run below is the release's and not a stand-in", () => {
  assert.ok(existsSync(CHANGESET_BIN), `${CHANGESET_BIN} is missing: run pnpm install`);
});

test("a release with 14 changesets since the last tag gains a CHANGELOG.md section for its version listing those 14 changes", () => {
  const dir = releaseTree(CONFIG);
  changesetVersion(dir);

  assert.deepEqual(changelogProblems(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), changesetSummaries()), []);
  assert.equal((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version, NEXT_VERSION);
  assert.deepEqual(readdirSync(join(dir, ".changeset")).filter((name) => name.startsWith("change-")), [], "the consumed changesets are not removed");
});

test("CONTROL: the same release with the config's changelog turned off gains no section, and the reading says so", () => {
  const dir = releaseTree({ ...CONFIG, changelog: false });
  changesetVersion(dir);

  assert.deepEqual(changelogProblems(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), changesetSummaries()), [`no "## ${NEXT_VERSION}" section`]);
});

test("CONTROL: the reading refuses a section that drops a change, lists one twice, or loses the last tag's section", () => {
  const summaries = changesetSummaries();
  const entries = summaries.map((summary) => `- abc1234: ${summary}`);
  const changelog = (lines: string[], older = LAST_TAG_SECTION) => `# ${PACKAGE_NAME}\n\n## ${NEXT_VERSION}\n\n### Patch Changes\n\n${lines.join("\n")}\n\n${older}`;

  assert.deepEqual(changelogProblems(changelog(entries), summaries), [], "the well-formed section is refused");
  assert.notDeepEqual(changelogProblems(changelog(entries.slice(1)), summaries), [], "a section missing one change");
  assert.notDeepEqual(changelogProblems(changelog([...entries.slice(1), entries[1]!]), summaries), [], "a section listing one change twice and dropping another");
  assert.notDeepEqual(changelogProblems(changelog(entries, ""), summaries), [], "a changelog that lost the last tag's section");
});

test("main's CHANGELOG.md says that a release's section is in the CHANGELOG.md of its tag and in its GitHub Release, because main's copy is never written", () => {
  const changelog = readFileSync(`${REPO}CHANGELOG.md`, "utf8");
  const firstSection = changelog.search(/^## /m);
  assert.ok(firstSection > 0, "main's CHANGELOG.md has no version section, so nothing here is a preamble");
  const preamble = changelog.slice(0, firstSection);
  assert.match(preamble, /git show v<version>:CHANGELOG\.md/);
  assert.match(preamble, /github\.com\/a11ign\/agent-org\/releases/);
});
