// no-token: gh
//
// Imports `row-file.ts`, which spawns `gh`; true of the IMPORT and false of the CALL. Every reader below is injected (`run`, the board and
// label readers, `moveStatus`, `roadmapItems`, `roadmapField`), so no test lets a real spawn happen -- the arrangement `row-file-board.test.ts` uses.
/**
 * #516: `row-file` refuses a row under a roadmap epic that has no `Roadmap` value, and sets it when it boards the row.
 *
 * POSITIVE CONTROL: the first refusal test below is the one the row names -- a parent whose epic HAS a value and an argv with no `--roadmap=`.
 * With `roadmapPlan`'s refusal removed that test fails (it files the row), which is the run the PR shows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIssue, parentFromArgv, parentRef, roadmapFromArgv, roadmapItemsOf, roadmapFieldOf, withFiledBy, type RoadmapItem } from "./row-file.ts";

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
 * A fake board: every project item keyed `owner/repo#n`. `item-add` boards the new row with no value; `item-edit` sets the value the option id
 * names -- so what each assertion reads is what the act WROTE, and a `--roadmap=` that was never applied reads as `null`.
 */
function fakeBoard(options: { epicValue?: string | null; epicUnreadable?: boolean; fieldMissing?: boolean; editFails?: boolean; editIgnored?: boolean } = {}) {
  const items = new Map<string, RoadmapItem[]>([[EPIC, [{ id: "PVTI_epic", number: 1, owner: "a11ign", value: options.epicValue ?? null }]]]);
  const log = { spawned: [] as string[][], edits: [] as string[][], reads: [] as string[], stderr: "", stdout: "" };
  const run = (_cmd: string, args: string[]): string => {
    if (args[0] === "project" && args[1] === "item-add") { items.set(ROW, [{ id: "PVTI_900", number: 1, owner: "a11ign", value: null }]); return ""; }
    if (args[0] === "project" && args[1] === "item-edit" && args.includes("--single-select-option-id")) {
      log.edits.push(args);
      if (options.editFails) throw new Error("GraphQL: Resource not accessible by integration");
      const name = OPTIONS.find((o) => o.id === args[args.indexOf("--single-select-option-id") + 1])?.name ?? null;
      if (!options.editIgnored) for (const item of items.get(ROW) ?? []) if (item.id === args[args.indexOf("--id") + 1]) item.value = name;
      return "";
    }
    if (args[0] === "issue" && args[1] === "list") return "[]"; // the duplicate-title read: no open row has it
    if (args[0] === "issue" && args[1] === "view" && args.includes("body")) return `${BODY}\nFiled-by: worker-516\n`;
    if (args[0] === "issue" && args[1] === "view" && args.includes("milestone")) return "CI reset";
    return "";
  };
  const roadmapItems = (issue: { repo: string; number: number }) => {
    const key = `${issue.repo}#${issue.number}`;
    log.reads.push(key);
    if (options.epicUnreadable && key === EPIC) throw new Error("HTTP 502");
    return (items.get(key) ?? []).map((item) => ({ ...item }));
  };
  const deps = { run, roadmapItems, roadmapField: () => (options.fieldMissing ? null : FIELD),
    moveStatus: () => ({ moved: true as const }), fetchBoardStatus: () => "Backlog", ensureLabels: () => undefined,
    fetchLabels: () => ({ number: 900, title: "t", state: "OPEN", labels: ["backlog", "lane:any", "out-of-release"] }),
    loadLanesConfig: () => ({ lanes: [] }), milestones: () => ["CI reset"], primaryMilestones: () => ["CI reset"], declaration: DECLARATION,
    spawnGh: (argv: string[]) => { log.spawned.push(argv); return "https://github.com/a11ign/a11ign/issues/900"; } };
  return { log, items, deps };
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
  assert.equal(r.log.edits.length, 0);
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
  assert.deepEqual(r.log.edits, [["project", "item-edit", "--id", "PVTI_900", "--project-id", "PVT_1", "--field-id", "PVTSSF_roadmap",
    "--single-select-option-id", "OPT_3"]]);
  assert.equal(r.items.get(ROW)?.[0].value, "Self-healing org");
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
  assert.equal(r.log.edits.length, 0);
});

test("#516: a --roadmap= given under an epic with no value is still checked and set, never silently ignored", () => {
  const set = file(["--parent=4437", "--roadmap=Clean boundaries"], fakeBoard({ epicValue: null }));
  assert.equal(set.code, 0, set.log.stderr);
  assert.equal(set.items.get(ROW)?.[0].value, "Clean boundaries");
  const unknown = file(["--parent=4437", "--roadmap=Sideways"], fakeBoard({ epicValue: null }));
  assert.equal(unknown.code, 1);
  assert.equal(unknown.log.spawned.length, 0);
});

test("#516: no --parent and no --roadmap= reads no epic and writes no field", () => {
  const r = file([], fakeBoard({ epicValue: "Clean boundaries" }));
  assert.equal(r.code, 0, r.log.stderr);
  assert.deepEqual(r.log.reads, []);
  assert.equal(r.log.edits.length, 0);
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
  assert.equal(r.items.get(ROW)?.[0].value, "Manager redesign");
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
  assert.ok(r.log.reads.includes(EPIC));
});

test("#516: the readers parse GitHub's shapes -- items with their value, options from the project, a missing field as null", () => {
  const items = JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { id: "PVTI_1", project: { number: 2, owner: { login: "a11ign" } }, fieldValueByName: { name: "Clean boundaries" } },
    { id: "PVTI_2", project: { number: 1, owner: { login: "a11ign" } }, fieldValueByName: null }] } } } } });
  assert.deepEqual(roadmapItemsOf({ repo: "a11ign/agent-org", number: 5 }, () => items),
    [{ id: "PVTI_1", number: 2, owner: "a11ign", value: "Clean boundaries" }, { id: "PVTI_2", number: 1, owner: "a11ign", value: null }]);
  const board = (field: unknown) => JSON.stringify({ data: { repositoryOwner: { projectV2: { id: "PVT_9", field } } } });
  const tracker = { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } };
  assert.deepEqual(roadmapFieldOf(tracker, () => board({ id: "F1", options: [{ id: "O1", name: "Clean boundaries" }] })),
    { projectId: "PVT_9", fieldId: "F1", options: [{ id: "O1", name: "Clean boundaries" }] });
  assert.equal(roadmapFieldOf(tracker, () => board(null)), null);
  assert.throws(() => roadmapFieldOf(tracker, () => JSON.stringify({ data: { repositoryOwner: { projectV2: null } } })), /could not read a11ign\/projects\/2/);
  assert.throws(() => roadmapItemsOf({ repo: "a11ign/agent-org", number: 5 }, () => "{}"), /expected shape/);
});
