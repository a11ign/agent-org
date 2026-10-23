// no-token: gh
//
// Imports `row-file.ts`, which spawns `gh`; true of the IMPORT and false of the CALL. The board, its items and its Roadmap field are the fake code host's world (A11-160, step 7); the label
// readers, `moveStatus` and `spawnGh` are injected, and the one `run` left answers only the claimed rows' by-label read, which is the blast radius's (another step). No test lets a real spawn happen.
/**
 * #516: `row-file` refuses a row under a roadmap epic that has no `Roadmap` value, and sets it when it boards the row.
 *
 * POSITIVE CONTROL: the first refusal test below is the one the row names -- a parent whose epic HAS a value and an argv with no `--roadmap=`.
 * With `roadmapPlan`'s refusal removed that test fails (it files the row), which is the run the PR shows.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createIssue } from "./row-file/roadmap-and-milestone-checks.ts";
import { parentFromArgv, parentRef, roadmapFromArgv } from "./row-file/title-kind-and-label-refusals.ts";
import { withFiledBy } from "./row-file/issue-body-and-region-checks.ts";
import { connectionOf, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const HOME = { key: "", repo: "a11ign/a11ign", board: { owner: "a11ign", number: 1 } };
const DECLARATION = { tracker: [HOME], code: [{ key: "", repo: "a11ign/a11ign" }],
  dora: [{ repo: "a11ign/a11ign", release: { kind: "tag" as const }, releasablePaths: ["packages/cli/"] }] };
const BODY = "## Region\n\n```\npackages/cli/src/index.ts\n```\n\n## Acceptance\n\n```\nnode --test src/x.test.mjs\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const OPTIONS = ["v3 — outside adopter", "Agent spend (Haiku/Jev)", "Clean boundaries", "Self-healing org", "Manager redesign"]
  .map((name, i) => ({ id: `OPT_${i}`, name }));
const FIELD = { projectId: "PVT_1", fieldId: "PVTSSF_roadmap", options: OPTIONS };
const EPIC = "a11ign/a11ign#4437";
const ROW = "a11ign/a11ign#900";

/**
 * A fake board: the fake code host's world, every project item keyed `owner/repo#n`. The new row is boarded with no value (`addRowToProject` finds its item there); setting the option names the value the option id
 * stands for -- so what each assertion reads is what the act WROTE, and a `--roadmap=` that was never applied reads as `null`.
 */
function fakeBoard(options: { epicValue?: string | null; epicUnreadable?: boolean; fieldMissing?: boolean; editFails?: boolean; editIgnored?: boolean } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  world.filing.roadmapItems.set(EPIC, options.epicUnreadable ? new Error("HTTP 502") : [{ id: "PVTI_epic", number: 1, owner: "a11ign", value: options.epicValue ?? null }]);
  world.filing.roadmapItems.set(ROW, [{ id: "PVTI_900", number: 1, owner: "a11ign", value: null }]);
  world.filing.roadmapFields.set("a11ign/1", options.fieldMissing ? null : FIELD);
  if (options.editFails) world.failures.set("setBoardItemOption", new Error("GraphQL: Resource not accessible by integration"));
  if (options.editIgnored) host.rows!.setBoardItemOption = (request) => { world.filing.optionsSet.push({ itemId: request.itemId, projectId: request.projectId, fieldId: request.fieldId, optionId: request.optionId }); };
  substituteCodeHost(host);
  const log = { spawned: [] as string[][], stderr: "", stdout: "" };
  const items = world.filing.roadmapItems;
  const deps = { run: (_cmd: string, args: string[]) => (readsRowsByLabel(args) !== null ? connectionOf([]) : ""), // #5039: the claimed rows' by-label read (the sweep window's, the blast radius's) -- none held
    moveStatus: () => ({ moved: true as const }), fetchBoardStatus: () => "Backlog", ensureLabels: () => undefined,
    fetchLabels: () => ({ number: 900, title: "t", state: "OPEN", labels: ["backlog", "lane:any", "out-of-release"] }),
    loadLanesConfig: () => ({ lanes: [] }), milestones: () => ["CI reset"], primaryMilestones: () => ["CI reset"], declaration: DECLARATION,
    spawnGh: (argv: string[]) => {
      log.spawned.push(argv);
      world.rows.set(900, fakeRow(world, 900, { body: `${BODY}\nFiled-by: worker-516\n` }));
      world.filing.rowMilestones.set(ROW, "CI reset");
      return "https://github.com/a11ign/a11ign/issues/900";
    } };
  return { log, items, deps, world };
}

function file(argv: string[], board = fakeBoard()) {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { board.log.stdout += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { board.log.stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(["--title", "a row", "--body", BODY, "--session=worker-516", "--milestone", "CI reset", ...argv], board.deps as never);
    return { code, ...board };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("#516 POSITIVE CONTROL: a parent whose epic has a Roadmap value and no --roadmap= is REFUSED, with the option list, before anything is filed", () => {
  const r = file(["--parent=4437"], fakeBoard({ epicValue: "Self-healing org" }));
  assert.equal(r.code, 1, r.log.stderr);
  assert.equal(r.log.spawned.length, 0, "refused before `gh issue create`, so nothing is left behind");
  assert.match(r.log.stderr, /REFUSING to file/);
  assert.match(r.log.stderr, /Self-healing org/, "names the value the epic carries");
  for (const option of OPTIONS) assert.ok(r.log.stderr.includes(`\`${option.name}\``), `lists ${option.name}`);
  assert.equal(r.world.filing.optionsSet.length, 0);
});

test("#516: an unknown --roadmap= is refused with the option list; nothing is filed", () => {
  const r = file(["--parent=4437", "--roadmap=Sideways"], fakeBoard({ epicValue: "Clean boundaries" }));
  assert.equal(r.code, 1);
  assert.equal(r.log.spawned.length, 0);
  assert.match(r.log.stderr, /`--roadmap=Sideways` names no option/);
  assert.match(r.log.stderr, /Manager redesign/);
});

test("#516: a parent whose epic has a value and --roadmap=<option> files the row, sets the value on ITS item, and reads it back", () => {
  const r = file(["--parent=4437", "--roadmap=Self-healing org"], fakeBoard({ epicValue: "Self-healing org" }));
  assert.equal(r.code, 0, r.log.stderr);
  assert.equal(r.log.spawned.length, 1);
  assert.deepEqual(r.world.filing.optionsSet, [{ itemId: "PVTI_900", projectId: "PVT_1", fieldId: "PVTSSF_roadmap", optionId: "OPT_3" }]);
  assert.equal((r.items.get(ROW) as { value: string | null }[])[0].value, "Self-healing org");
  assert.match(r.log.stdout, /issues\/900\n$/);
  assert.doesNotMatch(r.log.stderr, /differs from/, "agreeing with the epic is silent");
});

test("#516: our own flag never reaches gh, and --parent still does", () => {
  const r = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: "Clean boundaries" }));
  const filed = r.log.spawned[0];
  assert.ok(filed.includes("--parent=4437"));
  assert.ok(!filed.some((a) => a.startsWith("--roadmap")), `gh was given ${filed}`);
  assert.ok(!withFiledBy(["--roadmap=x", "--title", "t"], "worker-516", BODY).some((a) => a.startsWith("--roadmap")));
});

test("#516: an epic with NO Roadmap value changes nothing -- the row is filed and no field is written", () => {
  const r = file(["--parent=4437"], fakeBoard({ epicValue: null }));
  assert.equal(r.code, 0, r.log.stderr);
  assert.equal(r.log.spawned.length, 1);
  assert.equal(r.world.filing.optionsSet.length, 0);
});

test("#516: a --roadmap= given under an epic with no value is still checked and set, never silently ignored", () => {
  const set = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: null }));
  assert.equal(set.code, 0, set.log.stderr);
  assert.equal((set.items.get(ROW) as { value: string | null }[])[0].value, "Clean boundaries");
  const unknown = file(["--parent=4437", "--roadmap=Sideways"], fakeBoard({ epicValue: null }));
  assert.equal(unknown.code, 1);
  assert.equal(unknown.log.spawned.length, 0);
});

test("#516: no --parent and no --roadmap= reads no epic and writes no field", () => {
  const r = file([], fakeBoard({ epicValue: "Clean boundaries" }));
  assert.equal(r.code, 0, r.log.stderr);
  assert.deepEqual(r.world.filing.roadmapReads, []);
  assert.equal(r.world.filing.optionsSet.length, 0);
});

test("#516: --roadmap= with no --parent= is refused: the value comes from the epic", () => {
  const r = file(["--roadmap=Clean boundaries"], fakeBoard());
  assert.equal(r.code, 1);
  assert.equal(r.log.spawned.length, 0);
  assert.match(r.log.stderr, /no `--parent=`/);
});

test("#516: a failed set is reported and exits non-zero -- it is not a warning", () => {
  const r = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: "Clean boundaries", editFails: true }));
  assert.equal(r.code, 2);
  assert.equal(r.log.spawned.length, 1, "the row WAS filed; the failure is the value");
  assert.match(r.log.stderr, /FILED as #900/);
  assert.match(r.log.stderr, /could not be set to `Clean boundaries`/);
  assert.doesNotMatch(r.log.stdout, /issues\/900/, "no success URL is printed for a row without its value");
});

test("#516: a set that the read-back does not confirm is a failure too", () => {
  const r = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: "Clean boundaries", editIgnored: true }));
  assert.equal(r.code, 2);
  assert.match(r.log.stderr, /read-back shows `Roadmap` = no value, not `Clean boundaries`/);
});

test("#516: an epic that cannot be READ is a refusal, never 'no value' -- absence is not proof", () => {
  const r = file(["--parent=4437"], fakeBoard({ epicValue: "Clean boundaries", epicUnreadable: true }));
  assert.equal(r.code, 1);
  assert.equal(r.log.spawned.length, 0);
  assert.match(r.log.stderr, /could not read the Roadmap value of a11ign\/a11ign#4437/);
});

test("#516: a board with no Roadmap field cannot give a row one -- refused before filing", () => {
  const r = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: "Clean boundaries", fieldMissing: true }));
  assert.equal(r.code, 1);
  assert.equal(r.log.spawned.length, 0);
  assert.match(r.log.stderr, /has no `Roadmap` field/);
});

test("#516: naming a different option than the epic's is allowed, and says so", () => {
  const r = file(["--parent=4437", "--roadmap=Manager redesign"], fakeBoard({ epicValue: "Clean boundaries" }));
  assert.equal(r.code, 0, r.log.stderr);
  assert.match(r.log.stderr, /WARNING .* differs from a11ign\/a11ign#4437's `Roadmap` \(`Clean boundaries`\)/);
  assert.equal((r.items.get(ROW) as { value: string | null }[])[0].value, "Manager redesign");
});

test("#516: the parent is read in every spelling gh takes, and an epic in another repository is read there", () => {
  assert.equal(parentFromArgv(["--parent=12"]), "12");
  assert.equal(parentFromArgv(["--parent", "12"]), "12");
  assert.equal(parentFromArgv(["--title", "t"]), null);
  assert.equal(roadmapFromArgv(["--roadmap=A b"]), "A b");
  assert.equal(roadmapFromArgv(["--roadmap"]), null);
  assert.deepEqual(parentRef("#12", "a11ign/agent-org"), { repo: "a11ign/agent-org", number: 12 });
  assert.deepEqual(parentRef("https://github.com/a11ign/a11ign/issues/4437", "a11ign/agent-org"), { repo: "a11ign/a11ign", number: 4437 });
  assert.deepEqual(parentRef("a11ign/a11ign#4437", "a11ign/agent-org"), { repo: "a11ign/a11ign", number: 4437 });
  assert.equal(parentRef("the epic", "a11ign/agent-org"), null);
  const r = file(["--parent=a11ign/a11ign#4437"], fakeBoard({ epicValue: "Clean boundaries" }));
  assert.equal(r.code, 1);
  assert.ok(r.world.filing.roadmapReads.includes(EPIC));
});
