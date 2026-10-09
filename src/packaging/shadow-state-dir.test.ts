// no-token: gh
//
// Nothing here reaches the network or a real `gh`. Each reading is a child `node` importing the tool's own modules with `HOME` pointed at a
// path that is not the real one, against directories this file makes in a temp directory and deletes.

/**
 * #2623 DONE-WHEN 6: THE EXTRACTED GATE READS `A11IGN_SHADOW_STATE_DIR`.
 *
 * `decide(args)` has no state-directory parameter, so the shadow-window runner (#2846) hands the candidate its COPY of the state directory
 * through that variable, and "the candidate reads the copy" is true only once the gate's own state paths consult it. They did not: the drain
 * marker, the reviewer state and the shadow gate's live directory are constants computed at import from `stateEntryPath`, and it knew only
 * `host.json`. So the seam is `stateEntryPath`, and three things are pinned:
 *
 *   1. SET AND USABLE: all four readers (`DRAIN_MARKER`, `REVIEWER_STATE_DIR`, `LIVE_STATE_DIR`, the wake ledger) resolve under the copy, ahead
 *      of whatever `host.json` declares.
 *   2. SET AND UNUSABLE REFUSES, naming the path, never falling back. A variable that leaked into the LIVE tick would otherwise move its
 *      drain marker and reviewer state without a word. "Usable" is "carries the marker the runner writes", the runner's own test for a
 *      directory it may empty.
 *   3. UNSET IS TODAY'S BEHAVIOUR (`host-state-dir-wiring.test.ts` pins the strings; here the control is that the copy is NOT among them).
 *
 * The last test runs the runner end to end with the REAL `work-gate.mjs` imported by the candidate, because the first three read the seam and
 * only this one reads the seam as the runner arranges it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_MARKER, READS_DIR, STATE_DIR_ENV, shadowTick } from "../shadow-window.ts";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "../host-config.ts";
import { HOME_CHECKOUT } from "../project-config.ts";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_HOME = "/home/fixture";
const STDERR_EXCERPT = 400;
/** The fixture project's checkout must hold a `project.json`, because `project-config.mjs` reads it from the host's primary (#2873).
 * This file reads the four state paths, not the vocabulary, so a11ign's own checkout stands in for the fixture's. */
const PRIMARY_CHECKOUT = HOME_CHECKOUT;

const READER = `
  const gate = await import(${JSON.stringify(`${SRC}work-gate.mjs`)});
  const shadow = await import(${JSON.stringify(`${SRC}shadow-gate.mjs`)});
  const wake = await import(${JSON.stringify(`${SRC}wake.mjs`)});
  process.stdout.write(JSON.stringify({ DRAIN_MARKER: gate.DRAIN_MARKER, REVIEWER_STATE_DIR: gate.REVIEWER_STATE_DIR,
    LIVE_STATE_DIR: shadow.LIVE_STATE_DIR, ledger: wake.ledgerPathFrom([]) }));`;

type Four = { DRAIN_MARKER: string; REVIEWER_STATE_DIR: string; LIVE_STATE_DIR: string; ledger: string };

function withRoot(body: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-shadow-state-dir-")));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A directory the way the runner leaves one: made, with its marker written. */
function runnerCopy(root: string) {
  const copy = join(root, "copy");
  mkdirSync(copy);
  writeFileSync(join(copy, SHADOW_COPY_MARKER), "made by the runner\n");
  return copy;
}

/** Import the four readers with `shadowDir` as the variable (or unset), and a host that declares `stateDir` only when `hostStateDir` is given. */
function readFour(root: string, shadowDir: string | undefined, hostStateDir?: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: FIXTURE_HOME, AGENT_ORG_HOST: undefined, [SHADOW_STATE_DIR_ENV]: shadowDir };
  // Always a host: the tool finds its project through it (a standalone tool has no other way), `stateDir` only when the case declares one.
  const file = join(root, "host.json");
  writeFileSync(file, JSON.stringify({
    schema: 1, home: "/srv/acme", binDir: "/srv/acme/bin", primary: "widgets", ...(hostStateDir === undefined ? {} : { stateDir: hostStateDir }),
    projects: [{ id: "widgets", checkout: PRIMARY_CHECKOUT }],
    gh: { workers: "/srv/acme/workers", leads: "/srv/acme/leads", leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
  }));
  env.AGENT_ORG_HOST = file;
  return spawnSync(process.execPath, ["--input-type=module", "-e", READER], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
}

test("the runner and the gate agree on the variable's name and the marker's", () => {
  assert.equal(STATE_DIR_ENV, SHADOW_STATE_DIR_ENV);
  assert.equal(COPY_MARKER, SHADOW_COPY_MARKER);
  assert.equal(SHADOW_STATE_DIR_ENV, "A11IGN_SHADOW_STATE_DIR", "the name #2623 done-when 6 and #2846 both spell");
});

test("with a runner-made copy named, all four readers resolve under it, ahead of what host.json declares", () => {
  withRoot((root) => {
    const copy = runnerCopy(root);
    const run = readFour(root, copy, "/srv/acme/state");
    assert.equal(run.status, 0, `the modules failed to import: ${run.stderr.slice(0, STDERR_EXCERPT)}`);
    assert.deepEqual(JSON.parse(run.stdout) as Four, {
      DRAIN_MARKER: `${copy}/drain`, REVIEWER_STATE_DIR: copy, LIVE_STATE_DIR: copy, ledger: `${copy}/wake-ledger`,
    });
    const without = readFour(root, undefined, "/srv/acme/state");
    assert.equal(without.status, 0, without.stderr.slice(0, STDERR_EXCERPT));
    assert.equal((JSON.parse(without.stdout) as Four).REVIEWER_STATE_DIR, "/srv/acme/state",
      "POSITIVE CONTROL: the same host with the variable unset reads its own stateDir, so the copy above was chosen by the variable");
  });
});

test("unset, and no host stateDir: a11ign's directory, and the copy is not among the readings", () => {
  withRoot((root) => {
    const copy = runnerCopy(root);
    const run = readFour(root, undefined);
    assert.equal(run.status, 0, run.stderr.slice(0, STDERR_EXCERPT));
    const four = JSON.parse(run.stdout) as Four;
    assert.equal(four.REVIEWER_STATE_DIR, `${FIXTURE_HOME}/.cache/a11ign`);
    assert.ok(Object.values(four).every((path) => !path.startsWith(copy)), "a copy exists on disk and nothing read it, because nothing named it");
  });
});

test("set and unusable REFUSES naming the path, and prints no path: not a directory the runner made, relative, or empty", () => {
  withRoot((root) => {
    const notMade = join(root, "someone-elses-directory");
    mkdirSync(notMade);
    const cases: Array<[string, string, RegExp]> = [
      ["a directory without the runner's marker", notMade, new RegExp(`${notMade.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has no ${SHADOW_COPY_MARKER}`)],
      ["a path that does not exist", join(root, "nowhere"), /has no \.shadow-copy/],
      ["a relative path", "state/copy", /must be an absolute path/],
      ["the empty string", "", /must be an absolute path/],
    ];
    assert.equal(cases.length, 4, "POSITIVE CONTROL: four unusable spellings are tried, so an empty failure list is not a loop over nothing");
    for (const [what, value, message] of cases) {
      const run = readFour(root, value);
      assert.notEqual(run.status, 0, `${what}: importing must fail`);
      assert.match(run.stderr, message, `${what}: the refusal names what was wrong`);
      assert.equal(run.stdout, "", `${what}: and no path was answered`);
    }
    assert.equal(readFour(root, runnerCopy(root)).status, 0, "POSITIVE CONTROL: the same loop's refusal is about the value, since a runner-made copy imports cleanly");
  });
});

test("end to end: the runner hands the REAL gate's state paths its copy, and the live directory is not among them", () => {
  withRoot((root) => {
    const live = join(root, "live");
    mkdirSync(join(live, READS_DIR), { recursive: true });
    const tickMs = Date.UTC(2026, 9, 1, 8, 0, 0);
    writeFileSync(join(live, READS_DIR, `${tickMs}.json`), JSON.stringify({ tick: tickMs, args: { prs: [], readyRows: [] }, orders: [] }));
    // The candidate IS the real gate, wrapped only so the paths it resolved at import come back as an order the record can carry.
    const candidate = join(root, "candidate.mjs");
    writeFileSync(candidate, `import { decide as real, REVIEWER_STATE_DIR, DRAIN_MARKER } from ${JSON.stringify(`${SRC}work-gate.mjs`)};
export function decide(args) {
  return [...real(args), { causeKey: "paths", cause: "paths", session: "s", subject: REVIEWER_STATE_DIR, discriminator: DRAIN_MARKER, prompt: "p" }];
}`);
    const copy = join(root, "copy");
    const result = shadowTick({ liveDir: live, copyDir: copy, recordPath: join(root, "out", "diff.jsonl"), candidate });
    assert.equal(result.status, "RECORDED");
    const record = result.record!;
    assert.equal(record.candidateExit, 0, `the real gate ran as a candidate: ${(record.differences[0] as { error?: string } | undefined)?.error ?? ""}`);
    assert.deepEqual(record.candidate?.map((o: { subject: string; discriminator: string }) => [o.subject, o.discriminator]), [[copy, `${copy}/drain`]]);
    assert.notEqual(copy, live, "POSITIVE CONTROL: the live directory and the copy are different paths, so the reading above is the copy and not a coincidence");
  });
});
