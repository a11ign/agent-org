// no-token: gh
// a11ign/a11ign#3965 (earlier #3069, #3134, #3187, #3958): this file reads release.yml, CHANGELOG.md, package.json and README.md; nothing here spawns a process or needs the network.
/**
 * A RELEASE OF agent-org IS A TAG THAT CANNOT BE CUT BY ACCIDENT, OR TWICE (a11ign/a11ign#3069), AND THE FILE THAT STARTS IT MUST BE ONE GITHUB WILL RUN (#3965).
 *
 * This file used to RUN the in-file gate and tag steps against scratch git repositories and a stand-in `gh`. Those steps are gone: `release.yml` calls the shared per-merge
 * workflow in a11ign/toolchain, pinned at `ab856fdd`. For EACH old test, where it is now (toolchain's names are the test titles in `scripts/release-parity.test.ts` and
 * `scripts/release-per-merge-pipefail.test.ts`, read at that sha):
 *   - "the gate step waits for an absent or running gate, passes on success alone, and refuses anything else or giving up" and its positive control ... toolchain
 *     "parity G5: the gate waits for an absent or running check, passes on success alone, refuses any other conclusion, gives up ..." and "parity G5: the gate check is seen to
 *     FAIL on a step that accepts failure, never waits, never gives up, reads a stranger's success ...", which RUN the same bash against a stand-in `gh`;
 *   - "the tag step reports a tag the remote has, one it lacks, and does not read an unreadable remote as free" and its control ... toolchain "parity G5: the tag step pushes
 *     every tag atomically and never forced, moves no tag that appeared, cuts no Release for it, and does not read an unreadable remote as free" and "... the tag check is seen
 *     to FAIL on a push that is not atomic, one that is forced, and one that swallows an unreadable remote";
 *   - "the tag is `v` plus the package.json version, and a version that is not MAJOR.MINOR.PATCH is refused" ... toolchain "parity G4: a version that is not MAJOR.MINOR.PATCH is
 *     refused, naming the package, before any release commit or tag" and "the lone package at the root is tagged v<version>";
 *   - "the CHANGELOG step takes the entry for the version and refuses a version with none" ... toolchain "parity G3: a version with no changelog entry is refused in the version
 *     job, before any release commit or tag";
 *   - "the shell these steps run under is `bash -e`" and "no `run:` pipes a command that can fail into tee" ... toolchain `release-per-merge-pipefail.test.ts` (the shared
 *     steps run under `shell: bash`, which is `bash -eo pipefail`, #3766); the caller has no `run:` at all, which `release-tag-on-merge.test.ts` pins;
 *   - "the real release.yml is valid YAML, and a plain scalar holding `: ` is seen as the invalid YAML it is" ... HERE, unchanged: GitHub runs nothing from an invalid file and
 *     lists the workflow by its path, and PR #70 merged with exactly that in a `run:`;
 *   - "the real CHANGELOG.md carries an entry for the package.json version, and the README says how a release happens" ... HERE, unchanged: they read real files, not the workflow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Workflow { jobs: Record<string, unknown> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const README = readFileSync(`${REPO}README.md`, "utf8");
const PARSED = parse(readFileSync(`${REPO}.github/workflows/release.yml`, "utf8")) as Workflow;

test("the real release.yml is valid YAML, and a plain scalar holding `: ` is seen as the invalid YAML it is", () => {
  assert.ok(Object.keys(PARSED.jobs).length > 0);
  assert.throws(() => parse("jobs:\n  a:\n    steps:\n      - run: echo \"dry-run=$X: the tag\"\n"), /Nested mappings are not allowed|Implicit map keys/);
  assert.doesNotThrow(() => parse("jobs:\n  a:\n    steps:\n      - run: |\n          echo \"x: y\"\n      - name: 'p: q'\n"));
});

test("the real CHANGELOG.md carries an entry for the package.json version, and the README says how a release happens", () => {
  const version = (JSON.parse(readFileSync(`${REPO}package.json`, "utf8")) as { version: string }).version;
  assert.match(readFileSync(`${REPO}CHANGELOG.md`, "utf8"), new RegExp(`^## ${version.replace(/\./g, "\\.")}$`, "m"));
  assert.ok(README.includes("## Releases"));
  const releases = README.slice(README.indexOf("## Releases"));
  for (const phrase of ["never moved or deleted", "release commit", "changeset", "#semver:", "toolVersion", "lag"]) assert.ok(releases.includes(phrase), `README's Releases section lacks "${phrase}"`);
  for (const gone of ["publish-for-real", "dry run", "gh workflow run", "version pull request", "reopen", "tracks `main`", "not a deploy"]) assert.ok(!releases.includes(gone), `README's Releases section still says "${gone}", which the workflow no longer has`);
});
