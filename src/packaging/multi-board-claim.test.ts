// no-token: gh -- every `gh` call in this file is an injected seam over canned answers, and the two CLIs run in-process
/**
 * #2617 (child 3b of #69): THE CLAIM RULES, B4 AND `pr-open` READ EVERY REPOSITORY THE PROJECT DECLARES.
 *
 * One fixture per claim the row makes, each with the control that shows it is not passing by refusing (or accepting) everything:
 *   1. B4 across two code repositories: an overlap that lives ONLY in the second is REFUSED, naming the repository and the pull request;
 *      the same claim with only the first declared PASSES.
 *   2. A Region path with a repository prefix is that key's path, and a bare path is the first repository's -- in BOTH directions, so a
 *      reader that ignored the prefix (or the bareness) fails one of the two.
 *   3. A failed read of the second repository is INCONCLUSIVE, said aloud with the repository's name, and never printed as "no overlap".
 *   4. The same row number in two trackers is two worktree names and two `session:` labels, and the first tracker's are today's, byte for byte.
 *   5. The merge-blocking parser and `pr-open` ACCEPT `Closes a11ign/a11ign#7` and REFUSE the malformed cross-repository forms.
 * And the cost the row's closing comment reports: how many `gh` calls a claim's reads spend per declared repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProjectDeclaration } from "../project-config.ts";
import {
  b4Lines, claimNames, claimWithWorktree, reportB4, sessionEligibilityReason, trackerClaimRefusal, trackerFor,
} from "../row-claim.ts";
import {
  declaredClosedRows, fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles,
} from "../row-claim/file-overlap-rule.ts";
import { declaredRegionFiles, regionCoversIn, splitRegionEntry } from "../region-paths.ts";
import { closesDeclarationReport, closesReferences, extractClosesDeclaration } from "../acceptance-commands.ts";
import { checkBody, checkRegion, main } from "../pr-open.ts";

const FIRST = { key: "", repo: "a11ign/a11ign" };
const SECOND = { key: "nvda-worker", repo: "a11ign/nvda-worker" };
const BOTH = [FIRST, SECOND];
const NO_ROOT_FILES = new Set<string>();

/** A declaration read through the REAL reader, so the grammar the fixtures rely on is the one the tool enforces. */
const declaration = (tracker: object[], code: object[]) => parseProjectDeclaration(JSON.stringify({ schema: 1, tracker, code }));
const TWO_TRACKERS = declaration(
  [{ key: "", repo: "a11ign/a11ign", board: { owner: "a11ign", number: 1 } },
    { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } }],
  [FIRST, { key: "agent-org", repo: "a11ign/agent-org" }],
);

/** A Region in the fenced shape `region-paths.ts` reads, so the prefix goes through the real extractor. */
const regionBody = (...lines: string[]) => `## What it is\n\nx\n\n## Region\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\n## Acceptance\n\nx\n`;

/** An open pull request as `gh pr list --json number,changedFiles,files,body,labels` answers. */
const ghPr = (number: number, files: string[], body = "") => ({ number, changedFiles: files.length, files: files.map((path) => ({ path })), body, labels: [] });

interface Fake { calls: string[][]; run: (args: string[]) => string }

/** `gh` answering by repository: the row's body and edge from the TRACKER, and each repository's open pull requests from that repository. */
function fakeGh({ region, prs, failing = [] }: { region: string; prs: Record<string, object[]>; failing?: string[] }): Fake {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const repo = args[args.indexOf("--repo") + 1];
    if (args[0] === "pr" && args[1] === "list") {
      if (failing.includes(repo)) throw new Error(`HTTP 502 from ${repo}`);
      return JSON.stringify(prs[repo] ?? []);
    }
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "view") {
      return args[args.indexOf("--json") + 1] === "blockedBy" ? JSON.stringify({ blockedBy: { nodes: [] } }) : JSON.stringify({ body: region });
    }
    return "";
  };
  return { calls, run };
}

const eligibility = (fake: Fake, repos: typeof BOTH) =>
  sessionEligibilityReason(2617, "worker-2617", { run: (_cmd: string, args: string[]) => fake.run(args), repo: FIRST.repo, repos });

// --- 1. B4 reads the SECOND repository -------------------------------------------------------------------------------

test("#2617 done-when 1: a claim whose Region overlaps a file changed by an open pull request in the SECOND repository is REFUSED, naming the "
  + "repository and the pull request", () => {
  const fake = fakeGh({ region: regionBody("nvda-worker:src/capture.ts"), prs: { [SECOND.repo]: [ghPr(7, ["src/capture.ts", "src/other.ts"])] } });
  const reason = eligibility(fake, BOTH);
  assert.ok(reason, "an overlap that lives only in the second repository must refuse");
  assert.match(reason, /overlaps #7 in a11ign\/nvda-worker, which already touches: src\/capture\.ts\./);
  assert.match(reason, /B4/);
});

test("#2617 POSITIVE CONTROL: the SAME claim with only the first repository declared PASSES -- the refusal above is the second repository's, "
  + "and a reader that refuses everything would have refused this too", () => {
  const fake = fakeGh({ region: regionBody("nvda-worker:src/capture.ts"), prs: { [SECOND.repo]: [ghPr(7, ["src/capture.ts"])] } });
  assert.equal(eligibility(fake, [FIRST]), null);
  assert.deepEqual(fake.calls.filter((c) => c[0] === "pr").map((c) => c[c.indexOf("--repo") + 1]), [FIRST.repo],
    "only the declared repository was read, so the control passes for the right reason");
});

test("#2617: the first repository's pull requests keep their number as their whole name -- a refusal there reads as it always did", () => {
  const fake = fakeGh({ region: regionBody("packages/agent-org/src/row-claim.ts"),
    prs: { [FIRST.repo]: [ghPr(406, ["packages/agent-org/src/row-claim.ts"])] } });
  const reason = eligibility(fake, BOTH);
  assert.match(reason ?? "", /^overlaps #406, which already touches: packages\/agent-org\/src\/row-claim\.ts\./);
});

// --- 2. a repository prefix is that key's path; a bare path is the first's -------------------------------------------------

test("#2617 done-when 1b: `nvda-worker:src/x.ts` is read as the second repository's path and a bare path as the first's, by the real extractor", () => {
  const entries = declaredRegionFiles(regionBody("nvda-worker:src/x.ts", "nvda-worker:src/lib/", "packages/agent-org/src/row-claim.ts"),
    { rootFiles: NO_ROOT_FILES });
  const split = (entries ?? []).map(splitRegionEntry);
  assert.deepEqual(split.filter((e) => e.key === "").map((e) => e.path), ["packages/agent-org/src/row-claim.ts"], "a bare path is the first's");
  assert.deepEqual(split.filter((e) => e.key === "nvda-worker").map((e) => e.path).sort(), ["src/lib/", "src/x.ts"], "a prefixed one is that key's");
  assert.equal(entries?.length, 3, "all three declared -- an extractor that dropped the prefixed lines would leave one");
});

test("#2617: a prefixed entry covers files of ITS repository only, and a bare one the first's only -- both directions", () => {
  assert.equal(regionCoversIn("nvda-worker:src/x.ts", "nvda-worker", "src/x.ts"), true);
  assert.equal(regionCoversIn("nvda-worker:src/x.ts", "", "src/x.ts"), false, "the same path in the FIRST repository is not covered");
  assert.equal(regionCoversIn("src/x.ts", "", "src/x.ts"), true);
  assert.equal(regionCoversIn("src/x.ts", "nvda-worker", "src/x.ts"), false, "a bare path is the first repository's, never the second's");
  assert.equal(regionCoversIn("nvda-worker:src/", "nvda-worker", "src/lib/y.ts"), true, "a directory entry keeps its directory rule");
  assert.equal(regionCoversIn("nvda-worker:src/", "nvda-worker", "srcs/y.ts"), false);
});

test("#2617: B4 does not cross the repositories on a shared PATH -- the same file name in the other repository is not an overlap", () => {
  const otherFirst = fileOverlapReason(["nvda-worker:src/x.ts"], [{ number: 3, files: ["src/x.ts"], changedFiles: 1 }]);
  assert.equal(otherFirst.reason, null, "a first-repository pull request holding `src/x.ts` does not hold nvda-worker's");
  const bareVsSecond = fileOverlapReason(["src/x.ts"], [{ number: 3, files: ["src/x.ts"], changedFiles: 1, repo: SECOND.repo, repoKey: SECOND.key }]);
  assert.equal(bareVsSecond.reason, null, "a bare Region path is the first repository's, so the second's `src/x.ts` is not it");
  const same = fileOverlapReason(["nvda-worker:src/x.ts"], [{ number: 3, files: ["src/x.ts"], changedFiles: 1, repo: SECOND.repo, repoKey: SECOND.key }]);
  assert.match(same.reason ?? "", /overlaps #3 in a11ign\/nvda-worker/, "control: the matching pair IS refused, so the two nulls above are not a reader that never fires");
});

test("#2617: a file list that does not match its count is refused as NOT COMPARABLE, naming the repository", () => {
  const { reason } = fileOverlapReason(["nvda-worker:src/x.ts"],
    [{ number: 9, files: ["src/a.ts"], changedFiles: 130, repo: SECOND.repo, repoKey: SECOND.key }]);
  assert.match(reason ?? "", /cannot compare with #9 in a11ign\/nvda-worker: its file list came back with 1 of its 130 changed files/);
});

test("#2617: an open pull request of the SECOND repository that reads as touching no files is NAMED with its repository in `check`'s note", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason(["nvda-worker:src/x.ts"],
    [{ number: 5, files: [], changedFiles: 0, repo: SECOND.repo, repoKey: SECOND.key }, { number: 6, files: [], changedFiles: 0 }]);
  assert.equal(reason, null);
  assert.deepEqual(emptyOtherPrs, ["a11ign/nvda-worker#5", 6], "a number for the first repository's, `owner/repo#N` for another's");
  assert.match(b4Lines(["nvda-worker:src/x.ts"], [{ number: 5, files: [], changedFiles: 0, repo: SECOND.repo, repoKey: SECOND.key },
    { number: 6, files: [], changedFiles: 0 }]).join("\n"), /NOTE: a11ign\/nvda-worker#5, #6 read as touching NO files/);
});

test("#2617: an entry read from the FIRST repository carries no `repo` or `repoKey` -- only another repository's does", () => {
  const fake = fakeGh({ region: "", prs: { [FIRST.repo]: [ghPr(1, ["a.mjs"])], [SECOND.repo]: [ghPr(2, ["b.ts"])] } });
  const prs = lookupOpenPrFiles({ run: fake.run, log: () => {}, repos: BOTH }) ?? [];
  assert.equal(prs.length, 2, "control: both were read");
  assert.deepEqual(Object.keys(prs[0]).sort(), ["changedFiles", "closes", "files", "held", "number"], "the first's shape is what it always was");
  assert.equal((prs[1] as { repo?: string }).repo, SECOND.repo);
  assert.equal((prs[1] as { repoKey?: string }).repoKey, SECOND.key);
});

// --- 3. a failed read of the second repository is INCONCLUSIVE ---------------------------------------------------------------

test("#2617 done-when 1c: a failed read of the SECOND repository is INCONCLUSIVE -- null, named aloud with the repository, never `no overlap`", () => {
  const said: string[] = [];
  const fake = fakeGh({ region: regionBody("nvda-worker:src/x.ts"), prs: { [FIRST.repo]: [] }, failing: [SECOND.repo] });
  const prs = lookupOpenPrFiles({ run: fake.run, log: (line) => said.push(line), repos: BOTH });
  assert.equal(prs, null, "the first repository answering must not turn the second's failure into a quiet pass");
  assert.equal(said.length, 1);
  assert.match(said[0], /could not read a11ign\/nvda-worker's open pull requests .*INCONCLUSIVE, never "no overlap"/);
  const out: string[] = [];
  reportB4(2617, { write: (text) => out.push(text), mine: () => ["nvda-worker:src/x.ts"], others: () => prs });
  assert.match(out.join(""), /B4 COULD NOT BE ASKED/);
  assert.match(out.join(""), /INCONCLUSIVE, not clear/);
  assert.doesNotMatch(out.join(""), /no open pull request holds any file/, "the clear sentence must not print for a read that was never made");
});

test("#2617 POSITIVE CONTROL for the above: with the second repository answering, the same `check` prints the CLEAR sentence", () => {
  const fake = fakeGh({ region: regionBody("nvda-worker:src/x.ts"), prs: { [FIRST.repo]: [], [SECOND.repo]: [] } });
  const prs = lookupOpenPrFiles({ run: fake.run, log: () => {}, repos: BOTH });
  assert.deepEqual(prs, [], "both answered, both empty: an empty list is a real answer, distinct from null");
  assert.match(b4Lines(["nvda-worker:src/x.ts"], prs).join("\n"), /B4: no open pull request holds any file/);
});

test("#2617: a failure of the FIRST repository is INCONCLUSIVE too, and says which", () => {
  const said: string[] = [];
  const fake = fakeGh({ region: "", prs: {}, failing: [FIRST.repo] });
  assert.equal(lookupOpenPrFiles({ run: fake.run, log: (line) => said.push(line), repos: BOTH }), null);
  assert.match(said[0], /could not read a11ign\/a11ign's open pull requests/);
});

// --- the cost: how many `gh` calls a claim's reads spend per declared repository --------------------------------------------

test("#2617 done-when 5: B4's reads cost ONE `gh pr list` per declared code repository, and the rest of a claim's reads do not grow with it", () => {
  const spent = (repos: typeof BOTH) => {
    const fake = fakeGh({ region: regionBody("scripts/x.mjs"), prs: { [FIRST.repo]: [ghPr(1, ["scripts/y.mjs"])], [SECOND.repo]: [ghPr(2, ["src/y.ts"])] } });
    eligibility(fake, repos);
    return { total: fake.calls.length, prLists: fake.calls.filter((c) => c[0] === "pr" && c[1] === "list").length,
      rowReads: fake.calls.filter((c) => c[0] === "issue").length };
  };
  const one = spent([FIRST]);
  const two = spent(BOTH);
  assert.ok(one.total > 0 && one.prLists === 1, "control: the one-repository claim read its one repository");
  assert.equal(two.prLists, 2);
  assert.equal(two.total - one.total, 1, "the second repository adds exactly one call");
  assert.equal(two.rowReads, one.rowReads, "the row reads (held rows, `blockedBy`, Region) are the tracker's and do not grow");
  const region = fakeGh({ region: regionBody("scripts/x.mjs"), prs: {} });
  lookupMyRegionFiles(2617, { run: region.run, repo: FIRST.repo });
  assert.equal(region.calls.length, 1, "the Region read is one call whatever the repositories");
});

// --- 4. the same row number in two trackers -----------------------------------------------------------------------------------

test("#2617 done-when 3: the same row number in two trackers is two worktree names and two `session:` labels, and the first tracker's are today's", () => {
  const first = claimNames({ key: "", number: 7 });
  const other = claimNames({ key: "agent-org", number: 7 });
  assert.deepEqual(first, { worktree: "wt-7", session: "worker-7" }, "byte for byte the names the tool has always used");
  assert.deepEqual(other, { worktree: "wt-agent-org-7", session: "worker-agent-org-7" });
  assert.notEqual(first.worktree, other.worktree);
  assert.notEqual(`session:${first.session}`, `session:${other.session}`);
});

test("#2617: a claim in the first tracker is never refused for its names -- every claim written before this row is the same claim", () => {
  for (const mode of ["claim", "dispatch", "decline", "conflict"] as const) {
    assert.equal(trackerClaimRefusal({ mode, key: "", number: 7, session: "worker-7", worktree: "../wt-7" }, TWO_TRACKERS), null, mode);
  }
});

test("#2617: a claim in another tracker must NAME its worktree and session with the key -- and the correctly named one is written (agent-org#575), "
  + "and so are dispatch, decline and conflict (a11ign/a11ign#4737)", () => {
  const refusal = (session: string, worktree: string) =>
    trackerClaimRefusal({ mode: "claim", key: "agent-org", number: 7, session, worktree }, TWO_TRACKERS);
  assert.match(refusal("worker-agent-org-7", "../wt-7") ?? "", /names its worktree `wt-agent-org-7`, not `\.\.\/wt-7`/);
  assert.match(refusal("worker-7", "../wt-agent-org-7") ?? "", /`worker-7` is the name of the session that holds the FIRST tracker's row 7.*`worker-agent-org-7`/);
  assert.equal(refusal("worker-agent-org-7", "../wt-agent-org-7"), null, "correct names reach the write, and the write is built (agent-org#575)");
  assert.equal(trackerClaimRefusal({ mode: "decline", key: "agent-org", number: 7 }, TWO_TRACKERS), null, "so does a decline");
  for (const mode of ["dispatch", "conflict"] as const) {
    assert.equal(trackerClaimRefusal({ mode, key: "agent-org", number: 7, session: "worker-agent-org-7" }, TWO_TRACKERS), null,
      `${mode}: no "not built" refusal is left in a keyed tracker`);
    const wrong = trackerClaimRefusal({ mode, key: "agent-org", number: 7, session: "worker-7" }, TWO_TRACKERS) ?? "";
    assert.match(wrong, /`worker-7` is the name of the session that holds the FIRST tracker's row 7/, `${mode}: the names check stays`);
    assert.doesNotMatch(wrong, /not built/, mode);
  }
});

test("#2617: an undeclared tracker key is REFUSED listing what IS declared -- never read as the first tracker", () => {
  const found = trackerFor("nvda-worker", TWO_TRACKERS);
  assert.equal(found.ok, false);
  assert.match(found.ok ? "" : found.reason, /no tracker with key `nvda-worker` .*declared: the empty key, `agent-org`/);
  const known = trackerFor("agent-org", TWO_TRACKERS);
  assert.equal(known.ok && known.tracker.repo, "a11ign/agent-org", "control: a declared key resolves to ITS repository, not the first's");
  assert.match(trackerClaimRefusal({ mode: "claim", key: "nope", number: 7, session: "s" }, TWO_TRACKERS) ?? "", /no tracker with key `nope`/);
});

test("#2617: a row of another tracker is read from THAT tracker -- the same number is a different issue", () => {
  const fake = fakeGh({ region: regionBody("scripts/x.mjs"), prs: {} });
  sessionEligibilityReason(7, "worker-agent-org-7", { run: (_cmd: string, args: string[]) => fake.run(args), repo: "a11ign/agent-org", repos: [FIRST] });
  const rowReads = fake.calls.filter((c) => c[0] === "issue").map((c) => c[c.indexOf("--repo") + 1]);
  assert.ok(rowReads.length > 0);
  assert.deepEqual([...new Set(rowReads)], ["a11ign/agent-org"], "every row read went to the tracker the claim named");
});

// --- 5. the merge-blocking parser and pr-open accept `Closes owner/repo#N` ---------------------------------------------------

const ACCEPTANCE = "## Acceptance\n\n```bash\nnode -e \"process.exit(0)\"\n```\n";

test("#2617 done-when 2: the merge-blocking parser ACCEPTS `Closes a11ign/a11ign#7`, and the accepted form is one its own extractor returns", () => {
  const body = `${ACCEPTANCE}\nCloses a11ign/a11ign#7\n`;
  const declaration = extractClosesDeclaration(body);
  assert.deepEqual(declaration, { kind: "closes", numbers: [7], references: [{ repo: "a11ign/a11ign", number: 7 }] });
  assert.deepEqual(closesReferences(declaration as Parameters<typeof closesReferences>[0]), [{ repo: "a11ign/a11ign", number: 7 }]);
  assert.deepEqual(closesDeclarationReport(body), { ok: true, line: "CLOSES: a11ign/a11ign#7" });
});

test("#2617: a mix of bare and qualified rows is read, in order", () => {
  const declaration = extractClosesDeclaration("Closes #5, a11ign/a11ign#7 and a11ign/nvda-worker#9");
  assert.deepEqual(declaration.kind === "closes" && declaration.references, [
    { repo: null, number: 5 }, { repo: "a11ign/a11ign", number: 7 }, { repo: "a11ign/nvda-worker", number: 9 }]);
});

test("#2617 done-when 2: a MALFORMED cross-repository form is REFUSED, each one a different way to get it wrong", () => {
  for (const bad of ["Closes a11ign#7", "Closes a11ign/#7", "Closes /a11ign#7", "Closes a11ign/a11ign#", "Closes a/b/c#7",
    "Closes a11ign/a11ign #7", "Closes #7, a11ign#8"]) {
    const report = closesDeclarationReport(`${ACCEPTANCE}\n${bad}\n`);
    assert.equal(report.ok, false, bad);
    assert.match(report.line, /^CLOSES: MALFORMED/, bad);
  }
});

test("#2617: a body that names only bare rows is read EXACTLY as it always was -- no `references` key appears", () => {
  assert.deepEqual(extractClosesDeclaration("Closes #451, #452"), { kind: "closes", numbers: [451, 452] });
  assert.equal(closesDeclarationReport("Closes #451, #452").line, "CLOSES: #451, #452");
  assert.deepEqual(extractClosesDeclaration("Closes #7, and updates the docs"), { kind: "closes", numbers: [7] },
    "prose after a comma is not a malformed reference");
});

test("#2617 done-when 2: pr-open's own check ACCEPTS the body, and refuses the malformed one", () => {
  const accepted = checkBody(`${ACCEPTANCE}\nCloses a11ign/a11ign#7\n`, { run: () => 0 });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.lines.includes("CLOSES: a11ign/a11ign#7"));
  assert.equal(checkBody(`${ACCEPTANCE}\nCloses a11ign#7\n`, { run: () => 0 }).ok, false);
});

test("#2617 done-when 2: `pr-open` reads the Region of a qualified row from THAT repository, a bare row as before, and sends the PR", () => {
  const asked: [number, string | undefined][] = [];
  const rows: Record<number, string> = { 7: regionBody("nvda-worker:src/x.ts"), 5: regionBody("src/x.ts") };
  const sent: string[][] = [];
  const out: string[] = [];
  const code = main(["create", "--repo", SECOND.repo, "--body", `${ACCEPTANCE}\nCloses a11ign/a11ign#7\n`], {
    run: (args: string[]) => { sent.push(args); },
    git: (args: string[]) => (args[0] === "diff" ? "src/x.ts" : args.includes("--abbrev-ref") ? "agent/x" : "deadbeef"),
    prHead: () => ({ ref: "agent/x", oid: "deadbeef" }),
    runAcceptance: () => 0,
    rowBody: (number: number, repo?: string) => { asked.push([number, repo]); return rows[number]; },
    rootFiles: NO_ROOT_FILES,
    code: BOTH,
    owner: () => "ceo",
    out: (line: string) => { out.push(line); },
    err: () => {},
  });
  assert.equal(code, 0, out.join(""));
  assert.deepEqual(asked, [[7, "a11ign/a11ign"]], "the row was read from the repository the body named");
  assert.deepEqual(sent[0]?.slice(0, 2), ["pr", "create"], "the PR was sent");
  assert.match(out.join(""), /REGION: 1 changed path\(s\) against a11ign\/a11ign#7's Region .*1 inside/,
    "src/x.ts is inside `nvda-worker:src/x.ts` because THIS tree is nvda-worker (--repo)");
  const bare = checkRegion(`${ACCEPTANCE}\nCloses #5\n`, [], { git: () => "src/x.ts", code: BOTH, rowBody: (n: number, repo?: string) => { asked.push([n, repo]); return rows[n]; }, rootFiles: NO_ROOT_FILES });
  assert.deepEqual(asked.at(-1), [5, undefined], "a bare row is asked with the number alone, exactly as before");
  assert.equal(bare.refusal, null);
});

test("#2617: from the FIRST repository's tree, a Region entry prefixed for the second is not the changed file's -- the diff is outside", () => {
  const rows: Record<number, string> = { 7: regionBody("nvda-worker:src/x.ts") };
  const verdict = checkRegion(`${ACCEPTANCE}\nCloses a11ign/a11ign#7\n`, [], { git: () => "src/x.ts", code: BOTH, rowBody: (n: number) => rows[n], rootFiles: NO_ROOT_FILES });
  assert.match(verdict.refusal ?? "", /1 path\(s\) changed outside a11ign\/a11ign#7's Region/, "control for the acceptance above: the tree, not the row, decides");
});

test("#2617: a pull request of ANOTHER repository that says `Closes #7` closes ITS #7, not the tracker's row 7 -- and a qualified one does", () => {
  const tracker = "a11ign/a11ign";
  assert.deepEqual(declaredClosedRows("Closes #7", { prRepo: SECOND.repo, trackerRepo: tracker }), [],
    "a bare number is the pull request's own repository's issue");
  assert.deepEqual(declaredClosedRows("Closes a11ign/a11ign#7", { prRepo: SECOND.repo, trackerRepo: tracker }), [7]);
  assert.deepEqual(declaredClosedRows("Closes a11ign/other#7", { prRepo: SECOND.repo, trackerRepo: tracker }), [], "another repository's #7 is not the row");
  assert.deepEqual(declaredClosedRows("Closes #7", { prRepo: tracker, trackerRepo: tracker }), [7], "control: the first repository's bare number is the row");
  assert.deepEqual(declaredClosedRows("Closes #7"), [7], "and with no repositories named, the default is the first, as ever");
});

test("#2617: a layer pull request that declares it closes the ASKING row is that row's own work, and does not refuse it", () => {
  const body = "Closes a11ign/a11ign#2617";
  const fake = fakeGh({ region: regionBody("nvda-worker:src/x.ts"), prs: { [SECOND.repo]: [ghPr(4, ["src/x.ts"], body)] } });
  assert.equal(eligibility(fake, BOTH), null, "B4 excludes a row's own pull request across repositories, by declaration");
  const stranger = fakeGh({ region: regionBody("nvda-worker:src/x.ts"), prs: { [SECOND.repo]: [ghPr(4, ["src/x.ts"], "Closes #2617")] } });
  assert.match(eligibility(stranger, BOTH) ?? "", /overlaps #4 in a11ign\/nvda-worker/,
    "control: a bare `Closes #2617` in the layer repository is ITS #2617, so it is a stranger and still refuses");
});

// --- a11ign/a11ign#4737: a claim IN the second tracker reads that tracker's rows and pull requests, and its refusals name the repository ------------

const KEYED = { key: "agent-org", repo: "a11ign/agent-org" };

test("a11ign/a11ign#4737 item 4: a keyed row's `blockedBy` edge is read from the KEYED repository, and the refusal names it -- `a11ign/agent-org#12`, not a bare `#12`", () => {
  const reads: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    reads.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return args[args.indexOf("--json") + 1] === "blockedBy"
        ? JSON.stringify({ blockedBy: { nodes: [{ number: 12, state: "OPEN" }] } })
        : JSON.stringify({ body: regionBody("agent-org:src/row-claim.ts") });
    }
    return "[]";
  };
  const keyed = sessionEligibilityReason(575, "worker-agent-org-575", { run, repo: KEYED.repo, repos: [FIRST, KEYED] }) ?? "";
  assert.match(keyed, /^blocked by still-open a11ign\/agent-org#12:/, "the repository is named, so #12 is not read as the first tracker's row 12");
  assert.deepEqual([...new Set(reads.filter((a) => a[0] === "issue").map((a) => a[a.indexOf("--repo") + 1]))], [KEYED.repo], "and every row read was the keyed repository's");
  const first = sessionEligibilityReason(575, "worker-575", { run, repo: FIRST.repo, repos: [FIRST, KEYED] }) ?? "";
  assert.match(first, /^blocked by still-open #12:/, "CONTROL: the first tracker's refusal reads as it always did");
});

test("a11ign/a11ign#4737 item 4: B4 for a keyed row reads the KEYED repository's open pull requests and the refusal names that repository and pull request", () => {
  const fake = fakeGh({ region: regionBody("agent-org:src/row-claim.ts"), prs: { [KEYED.repo]: [ghPr(581, ["src/row-claim.ts"])] } });
  const reason = sessionEligibilityReason(575, "worker-agent-org-575",
    { run: (_cmd: string, args: string[]) => fake.run(args), repo: KEYED.repo, repos: [FIRST, KEYED] });
  assert.match(reason ?? "", /overlaps #581 in a11ign\/agent-org, which already touches: src\/row-claim\.ts\./);
  assert.ok(fake.calls.some((c) => c[0] === "pr" && c[c.indexOf("--repo") + 1] === KEYED.repo), "the keyed repository's pull requests were read");
  const same = fakeGh({ region: regionBody("agent-org:src/row-claim.ts"), prs: { [FIRST.repo]: [ghPr(581, ["src/row-claim.ts"])] } });
  assert.equal(sessionEligibilityReason(575, "worker-agent-org-575",
    { run: (_cmd: string, args: string[]) => same.run(args), repo: KEYED.repo, repos: [FIRST, KEYED] }), null,
  "CONTROL: the same path touched in the FIRST repository is not the keyed row's file");
});

test("a11ign/a11ign#4737 item 3: a keyed claim whose worktree path or branch exists is REFUSED before any write, naming what exists", () => {
  const calls: string[][] = [];
  const run = ((cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; }) as never;
  const claim = (() => { throw new Error("the claim must not run"); }) as never;
  const path = claimWithWorktree(575, "worker-agent-org-575", { branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575", run, claim,
    exists: (p: string) => p === "/clones/wt-agent-org-575", owner: () => "worker-agent-org-575", claimDeps: { tracker: { ...KEYED, board: { owner: "a11ign", number: 2 } } },
    clone: "/clones/agent-org", stamp: () => {} });
  assert.equal(path.claimed, false);
  assert.match((path as { reason: string }).reason, /--worktree=\/clones\/wt-agent-org-575 ALREADY EXISTS.*Refusing before any write/);
  assert.deepEqual(calls.filter(([cmd, ...rest]) => cmd === "gh" || rest.includes("worktree") && rest.includes("add") || rest.includes("fetch")), [],
    "no gh call, no fetch and no `worktree add` happened");
  assert.ok(calls.every(([cmd, ...rest]) => cmd !== "git" || (rest[0] === "-C" && rest[1] === "/clones/agent-org")), "every git read named the keyed clone");
});

test("a11ign/a11ign#4737: the three refusals that exist today still refuse in a keyed tracker, for their own reasons -- undeclared key, `wt-<n>` worktree, `worker-<n>` session", () => {
  const refusal = (key: string, session: string, worktree: string) => trackerClaimRefusal({ mode: "claim", key, number: 575, session, worktree }, TWO_TRACKERS) ?? "";
  assert.match(refusal("nope", "worker-nope-575", "../wt-nope-575"), /no tracker with key `nope`/);
  assert.match(refusal("agent-org", "worker-agent-org-575", "../wt-575"), /names its worktree `wt-agent-org-575`, not `\.\.\/wt-575`/);
  assert.match(refusal("agent-org", "worker-575", "../wt-agent-org-575"), /`worker-575` is the name of the session that holds the FIRST tracker's row 575/);
  assert.equal(refusal("agent-org", "worker-agent-org-575", "../wt-agent-org-575"), "", "control: the right names are not refused");
});
