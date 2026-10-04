// no-token: gh -- nothing here reaches `gh` or `herdr`: the roster is an injected argument and the one delivery goes through a recording `run`
/**
 * #2406: A SPAWNED ENGINEER IS TOLD TO READ THE ENGINEER BRIEF, AND THE BRIEF HOLDS THE RESOURCE BAN.
 *
 * `sessions.json`'s `brief` field was read by no code, and `addressed()` -- which writes every session's first
 * message -- named no file under `docs/roles`, so a spawned engineer, which starts knowing nothing, was never told
 * the acceptance standard or the ban. Its own file, and not a block in `wake.test.ts`, for #2280's reason: that
 * file reaches `gh`, so the token-less acceptance job refused it and verified nothing.
 *
 * #2505 (the retirement row) DELETED `worker-capture.md` and `worker-judge.md`, which were the SOURCE the ban test derived
 * from. The derivation now reads the one place that holds the ban, `engineer.md`, and is checked against the eight
 * families the row measured, so it is no longer the brief compared with itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addressed, deliver, engineerRoles, ENGINEER_BRIEF } from "../wake.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { startedPanes } from "./started-pane.ts";

const ROOT = HOME_CHECKOUT;
const read = (repoPath: string) => readFileSync(`${ROOT}/${repoPath}`, "utf8");
const SESSIONS = JSON.parse(read(".agent-org/roles/sessions.json")) as {
  live: { name: string; role: string; brief: string | null; family?: { prefix: string; from: number } }[];
  retired: { name: string }[];
};
// Derived, not listed: a role the project adds tomorrow (`liaison`, #3421) is a singleton without this file being edited (#3467).
const SINGLETONS = SESSIONS.live.filter((s) => s.role !== "engineer" && s.family === undefined).map((s) => s.name);
const ROLES_DIR = ".agent-org/roles";
const ORDER = { session: "engineers", prompt: "claim row 1 as `<you>`" };
const BRIEF_LINE = new RegExp(ENGINEER_BRIEF.replaceAll(".", "\\."));

// --- done-when 2: `addressed()` names the brief for every engineer role and for NO other --------------------------

test("an engineer label's first message names the engineer brief", () => {
  assert.equal(ENGINEER_BRIEF, `${ROLES_DIR}/engineer.md`);
  assert.ok(existsSync(`${ROOT}/${ENGINEER_BRIEF}`), "the file the line names exists");
  const message = addressed(ORDER, "worker-6", { engineers: ["worker-6"] });
  assert.match(message, BRIEF_LINE);
  assert.match(message, /claim row 1 as `worker-6`/, "and the order's own text, with <you> substituted, survives");
});

test("the positive control: with an EMPTY roster nobody is told, so the line is the roster's doing", () => {
  assert.doesNotMatch(addressed(ORDER, "worker-6", { engineers: [], families: [] }), BRIEF_LINE);
  assert.doesNotMatch(addressed(ORDER, "worker-3", { engineers: ["worker-7"] }), BRIEF_LINE, "membership, not the label's shape");
});

test("#2403: a SPARE-FAMILY member is told, though no address in the roster names it", () => {
  // The instance the pilot spawns starts knowing nothing, and `engineerRoles()` lists addresses only, so a
  // roster-only test would leave `worker-9` the one engineer never told to read the brief.
  assert.ok(!engineerRoles().includes("worker-9"), "the positive control: worker-9 is in no listed address");
  assert.match(addressed(ORDER, "worker-9"), BRIEF_LINE, "worker-9, roster and families read from sessions.json");
  assert.match(addressed(ORDER, "worker-12"), BRIEF_LINE, "worker-12: a number nobody committed");
  assert.doesNotMatch(addressed(ORDER, "worker-9", { engineers: [], families: [] }), BRIEF_LINE, "the family is the doing, not the label");
  assert.doesNotMatch(addressed(ORDER, "worker-3"), BRIEF_LINE, "below the family's `from` names no engineer role");
  assert.doesNotMatch(addressed(ORDER, "worker-09"), BRIEF_LINE, "a second spelling of worker-9 is not a member");
});

test("the singletons and a reviewer are NOT told, whatever roster is supplied or read", () => {
  const notEngineers = SESSIONS.live.filter((s) => s.role !== "engineer").map((s) => s.name);
  for (const name of ["ceo", "orchestrator", "product-manager"]) {
    assert.ok(notEngineers.includes(name), `the positive control for the loop below: ${name} is among the non-engineer roles`);
  }
  for (const label of [...notEngineers, "reviewer", "reviewer-2"]) {
    assert.doesNotMatch(addressed(ORDER, label, { engineers: ["worker-6"] }), BRIEF_LINE, `${label}, with an injected roster`);
    assert.doesNotMatch(addressed(ORDER, label), BRIEF_LINE, `${label}, with the roster read from sessions.json`);
  }
});

test("#2505: sessions.json lists NO standing engineer address, so the roster READ is empty and the family is the population", () => {
  const engineers = engineerRoles();
  // The population is derived a SECOND way -- every live name that is not a singleton (`SINGLETONS`, the roster's own
  // non-engineer roles, with the three the test above names asserted among them) -- and compared by EQUALITY, so a
  // count floor is not standing in for "the roster is right" (#1067).
  assert.deepEqual(engineers,
    SESSIONS.live.filter((s) => s.family === undefined).map((s) => s.name).filter((n) => !SINGLETONS.includes(n)),
    "the engineer addresses are every live session that is not a singleton and not a family (#2403)");
  assert.deepEqual(engineers, [], "the three standing engineers are retired, not live (#2505)");
  // An emptiness needs its positive control (`.claude/rules/guards-and-assertions.md`): it is the `#2403` test above,
  // which asserts `worker-9` and `worker-12` ARE told by the family, and the loop below, which
  // asserts each of the three is in `retired` with `retiredBy` this row.
  for (const name of ["worker-capture", "worker-judge", "worker-tooling"]) {
    assert.deepEqual(SESSIONS.retired.find((r) => r.name === name), { name, retiredBy: "#2505" }, `${name} is retired by #2505`);
    assert.ok(!SESSIONS.live.some((s) => s.name === name), `${name} is not live`);
  }
});

test("the delivery path carries the line: what herdr is handed is the addressed text", () => {
  const prompts: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    prompts.push(args);
    const answered = pane(args);
    if (answered !== null) return answered;
    return args.join(" ").includes("workspace create")
      ? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } }) : "{}";
  };
  // A spare-family instance STARTED for the row -- the FIRST order, which is the one that carries the brief line (#2538): no
  // standing address exists to use since #2505, and the family is who is told (#2403). Every standing address is held so the
  // pilot has to start `worker-2131`.
  const held = ["worker-capture", "worker-judge", "worker-tooling"].map((label) => ({ label, status: "working" }));
  const rowOrder = { session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
    prompt: "Ready row #2131 is unclaimed." };
  const got = deliver([rowOrder], held, ["worker-capture", "worker-judge", "worker-tooling"], { run });
  assert.deepEqual(got.sent, [`worker-2131 <- ${rowOrder.causeKey} (STARTED sonnet/high)`], `it was delivered: ${JSON.stringify(got)}`);
  const prompt = prompts.find((a) => a[3] === "prompt" && a[4] === "worker-2131" && a[5] !== "/clear");
  assert.match(String(prompt?.[5]), BRIEF_LINE);
});

test("#2538 the brief line is the FIRST order's: a follow-up to a live instance does not repeat it", () => {
  const prompts: string[][] = [];
  const run = (args: string[]) => { prompts.push(args); return "{}"; };
  const engineerOrder = { session: "worker-4", causeKey: "worker-4/rework/1", prompt: "rework #1" };
  const got = deliver([engineerOrder], [{ label: "worker-4", status: "idle" }], engineerRoles(), { run });
  assert.deepEqual(got.sent, [`worker-4 <- ${engineerOrder.causeKey} (no clear)`], `it was delivered: ${JSON.stringify(got)}`);
  const prompt = prompts.find((a) => a[3] === "prompt" && a[4] === "worker-4" && a[5] !== "/clear");
  assert.ok(prompt, "the order was typed, so the absence below is not an empty run");
  assert.doesNotMatch(String(prompt[5]), BRIEF_LINE);
  assert.match(addressed(engineerOrder, "worker-4"), BRIEF_LINE, "CONTROL: the full form for the same label DOES carry it");
});

// --- done-when 4: the ban is in the brief, DERIVED from the two briefs' own blocks, with no exception --------------

/** The `>`-quoted block that opens with the ban sentence: a brief's own words, not a list this file retypes. */
function banBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("> Do not run anything that reaches the fleet or the lab"));
  assert.ok(start >= 0, "the brief carries a ban block");
  const block: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith(">"); i++) block.push(lines[i]);
  return block.join("\n");
}
/** Every command family the block names: `fleet:*`, `training:capture*`, `evidence:check`, ... */
const families = (block: string) => [...block.matchAll(/`([a-z]+:[a-z*][a-z:*-]*)`/g)].map((m) => m[1]);
/** The one command #1828 lets a routed pool run; it is never copied into the shared brief (#1817). */
const EXCEPTION = "lab:job";

test("#2505: the two briefs the ban was derived from are GONE, and the engineer brief names every family the row measured", () => {
  // The positive control for the deletion: the two files were the source until #2505, and a test that read a missing
  // file would crash rather than say so. That they are absent is asserted, not assumed.
  for (const gone of ["worker-capture.md", "worker-judge.md"]) {
    assert.ok(!existsSync(`${ROOT}/${ROLES_DIR}/${gone}`), `${gone} was deleted by the retirement row`);
  }
  const brief = read(ENGINEER_BRIEF);
  const derived = families(banBlock(brief));
  // The eight named families are the independent list: `derived` is read from the brief, so they say it is RIGHT.
  for (const family of ["fleet:*", "fleet:deploy", "fleet:provision", "lab:*", "lab:stop", "lab:status", "training:capture*",
    "worker:*", "evidence:check", "gate:stability", "capture:check"]) {
    assert.ok(derived.includes(family), `the engineer brief's ban block names ${family}`);
  }
  assert.ok(!derived.includes(EXCEPTION), "and the exception a routed pool holds is not among them");
});

test("the engineer brief carries the ban with NO exception, and never the words `lab:job`", () => {
  const brief = read(ENGINEER_BRIEF);
  assert.ok(!brief.includes(EXCEPTION), "the exception is a privilege of a routed pool, not of every engineer");
  assert.match(brief, /total, with no exception/i);
  assert.ok(banBlock(brief).includes("`lab:*`"), "the family the exception lives in is banned whole");
});

// --- done-when 5: the `brief` field is honest ---------------------------------------------------------------------

test("the family points at the engineer brief, and every live engineer's brief exists", () => {
  const brief = (name: string) => SESSIONS.live.find((s) => s.name === name)?.brief;
  const shared = `${ROLES_DIR}/engineer.md`;
  assert.ok(shared === ENGINEER_BRIEF, "the field's path is the one addressed() names");
  // #2403: the spares are ONE family entry, `worker-<n>`, and not five addresses.
  assert.equal(brief("worker-<n>"), shared, "worker-<n>");
  assert.equal(SESSIONS.live.filter((s) => s.family !== undefined).length, 1,
    "the positive control: the family entry is the one `worker-<n>` was read from");
  for (const s of SESSIONS.live.filter((e) => e.role === "engineer")) {
    assert.ok(s.brief !== null && existsSync(`${ROOT}/${s.brief}`), `${s.name}'s brief exists`);
  }
});

// --- done-when 6: the area rules are where the work is, and name no session --------------------------------------

const NESTED = [
  { file: "packages/nvda-worker/CLAUDE.md", heading: /^## The capture path/m,
    governs: ["packages/nvda-worker/src/capture-probes.mjs", "packages/nvda-worker/src/capture-pure.mjs",
      "packages/nvda-worker/src/browser-session.mjs"] },
  { file: "packages/lab/CLAUDE.md", heading: /^## Reading captures back/m,
    governs: ["packages/lab/src/capture", "packages/lab/src/training/corpus-settled.mjs"] },
  { file: "packages/judge/CLAUDE.md", heading: /^## The judge/m,
    governs: ["packages/judge/src/rules.ts", "packages/judge/src/criterion-coverage.ts"] },
];
const FAMILIES = SESSIONS.live.flatMap((s) => (s.family === undefined ? [] : [s.family]));
const SESSION_NAMES = [...SESSIONS.live.filter((s) => s.family === undefined).map((s) => s.name),
  ...SESSIONS.retired.map((s) => s.name)];
/** A name as a WORD: `worker-ctl.sh` and `worker-fleet` are not sessions. */
const namesIn = (text: string) => [
  ...SESSION_NAMES.filter((n) => new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(text)),
  // #2403: a family member is every `<prefix><n>` for n from `from`, so the matcher reads the family and not a list.
  ...FAMILIES.flatMap(({ prefix, from }) => [...text.matchAll(new RegExp(`(?<![\\w-])${prefix}(\\d+)(?![\\w-])`, "g"))]
    .filter((m) => Number(m[1]) >= from).map((m) => m[0])),
];

test("the name matcher notices a session name, and only as a word (its own positive control)", () => {
  assert.deepEqual(namesIn("hand it to `orchestrator`, then worker-4."), ["orchestrator", "worker-4"]);
  assert.deepEqual(namesIn("and worker-40, a family member nobody listed"), ["worker-40"]);
  assert.deepEqual(namesIn("`worker-ctl.sh up`, the worker-fleet package, worker-3, worker-4abc, ceo-ish, preceo"), []);
  // #2403: the floor of 12 counted the five spare addresses; the roster is now checked by what it must hold.
  assert.ok(SESSION_NAMES.includes("worker-capture") && SESSIONS.retired.every((r) => SESSION_NAMES.includes(r.name)),
    "the roster was read: a live address and every retired name");
  assert.ok(!SESSION_NAMES.includes("worker-<n>") && FAMILIES.length === 1, "the family is matched as a rule");
});

for (const { file, heading, governs } of NESTED) {
  test(`${file}: the addition names the paths it governs in its first lines`, () => {
    const text = read(file);
    const at = text.search(heading);
    assert.ok(at >= 0, `the section exists in ${file}`);
    const head = text.slice(at).split("\n").slice(0, 4).join("\n");
    for (const path of governs) {
      assert.ok(existsSync(`${ROOT}/${path}`), `${path} is a real path`);
      assert.ok(head.includes(path), `the section's first lines name ${path}`);
    }
  });

  test(`${file}: names no session, standing or retired`, () => {
    assert.deepEqual(namesIn(read(file)), []);
  });
}
