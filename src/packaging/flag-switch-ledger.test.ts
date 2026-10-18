// no-token: gh -- the ledger reads files and a throwaway local git repository, and `orgHealthNow` is handed fake readers for everything else; nothing reaches `gh`, the fleet or the network
/**
 * agent-org#1135: A FLAG THE CODE SHIPS OFF AND A11IGN NEVER SET IS COUNTED BY THE TICK.
 *
 * THE DEFECT: `rows.autoUnpark` (a11ign#5194) and the Haiku flags (a11ign#5138) merged behind a flag that is OFF when absent, and the first sign that nobody had set one was a human flipping
 * the switch hours later (class `hand-reroute`: a11ign#5041, #5139, #5195). The chairman's rule (a11ign#928, 2026-10-12) asked for a switch row filed with the change, and "org-health counts
 * violations" had no code behind it.
 *
 * WHAT IS PINNED, with the mutation that breaks each, run by hand and recorded on the row:
 *   (1) the registry: `discoverFlags` finds the seven keys of the row's open-check in THIS tree (POSITIVE CONTROL), and nothing that is not a dotted key or sits in a test file;
 *       break: narrow the pattern to `[a-z]+\.[a-z]+` (the camelCase keys vanish) -- (1) goes red.
 *   (2) the three directions of the row's Done-when 2: a key absent from the declaration is reported, the same key set `false` is not, and a key in `FLAGS_WITH_ANOTHER_HOME` is not;
 *       break: `unsetFlags` reports every shipped flag -- the `false` and `another home` cases go red; `unsetFlags` reports none -- the absent case goes red.
 *   (3) a declaration that cannot be read makes the answer UNKNOWN, never a list (a file that did not parse would otherwise name every flag), and a required file that is missing is the same;
 *       break: `continue` past a parse failure -- (3) goes red.
 *   (4) the merge date is the first-parent merge that added the key, with its pull request number;
 *       break: drop `--first-parent` -- the branch commit is found first, whose subject names no pull request, and (4) goes red.
 *   (5) the reading and its order: unknown is never clear, the order is keyed on the day so a standing set is named once a day, it goes to `product-manager` and `ceo`;
 *       break: take the day out of the discriminator -- the once-a-day case goes red.
 *   (6) WIRING: `orgHealthNow` asks only when handed a reader and says nothing otherwise, and the gate's call site hands it `readFlagLedger`;
 *       break: drop `readFlagSwitches` at `work-gate.ts`'s call -- the wiring test goes red; make `orgHealthNow`'s default a read -- the "does not ask" case goes red. WHY THE DEFAULT IS
 *       SILENT, MEASURED: a first version had `orgHealthTick` read the ledger itself when given none (as it does the copies), and 25 tests in 8 other files failed on the extra order.
 *   (8) agent-org#1372: THE OTHER TRACKERS. A canary-homed flag the home rows do not name is cleared by a `ready` or `in-progress` row in another declared tracker; the other trackers
 *       are asked only for such a flag, and a refused list is UNKNOWN. break: read the home rows only -- the first case goes red (no other list is asked, and the flag is counted).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { workGateSource } from "../lib/work-gate-source.ts";
import type { CanaryState } from "../org-health/fleet-build-incident.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-fleet-build-fact.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically, so
// the Acceptance's `AGENT_ORG_HOST` (a11y-witness's live declaration) is never what a test below reads; every ledger read gets its own roots.
const SCRATCH = mkdtempSync(join(tmpdir(), "flag-switch-ledger-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const ledger = await import("../flag-switch-ledger.ts");
const { discoverFlags, declaresKey, unsetFlags, mergeOf, readFlagLedger, readFlagSwitchesFor, readCanaryState, canaryAbsentFlags, otherTrackerRepos, owedRowsOf, CANARY_ABSENT_MS, FLAGS_WITH_ANOTHER_HOME } = ledger;
const { SIGNALS } = await import("../org-health/no-merge-hours.ts");
const { CANARY_STATE_FILE, flagSwitchReading } = await import("../org-health/claim-refusal.ts");
const { emptyCanaryState, orgHealthOrders, orgHealthReadings } = await import("../org-health/fleet-build-incident.ts");
const { withMachineryFlag } = await import("../org-health.ts");
const { FLAG_REGISTRY } = await import("../machinery-flag.ts");
const { ORG_HEALTH_CLASSES } = await import("../work-gate/org-health-suppression.ts");
const { orgHealthNow } = await import("../work-gate/org-health.ts");

const FLAG = (name: string, key: string, file = "src/x.ts") => ({ name, key, file });
/** Writes `files` (path to text) under a fresh directory and returns it. */
function tree(label: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(SCRATCH, `${label}-`));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("(1) POSITIVE CONTROL: the registry finds the nine keys of the rows' open-checks in this tree, and the registry is not a list typed here", () => {
  const found = discoverFlags();
  assert.ok(found !== null, "src/ of this tool can be listed");
  const keys = found.map((flag) => flag.key);
  for (const key of ["workers.haikuBrief", "workers.orchestratorOneShot", "rows.specLint", "rows.autoUnpark", "queue.chainWaitWake", "queue.reenqueueEjected", "rows.closedUnderOpenHalf", "queue.queueEntryNoRun", "holds.recheck", "prune.holdOpenPr"]) {
    assert.ok(keys.includes(key), `${key} is found (found: ${keys.join(", ")})`);
  }
  assert.equal(found.find((flag) => flag.key === "rows.autoUnpark")?.name, "AUTO_UNPARK_FLAG");
  assert.equal(found.find((flag) => flag.key === "rows.autoUnpark")?.file, "src/unpark-satisfied.ts");
  assert.equal(found.find((flag) => flag.key === "holds.recheck")?.name, "RECHECK_FLAG", "agent-org#1187: the flag the digest listed as flag-without-a-switch is found by its constant");
  assert.equal(found.find((flag) => flag.key === "prune.holdOpenPr")?.name, "OPEN_PR_HOLD_FLAG", "agent-org#1221: the flag the digest listed as flag-without-a-switch is found by its constant");
  assert.ok(!keys.some((key) => key.startsWith("--")), "a CLI flag constant (`--decision`) is not a switch");
});

test("(1) the walk takes `.ts` and `.mjs`, skips tests, fixtures and node_modules, and reads one key declared twice as one flag", () => {
  const root = tree("discover", {
    "src/a.ts": 'export const ALPHA_FLAG = "rows.alpha";\nexport const OPTION_FLAG = "--option";\nexport const NOT_A_KEY_FLAG = "plain";\n',
    "src/deep/b.mjs": 'export const BETA_FLAG = "queue.beta";\n',
    "src/c.ts": 'export const ALPHA_AGAIN_FLAG = "rows.alpha";\n',
    "src/a.test.ts": 'export const IN_A_TEST_FLAG = "rows.inTest";\n',
    "src/fixtures/d.ts": 'export const IN_A_FIXTURE_FLAG = "rows.inFixture";\n',
    "src/node_modules/e.ts": 'export const VENDORED_FLAG = "rows.vendored";\n',
    "src/f.ts": 'const NOT_EXPORTED_FLAG = "rows.local";\nexport const lowerCaseFlag = "rows.lower";\n',
  });
  assert.deepEqual(discoverFlags({ toolRoot: root }), [FLAG("BETA_FLAG", "queue.beta", join("src", "deep", "b.mjs")), FLAG("ALPHA_FLAG", "rows.alpha", join("src", "a.ts"))]);
  assert.equal(discoverFlags({ toolRoot: join(root, "no-such-directory") }), null, "a tree whose src cannot be listed is null, not an empty list");
});

test("(2) the three directions: absent is reported, the same key set `false` is not, and a key with another home is not", () => {
  const shipped = [FLAG("HAIKU_BRIEF_FLAG", "workers.haikuBrief"), FLAG("CHAIN_WAIT_FLAG", "queue.chainWaitWake")];
  const keysOf = (declarations: unknown[]) => unsetFlags({ shipped, declarations }).map((flag) => flag.key);
  assert.deepEqual(keysOf([{ decisions: true }]), ["workers.haikuBrief"], "absent: workers.haikuBrief is the violation; queue.chainWaitWake is switched by `machinery:flag`");
  assert.deepEqual(keysOf([{ workers: { haikuBrief: false } }]), [], "the same key set `false` is a decision, and not counted");
  assert.deepEqual(keysOf([{ workers: { haikuBrief: true } }]), [], "and `true` is one too");
  assert.deepEqual(keysOf([]), ["workers.haikuBrief"], "no declaration at all: still only the one without another home");
  assert.deepEqual(unsetFlags({ shipped: [FLAG("AUTO_UNPARK_FLAG", "rows.autoUnpark")], declarations: [] }), [], "rows.autoUnpark is switched by `machinery:flag`, so nothing declared does not count it (agent-org#1161)");
  assert.deepEqual(unsetFlags({ shipped: [FLAG("RECHECK_FLAG", "holds.recheck")], declarations: [] }), [], "agent-org#1187: holds.recheck is switched by `machinery:flag`, so the digest does not list it as flag-without-a-switch");
  assert.deepEqual(unsetFlags({ shipped: [FLAG("OPEN_PR_HOLD_FLAG", "prune.holdOpenPr")], declarations: [] }), [], "agent-org#1221: prune.holdOpenPr is switched by `machinery:flag`, so the digest does not list it as flag-without-a-switch");
  assert.deepEqual(unsetFlags({ shipped: [FLAG("CHAIN_WAIT_FLAG", "queue.chainWaitWake")], declarations: [] }), [], "a key in FLAGS_WITH_ANOTHER_HOME is not reported with nothing declared");
  assert.deepEqual(unsetFlags({ shipped: [FLAG("CHAIN_WAIT_FLAG", "queue.chainWaitWake")], declarations: [], anotherHome: {} }).map((flag) => flag.key), ["queue.chainWaitWake"],
    "and the map is what excuses it: without the entry the same flag is reported (the exemption is not a hard-coded name)");
});

test("(2) both declared shapes decide a flag: nested (host.json) and flat dotted (decisions.json); a value that is not a boolean does not", () => {
  assert.equal(declaresKey({ workers: { haikuBrief: false } }, "workers.haikuBrief"), true, "nested false");
  assert.equal(declaresKey({ "routing.haikuDefault": true }, "routing.haikuDefault"), true, "flat true");
  assert.equal(declaresKey({ "rows.autoUnpark": false }, "rows.autoUnpark"), true, "flat false");
  assert.equal(declaresKey({ workers: { haikuBrief: "yes" } }, "workers.haikuBrief"), false, "a string is not a decision (the readers say `not true or false; it is off`)");
  assert.equal(declaresKey({ workers: { haikuBrief: null } }, "workers.haikuBrief"), false);
  assert.equal(declaresKey({ workers: { orchestratorOneShot: true } }, "workers.haikuBrief"), false, "a sibling key is not the key");
  assert.equal(declaresKey({ workers: [true] }, "workers.haikuBrief"), false);
  assert.equal(declaresKey(null, "workers.haikuBrief"), false);
  assert.equal(declaresKey("text", "workers.haikuBrief"), false);
});

test("(2) FLAGS_WITH_ANOTHER_HOME is exactly the flags `machinery:flag` switches, and every key in it is a flag the code ships", () => {
  assert.deepEqual(Object.keys(FLAGS_WITH_ANOTHER_HOME).sort(), [...FLAG_REGISTRY].sort(), "a fourth machinery flag is a change to the map, here, and not a silent gap");
  const shipped = (discoverFlags() ?? []).map((flag) => flag.key);
  for (const [key, reason] of Object.entries(FLAGS_WITH_ANOTHER_HOME)) {
    assert.ok(shipped.includes(key), `${key} is shipped, so the entry is not stale`);
    assert.notEqual(reason.trim(), "", `${key} names its reason`);
  }
});

/** A tool tree holding the two flags below, and a project whose declarations the cases vary. */
const TOOL = tree("tool", { "src/m.ts": 'export const HAIKU_BRIEF_FLAG = "workers.haikuBrief";\nexport const AUTO_UNPARK_FLAG = "rows.autoUnpark";\nexport const CHAIN_WAIT_FLAG = "queue.chainWaitWake";\n' });
const merge = (flag: { key: string; }) => ({ mergedAt: flag.key === "rows.autoUnpark" ? "2026-10-12T08:01:58+00:00" : "2026-10-11T18:46:01+00:00", pr: flag.key === "rows.autoUnpark" ? 1118 : 1022 });
const NOW = Date.parse("2026-10-13T12:00:00Z");
/** agent-org#1324: a canary state that carries EVERY canary-homed flag, off, so the canary half counts none; the existing cases below are about the declarations. */
function canaryDecided(names: readonly string[] = Object.keys(FLAGS_WITH_ANOTHER_HOME)): CanaryState {
  return names.reduce((state, name) => withMachineryFlag(state, { name, on: false }), emptyCanaryState());
}
const DECIDED = { canary: () => canaryDecided(), openRows: [], now: NOW };
function project(label: string, files: Record<string, string>) {
  const root = tree(label, Object.fromEntries(Object.entries(files).map(([name, text]) => [name === "host.json" ? "host/host.json" : `.agent-org/${name}`, text])));
  return { projectRoot: root, hostPath: join(root, "host", "host.json") };
}

test("(3) the ledger reads every declaration file: decided in host.json or decisions.json, an absent seats.json is no fault, and what is left is named with its merge", () => {
  const where = project("decided", { "project.json": "{}", "decisions.json": '{ "rows.autoUnpark": false }', "host.json": '{ "workers": { "haikuBrief": true } }' });
  assert.deepEqual(readFlagLedger({ ...DECIDED, toolRoot: TOOL, ...where, merge }), { shipped: 3, unset: [], canaryAbsent: [] }, "both decided (one flat and false, one nested and true) and the third has another home");
  const half = project("half", { "project.json": "{}", "host.json": "{}" });
  const answer = readFlagLedger({ ...DECIDED, toolRoot: TOOL, ...half, merge });
  assert.ok(!("unknown" in answer));
  assert.deepEqual(answer.unset.map(({ key, mergedAt, pr }) => ({ key, mergedAt, pr })), [
    { key: "workers.haikuBrief", mergedAt: "2026-10-11T18:46:01+00:00", pr: 1022 },
  ], "decisions.json absent is no fault; rows.autoUnpark has another home, so the one undecided flag is named with the merge that added it");
});

test("(3) a declaration that cannot be read is UNKNOWN and never a list, and so is a missing required file or a tree with no flag", () => {
  const malformed = project("malformed", { "project.json": "{}", "decisions.json": "{ not json", "host.json": "{}" });
  const bad = readFlagLedger({ ...DECIDED, toolRoot: TOOL, ...malformed, merge });
  assert.ok("unknown" in bad && /decisions\.json is not valid JSON/.test(bad.unknown), `names the file: ${JSON.stringify(bad)}`);
  const noHost = project("nohost", { "project.json": "{}" });
  const missing = readFlagLedger({ ...DECIDED, toolRoot: TOOL, ...noHost, merge });
  assert.ok("unknown" in missing && /host\.json could not be read/.test(missing.unknown), `a wrong $AGENT_ORG_HOST would otherwise name every flag: ${JSON.stringify(missing)}`);
  const noProject = project("noproject", { "host.json": "{}" });
  assert.ok("unknown" in readFlagLedger({ ...DECIDED, toolRoot: TOOL, ...noProject, merge }), "project.json is required too");
  const empty = readFlagLedger({ ...DECIDED, toolRoot: tree("empty", { "src/none.ts": "export const X = 1;\n" }), ...project("ok", { "project.json": "{}", "host.json": "{}" }), merge });
  assert.ok("unknown" in empty && /no `\*_FLAG` constant/.test(empty.unknown), "a walk that found nothing has not found a clean tree");
});

test("(3) the real tree against a declaration that sets nothing names the flags the row lists, and against one that sets them all names none", () => {
  const nothing = readFlagLedger({ ...DECIDED, ...project("real-nothing", { "project.json": "{}", "host.json": "{}" }), merge: () => ({ mergedAt: null, pr: null }) });
  assert.ok(!("unknown" in nothing));
  const keys = nothing.unset.map((flag) => flag.key);
  for (const key of ["workers.haikuBrief", "workers.orchestratorOneShot", "rows.specLint"]) assert.ok(keys.includes(key), `${key} is counted`);
  for (const key of Object.keys(FLAGS_WITH_ANOTHER_HOME)) assert.ok(!keys.includes(key), `${key} is not`);
  const all = Object.fromEntries((discoverFlags() ?? []).map((flag) => [flag.key, false]));
  const decided = readFlagLedger({ ...DECIDED, ...project("real-all", { "project.json": "{}", "decisions.json": JSON.stringify(all), "host.json": "{}" }), merge: () => ({ mergedAt: null, pr: null }) });
  assert.ok(!("unknown" in decided));
  assert.deepEqual(decided.unset, [], "every key set `false` is decided, so nothing is counted");
});

test("(4) the merge date is the first-parent merge that added the key, with its pull request, and not the branch commit under it", () => {
  const repo = mkdtempSync(join(SCRATCH, "git-"));
  const git = (when: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: sandboxGitEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }) });
  git("2026-10-01T00:00:00+0000", "init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/f.ts"), "export const OTHER = 1;\n");
  git("2026-10-01T00:00:00+0000", "add", ".");
  git("2026-10-01T00:00:00+0000", "commit", "-q", "-m", "first");
  git("2026-10-02T00:00:00+0000", "checkout", "-q", "-b", "agent/the-flag");
  writeFileSync(join(repo, "src/f.ts"), 'export const OTHER = 1;\nexport const NEW_FLAG = "rows.newThing";\n');
  git("2026-10-02T00:00:00+0000", "commit", "-q", "-am", "add the flag");
  git("2026-10-03T00:00:00+0000", "checkout", "-q", "main");
  writeFileSync(join(repo, "src/g.ts"), "export const UNRELATED = 1;\n");
  git("2026-10-03T00:00:00+0000", "add", ".");
  git("2026-10-03T00:00:00+0000", "commit", "-q", "-m", "unrelated");
  git("2026-10-12T08:00:00+0000", "merge", "-q", "--no-ff", "agent/the-flag", "-m", "Merge pull request #42 from a11ign/agent/the-flag");
  writeFileSync(join(repo, "src/f.ts"), 'export const OTHER = 1;\nexport const NEW_FLAG = "rows.newThing"; // reworded\n');
  git("2026-10-13T00:00:00+0000", "commit", "-q", "-am", "reword");
  assert.deepEqual(mergeOf(FLAG("NEW_FLAG", "rows.newThing", "src/f.ts"), { toolRoot: repo }), { mergedAt: "2026-10-12T08:00:00Z", pr: 42 });
  assert.deepEqual(mergeOf(FLAG("NEW_FLAG", "rows.noSuchKey", "src/f.ts"), { toolRoot: repo }), { mergedAt: null, pr: null }, "a key history never held is no date, not a wrong one");
  assert.deepEqual(mergeOf(FLAG("NEW_FLAG", "rows.newThing", "src/f.ts"), { toolRoot: join(SCRATCH, "not-a-repository") }), { mergedAt: null, pr: null }, "no history (an installed tool) is no date, and the flag is still counted");
  assert.deepEqual(mergeOf(FLAG("X", "rows.x"), { run: () => { throw new Error("git is not here"); } }), { mergedAt: null, pr: null });
});

const FACTS = { now: Date.parse("2026-10-12T09:30:00Z"), lastMergedAt: Date.parse("2026-10-12T09:00:00Z"), work: null, redPrs: [], refusals: {}, drift: null, primarySince: null };
const UNSET = { shipped: 8, unset: [
  { name: "AUTO_UNPARK_FLAG", key: "rows.autoUnpark", file: "src/unpark-satisfied.ts", mergedAt: "2026-10-12T08:01:58+00:00", pr: 1118 },
  { name: "HAIKU_BRIEF_FLAG", key: "workers.haikuBrief", file: "src/haiku-brief.ts", mergedAt: null, pr: null },
] };

test("(5) the reading: unknown is never clear, a decided set is clear, and an undecided one is tripped with each key, its merge and its pull request", () => {
  const signal = SIGNALS.FLAG_WITHOUT_SWITCH;
  assert.equal(signal, "flag-without-a-switch");
  assert.equal(flagSwitchReading({ day: "2026-10-12", ledger: null }).status, "unknown");
  const why = flagSwitchReading({ day: "2026-10-12", ledger: { unknown: "decisions.json is not valid JSON" } });
  assert.equal(why.status, "unknown");
  assert.match(why.detail, /decisions\.json is not valid JSON/);
  assert.equal(flagSwitchReading({ day: "2026-10-12", ledger: { shipped: 8, unset: [] } }).status, "clear");
  const tripped = flagSwitchReading({ day: "2026-10-12", ledger: UNSET });
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /^2 of 8 flags the code ships are OFF because no declaration sets them:/);
  assert.match(tripped.detail, /`rows\.autoUnpark` \(AUTO_UNPARK_FLAG in src\/unpark-satisfied\.ts\), merged 2026-10-12 in #1118/);
  assert.match(tripped.detail, /`workers\.haikuBrief` \(HAIKU_BRIEF_FLAG in src\/haiku-brief\.ts\), merged on a date git did not give\n?/, "a date git could not give is said, not invented");
  assert.equal(tripped.discriminator, `${signal}@2026-10-12:rows.autoUnpark,workers.haikuBrief`);
});

test("(5) the order goes to product-manager and ceo, names the keys, is the same all day and a new one the next day", () => {
  const read = (now: number, ledger: unknown) => orgHealthOrders(orgHealthReadings({ ...FACTS, now, flagSwitches: ledger as never })).filter((order) => order.subject === SIGNALS.FLAG_WITHOUT_SWITCH);
  const morning = read(Date.parse("2026-10-12T09:30:00Z"), UNSET);
  assert.deepEqual(morning.map((order) => order.session), ["product-manager", "ceo"], "the first reader and then ceo, who takes every signal");
  assert.match(morning[0].prompt, /`rows\.autoUnpark`/);
  assert.match(morning[0].prompt, /a11ign#928/, "the remedy names the chairman's rule");
  assert.doesNotMatch(morning[0].prompt, /undefined/);
  const evening = read(Date.parse("2026-10-12T21:00:00Z"), UNSET);
  assert.deepEqual(evening.map((order) => order.causeKey), morning.map((order) => order.causeKey), "the same set on the same day is one order however many ticks it lasts");
  const nextDay = read(Date.parse("2026-10-13T00:30:00Z"), UNSET);
  assert.notEqual(nextDay[0].causeKey, morning[0].causeKey, "and the next day names it again: once a day");
  const grown = read(Date.parse("2026-10-12T21:00:00Z"), { ...UNSET, unset: [...UNSET.unset, { name: "B_FLAG", key: "rows.b", file: "src/b.ts", mergedAt: null, pr: null }] });
  assert.notEqual(grown[0].causeKey, morning[0].causeKey, "a flag shipped that day is a new order that day");
  assert.deepEqual(read(Date.parse("2026-10-12T09:30:00Z"), { shipped: 8, unset: [] }), [], "nothing unset, no order");
  assert.deepEqual(read(Date.parse("2026-10-12T09:30:00Z"), undefined), [], "a caller that does not ask adds no reading");
});

test("(5) the class is declared in the suppression table, as a digest: it has a first reader, so `ceo` reading it again is a turn and not a decision", () => {
  assert.deepEqual(Object.keys(ORG_HEALTH_CLASSES).filter((cls) => cls === SIGNALS.FLAG_WITHOUT_SWITCH), ["flag-without-a-switch"]);
  assert.equal(ORG_HEALTH_CLASSES[SIGNALS.FLAG_WITHOUT_SWITCH].severity, "digest");
});

type Order = { subject: string; session: string; prompt: string; causeKey: string; };
const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
/** One gate tick with every other read stubbed; `readFlagSwitches` is left OUT of the options when it is not given, which is a caller that does not ask. */
function gateTick(readFlagSwitches?: () => unknown, now = Date.parse("2026-10-12T09:30:00Z")) {
  const said: string[] = [];
  const orders = orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now, lastMergedAt: () => now, readCaptures: () => undefined, readLabJobs: () => [], log: (line: string) => said.push(line), teamAccess: () => undefined, readCopies: () => null, readRefusals: () => [],
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...(readFlagSwitches && { readFlagSwitches }) } as never) as Order[];
  return { orders: orders.filter((order) => order.subject === SIGNALS.FLAG_WITHOUT_SWITCH), said };
}

test("(6) through the gate's `orgHealthNow`: a reader that finds unset flags yields the order, and a caller that does not ask is silent", () => {
  const asked = gateTick(() => UNSET);
  assert.deepEqual(asked.orders.map((order) => order.session), ["product-manager", "ceo"], "the fact reached the reading and the reading reached an order");
  const unasked = gateTick();
  assert.deepEqual(unasked.orders, [], "undefined is a caller that does not ask, which is every other test of the tick");
  assert.equal(unasked.said.some((line) => line.includes(`${SIGNALS.FLAG_WITHOUT_SWITCH} UNKNOWN`)), false, "and it is SILENT: not asking is not a refused read");
  assert.deepEqual(gateTick(() => undefined).orders, [], "a reader that answers undefined adds no fact either");
  const refused = gateTick(() => null);
  assert.deepEqual(refused.orders, []);
  assert.ok(refused.said.some((line) => line.includes(`org-health: ${SIGNALS.FLAG_WITHOUT_SWITCH} UNKNOWN`)), `a null is a stated unknown: ${JSON.stringify(refused.said)}`);
  assert.deepEqual(gateTick(() => ({ shipped: 8, unset: [] })).orders, [], "and a decided set orders nothing");
});

test("(6) WIRING: the gate's call site hands `orgHealthNow` the real reader, so the signal is not dead for want of a fact (#2980's lesson)", () => {
  const gate = workGateSource();
  assert.match(gate, /readFlagSwitches: readFlagSwitchesFor\(openRowsRead\),/, "agent-org#1324: the gate hands the open rows it read to the canary half, through the helper the next test runs");
  assert.match(gate, /import \{ readFlagSwitchesFor \} from "\.\/flag-switch-ledger\.ts"/);
});

// agent-org#1324: THE CANARY HALF. A flag whose home is the canary state is counted by its absence from `machinery-canary.json` two hours after its merge, not by a declaration.
const PACING_TREE = tree("canary", { "src/g.ts": 'export const PACING_FLAG = "gate.graphqlPacing";\n' });
const pacingMergedHoursAgo = (hours: number | null) => () => ({ mergedAt: hours === null ? null : new Date(NOW - hours * 3_600_000).toISOString(), pr: 1240 });
type Row = { title: string; body: string; labels: { name: string; }[]; };
const named = (labels: string[], title = "switch row", body = ""): Row => ({ title, body, labels: labels.map((name) => ({ name })) });
/** The count of canary findings a case reads, and a throw when the read was unknown (every case that counts expects a read). */
const absent = (args: Parameters<typeof canaryLedger>[0]) => { const answer = canaryLedger(args); if ("unknown" in answer) throw new Error(answer.unknown); return answer.canaryAbsent?.length; };
/** The gate's canary half on the one shipped canary-homed flag, `gate.graphqlPacing`, with the state, the open rows and the merge age the case gives. */
function canaryLedger({ state = emptyCanaryState(), openRows = [] as Row[] | null, hours = 3 }: { state?: CanaryState | { unknown: string; }; openRows?: Row[] | null; hours?: number | null; } = {}) {
  return readFlagLedger({ toolRoot: PACING_TREE, ...project(`canary-${hours}`, { "project.json": "{}", "host.json": "{}" }), canary: () => state, openRows, now: NOW, merge: pacingMergedHoursAgo(hours) });
}

test("(7) agent-org#1324 POSITIVE CONTROL: a canary-homed flag absent from the canary state, merged three hours before the read and named by no open row, is one finding", () => {
  const answer = canaryLedger({ hours: 3, openRows: [] });
  assert.ok(!("unknown" in answer), `the read is made: ${JSON.stringify(answer)}`);
  assert.deepEqual(answer.canaryAbsent?.map(({ key, pr, mergedAt }) => ({ key, pr, mergedAt })), [{ key: "gate.graphqlPacing", pr: 1240, mergedAt: new Date(NOW - 3 * 3_600_000).toISOString() }]);
  assert.deepEqual(answer.unset, [], "the declarations do not count a flag with another home");
  const reading = flagSwitchReading({ day: "2026-10-13", ledger: answer });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, new RegExp(`ABSENT from ${CANARY_STATE_FILE}[\\s\\S]*\`gate\\.graphqlPacing\``), "the detail names the key and the state it is absent from");
  assert.equal(reading.discriminator, `${SIGNALS.FLAG_WITHOUT_SWITCH}@2026-10-13:gate.graphqlPacing`);
});

test("(7) agent-org#1324: an open row in a ready or in-progress state that names the key clears the finding; a row in another state, one naming another key, or none does not", () => {
  assert.equal(absent({ openRows: [named(["in-progress"], "Pacing switch", "turns gate.graphqlPacing on")] }), 0, "a claimed row whose body names the key");
  assert.equal(absent({ openRows: [named(["ready"], "gate.graphqlPacing: switch it")] }), 0, "a ready row whose title names the key");
  assert.equal(absent({ openRows: [named(["done"], "gate.graphqlPacing: switch it")] }), 1, "CONTROL: a row not owed its switch does not name the flag");
  assert.equal(absent({ openRows: [named(["ready"], "gate.graphqlPacingWindow: switch it")] }), 1, "CONTROL: the key is matched whole, so a longer key is another flag");
  assert.equal(absent({ openRows: [named(["ready"], "unrelated row")] }), 1, "CONTROL: a row that names nothing");
});

test("(7) agent-org#1324: a flag merged less than two hours before the read is not yet owed its row; a flag the canary state carries, on or off, is decided", () => {
  assert.equal(absent({ hours: 1 }), 0, "one hour: inside the window");
  assert.equal(absent({ hours: 3 }), 1, "CONTROL: the same flag, three hours on, is counted");
  assert.equal(CANARY_ABSENT_MS, 2 * 60 * 60 * 1000);
  const off = withMachineryFlag(emptyCanaryState(), { name: "gate.graphqlPacing", on: false });
  assert.equal(absent({ state: off, hours: 3 }), 0, "present as off is a decision");
  const on = withMachineryFlag(emptyCanaryState(), { name: "gate.graphqlPacing", on: true });
  assert.equal(absent({ state: on, hours: 3 }), 0, "present as on is a decision");
});

test("(7) agent-org#1324: the two-hour line is exact, so a flag merged exactly two hours before the read is not yet past it, and a second more is (break: `>` to `>=` -- the first case goes red)", () => {
  const ageMs = (ago: number) => readFlagLedger({ toolRoot: PACING_TREE, ...project("canary-boundary", { "project.json": "{}", "host.json": "{}" }), canary: () => emptyCanaryState(), openRows: [], now: NOW, merge: () => ({ mergedAt: new Date(NOW - ago).toISOString(), pr: 1240 }) });
  const count = (answer: ReturnType<typeof ageMs>) => { if ("unknown" in answer) throw new Error(answer.unknown); return answer.canaryAbsent?.length; };
  assert.equal(count(ageMs(CANARY_ABSENT_MS)), 0, "exactly two hours: not more than two hours, so not yet owed");
  assert.equal(count(ageMs(CANARY_ABSENT_MS + 1000)), 1, "CONTROL: one second past the line is counted");
});

test("(7) agent-org#1324: the gate's read hands the ledger the open rows it read, so an owed row it names is not counted and a row set that was not read is UNKNOWN (break: the helper drops `openRows` -- the first case goes red)", () => {
  const read = (openRows: Row[] | null) => readFlagSwitchesFor(openRows, { toolRoot: PACING_TREE, ...project("canary-thunk", { "project.json": "{}", "host.json": "{}" }), canary: () => emptyCanaryState(), now: NOW, merge: pacingMergedHoursAgo(3) })();
  const owed = read([named(["ready"], "gate.graphqlPacing: switch it")]);
  assert.ok(!("unknown" in owed), "the owed row is read");
  assert.equal(owed.canaryAbsent?.length, 0, "a named owed row is not counted");
  const bare = read([]);
  assert.ok(!("unknown" in bare), "no rows is a read");
  assert.equal(bare.canaryAbsent?.length, 1, "CONTROL: with no row naming the flag, it is counted");
  assert.ok("unknown" in read(null), "a row set that was not read is UNKNOWN for a flag past its window");
});

test("(7) agent-org#1324: an unreadable canary state is UNKNOWN, a missing one is empty, and a read of the open rows that did not happen is UNKNOWN when a flag is past its window", () => {
  const bad = join(SCRATCH, "machinery-canary-bad.json");
  writeFileSync(bad, "{ not json");
  const unreadable = readCanaryState(bad);
  assert.ok("unknown" in unreadable && unreadable.unknown.startsWith(bad), `the reader names the file: ${JSON.stringify(unreadable)}`);
  assert.ok("unknown" in canaryLedger({ state: unreadable, hours: 3 }), "an unreadable state makes the answer unknown");
  const missing = readCanaryState(join(SCRATCH, "no-such-canary.json"));
  assert.deepEqual(missing, emptyCanaryState(), "CONTROL: an absent file is empty, as `machinery-flag.ts` reads it");
  assert.ok(!("unknown" in canaryLedger({ state: missing, hours: 3, openRows: [] })), "CONTROL: and the same tree with an empty state is a read");
  assert.ok("unknown" in canaryLedger({ hours: 3, openRows: null }), "the open rows were not read, so a flag past its window cannot be cleared");
  assert.ok(!("unknown" in canaryLedger({ hours: 1, openRows: null })), "CONTROL: nothing is past its window, so the open rows are not needed");
  assert.ok("unknown" in canaryLedger({ hours: null, openRows: [] }), "git did not say when it merged, so its two hours cannot be counted");
  assert.deepEqual(canaryAbsentFlags({ shipped: [], state: emptyCanaryState(), openRows: null, now: NOW, merge: pacingMergedHoursAgo(3) }), [], "CONTROL: no shipped flag, nothing to read");
});

// agent-org#1372: A SWITCH ROW FOR CODE THAT LIVES IN ANOTHER TRACKER IS FILED THERE, so the owed rows of every declared tracker are read before a flag is counted absent.
const OTHER_TRACKER = project("other-tracker", { "project.json": JSON.stringify({ tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }] }), "host.json": "{}" });
/** A fake `gh` list: the rows a `repo label` pair holds, `{ refused }` for a refused list. A pair the case does not name holds no rows. Records every pair asked for. */
function otherLists(lists: Record<string, Row[] | { refused: string; }>) {
  const asked: string[] = [];
  const listOwed = (repo: string, label: string) => {
    const pair = `${repo} ${label}`;
    asked.push(pair);
    return pair in lists ? lists[pair] : [];
  };
  return { asked, listOwed };
}
/** The gate's canary half on `gate.graphqlPacing` with the other trackers' lists the case gives, and the home rows it was given. */
function otherLedger(lists: Record<string, Row[] | { refused: string; }>, { openRows = [] as Row[] | null, hours = 3 } = {}) {
  const { asked, listOwed } = otherLists(lists);
  const answer = readFlagLedger({ toolRoot: PACING_TREE, ...OTHER_TRACKER, canary: () => emptyCanaryState(), openRows, now: NOW, merge: pacingMergedHoursAgo(hours), listOwed });
  return { answer, asked };
}
/** The canary-absent count of a read that must not be unknown; an unknown answer fails the assertion. */
function absentCount(answer: ReturnType<typeof readFlagLedger>): number {
  assert.ok(!("unknown" in answer), `the read is made: ${JSON.stringify(answer)}`);
  const absent = answer.canaryAbsent;
  assert.ok(absent !== undefined, "the canary-absent list is present");
  return absent.length;
}

test("(8) agent-org#1372 POSITIVE CONTROL: a flag whose only owed row is in another declared tracker is not counted, and both owed labels of that tracker are asked (break: read the home rows only -- this case goes red)", () => {
  const ready = otherLedger({ "a11ign/agent-org ready": [named(["ready"], "gate.graphqlPacing: switch it")] });
  assert.ok(!("unknown" in ready.answer), `the read is made: ${JSON.stringify(ready.answer)}`);
  assert.equal(absentCount(ready.answer), 0, "a ready row in agent-org names the flag");
  assert.deepEqual(ready.asked, ["a11ign/agent-org ready", "a11ign/agent-org in-progress"], "the home repository is not asked again; the other tracker is asked for both owed labels");
  const claimed = otherLedger({ "a11ign/agent-org in-progress": [named(["in-progress"], "Pacing switch", "turns gate.graphqlPacing on")] });
  assert.equal(absentCount(claimed.answer), 0, "an in-progress row in agent-org whose body names the flag");
});

test("(8) agent-org#1372 CONTROL: no owed row anywhere still counts; a row of another tracker in a state not owed its switch does not clear it", () => {
  assert.equal(absentCount(otherLedger({}).answer), 1, "CONTROL: every other tracker holds no owed row, so the flag is counted");
  assert.equal(absentCount(otherLedger({ "a11ign/agent-org ready": [named(["done"], "gate.graphqlPacing: switch it")] }).answer), 1, "a done row does not name an owed switch");
  assert.equal(absentCount(otherLedger({ "a11ign/agent-org ready": [named(["ready"], "gate.graphqlPacingWindow: switch it")] }).answer), 1, "the key is matched whole, in another tracker too");
});

test("(8) agent-org#1372: a refused list of another tracker is UNKNOWN, never a clean list, and the other trackers are not asked for a flag the home rows name or one not past its window", () => {
  const refused = otherLedger({ "a11ign/agent-org in-progress": { refused: "HTTP 502" } });
  assert.ok("unknown" in refused.answer && /a11ign\/agent-org/.test(refused.answer.unknown), `a refused other tracker names itself: ${JSON.stringify(refused.answer)}`);
  const home = otherLedger({ "a11ign/agent-org ready": { refused: "HTTP 502" } }, { openRows: [named(["ready"], "gate.graphqlPacing: switch it")] });
  assert.ok(!("unknown" in home.answer) && home.asked.length === 0, "CONTROL: the home row names the flag, so no other tracker is read");
  const young = otherLedger({ "a11ign/agent-org ready": { refused: "HTTP 502" } }, { hours: 1 });
  assert.ok(!("unknown" in young.answer) && young.asked.length === 0, "CONTROL: one hour in, the flag is not past its window, so no other tracker is read");
});

test("a refused owed-rows read names its cause (agent-org#1700): the unknown carries the thrown message's first line, and a list that holds no rows names no unknown", () => {
  const cause = "Could not resolve to a Repository with the name 'a11ign/agent-org'.";
  const refused = owedRowsOf(["a11ign/agent-org"], () => ({ refused: cause }));
  assert.ok("unknown" in refused && refused.unknown.includes(cause), `the unknown names why the read failed: ${JSON.stringify(refused)}`);
  assert.deepEqual(owedRowsOf(["a11ign/agent-org"], () => []), [], "CONTROL: a list that returns no rows yields no unknown");
});

test("liveOwedRows converts the thrown error to its first line through the real read (agent-org#1700): a refused read is `{ refused }`, and an answered read is its rows", () => {
  const cause = "Could not resolve to a Repository with the name 'a11ign/agent-org'.";
  // NOT a rate-limit text: a limit refusal is remembered for the whole tick (`readUnlessRefused`) and would refuse every later read in this file.
  const refusedRun = () => { throw new Error(`${cause}\nthe second line names nothing the tick needs`); };
  assert.deepEqual(ledger.liveOwedRows("a11ign/agent-org", "ready", refusedRun), { refused: cause }, "a refused read names the first line of the thrown error, and only that");
  const answeredRun = () => JSON.stringify({ data: { repository: { issues: { nodes: [{ title: "t", body: "b", labels: { nodes: [{ name: "ready" }] } }], pageInfo: { hasNextPage: false } } } } });
  assert.deepEqual(ledger.liveOwedRows("a11ign/agent-org", "ready", answeredRun), [{ title: "t", body: "b", labels: [{ name: "ready" }] }], "CONTROL: an answered read is rows, so a producer that always refuses goes red");
});

test("(8) agent-org#1372: the other trackers are the declared ones except the project's own (key `\"\"`), and a declaration without a list names none", () => {
  assert.deepEqual(otherTrackerRepos({ tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }] }), ["a11ign/agent-org"]);
  assert.deepEqual(otherTrackerRepos({ tracker: [{ key: "", repo: "a11ign/a11ign" }] }), [], "the project's own tracker alone is no other");
  assert.deepEqual(otherTrackerRepos({}), [], "a declaration with no tracker list names none");
  assert.deepEqual(otherTrackerRepos(null), []);
  assert.deepEqual(owedRowsOf([], () => ({ refused: "not asked" })), [], "CONTROL: no other tracker, nothing to refuse");
});
