// no-token: gh
//
// Nothing here reaches the network or a real `gh`. Each reading is a child `node` importing the tool's own modules against a `host.json`
// this file writes to a temp directory and deletes, with `HOME` pointed at a path that is not the real one.

/**
 * #2799 (child 5c of #2623): THE DRAIN MARKER, THE REVIEWER STATE, THE SHADOW GATE'S LIVE DIRECTORY AND THE WAKE LEDGER READ THE HOST'S
 * `stateDir`, not a hard-coded `~/.cache/a11ign` -- with the running unit untouched.
 *
 * #2793 (child 5b) gave `host.json` a `stateDir` and the reader `stateFilePath`, and four constants went on spelling a11ign's directory:
 * `DRAIN_MARKER` and `REVIEWER_STATE_DIR` (`work-gate.ts`), `LIVE_STATE_DIR` (`shadow-gate.ts`) and `ledgerPathFrom`'s default
 * (`wake.ts`). Until they read the host's, #2623's cut-over would point `host.json` at the installed tool while the gate, the drain marker,
 * the reviewer state and the wake ledger still read a11ign's directory.
 *
 * **It changes nothing that runs.** a11ign's `host.json` declares no `stateDir`, so each of the four resolves to the string it always did
 * (asserted below against the real modules under the real `host.json`, and under a fixture with none). Editing a11ign's `host.json` is
 * #2623's cut-over, not this row's.
 *
 * THE FOUR ARE READ BY IMPORTING THEM in a child process whose `AGENT_ORG_HOST` names a fixture, because three of them are constants
 * computed at import and a test that re-derived them would be reading its own copy of the derivation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeHostConfig, stateEntryPath } from "../host-config.ts";
import { HOME_CHECKOUT, HOST_ENV } from "../project-config.ts";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_HOME = "/home/fixture";
const A11IGN_STATE = `${FIXTURE_HOME}/.cache/a11ign`;
const FIXTURE_STATE_DIR = "/srv/acme/state";
/** The fixture project's checkout. It does not exist, and `project-config.ts` now reads `project.json` from the primary's checkout
 * (#2873), so `readFourUnder` swaps in a checkout that does: this file reads the four paths, not the vocabulary. */
const FIXTURE_CHECKOUT = "/srv/acme/repos/widgets";
const REAL_CHECKOUT = HOME_CHECKOUT;
const STDERR_EXCERPT = 400;
/** The directory (twice: the reviewer state and the shadow gate's live directory), the drain marker and the ledger. */
const DISTINCT_PATHS = 3;

/** The four readings, in the order the row names them. */
const FOUR = ["DRAIN_MARKER", "REVIEWER_STATE_DIR", "LIVE_STATE_DIR", "ledgerPathFrom([])"] as const;
type Four = Record<(typeof FOUR)[number], string>;

/** A host that is nothing like a11ign's, with or without a `stateDir`. */
const fixtureHost = (extra: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, home: "/srv/acme", binDir: "/srv/acme/bin", primary: "widgets",
  projects: [{ id: "widgets", checkout: FIXTURE_CHECKOUT }],
  gh: { workers: "/srv/acme/workers", leads: "/srv/acme/leads", leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
  ...extra,
});

const READER = `
  const gate = await import(${JSON.stringify(`${SRC}work-gate.ts`)});
  const shadow = await import(${JSON.stringify(`${SRC}shadow-gate.ts`)});
  const wake = await import(${JSON.stringify(`${SRC}wake.ts`)});
  process.stdout.write(JSON.stringify({ DRAIN_MARKER: gate.DRAIN_MARKER, REVIEWER_STATE_DIR: gate.REVIEWER_STATE_DIR,
    LIVE_STATE_DIR: shadow.LIVE_STATE_DIR, "ledgerPathFrom([])": wake.ledgerPathFrom([]) }));`;

/** Import the tool's modules against `hostJson` (or the real `host.json` when null) and return what the four resolved to. */
function readFourUnder(hostJson: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "state-dir-wiring-"));
  try {
    // `null` reads the host file this process itself found the project through (unset in the project's own CI, where the tool sits inside the project).
    const env: Record<string, string | undefined> = { ...process.env, HOME: FIXTURE_HOME, AGENT_ORG_HOST: hostJson === null ? process.env[HOST_ENV] : undefined };
    if (hostJson !== null) {
      const file = join(dir, "host.json");
      writeFileSync(file, hostJson.replace(FIXTURE_CHECKOUT, REAL_CHECKOUT));
      env.AGENT_ORG_HOST = file;
    }
    return spawnSync(process.execPath, ["--input-type=module", "-e", READER], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fourUnder(hostJson: string | null): Four {
  const run = readFourUnder(hostJson);
  assert.equal(run.status, 0, `the modules failed to import: ${run.stderr.slice(0, STDERR_EXCERPT)}`);
  return JSON.parse(run.stdout) as Four;
}

test("#2799: with no `stateDir` each of the four resolves to exactly today's string", () => {
  const today: Four = {
    DRAIN_MARKER: `${A11IGN_STATE}/drain`,
    REVIEWER_STATE_DIR: A11IGN_STATE,
    LIVE_STATE_DIR: A11IGN_STATE,
    "ledgerPathFrom([])": `${A11IGN_STATE}/wake-ledger`,
  };
  assert.deepEqual(fourUnder(fixtureHost()), today, "a fixture host with no stateDir");
  assert.deepEqual(fourUnder(null), today, "and a11ign's own host.json, unedited, which is the running unit");
  assert.equal(Object.hasOwn(homeHostConfig(), "stateDir"), false, "POSITIVE CONTROL: a11ign's host.json really declares none, so the second reading is the default and not a declared value");
});

test("#2799: with a fixture `stateDir` each of the four resolves under it, and a11ign's directory is not among them", () => {
  assert.notEqual(FIXTURE_STATE_DIR, A11IGN_STATE, "POSITIVE CONTROL: the fixture's stateDir is not a11ign's, checked before it is used");
  assert.ok(!FIXTURE_STATE_DIR.startsWith(A11IGN_STATE) && !A11IGN_STATE.startsWith(FIXTURE_STATE_DIR));
  const declared = fourUnder(fixtureHost({ stateDir: FIXTURE_STATE_DIR }));
  const undeclared = fourUnder(fixtureHost());
  assert.deepEqual(declared, {
    DRAIN_MARKER: `${FIXTURE_STATE_DIR}/drain`,
    REVIEWER_STATE_DIR: FIXTURE_STATE_DIR,
    LIVE_STATE_DIR: FIXTURE_STATE_DIR,
    "ledgerPathFrom([])": `${FIXTURE_STATE_DIR}/wake-ledger`,
  });
  for (const name of FOUR) {
    assert.notEqual(declared[name], undeclared[name], `POSITIVE CONTROL: ${name} differs between the two hosts, so "equal" above is not one text compared with itself`);
    assert.ok(!declared[name].includes(".cache/a11ign"), `${name} still names a11ign's directory under a host that declares its own`);
  }
  assert.equal(new Set(FOUR.map((name) => declared[name])).size, DISTINCT_PATHS, "POSITIVE CONTROL: the four are three distinct paths (the directory twice), not one string repeated");
});

test("#2799: an unreadable host declaration REFUSES the import, and is never answered with a11ign's directory", () => {
  const run = readFourUnder("{ not json");
  assert.notEqual(run.status, 0, "importing against a malformed host.json must fail");
  assert.match(run.stderr, /HostConfigRefusal|not valid JSON/);
  assert.equal(run.stdout, "", "and nothing was printed, so no path was answered");
});

test("#2799: `stateEntryPath` is `stateFilePath`'s answer under a declared `stateDir` and the documented default otherwise", () => {
  const host = (extra: Record<string, unknown>) => ({ ...JSON.parse(fixtureHost()), ...extra });
  assert.equal(stateEntryPath("drain", { host: host({ stateDir: FIXTURE_STATE_DIR }), home: FIXTURE_HOME }), `${FIXTURE_STATE_DIR}/drain`);
  assert.equal(stateEntryPath("drain", { host: host({}), home: FIXTURE_HOME }), `${A11IGN_STATE}/drain`);
  assert.equal(stateEntryPath("", { host: host({}), home: "/root" }), "/root/.cache/a11ign", "the home is the process's HOME, as the four constants spelled it");
});

test("#2799: none of the four sites spells `.cache/a11ign` in code, and the documented default is spelled once", () => {
  const CODE = /^\s*(?!\/\/|\*|\/\*)\S.*\.cache\/a11ign/;
  const spelling = (file: string) => readFileSync(join(SRC, file), "utf8").split("\n").filter((line) => CODE.test(line));
  const sites = ["work-gate.ts", "shadow-gate.ts", "wake.ts"];
  assert.equal(sites.length, 3, "POSITIVE CONTROL: the three files the row names are scanned, so an empty offender list is not a scan of nothing");
  const offenders = sites.flatMap((file) => spelling(file).map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(offenders, [], "each of these still names a11ign's directory instead of reading the host's");
  assert.equal(spelling("host-config.ts").length, 1, "POSITIVE CONTROL: the scan does find a spelling where one is documented (the default), so an empty result above is not a scan that matches nothing");
});
