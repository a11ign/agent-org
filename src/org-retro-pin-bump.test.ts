// no-token: gh -- `org-retro.ts` reaches `gh` only through the `read` seam of `pinBumpRead`, which every test here replaces with a fixture; `buildReport` reads nothing, so nothing imported reaches the real `ghJson`
// The pin/bump line on #928 (agent-org#1245), behind `PIN_BUMP_FLAG`. The flag OFF control is the one the row asks for: a report built with
// the flag off is the report it was, byte for byte, and the flag ON report is that report with the one line added and nothing else.
// The reads are fixtures and the `gh` reader is a seam, so no `gh` runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, pinBumpRead, renderReport, retroClasses } from "./org-retro.ts";
import { PIN_BUMP_FLAG, pinBumpLine, pinBumpMeasure } from "./pin-bump-measure.ts";
import { CANARY_STATE_FILE, emptyCanaryState, withMachineryFlag } from "./org-health.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
// Every read the report takes, empty: the report is the same whatever the pin/bump reading is.
const BASE = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };

test("flag OFF: the report has no pin/bump line, and an absent reading is the same report as a null one", () => {
  const off = renderReport(buildReport(BASE, NOW));
  assert.equal(renderReport(buildReport({ ...BASE, pinBump: null }, NOW)), off, "a null reading is the flag OFF report");
  assert.doesNotMatch(off, /Hand-filed pin or bump rows/);
  assert.doesNotMatch(off, /Renovate PRs across/);
});

test("flag ON: the report is the flag OFF report with the one pin/bump line added, and the line quotes both figures", () => {
  const measure = pinBumpMeasure({
    now: NOW,
    rows: [{ title: "Bump left-pad to 1.3.0", body: "", author: "a11ign", createdAt: ago(DAY) }],
    repos: [{ repo: "a11ign/x", prs: [{ number: 3, author: "app/renovate", createdAt: ago(2 * HOUR) }] }],
  });
  const line = pinBumpLine(measure);
  assert.match(line, /Hand-filed pin or bump rows, last 7 days: 1\./);
  assert.match(line, /a11ign\/x 1 aged \/ 0 red/);
  const off = renderReport(buildReport(BASE, NOW));
  const on = renderReport(buildReport({ ...BASE, pinBump: measure }, NOW));
  assert.ok(on.split("\n").includes(line), "the line is one line of the report");
  assert.deepEqual(on.split("\n").filter((text) => text !== line), off.split("\n"), "nothing else in the report moves");
});

test("a refused read is `unknown` on the line, never 0", () => {
  const measure = pinBumpMeasure({ now: NOW, rows: null, repos: [{ repo: "a11ign/x", prs: null }] });
  const line = pinBumpLine(measure);
  assert.match(line, /Hand-filed pin or bump rows, last 7 days: unknown\./);
  assert.match(line, /a11ign\/x unknown/);
});

// The home repository's issues as `gh api graphql` answers one page of `repository.issues`: `PAGE` nodes from the `after=` cursor (a page's
// `endCursor` is the next offset), newest first as the rows are given. Any other read is the open PRs list, answered by the caller.
const PAGE = 100;
const isIssuesQuery = (args: string[]) => args.some((arg) => arg.startsWith("query=") && arg.includes("issues("));
const issuesPage = (rows: object[], args: string[]) => {
  const at = Number(args.find((arg) => arg.startsWith("after="))?.slice("after=".length) ?? 0);
  return { data: { repository: { issues: { pageInfo: { hasNextPage: at + PAGE < rows.length, endCursor: String(at + PAGE) }, nodes: rows.slice(at, at + PAGE) } } } };
};

test("pinBumpRead reads the home repository's filed rows and each population repository's open PRs, and counts them", () => {
  const calls: string[][] = [];
  const rows = [{ title: "Pin left-pad to 1.3.0", body: "", author: { login: "a11ign" }, createdAt: ago(DAY) }];
  const read = (args: string[]) => {
    calls.push(args);
    if (isIssuesQuery(args)) return issuesPage(rows, args);
    if (args[3] === "a11ign/x") return [{ number: 3, author: { login: "app/renovate" }, createdAt: ago(2 * HOUR) }];
    return [];
  };
  const measure = pinBumpRead({ now: NOW, read, declaration: { repo: "a11ign/x", dora: [{ repo: "a11ign/y" }] } });
  assert.equal(measure.pinRows, 1);
  assert.deepEqual(measure.repos, [{ repo: "a11ign/x", aged: 1, red: 0 }, { repo: "a11ign/y", aged: 0, red: 0 }]);
  const issues = calls.find(isIssuesQuery);
  assert.ok(issues?.includes("owner=a11ign") && issues.includes("name=x"), "the rows are asked of the home repository");
  assert.ok(issues?.some((arg) => arg.includes("issues(states:[OPEN,CLOSED],")), "a connection of all states, never a search (#5074)");
});

test("pinBumpRead counts the window's rows in a repository of 3000 issues, where the plain list was at its ceiling (#1430)", () => {
  // Two hand-filed pins inside the window, then 2,998 older issues: a plain list of all of them is at its 1,000 ceiling and reads null.
  const rows = [
    { title: "Pin left-pad to 1.3.0", body: "", author: { login: "a11ign" }, createdAt: ago(DAY) },
    { title: "Bump lodash to 4.17.22", body: "", author: { login: "a11ign" }, createdAt: ago(2 * DAY) },
    ...Array.from({ length: 2998 }, (_, i) => ({ title: `Old issue ${i}`, body: "", author: { login: "a11ign" }, createdAt: ago(10 * DAY + i * HOUR) })),
  ];
  const read = (args: string[]) => {
    if (args[0] === "issue") return rows; // the plain list, were it asked: 3,000 rows is past `LIST_LIMIT`
    if (isIssuesQuery(args)) return issuesPage(rows, args);
    return [];
  };
  const measure = pinBumpRead({ now: NOW, read, declaration: { repo: "a11ign/x", dora: [] } });
  assert.equal(measure.pinRows, 2, "the two pins in the window are counted, and the 2,998 older rows are not");
});

test("pinBumpRead: a window whose rows run past the pages it may read before its boundary is `unknown`, never 0", () => {
  // 1,100 issues all created inside the window: the read walks its 10 pages and the window is still open, so it is cut short.
  const rows = Array.from({ length: 1100 }, (_, i) => ({ title: `Pin number ${i}`, body: "", author: { login: "a11ign" }, createdAt: ago(i * 60_000) }));
  const read = (args: string[]) => (isIssuesQuery(args) ? issuesPage(rows, args) : []);
  const measure = pinBumpRead({ now: NOW, read, declaration: { repo: "a11ign/x", dora: [] } });
  assert.equal(measure.pinRows, null);
});

test("pinBumpRead: a list that is refused reads `unknown`, and a filed row that is refused is not a zero", () => {
  const measure = pinBumpRead({ now: NOW, read: () => null, declaration: { repo: "a11ign/x", dora: [] } });
  assert.equal(measure.pinRows, null);
  assert.deepEqual(measure.repos, [{ repo: "a11ign/x", unknown: true }]);
});

// The wiring, through `retroClasses` and a real canary file in a temp state directory: the class exists only when the flag is ON, and its read is
// the one that makes the pin read. Constructing `retroClasses` reads nothing; only the pin class's own `read` is called here.
const FIXTURE = pinBumpMeasure({ now: NOW, rows: [], repos: [] });
const canaryText = (on: boolean) => JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: PIN_BUMP_FLAG, on }));
function stateDirWith(text: string | null): string {
  const dir = tmpDir("pin-bump-state-");
  if (text !== null) writeFileSync(join(dir, CANARY_STATE_FILE), text);
  return dir;
}
function pinClass(stateDir: string, calls: number[]) {
  return retroClasses({ now: NOW, stateDir, readPinBump: (at) => { calls.push(at); return FIXTURE; } }).find((cls) => cls.name === "pin and bump");
}

test("flag ON in the canary state: the class is wired, and its read is the pin read at `now`", () => {
  const calls: number[] = [];
  const cls = pinClass(stateDirWith(canaryText(true)), calls);
  assert.ok(cls, "the class is in the report's classes when the flag is ON");
  assert.deepEqual(cls.read(), { pinBump: FIXTURE });
  assert.deepEqual(calls, [NOW]);
});

test("flag OFF, or no canary state at all: no class and no pin read", () => {
  for (const dir of [stateDirWith(canaryText(false)), stateDirWith(null)]) {
    const calls: number[] = [];
    assert.equal(pinClass(dir, calls), undefined, "no class when OFF");
    assert.deepEqual(calls, []);
  }
});

test("a canary state that will not parse makes the flag UNKNOWN, never OFF: the class says so and reads nothing", () => {
  for (const text of ["not json", `{"flags":{}}`]) {
    const calls: number[] = [];
    const cls = pinClass(stateDirWith(text), calls);
    assert.ok(cls, "an unreadable state keeps the class, so the report can say it is unknown");
    assert.deepEqual(cls.read(), { pinBump: { flagUnreadable: true } });
    assert.deepEqual(calls, [], "no pin read on an unknown flag");
  }
  const report = renderReport(buildReport({ ...BASE, pinBump: { flagUnreadable: true } }, NOW));
  assert.match(report, /Hand-filed pin or bump rows and stuck Renovate PRs: unknown, because machinery-canary\.json cannot be read/);
  assert.notEqual(report, renderReport(buildReport(BASE, NOW)), "UNKNOWN is not the OFF report");
});
