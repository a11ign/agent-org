// no-token: gh
//
// The `pr:open` tests at the end import `pr-open.ts` in a child process, whose `defaultGh` spawns `gh` -- a path none of them take: `checkBody` is handed
// the body and an injected `run`. Proved, not just declared: with `GH_TOKEN`/`GITHUB_TOKEN` unset and a fake `gh` first on `PATH` that logs and exits 97, the file
// passes and the log is never written (see the PR body).

/**
 * #4322: AN ACCEPTANCE THAT `cd`s INTO THE PROJECT'S OWN PRIMARY CHECKOUT WAS ACCEPTED AT FILING. CI has no such path (#4318's `acceptance`
 * job died three times on `cd: /home/agent/repos/a11y-witness: No such file or directory`) and on the host the line reads the PRIMARY
 * checkout, which carries the change only after the merge. 21 open rows had it.
 *
 * CONTROL FIRST: the population below is the three lines #4220 carries (its body, lines 25-27), plus the sibling rows that share them.
 * `refused` is derived from the check, and `POPULATION` is asserted non-empty and of the size the transcript gives, so an emptiness
 * assertion has its positive control in this file (guards-and-assertions.md).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptancePathsReason, cdIntoCheckout, primaryCheckoutCdReason } from "./acceptance-commands.ts";

const PRIMARY = "/home/agent/repos/a11y-witness";
const OTHER_REPO = "/home/agent/repos/agent-org";
const scratch = mkdtempSync(join(tmpdir(), "primary-cd-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A row body whose Acceptance is `lines`, each its own command. */
function rowBody(lines: string[], extra = ""): string {
  return `## Region\n\n\`\`\`\nscripts/x.mjs\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n\n${extra}## Open-check\n\nfalse today.\n`;
}

// The three lines of #4220's body (gh api repos/a11ign/a11ign/issues/4220 --jq .body | grep -n "cd /home/agent/repos/a11y-witness"),
// the third being the `bash -c '...'` spelling. Copied from the row's pasted transcript, not retyped from memory.
const FOUND_ON_4220 = [
  "cd /home/agent/repos/a11y-witness && node scripts/pnpm.mjs install --frozen-lockfile",
  "cd /home/agent/repos/a11y-witness && npx rstest run --config scripts/rstest/rstest.config.ts --include packages/nvda-speech/x.test.ts",
  "bash -c 'cd /home/agent/repos/a11y-witness && test \"$(grep -c releasablePaths.*packages/nvda-speech/ .agent-org/project.json)\" = 1'",
];

/** The fixture tracker: open rows, each `[number, body]`. */
const OPEN_ROWS: [number, string][] = [
  [4220, rowBody(FOUND_ON_4220)],
  [4219, rowBody([FOUND_ON_4220[0]])],
  [4259, rowBody([FOUND_ON_4220[1]])],
  [4261, rowBody([FOUND_ON_4220[2]])],
];

test("CONTROL (a): every open row of the fixture tracker is refused, and the population is the one the transcript gives", () => {
  assert.equal(OPEN_ROWS.length, 4, "the positive control: an empty population would pass the assertion below");
  assert.ok(OPEN_ROWS.length >= 3 && OPEN_ROWS[0][1].includes(FOUND_ON_4220[2]));
  const accepted = OPEN_ROWS.filter(([, body]) => primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY }) === null);
  assert.deepEqual(accepted.map(([number]) => number), [], "a row that cds into the primary checkout was accepted");
});

test("the refusal names the line, says CI has no such path, that the primary checkout lacks the change, and the remedy", () => {
  const reason = primaryCheckoutCdReason(OPEN_ROWS[0][1], "row-file", { primaryCheckout: PRIMARY }) ?? "";
  for (const line of FOUND_ON_4220) assert.ok(reason.includes(line), `does not name: ${line}`);
  assert.match(reason, /CI has no such path/);
  assert.match(reason, /carries the change only after the merge/);
  assert.match(reason, /Drop the `cd` and run the command from the repository root/);
});

test("both spellings are caught: bare `cd <path> &&`, and the same inside `bash -c '...'` (and a double-quoted one)", () => {
  assert.equal(cdIntoCheckout(FOUND_ON_4220[0], PRIMARY), PRIMARY);
  assert.equal(cdIntoCheckout(FOUND_ON_4220[2], PRIMARY), PRIMARY);
  assert.equal(cdIntoCheckout(`bash -c "cd ${PRIMARY}/ && ls"`, PRIMARY), PRIMARY);
  assert.equal(cdIntoCheckout(`cd '${PRIMARY}' && ls`, PRIMARY), PRIMARY);
  assert.equal(cdIntoCheckout(`true; cd ${PRIMARY}/packages/x && ls`, PRIMARY), `${PRIMARY}/packages/x`, "a subdirectory is the same checkout");
});

test("what is NOT the primary checkout is not caught: another repository, a sibling that shares the prefix, prose, a worktree", () => {
  assert.equal(cdIntoCheckout(`cd ${OTHER_REPO} && node --test x.test.ts`, PRIMARY), null);
  assert.equal(cdIntoCheckout(`cd ${PRIMARY}-extra && ls`, PRIMARY), null, "a prefix of the string is not a prefix of the path");
  assert.equal(cdIntoCheckout(`echo "cd ${PRIMARY} && ls"`, PRIMARY), null, "a cd inside an echo is prose");
  assert.equal(cdIntoCheckout("cd /home/agent/repos/wt-4322 && ls", PRIMARY), null);
  assert.equal(cdIntoCheckout("pnpm --prefix /home/agent/repos/a11y-witness test", PRIMARY), null, "--prefix is not claimed by this row");
});

test("CONTROL (b): a `cd` into a DIFFERENT repository's checkout with a `Hand-run:` line is accepted", () => {
  const body = rowBody([`cd ${OTHER_REPO} && node --import tsx --test src/x.test.ts`], "Hand-run: the host owner runs it in the tool's clone.\n\n");
  assert.equal(primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY }), null);
});

test("CONTROL (c): the same row without the declaration keeps today's verdict -- the check adds nothing for another repository", () => {
  const body = rowBody([`cd ${OTHER_REPO} && node --import tsx --test src/x.test.ts`]);
  assert.equal(primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY }), null);
  const deps = { exists: () => true, trackedDirs: ["src"], regionEntries: [] };
  assert.equal(acceptancePathsReason(body, "row-file", { ...deps, primaryCheckout: PRIMARY }),
    acceptancePathsReason(body, "row-file", { ...deps, primaryCheckout: null }));
});

test("a `Hand-run:` declaration keeps its meaning for the primary checkout too: a human runs it, so it is not refused", () => {
  const body = rowBody([FOUND_ON_4220[0]], "Hand-run: the host runs it in the primary checkout, by design.\n\n");
  assert.equal(primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY }), null);
});

test("`null` is `cannot tell` (no host declaration, as on CI): the check is skipped rather than passed as a refusal", () => {
  assert.equal(primaryCheckoutCdReason(OPEN_ROWS[0][1], "row-file", { primaryCheckout: null }), null);
});

test("the seam `row-file` already calls, `acceptancePathsReason`, carries the refusal, and a clean row is untouched by it", () => {
  const deps = { exists: () => true, trackedDirs: ["src"], regionEntries: [] };
  assert.match(acceptancePathsReason(OPEN_ROWS[0][1], "row-file", { ...deps, primaryCheckout: PRIMARY }) ?? "", /REFUSING -- the Acceptance `cd`s into this project's own primary checkout/);
  assert.equal(acceptancePathsReason(rowBody(["node --test src/x.test.ts"]), "row-file", { ...deps, primaryCheckout: PRIMARY }), null);
});

// DONE-WHEN 4 AND 5, in a child process: the checkout is READ FROM THE HOST'S DECLARATION (a project checked out elsewhere is protected
// the same way), and the host is read once per process, at import, so it cannot be varied in this one.
const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The smallest project declaration the tool's modules read at import: a project of nobody's, so nothing here is a11ign's. */
const DECLARATION = {
  schema: 1,
  roles: { dir: "roles" },
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/** Runs `script(checkout)` in a child whose host declares a primary project checked out at a fresh scratch directory. */
function underHost(script: (checkout: string) => string): { status: number | null; out: string } {
  const checkout = mkdtempSync(join(scratch, "checkout-"));
  mkdirSync(join(checkout, ".agent-org"));
  mkdirSync(join(checkout, "roles"));
  writeFileSync(join(checkout, "roles/sessions.json"), JSON.stringify({ live: [{ name: "ceo" }], retired: [] }));
  writeFileSync(join(checkout, ".agent-org/project.json"), JSON.stringify(DECLARATION));
  const hostFile = join(scratch, `host-${basename(checkout)}.json`);
  writeFileSync(hostFile, JSON.stringify({
    schema: 1, home: "/home/agent", binDir: "/home/agent/.local/bin", primary: "proj",
    projects: [{ id: "proj", checkout }], gh: { workers: "/home/agent/workers", leads: "/home/agent/leads", leadsHeader: [], leadsWorkspaces: [] },
  }));
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script(checkout)], {
    cwd: HERE, encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: hostFile },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("the path is read from the host's declaration: a project checked out ELSEWHERE is protected, and a11y-witness's path is then just a path", () => {
  const result = underHost((checkout) => `import { primaryCheckoutCdReason as r } from "./acceptance-commands.ts";
    const own = ${JSON.stringify(rowBody(["cd CHECKOUT && ls"]))}.replace("CHECKOUT", ${JSON.stringify(checkout)});
    const other = ${JSON.stringify(rowBody([FOUND_ON_4220[0]]))};
    console.log(JSON.stringify([r(own, "t") !== null, r(other, "t") !== null]));`);
  assert.equal(result.status, 0, result.out);
  assert.equal(result.out.trim().split("\n").pop(), "[true,false]");
});

// `pr-open`'s own `checkBody` is called here, in a child, with an injected `run` -- the entry point `pr:open` and the gate use, not the list under it, so
// a `checkBody` that stops reaching the `acceptance` report fails this test. The import is dynamic and in the child: `pr-open.ts`'s `defaultGh` spawns
// `gh`, a path nothing here takes (the `// no-token: gh` line at the top).
test("`pr-open`'s `checkBody` refuses an Acceptance that cds into the primary checkout before the command runs, naming the same remedy", () => {
  const result = underHost((checkout) => `import { checkBody } from "./pr-open.ts";
    let ran = 0;
    const body = "Acceptance: cd " + ${JSON.stringify(checkout)} + " && ls\\n\\nCloses: none -- test\\n";
    const verdict = checkBody(body, { run: () => { ran++; return 0; }, diff: { ok: false, why: "none" } });
    console.log(JSON.stringify({ ok: verdict.ok, ran, line: verdict.lines.join(" ") }));`);
  assert.equal(result.status, 0, result.out);
  const verdict = JSON.parse(result.out.trim().split("\n").pop() ?? "{}");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ran, 0, "the command was run for real before being refused");
  assert.match(verdict.line, /Drop the `cd` and run the command from the repository root/);
});

test("`pr-open`'s `checkBody` still lets a Hand-run-declared `cd` into the primary checkout through to the command", () => {
  const result = underHost((checkout) => `import { checkBody } from "./pr-open.ts";
    let ran = 0;
    const body = "Acceptance: cd " + ${JSON.stringify(checkout)} + " && ls\\n\\nHand-run: the host reads the primary checkout\\n\\nCloses: none -- test\\n";
    const verdict = checkBody(body, { run: () => { ran++; return 0; }, diff: { ok: false, why: "none" } });
    console.log(JSON.stringify({ ran, line: verdict.lines.join(" ") }));`);
  assert.equal(result.status, 0, result.out);
  assert.equal(JSON.parse(result.out.trim().split("\n").pop() ?? "{}").line.includes("Drop the `cd`"), false);
});
