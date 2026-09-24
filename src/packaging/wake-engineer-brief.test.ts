// no-token: gh -- nothing here reaches `gh` or `herdr`: the roster is an injected argument and the one delivery goes through a recording `run`
/**
 * #2406: A SPAWNED ENGINEER IS TOLD TO READ THE ENGINEER BRIEF, AND THE BRIEF HOLDS THE RESOURCE BAN.
 *
 * `sessions.json`'s `brief` field was read by no code, and `addressed()` -- which writes every session's first
 * message -- named no file under `docs/roles`, so a spawned engineer, which starts knowing nothing, was never told
 * the acceptance standard or the ban. Its own file, and not a block in `wake.test.ts`, for #2280's reason: that
 * file reaches `gh`, so the token-less acceptance job refused it and verified nothing.
 *
 * THE RETIREMENT ROW OWNS THIS FILE'S SECOND HALF. `worker-capture.md` and `worker-judge.md` are the SOURCE the ban
 * test derives from, and they are deleted by the retirement row, not by #2406; that row moves the derivation to
 * whatever then holds the ban and says so, rather than leaving this test to crash on a missing file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addressed, deliver, engineerRoles, ENGINEER_BRIEF } from "../wake.mjs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (repoPath: string) => readFileSync(`${ROOT}${repoPath}`, "utf8");
const SESSIONS = JSON.parse(read("packages/agent-org/docs/roles/sessions.json")) as {
  live: { name: string; role: string; brief: string | null }[];
  retired: { name: string }[];
};
const ROLES_DIR = "packages/agent-org/docs/roles";
const ORDER = { session: "engineers", prompt: "claim row 1 as `<you>`" };
const BRIEF_LINE = new RegExp(ENGINEER_BRIEF.replaceAll(".", "\\."));

// --- done-when 2: `addressed()` names the brief for every engineer role and for NO other --------------------------

test("an engineer label's first message names the engineer brief", () => {
  assert.equal(ENGINEER_BRIEF, `${ROLES_DIR}/engineer.md`);
  assert.ok(existsSync(`${ROOT}${ENGINEER_BRIEF}`), "the file the line names exists");
  const message = addressed(ORDER, "worker-6", ["worker-6"]);
  assert.match(message, BRIEF_LINE);
  assert.match(message, /claim row 1 as `worker-6`/, "and the order's own text, with <you> substituted, survives");
});

test("the positive control: with an EMPTY roster nobody is told, so the line is the roster's doing", () => {
  assert.doesNotMatch(addressed(ORDER, "worker-6", []), BRIEF_LINE);
  assert.doesNotMatch(addressed(ORDER, "worker-6", ["worker-7"]), BRIEF_LINE, "membership, not the label's shape");
});

test("the singletons and a reviewer are NOT told, whatever roster is supplied or read", () => {
  const notEngineers = SESSIONS.live.filter((s) => s.role !== "engineer").map((s) => s.name);
  assert.deepEqual(notEngineers.sort(), ["ceo", "orchestrator", "product-manager"],
    "the positive control for the loop below: the three singletons really are the non-engineer roles");
  for (const label of [...notEngineers, "reviewer", "reviewer-2"]) {
    assert.doesNotMatch(addressed(ORDER, label, ["worker-6"]), BRIEF_LINE, `${label}, with an injected roster`);
    assert.doesNotMatch(addressed(ORDER, label), BRIEF_LINE, `${label}, with the roster read from sessions.json`);
  }
});

test("every engineer role in sessions.json is told, with the roster READ and not injected", () => {
  const engineers = engineerRoles();
  // The population is derived a SECOND way -- every live name that is not one of the three singletons the test
  // above pins -- and compared by EQUALITY, so a count floor is not standing in for "the roster is right" (#1067).
  const singletons = ["ceo", "orchestrator", "product-manager"];
  assert.deepEqual(engineers, SESSIONS.live.map((s) => s.name).filter((n) => !singletons.includes(n)),
    "the engineer roles are every live session that is not a singleton");
  assert.ok(engineers.includes("worker-tooling"), "the positive control: a known engineer is in the population");
  for (const label of engineers) assert.match(addressed(ORDER, label), BRIEF_LINE, label);
});

test("the delivery path carries the line: what herdr is handed is the addressed text", () => {
  const prompts: string[][] = [];
  const run = (args: string[]) => { prompts.push(args); return "{}"; };
  const engineerOrder = { session: "worker-tooling", causeKey: "worker-tooling/rework/1", prompt: "rework #1" };
  const got = deliver([engineerOrder], [{ label: "worker-tooling", status: "idle" }], engineerRoles(), { run });
  assert.deepEqual(got.sent, [`worker-tooling <- ${engineerOrder.causeKey}`], `it was delivered: ${JSON.stringify(got)}`);
  const prompt = prompts.find((a) => a[3] === "prompt" && a[4] === "worker-tooling" && a[5] !== "/clear");
  assert.match(String(prompt?.[5]), BRIEF_LINE);
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

test("every command family both briefs' ban blocks name appears in the engineer brief", () => {
  const capture = families(banBlock(read(`${ROLES_DIR}/worker-capture.md`)));
  const judge = families(banBlock(read(`${ROLES_DIR}/worker-judge.md`)));
  assert.ok(capture.includes(EXCEPTION),
    "the positive control: the capture brief's block DOES name the exception, so filtering it below is not vacuous");
  assert.ok(!judge.includes(EXCEPTION), "and the judge's block does not");
  const derived = [...new Set([...capture, ...judge])].filter((f) => f !== EXCEPTION);
  // Non-empty, with the count NOT in the message (#1067): the eight named families below say the list is RIGHT.
  assert.ok(derived.length > 0, "the derivation found command families at all");
  for (const family of ["fleet:*", "fleet:deploy", "lab:*", "training:capture*", "worker:*", "evidence:check",
    "gate:stability", "capture:check"]) {
    assert.ok(derived.includes(family), `the derivation found ${family}`);
  }
  const brief = read(ENGINEER_BRIEF);
  const missing = derived.filter((f) => !brief.includes(f));
  assert.deepEqual(missing, [], "every derived family is in the engineer brief");
});

test("the engineer brief carries the ban with NO exception, and never the words `lab:job`", () => {
  const brief = read(ENGINEER_BRIEF);
  assert.ok(!brief.includes(EXCEPTION), "the exception is a privilege of a routed pool, not of every engineer");
  assert.match(brief, /total, with no exception/i);
  assert.ok(banBlock(brief).includes("`lab:*`"), "the family the exception lives in is banned whole");
});

// --- done-when 5: the `brief` field is honest ---------------------------------------------------------------------

test("worker-tooling and every spare point at the engineer brief; capture and judge keep their own", () => {
  const brief = (name: string) => SESSIONS.live.find((s) => s.name === name)?.brief;
  const shared = "docs/roles/engineer.md";
  assert.ok(`packages/agent-org/${shared}` === ENGINEER_BRIEF, "the field's path is the one addressed() names");
  for (const name of ["worker-tooling", "worker-4", "worker-5", "worker-6", "worker-7", "worker-8"]) {
    assert.equal(brief(name), shared, name);
  }
  assert.equal(brief("worker-capture"), "docs/roles/worker-capture.md");
  assert.equal(brief("worker-judge"), "docs/roles/worker-judge.md");
  for (const s of SESSIONS.live.filter((e) => e.role === "engineer")) {
    assert.ok(s.brief !== null && existsSync(`${ROOT}packages/agent-org/${s.brief}`), `${s.name}'s brief exists`);
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
const SESSION_NAMES = [...SESSIONS.live.map((s) => s.name), ...SESSIONS.retired.map((s) => s.name)];
/** A name as a WORD: `worker-ctl.sh` and `worker-fleet` are not sessions, and `worker-4` inside `worker-40` is not. */
const namesIn = (text: string) => SESSION_NAMES.filter((n) => new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(text));

test("the name matcher notices a session name, and only as a word (its own positive control)", () => {
  assert.deepEqual(namesIn("hand it to `orchestrator`, then worker-4."), ["orchestrator", "worker-4"]);
  assert.deepEqual(namesIn("`worker-ctl.sh up`, the worker-fleet package, worker-40, ceo-ish, preceo"), []);
  assert.ok(SESSION_NAMES.includes("worker-capture") && SESSION_NAMES.length >= 12, "the roster was read");
});

for (const { file, heading, governs } of NESTED) {
  test(`${file}: the addition names the paths it governs in its first lines`, () => {
    const text = read(file);
    const at = text.search(heading);
    assert.ok(at >= 0, `the section exists in ${file}`);
    const head = text.slice(at).split("\n").slice(0, 4).join("\n");
    for (const path of governs) {
      assert.ok(existsSync(`${ROOT}${path}`), `${path} is a real path`);
      assert.ok(head.includes(path), `the section's first lines name ${path}`);
    }
  });

  test(`${file}: names no session, standing or retired`, () => {
    assert.deepEqual(namesIn(read(file)), []);
  });
}
