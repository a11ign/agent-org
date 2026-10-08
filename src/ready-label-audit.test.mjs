// no-token: gh -- every `gh` this file reaches is a FAKE one: a script written into a temp directory and put first on PATH, answering from a fixture keyed by repository. Nothing here reaches GitHub.
// #4080 (row 2 of #4056): THE READY-QUEUE AUDIT READS EVERY DECLARED TRACKER, not the one `REPO` constant. Each test drives `auditTrackers` over TWO declared trackers (the home one,
// key "", and `agent-org`) with a fixture per repository, and its twin differs by ONE fact:
//   - a row that exists ONLY in the second tracker is reported (unfixed, the audit never asks that repository);
//   - the same number in both trackers stays TWO findings, named `#7` and `agent-org#7`;
//   - a read that fails on the second tracker is named, and the first tracker's findings are still counted;
//   - with ONE declared tracker the output is today's (a recorded snapshot), so the change is inert until a second is declared.
// POSITIVE CONTROL for every "not reported" assertion: the same fixture, audited as the tracker that owns the row, DOES report it (the `labelless` pair below).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as audit from "./ready-label-audit.mjs";

const HOME = "a11ign/a11ign";
const ORG = "a11ign/agent-org";
const scratch = mkdtempSync(join(tmpdir(), "ready-label-audit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The fake `gh`: `issue list --repo R` answers R's open rows, `api search/issues?q=repo:R` their numbers, a repository marked `fail` is refused, anything else is loud. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const args = process.argv.slice(2);
const refuse = (why) => { process.stderr.write("fake gh: " + why + "\\n"); process.exit(1); };
let repo;
if (args[0] === "issue" && args[1] === "list") repo = args[args.indexOf("--repo") + 1];
else if (args[0] === "api" && args[1].startsWith("search/issues?q=")) repo = /repo:([^ ]+)/.exec(decodeURIComponent(args[1]))[1];
else refuse("unexpected call " + args.join(" "));
const held = fixture[repo];
if (!held) refuse("no fixture for " + repo);
if (held.fail) refuse("HTTP 502 reading " + repo);
const rows = held.open.map((r) => ({ number: r.number, title: r.title, labels: r.labels.map((name) => ({ name })) }));
process.stdout.write(args[0] === "issue" ? JSON.stringify(rows) : rows.map((r) => r.number).join("\\n") + "\\n");
`;

/** @param {Record<string, { open: { number: number, title: string, labels: string[] }[], fail?: boolean }>} fixture */
function withFakeGh(fixture, body) {
  const dir = mkdtempSync(join(scratch, "bin-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const saved = { PATH: process.env.PATH, FAKE_GH_FIXTURE: process.env.FAKE_GH_FIXTURE, out: process.stdout.write, err: process.stderr.write };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.FAKE_GH_FIXTURE = fixturePath;
  const captured = { out: "", err: "" };
  process.stdout.write = /** @type {any} */ ((/** @type {string} */ text) => { captured.out += text; return true; });
  process.stderr.write = /** @type {any} */ ((/** @type {string} */ text) => { captured.err += text; return true; });
  try {
    return { result: body(), ...captured };
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    process.env.PATH = saved.PATH;
    if (saved.FAKE_GH_FIXTURE === undefined) delete process.env.FAKE_GH_FIXTURE; else process.env.FAKE_GH_FIXTURE = saved.FAKE_GH_FIXTURE;
  }
}

const TWO = { tracker: [{ key: "", repo: HOME, board: { owner: "a11ign", number: 1 } }, { key: "agent-org", repo: ORG, board: { owner: "a11ign", number: 3 } }],
  code: [{ key: "", repo: HOME }, { key: "agent-org", repo: ORG }] };
const ONE = { tracker: [TWO.tracker[0]], code: [TWO.code[0]] };

/** The two cheap checks: the open-issue mutex and the labelless-row check. Both read only the open list and the search index, which is all the fake answers. */
const CHEAP = audit.CHECKS.filter(([what]) => what === "open issues" || what === "labelless rows");

const row = (/** @type {number} */ number, /** @type {string[]} */ labels, title = `row ${number}`) => ({ number, title, labels });

test("the control: the CHEAP population is two checks, so a test that selects it is not asserting over nothing", () => {
  assert.deepEqual(CHEAP.map(([what]) => what), ["open issues", "labelless rows"]);
});

test("a row that exists ONLY in the second tracker is reported, named in the key form", () => {
  const fixture = { [HOME]: { open: [row(1, ["ready"])] }, [ORG]: { open: [row(9, [], "only in agent-org")] } };
  const { result, out } = withFakeGh(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  agent-org#9 "only in agent-org"/);
  assert.equal(result.findings, 1);
  // The twin: the same row, audited as the home tracker's own, is found by the same check -- so the line above is the second tracker being READ, not a check that always fires.
  const own = withFakeGh({ [HOME]: { open: [row(9, [], "only in agent-org")] } }, () => audit.auditTrackers(audit.trackersOf(ONE), { checks: CHEAP }));
  assert.match(own.out, /NO LABELS  #9 "only in agent-org"/);
});

test("the same number in both trackers stays TWO findings, `#7` and `agent-org#7`", () => {
  const fixture = { [HOME]: { open: [row(7, [], "home seven")] }, [ORG]: { open: [row(7, [], "org seven")] } };
  const { result, out } = withFakeGh(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  #7 "home seven"/);
  assert.match(out, /NO LABELS  agent-org#7 "org seven"/);
  assert.equal(result.findings, 2);
});

test("a read that fails on the second tracker names that tracker, and the first tracker's findings are still counted", () => {
  const fixture = { [HOME]: { open: [row(7, [], "home seven")] }, [ORG]: { open: [], fail: true } };
  const { result, out, err } = withFakeGh(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  #7 "home seven"/);
  assert.equal(result.findings, 1);
  assert.match(err, /COULD NOT AUDIT open issues \(agent-org\)/);
  assert.match(err, /COULD NOT AUDIT labelless rows \(agent-org\)/);
  assert.deepEqual(result.refused, ["open issues (agent-org)", "labelless rows (agent-org)"]);
  // The twin: the same fixture with the second tracker healthy refuses nothing, so `refused` is the failure and not a standing value.
  const healthy = withFakeGh({ ...fixture, [ORG]: { open: [] } }, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.deepEqual(healthy.result.refused, []);
});

test("a check only the primary project can answer is SAID to be skipped for the second tracker, never counted as agreeing", () => {
  const board = audit.CHECKS.filter(([what]) => what === "board membership");
  assert.equal(board.length, 1, "positive control: the check exists");
  const fixture = { [HOME]: { open: [] }, [ORG]: { open: [] } };
  const { result, out } = withFakeGh(fixture, () => audit.auditTrackers(audit.trackersOf(TWO).slice(1), { checks: board }));
  assert.match(out, /NOT RUN  board membership \(agent-org\)/);
  assert.deepEqual(result.skipped, ["board membership (agent-org)"]);
  assert.equal(result.findings, 0);
});

const SNAPSHOT = {
  out: "OK  1 of 1 open issue(s) checked, none carry `ready` with a not-pickable label\n"
    + "\n"
    + "NO LABELS  #3 \"bare\" -- carries no label at all, so it is absent from every other check in this audit, and from the Ready lane, the backlog view, the WIP count, "
    + "the dead-claim check, the hourly table and the section-backfill sweep, all of which enumerate by label\n",
  err: "\n1 row(s) carry no label at all. Add at least one -- `backlog` is the safe default, and which is right is a human judgement -- so they become visible to every check that reads this tracker.\n",
};

test("with ONE declared tracker the output is today's: no header, no key form, the same lines in the same order", () => {
  const one = withFakeGh({ [HOME]: { open: [row(3, [], "bare")] } }, () => audit.auditTrackers(audit.trackersOf(ONE), { checks: CHEAP }));
  assert.equal(one.out, SNAPSHOT.out);
  assert.equal(one.err, SNAPSHOT.err);
  assert.equal(one.result.findings, 1);
  assert.deepEqual(one.result.refused, []);
});
