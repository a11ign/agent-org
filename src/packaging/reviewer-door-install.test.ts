/**
 * The reviewers' verdict door RESOLVES and is KEPT CURRENT (#3316, found on #3311).
 *
 * `reviewer-3311` finished a review and could not post it: `pr-review-verdict: command not found`. Two defects behind one
 * symptom -- `~/reviewer/bin` is on no PATH while every order printed the bare name, and the installed copy was 7,227 bytes
 * against a 15,704-byte source because `install-reviewer-bin.sh` was called by nothing and `host:check` never read the install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./host-units-project.ts"; // FIRST of the tool imports: it makes a fixture project the tool's before `host-units.mjs` resolves one (#3233)

const { REVIEWER_DOOR_SOURCE, driftReport, hostUnitDrift, reviewerDoorDrift, reviewerDoorInstall, reviewerDoorPath, reviewerDoorState }
  = await import("../host-units.mjs");

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const INSTALLER = here("../reviewer/install-reviewer-bin.sh");
const WAKE = here("../wake.mjs");
const PR_ORDERS = here("../work-gate/pr-orders.mjs");
/** The door as it stood before #3030, 7,227 bytes: the very file the reviewers were running on 2026-10-03. */
const PRE_3030 = readFileSync(here("./fixtures/reviewer-door/pr-review-verdict.pre-3030.sh"), "utf8");
const INCIDENT_BYTES = 7227;
// Only `home` is read; the rest of the host config is not what these tests are about.
const NO_HOST = { host: { home: "/nonexistent-home" } } as unknown as Parameters<typeof reviewerDoorPath>[0];

/** The spelling the installer writes to, READ from its default and not restated: `${A11Y_REVIEWER_BIN:-$HOME/reviewer/bin}/pr-review-verdict`. */
function installerDefault(): string {
  const line = readFileSync(INSTALLER, "utf8").split("\n").find((l) => l.startsWith("dest="));
  const spelled = /\$\{A11Y_REVIEWER_BIN:-([^}]+)\}\/(pr-review-verdict)\}?"?$/.exec(line ?? "");
  assert.ok(spelled, `could not read the installer's default out of: ${line}`);
  return `${spelled[1]}/${spelled[2]}`;
}

function inTemporaryBin(body: (reviewerBin: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "reviewer-door-3316-"));
  try {
    body(join(root, "reviewer", "bin"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plant(reviewerBin: string, text: string): string {
  mkdirSync(reviewerBin, { recursive: true });
  const target = join(reviewerBin, "pr-review-verdict");
  writeFileSync(target, text);
  return target;
}

// --- 1. a drifted installed door is REPORTED -------------------------------------------------------------------------

test("the positive control IS the incident: the pre-#3030 door is 7,227 bytes and the shipped one is not", () => {
  assert.equal(Buffer.byteLength(PRE_3030), INCIDENT_BYTES);
  assert.notEqual(PRE_3030, readFileSync(REVIEWER_DOOR_SOURCE, "utf8"));
});

test("1. a drifted door is DRIFTED in the report; an identical copy is CURRENT and the report says so", () => {
  inTemporaryBin((reviewerBin) => {
    const target = plant(reviewerBin, PRE_3030);
    const [finding, ...rest] = reviewerDoorDrift({ ...NO_HOST, reviewerBin });
    assert.deepEqual([finding.problem, finding.unit, rest.length], ["DRIFTED", target, 0]);
    assert.equal(reviewerDoorState({ ...NO_HOST, reviewerBin }).installedBytes, INCIDENT_BYTES, "the state carries the incident's byte count");
    assert.match(driftReport([finding]), new RegExp(`${target}: DRIFTED`));
    assert.match(driftReport([finding]), /Remedy for all of them: pnpm run host:install/);

    writeFileSync(target, readFileSync(REVIEWER_DOOR_SOURCE));
    assert.deepEqual(reviewerDoorDrift({ ...NO_HOST, reviewerBin }), [], "the one-change control: only the bytes differ");
    assert.equal(reviewerDoorState({ ...NO_HOST, reviewerBin }).state, "CURRENT");
    assert.match(driftReport([]), /reviewer door is CURRENT/);
  });
});

test("1. an absent door is NOT INSTALLED, and an unreadable source is neither CURRENT nor DRIFTED", () => {
  inTemporaryBin((reviewerBin) => {
    assert.equal(reviewerDoorDrift({ ...NO_HOST, reviewerBin })[0].problem, "NOT INSTALLED");
    plant(reviewerBin, "");
    const unreadable = { ...NO_HOST, reviewerBin, source: join(reviewerBin, "no-such-source") };
    assert.equal(reviewerDoorState(unreadable).state, "SOURCE UNREADABLE", "an empty installed file must not equal an unreadable source");
  });
});

test("1. `host:check` is WIRED to it: hostUnitDrift carries the door finding, and drops it once CURRENT", () => {
  // THE MUTANT: deleting `...reviewerDoorDrift(deps)` from `hostUnitDrift` kills every direct call above and none of the command run.
  inTemporaryBin((reviewerBin) => {
    const target = plant(reviewerBin, PRE_3030);
    const asked = { reviewerBin, systemctl: () => "LANG=C\n", shippedDir: reviewerBin, installedDir: reviewerBin };
    const mine = (deps: object) => (hostUnitDrift(deps as never) as { unit: string, problem: string }[]).filter((d) => d.unit === target);
    assert.deepEqual(mine(asked).map((d) => d.problem), ["DRIFTED"]);
    writeFileSync(target, readFileSync(REVIEWER_DOOR_SOURCE));
    assert.deepEqual(mine(asked), []);
  });
});

// --- 2. no order prints a spelling that does not resolve -------------------------------------------------------------

test("the spelling orders print is the installer's default, read from the script", () => {
  assert.equal(installerDefault(), "$HOME/reviewer/bin/pr-review-verdict");
  for (const file of [WAKE, PR_ORDERS]) {
    assert.equal(/const REVIEWER_DOOR = "([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1], installerDefault(),
      `${file} keeps the spelling it prints in step with the installer's default`);
  }
  const home = "/home/somebody";
  assert.equal(reviewerDoorPath({ host: { home } } as never), installerDefault().replace("$HOME", home),
    "host:check compares the file the installer writes, not a second opinion about where it is");
});

/**
 * Every line of code that tells a reviewer to post: it names the door, by the bare name or through the constant. A comment and the
 * constant's own definition do not. A line that regressed to the bare name still names the door, which is what makes it findable.
 */
const instructsToPost = (line: string) => /pr-review-verdict(?!\.sh)|\$\{REVIEWER_DOOR\}/.test(line)
  && !/^\s*(\*|\/\/|\/\*)/.test(line) && !/^\s*(export )?const REVIEWER_DOOR =/.test(line);
/** A line in an order that names the door by a spelling that cannot resolve: the bare name, not preceded by the install path. */
const bareDoorName = (line: string) => /(^|[\s`])pr-review-verdict(?=[\s`])/.test(line.replace(/\$HOME\/reviewer\/bin\/pr-review-verdict/g, ""));

test("2. the detector refuses the bare name and accepts the installed path (both directions)", () => {
  assert.equal(bareDoorName("post it as `A11Y_REVIEWER_SESSION=reviewer-6 pr-review-verdict <n>`"), true);
  assert.equal(bareDoorName("post it as `A11Y_REVIEWER_SESSION=reviewer-6 $HOME/reviewer/bin/pr-review-verdict <n>`"), false);
});

test("2. every order in wake.mjs and pr-orders.mjs that tells a reviewer to post names the installed path", () => {
  const orders = [WAKE, PR_ORDERS].flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, i) => ({ file, text, line: i + 1 })))
    .filter(({ text }) => instructsToPost(text));
  assert.ok(orders.length >= 2, "positive control: both files carry an order that names the door");
  for (const { file, text, line } of orders) {
    assert.ok(text.includes("${REVIEWER_DOOR}"), `${file}:${line} tells a reviewer to post without the installed path: ${text.trim()}`);
    assert.equal(bareDoorName(text), false, `${file}:${line} prints the bare name`);
  }
});

// --- 3. the install is reachable -------------------------------------------------------------------------------------

test("3. host:install's door step leaves a byte-identical, executable door at the declared path, and keeps what it replaced", () => {
  inTemporaryBin((reviewerBin) => {
    const printed: string[] = [];
    const target = plant(reviewerBin, PRE_3030);
    const installed = reviewerDoorInstall({ ...NO_HOST, reviewerBin, out: (l: string) => printed.push(l) });
    assert.equal(installed, target);
    assert.ok(readFileSync(target).equals(readFileSync(REVIEWER_DOOR_SOURCE)), "byte-identical to the source");
    assert.ok((statSync(target).mode & 0o111) !== 0, "executable");
    assert.match(printed.join(""), /kept the previous door at .*\.bak-/);
    assert.deepEqual(reviewerDoorDrift({ ...NO_HOST, reviewerBin }), [], "and the check now reads CURRENT");
  });
});

test("3. the door step is part of `host:install`, not just exported", () => {
  const main = readFileSync(here("../host-units.mjs"), "utf8").split("\n");
  const at = main.findIndex((l) => l.trim() === "reviewerDoorInstall();");
  assert.ok(at > 0 && main.slice(at - 6, at).some((l) => l.includes("--install")), "reviewerDoorInstall() is called inside the --install branch of main()");
});
