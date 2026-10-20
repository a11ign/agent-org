// no-token: gh
//
// #775: A BARE `rstest run` AGAINST AN AGENT-ORG TEST IS REFUSED WHERE THE ROW IS FILED. The `node:test` shim lives only in
// `scripts/rstest/rstest.config.ts`, so `npx rstest run <file>` there prints "No test suites found" and the row can never pass; a11ign#4900,
// #4902 and #4904 carried it inside an hour, and a worker cannot amend a row under its own claim.
//
// CASES 1 AND 2 GO THROUGH `fileRefusalReason` (what `createIssue` calls), so a predicate that is right and not wired into `row-file` is red
// here (case 6 breaks if the call is removed); cases 3 to 5 ask the rule directly, being a pure function of the body.
//
// THE THREE SPELLINGS of an agent-org path are `cd ~/repos/agent-org`, `cd /home/agent/repos/agent-org` and the `agent-org:` Region prefix,
// and each has its control. NEGATIVES ARE ASKED THROUGH `bare` (the rule's own refusal), never `=== null`: `acceptancePathsReason` stats the checkout it runs
// in, and CI's is the project root with the tool at packages/agent-org, so a whole-result `null` is true on a workstation and false there (#778's first run).
// THE CONTROLS ARE THE REASON THE RULE CAN BE TRUSTED: case 1's refusals cannot be "every rstest run is refused"
// because cases 2 and 3 accept the same command with a config and in another repository; case 4 is `node --test`, the form the row's own
// Acceptance uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileRefusalReason } from "../row-file/issue-body-and-region-checks.ts";
import { promoteRefusalReason } from "../row-file/roadmap-and-milestone-checks.ts";
import { bareRstestRunReason } from "../row-claim/template-fields-rule.ts";

const CONFIG = "--config scripts/rstest/rstest.config.ts";
/** A test file of this tree. Every Region below declares it and the config, because `acceptancePathsReason` stats the checkout it runs in, and CI's is not this one's layout. */
const FILE = "src/packaging/row-file.test.ts";

const row = (region: string, acceptance: string) => `## Region\n\n\`\`\`\n${region}\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\n${acceptance}\n\`\`\`\n\n`
  + "## Open-check\n\n```\ngit grep -c \"bareRstest\" origin/main -- src | wc -l\n```\n";
const KEYED = `agent-org:src/row-claim/template-fields-rule.ts\nagent-org:${FILE}\nagent-org:scripts/rstest/rstest.config.ts`;
const BARE_REGION = `packages/lab/src/packaging/x.ts\npackages/lab/src/packaging/x.test.ts\n${FILE}\nscripts/rstest/rstest.config.ts`;

/** Is this the rule's own refusal? Asked of the whole `fileRefusalReason`, so a refusal of another rule is not mistaken for it, nor for its absence. */
const bare = (reason: string | null) => /runs `rstest run` against agent-org without/.test(String(reason));

const AGENT_ORG_COMMANDS = {
  "cd ~/repos/agent-org": [BARE_REGION, `cd ~/repos/agent-org && npx rstest run ${FILE}`],
  "cd /home/agent/repos/agent-org": [BARE_REGION, `cd /home/agent/repos/agent-org && npx rstest run ${FILE}`],
  "the agent-org: Region prefix": [KEYED, `npx rstest run ${FILE}`],
  "pnpm exec under the prefix": [KEYED, `pnpm exec rstest run ${FILE}`],
  "inside a bash -c": [BARE_REGION, `bash -c 'cd /home/agent/repos/agent-org && npx rstest run ${FILE}'`],
} as const;

test("0. CONTROL FOR THE MATCHER: another rule's refusal, and no refusal, are not read as this rule's, so cases 1 and 2 cannot pass on them", () => {
  assert.equal(bare(null), false);
  const wholeSuite = String(fileRefusalReason(row(KEYED, "pnpm test")));
  assert.match(wholeSuite, /REFUSING/, "the control body is refused, by the whole-suite rule");
  assert.equal(bare(wholeSuite), false);
  assert.equal(bare(bareRstestRunReason(row(KEYED, `npx rstest run ${FILE}`), "row-file")), true, "and the rule's own message is what it matches");
});

test("1. THE FAILING CASE: the bare form against an agent-org path is refused in each of the three spellings, with the corrected command", () => {
  for (const [spelling, [region, command]] of Object.entries(AGENT_ORG_COMMANDS)) {
    const reason = String(fileRefusalReason(row(region, command)));
    assert.ok(bare(reason), `${spelling}: ${reason}`);
    assert.ok(reason.includes(`--config scripts/rstest/rstest.config.ts`), `${spelling}: names the missing flag: ${reason}`);
    assert.ok(reason.includes(`rstest run ${CONFIG} ${FILE}`), `${spelling}: carries the corrected command: ${reason}`);
    assert.ok(reason.includes(`\`${command}\``), `${spelling}: quotes the command it refused: ${reason}`);
  }
  assert.match(String(promoteRefusalReason(row(KEYED, `npx rstest run ${FILE}`), 775)), /REFUSING[\s\S]*--config scripts\/rstest\/rstest\.config\.ts/,
    "a backlog row that carries it is refused its promotion, as it is for the whole suite");
});

test("2. NEGATIVE CONTROL: the same command with the config is accepted, in each spelling and in each way of passing the flag", () => {
  for (const [spelling, [region, command]] of Object.entries(AGENT_ORG_COMMANDS)) {
    const fixed = command.replace("rstest run", `rstest run ${CONFIG}`);
    assert.equal(bare(fileRefusalReason(row(region, fixed))), false, spelling);
  }
  for (const flag of [`--config=scripts/rstest/rstest.config.ts`, `-c scripts/rstest/rstest.config.ts`, `--config ./scripts/rstest/rstest.config.ts`]) {
    assert.equal(bare(fileRefusalReason(row(KEYED, `npx rstest run ${flag} ${FILE}`))), false, flag);
  }
  assert.equal(bare(fileRefusalReason(row(KEYED, `npx rstest run ${FILE} --config scripts/rstest/rstest.config.ts`))), false, "a flag after the file");
});

test("3. NEGATIVE CONTROL: `rstest run` in another repository, or a Region that is not agent-org's, is not refused", () => {
  const lab = "cd /home/agent/repos/lab && npx rstest run src/mjs-ratchet.test.ts";
  assert.equal(bareRstestRunReason(row(BARE_REGION, lab), "row-file"), null, "another repository's cd");
  assert.equal(bareRstestRunReason(row(KEYED, lab), "row-file"), null, "the cd decides even when the Region names agent-org");
  assert.equal(bareRstestRunReason(row(BARE_REGION, `npx rstest run ${FILE}`), "row-file"), null, "no cd and a bare Region: this repository's, not agent-org's");
  assert.equal(bareRstestRunReason(row(`lab:src/x.ts\nlab:${FILE}`, `npx rstest run ${FILE}`), "row-file"), null, "another repository's key");
  assert.equal(bareRstestRunReason(row(`agent-org:src/a.ts\n${BARE_REGION}`, `npx rstest run ${"packages/lab/src/packaging/x.test.ts"}`), "row-file"), null,
    "a mixed Region, the command naming a file the other repository's entry covers");
  assert.match(String(bareRstestRunReason(row(`agent-org:src/a.ts\nagent-org:${FILE}\n${BARE_REGION}`, `npx rstest run ${FILE}`), "row-file")), /REFUSING/,
    "and the same mixed Region refuses the command that names an agent-org file (the control for the line above)");
});

test("4. NEGATIVE CONTROL: `node --test` against agent-org is not refused, nor is a command that does not run rstest", () => {
  for (const command of [
    `cd /home/agent/repos/agent-org && node --import tsx --test ${FILE}`,
    `cd ~/repos/agent-org && node --test ${FILE}`,
    `bash -c 'cd /home/agent/repos/agent-org && node --import tsx --test ${FILE}'`,
    `pnpm exec tsx --test ${FILE}`,
    "cd ~/repos/agent-org && git grep -n rstest -- src | head",
  ]) {
    assert.equal(bareRstestRunReason(row(KEYED, command), "row-file"), null, command);
  }
});

test("5. a row with no Acceptance command is not this rule's to read, and a second command is read as well as the first", () => {
  assert.equal(bareRstestRunReason("## Region\n\nsrc/x.ts\n\n## Acceptance\n\nnone -- a decision, nothing to run\n", "row-file"), null);
  assert.equal(bareRstestRunReason("no sections at all", "row-file"), null);
  const reason = String(bareRstestRunReason(row(KEYED, `node --test ${FILE}\nnpx rstest run ${FILE}`), "row-file"));
  assert.match(reason, /REFUSING/);
  assert.ok(!reason.includes("`node --test"), "only the offending command is named");
});

test("6. THE RULE IS ASKED AT FILING ONLY: `row-file.ts` is the one place outside the rule's own file and tests that names it", () => {
  const SELF = "template-fields-rule.ts";
  const src = join(dirname(fileURLToPath(import.meta.url)), "..");
  const callers = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(?:ts|mjs)$/.test(name) && !/\.test\.(?:ts|mjs)$/.test(name) && !name.endsWith(SELF))
    .filter((name) => readFileSync(join(src, name), "utf8").includes("bareRstestRunReason"));
  assert.deepEqual(callers, ["row-file/issue-body-and-region-checks.ts"], "claim never reads it, so a row already open is not shelved");
});
