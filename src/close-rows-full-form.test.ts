// #2995: A ROW OF THE TRACKER IS NAMED BY A PULL REQUEST OF ANOTHER REPOSITORY IN THE FULL FORM, `Closes owner/repo#N`, and the platform
// closes it (read on a draft PR: `closingIssuesReferences` reported it). This file pins the three readers that had to accept it:
// the template and `pr:open` (done-when 1), the CLOSES MISMATCH guard (2) and the row closer (3). Done-when 4 is a real merge.
//
// RUN FROM THIS CHECKOUT ALONE: `node --test src/close-rows-full-form.test.ts`. The modules under test read the project's declaration
// at import, and a bare checkout of the tool has none beside it, so this points `AGENT_ORG_HOST` at the host file the project carries
// (`A11IGN_CHECKOUT`, the primary checkout on this host by default) BEFORE importing them. Inside the project's own tree there is
// nothing to point at and nothing is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.A11IGN_CHECKOUT ?? "/home/agent/repos/a11y-witness";
// The project is found through the host file, never by counting directories up from `src`, which is the HOME directory in this repository.
// Default it only when the file is there: a CI runner has no primary checkout, and a host path that does not exist throws at import.
const PROJECT_HOST = join(PROJECT, ".agent-org/host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(PROJECT_HOST)) {
  process.env.AGENT_ORG_HOST = PROJECT_HOST;
}
const { closesMismatchReport } = await import("./closes-mismatch-check.ts");
const { checkRegion } = await import("./pr-open.ts");
const { REPO } = await import("./project-identity.ts");
const { extractClosesDeclaration } = await import("./acceptance-commands.ts");

const TRACKER = "a11ign/a11ign";
const LAYER = "a11ign/agent-org";
const declared = (body: any) => ({ kind: "closes", numbers: [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
  references: [...body.matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g)].map((m) => ({ repo: m[1] ?? null, number: Number(m[2]) })) });

test("the project's tracker is the repository these cases are written against", () => {
  assert.equal(REPO, TRACKER, "every case below names the tracker by this repository; a different project's declaration would make them about something else");
});

// ---- done-when 1: the template and `pr:open` write the full form --------------------------------------------------------------------

test("done-when 1: the pull request template asks for the full form, and a filled one reads as a row of the tracker", (t) => {
  const path = resolve(SRC, "../.github/PULL_REQUEST_TEMPLATE.md");
  // The project's CI copies only `src` beside its own tree, where there is no template to read: said, never passed silently.
  if (!existsSync(path)) return t.skip("the template is not beside the tool in this tree");
  const template = readFileSync(path, "utf8");
  assert.match(template, /^Closes a11ign\/a11ign#$/m);
  assert.doesNotMatch(template, /^Row:/m, "the old line named no closing keyword, so nothing was ever closed by it");
  const filled = template.replace(/^Closes a11ign\/a11ign#$/m, "Closes a11ign/a11ign#2995");
  assert.deepEqual((extractClosesDeclaration(filled) as any).references, [{ repo: TRACKER, number: 2995 }]);
});

const ROW = "## Region\n\n```\nsrc/x.mjs\n```\n";
const regionDeps = { git: () => "", rowBody: () => ROW, rootFiles: new Set(), code: [{ key: "", repo: TRACKER }, { key: "agent-org", repo: LAYER }] };

test("done-when 1: pr:open refuses the short form in a pull request of another repository, and says what to write", () => {
  const result = checkRegion("Closes #7", ["--repo", LAYER], (regionDeps as any));
  assert.match(result.refusal ?? "", /REFUSED/);
  assert.match(result.refusal ?? "", /names an issue of a11ign\/agent-org, not a row of a11ign\/a11ign/);
  assert.match(result.refusal ?? "", /Write `Closes a11ign\/a11ign#7`/);
});

test("done-when 1, POSITIVE CONTROL: the full form passes the same check, and the short form is still the tracker's own", () => {
  assert.equal(checkRegion("Closes a11ign/a11ign#7", ["--repo", LAYER], (regionDeps as any)).refusal, null);
  assert.equal(checkRegion("Closes #7", [], (regionDeps as any)).refusal, null, "no --repo: the tracker's own pull request, whose `#7` IS the row");
  assert.equal(checkRegion("Closes #7", ["--repo", TRACKER], (regionDeps as any)).refusal, null);
});

// ---- done-when 2: the guard compares repository AND number --------------------------------------------------------------------------

const OK = { ok: true };
const refused = (report: any) => { assert.equal(report.ok, false); return report.reasons.join("\n"); };

test("done-when 2: a declared full form that GitHub resolved is OK", () => {
  const body = "Closes a11ign/a11ign#7";
  assert.deepEqual(closesMismatchReport((declared(body) as any), [{ repo: TRACKER, number: 7 }], body, LAYER), OK);
});

test("done-when 2: a declared full form GitHub did not resolve is refused and named", () => {
  const body = "Closes a11ign/a11ign#7";
  const text = refused(closesMismatchReport((declared(body) as any), [], body, LAYER));
  assert.match(text, /you declared a11ign\/a11ign#7, but GitHub will NOT close it/);
});

test("done-when 2: a row GitHub resolved that the body did not declare is refused and named, with its repository", () => {
  const body = "Closes a11ign/a11ign#7\nCloses a11ign/a11ign#8";
  const text = refused(closesMismatchReport((declared("Closes a11ign/a11ign#7") as any), [{ repo: TRACKER, number: 7 }, { repo: TRACKER, number: 8 }], body, LAYER));
  assert.match(text, /GitHub will close a11ign\/a11ign#8 anyway -- the phrase "Closes a11ign\/a11ign#8" on line 2/);
});

test("done-when 2: the SAME NUMBER in another repository is a different row -- it matches nothing", () => {
  const body = "Closes a11ign/a11ign#7";
  const text = refused(closesMismatchReport((declared(body) as any), [{ repo: LAYER, number: 7 }], body, LAYER));
  assert.match(text, /will NOT close it/, "the declared row was not the one resolved");
  assert.match(text, /will close #7 anyway/, "and the one resolved is the layer's own #7, which was never declared");
});

test("done-when 2, POSITIVE CONTROL: the short form in a pull request of another repository is refused, even when GitHub resolved it", () => {
  const body = "Closes #7";
  const text = refused(closesMismatchReport((declared(body) as any), [{ repo: LAYER, number: 7 }], body, LAYER));
  assert.match(text, /you wrote `Closes #7`, which names issue 7 of a11ign\/agent-org, not a row of a11ign\/a11ign/);
  assert.match(text, /write `Closes a11ign\/a11ign#7`/);
  assert.deepEqual(closesMismatchReport((declared(body) as any), [7], body), OK, "the control: the same body in a tracker pull request, as before");
});

// ---- done-when 3: the row closer settles a row GitHub closed natively -------------------------------------------------------------------

/** A `gh` that answers the closer's one pull-request read and records every other call. */
function runCloser({ rowState }: { rowState: any }) {
  const dir = tmpDir("close-rows-full-form-");
  const calls = join(dir, "calls.log");
  const pr = { merged: true, baseRefName: "main", mergedAt: "2026-10-02T14:00:00Z", headRefName: "agent/x-2995", body: "Closes a11ign/a11ign#2995",
    mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [
      { number: 2995, state: rowState, repository: { nameWithOwner: TRACKER }, labels: { nodes: [{ name: "in-progress" }, { name: "session:worker-2995" }] }, timelineItems: { nodes: [] } },
      { number: 4, state: "OPEN", repository: { nameWithOwner: LAYER }, labels: { nodes: [{ name: "in-progress" }] }, timelineItems: { nodes: [] } }] } };
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/gh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const query = args.find((a) => a.startsWith("query=")) ?? "";
if (query.includes("pullRequest(number:")) { console.log(${JSON.stringify(JSON.stringify(pr))}); process.exit(0); }
if (query.includes("rateLimit")) { console.log("HTTP/2 200\\nx-ratelimit-used: 1\\n\\n{}"); process.exit(0); }
if (args[0] === "issue") process.exit(0);
console.error("NOT_FOUND (a11ign.projectV2): Could not resolve to a ProjectV2 with the number 1"); process.exit(1);
`);
  chmodSync(join(dir, "bin/gh"), 0o755);
  spawnSync("git", ["init", "-q", dir], { env: sandboxGitEnv() });
  const run = spawnSync(process.execPath, [join(SRC, "close-rows-for-merged-pr.ts"), "17"], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_REPOSITORY: LAYER } });
  const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { run, issueCalls: log.filter((args) => args[0] === "issue") };
}

test("done-when 3, POSITIVE CONTROL: a row still open is closed by the closer, in the TRACKER, naming the other repository's pull request", () => {
  const { run, issueCalls } = runCloser({ rowState: "OPEN" });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const close = issueCalls.find((args) => args[1] === "close");
  assert.deepEqual([close?.[2], close?.[close.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.match(close?.[close.indexOf("--comment") + 1] ?? "", /PR a11ign\/agent-org#17 merged as `abc1234` and declared `Closes a11ign\/a11ign#2995`/);
  const strip = issueCalls.find((args) => args[1] === "edit");
  assert.deepEqual([strip?.[2], strip?.[strip.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.ok(issueCalls.every((args) => args[args.indexOf("--repo") + 1] === TRACKER && args[2] !== "4"), "nothing was aimed at the layer's own #4, which this merge never named");
});

test("done-when 3: a row GitHub already closed natively is not closed again -- only its labels and Status are settled", () => {
  const { run, issueCalls } = runCloser({ rowState: "CLOSED" });
  assert.match(run.stdout, /#2995 ALREADY CLOSED -- left alone/);
  assert.equal(issueCalls.some((args) => args[1] === "close"), false);
  const strip = issueCalls.find((args) => args[1] === "edit");
  assert.deepEqual([strip?.[2], strip?.[strip.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.deepEqual(strip?.filter((a: any, i: any) => strip[i - 1] === "--remove-label").sort(), ["in-progress", "session:worker-2995"]);
  assert.match(run.stdout + run.stderr, /DEGRADED|Status/, "and the Status move was ASKED for (the shim's board is unreadable, which the closer reports rather than hides)");
});
