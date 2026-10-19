// no-token: gh -- the refusal is a tracker key no project declares, refused before any `gh` call; the one subprocess is the real `row-claim.ts` with HOME in a temporary directory.
/**
 * `src/row-claim.ts`, agent-org#972 (the recorder agent-org#889's storm signal reads): EVERY REFUSED CLAIM IS ONE `claim-refused` LINE OF THE FAILURE LEDGER.
 *
 * POSITIVE CONTROLS. The refused claim is run as a real process, so the line it leaves is the one the tool wrote, not one this file wrote for it; the reason is checked
 * against what the process PRINTED, so a recorder that wrote some other text fails here. Eleven recorded refusals inside the window TRIP `claim-refusal-storm` and ten do
 * not, read back through the real `readClaimRefusals`. An unwritable ledger leaves the exit code and the printed verdict what they were.
 *
 * NOT COVERED HERE: a claim that LANDS leaves no line. That path needs `gh` to write a row, which this suite does not call; the recorder is only called at the refusal
 * exits, which is what keeps a landed claim out of the ledger by construction.
 *
 * MUTATIONS, each run by hand and recorded on the row: a recorder that writes nothing (the subprocess and the eleven tests go red), a reason that is the whole refusal
 * rather than its first line (the reason test goes red), and a recorder that throws into the claim (the unwritable test goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE STORM READER IS `org-health.ts`, WHICH RESOLVES THE CHECKOUT IT SERVES WHEN IT IS IMPORTED: the host file is set FIRST and the tools imported AFTER it, as
// `claim-refusal-storm.test.ts` does.
const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-refusal-record-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { recordClaimRefusal } = await import("./row-claim.ts");
const { readClaimRefusals, claimRefusalStormReading } = await import("./org-health/claim-refusal.ts");
const { CLAIM_REFUSED_KIND, parseFailureLedger } = await import("./failure-ledger.ts");

const NOW = Date.UTC(2026, 9, 11, 9, 0);
const MINUTE = 60_000;
const ROW_CLAIM = fileURLToPath(new URL("./row-claim.ts", import.meta.url));
const REFUSAL = "no tracker with key `nope` is declared in .agent-org/project.json (declared: the empty key); nothing is defaulted to another tracker's row of the same number";
const PRINTED_PREFIX = "NOT CLAIMED: ";

/** The claim, run as the real process with HOME in `home`: the host file names the fixture project (the child cannot resolve one without it), and the launch gate's reason is set so it runs outside a linked worktree. */
function claimIn(home: string) {
  return spawnSync(process.execPath, [ROW_CLAIM, "claim", "972", "--session=worker-agent-org-972", "--tracker=nope"],
    { env: { ...process.env, HOME: home, A11Y_POLICY_LAUNCH_REASON: "row-claim-refusal-record test fixture" }, encoding: "utf8" });
}

/** The ledger under HOME: the declared host sets no `stateDir`, so `host-config.ts`'s `stateEntryPath` falls back to `${HOME}/.cache/a11ign`. A directory tree, so a test can read the line the tool wrote. */
const ledgerUnder = (home: string): string => join(home, ".cache", "a11ign", "failure-ledger");

/** The entries under HOME, parsed, so a test reads them as the next tool would. */
const ledgerEntriesUnder = (home: string) => parseFailureLedger(readFileSync(ledgerUnder(home), "utf8"));

test("a refused claim leaves exactly one claim-refused line, whose reason is the refusal's first line", () => {
  const home = join(SCRATCH, "home-refused");
  mkdirSync(home, { recursive: true });
  const run = claimIn(home);
  assert.equal(run.status, 1, `a refused claim exits 1: ${run.stderr}`);
  const printed = run.stdout.split("\n")[0];
  assert.equal(printed, `${PRINTED_PREFIX}${REFUSAL}`, "the verdict the tool printed is the refusal, unchanged");
  const lines = readFileSync(ledgerUnder(home), "utf8").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, "one refusal, one line");
  const [entry] = parseFailureLedger(lines.join("\n"));
  assert.equal(entry.classKey, CLAIM_REFUSED_KIND);
  assert.equal(entry.ref, printed.slice(PRINTED_PREFIX.length), "the reason is the printed refusal's first line, which is the whole refusal here");
  assert.ok(Math.abs(entry.at - Date.now()) < 60 * MINUTE, "stamped with the time it was refused");
});

test("the reason keeps only the first line of a multi-line refusal, and spaces out its tabs", () => {
  const path = join(SCRATCH, "multi-line-ledger");
  recordClaimRefusal("first\tline of a refusal\nsecond line the ledger never holds", { logPath: path, now: NOW });
  assert.deepEqual(parseFailureLedger(readFileSync(path, "utf8")), [{ classKey: CLAIM_REFUSED_KIND, at: NOW, ref: "first line of a refusal" }]);
});

test("eleven refusals inside the window trip the storm, and ten do not, read back through readClaimRefusals", () => {
  const path = join(SCRATCH, "storm-ledger");
  const record = (count: number) => {
    for (let i = 0; i < count; i += 1) recordClaimRefusal(REFUSAL, { logPath: path, now: NOW - i * MINUTE });
    return readClaimRefusals({ path });
  };
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: record(10) }).status, "clear", "ten do not trip");
  assert.equal(claimRefusalStormReading({ now: NOW, refusals: record(1) }).status, "tripped", "the eleventh does");
});

test("an unwritable ledger is said on stderr, and the verdict and exit code are what they were", () => {
  const home = join(SCRATCH, "home-unwritable");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".cache"), "a file where the state directory must be");
  const run = claimIn(home);
  assert.equal(run.status, 1, "the claim's exit code is the refusal's, not the ledger's");
  assert.equal(run.stdout.split("\n")[0], `${PRINTED_PREFIX}${REFUSAL}`, "the verdict is the refusal, unchanged");
  assert.match(run.stderr, /failure-ledger: NOT RECORDED claim-refused/, "the refused append is said on stderr");
});

test("a decline that cannot read its row says COULD NOT DETERMINE, exits 2, and leaves one claim-refused line", () => {
  // THE DECLINE'S OWN CATCH (agent-org#972 review): `gh` is a shim that always fails, so `declineRow` throws before any write. Nothing reaches GitHub.
  const home = join(SCRATCH, "home-decline");
  mkdirSync(home, { recursive: true });
  const shimBin = join(SCRATCH, "gh-down");
  mkdirSync(shimBin, { recursive: true });
  writeFileSync(join(shimBin, "gh"), "#!/bin/sh\necho \"gh: simulated outage\" >&2\nexit 1\n");
  chmodSync(join(shimBin, "gh"), 0o755);
  const run = spawnSync(process.execPath, [ROW_CLAIM, "decline", "972", "--session=worker-agent-org-972"],
    { env: { ...process.env, PATH: `${shimBin}:${process.env.PATH}`, HOME: home, A11Y_POLICY_LAUNCH_REASON: "row-claim-refusal-record test fixture" }, encoding: "utf8" });
  assert.equal(run.status, 2, `a decline that cannot read its row exits 2: ${run.stderr}`);
  // gh's own stderr comes first; the tool's verdict is the line that names the outcome.
  const printed = run.stderr.split("\n").find((line) => line.startsWith("COULD NOT DETERMINE: ")) ?? "";
  assert.notEqual(printed, "", "the verdict the tool printed is the could-not-determine one");
  const entries = ledgerEntriesUnder(home);
  assert.equal(entries.length, 1, "one refusal, one line");
  const [entry] = entries;
  assert.equal(entry.classKey, CLAIM_REFUSED_KIND);
  assert.equal(entry.ref, printed.slice("COULD NOT DETERMINE: ".length), "the reason is the printed message's first line");
});
