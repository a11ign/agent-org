#!/usr/bin/env node
// @ts-check
// RULE: DOES THIS ROW'S BODY STATE ALL THREE REQUIRED TEMPLATE FIELDS? -- #707.
//
// `.github/ISSUE_TEMPLATE/backlog-row.yml` marks Region, Acceptance and Open-check `required` -- but that
// is a GitHub issue FORM, which applies only in the web UI. Every row in this repository is filed with
// `gh issue create --body`, which bypasses the form entirely: there is no field to leave blank, because
// there are no fields. Measured 2026-09-09: 39 of ~65 open rows carry no Open-check, sixteen of them
// filed the same day by the person who owns the template. The requirement was real and had no path to
// being met.
//
// CLAIMING, NOT FILING, is where this is asked -- `ceo`'s ruling. Filing stays `gh issue create` and
// always will; an Open-check exists so a session is not dispatched at a row already done, and that
// question matters at the moment a session is about to spend a day on it, not at the moment it was typed.
//
// A MISSING FIELD IS REFUSED BY NAME, never folded into one generic "template incomplete" message -- the
// same reason `owned-path-signoff.ts` (#603) names each unstated fact rather than saying "sign-off
// missing": a reader fixing the row needs to know WHICH of the three to add, not that something is wrong.
import { REPO } from "../project-identity.ts";
import { gh, lookup } from "../merge-guard/lookups.ts";
import { rows } from "../plugins/rows.ts";
import { declaredRegionFiles, hasTemplateField, regionCoversIn, splitRegionEntry } from "../region-paths.ts";
import { extractAcceptanceSection, runsTheWholeSuite } from "../acceptance-commands/suite-and-checkout-commands.ts";

/** The three fields the issue template requires, in the order they appear in the form. */
export const REQUIRED_FIELDS = ["Region", "Acceptance", "Open-check"];

/**
 * THE VERDICT, PURE -- every required field this body does NOT state a non-empty value for, in
 * `REQUIRED_FIELDS` order. `[]` means the row is complete.
 * @param {string} body
 * @returns {string[]}
 */
export function missingTemplateFields(body: string): string[] {
  return REQUIRED_FIELDS.filter((field) => !hasTemplateField(body, field));
}

/**
 * DOES THIS ROW'S ACCEPTANCE NAME A COMMAND THE ACCEPTANCE JOB CANNOT RUN? -- #879.
 *
 * `pr-open` already refuses `pnpm test` in a PR body, and it caught the only instance: *"needs `corpus`,
 * which this job does not have -- abstention-regression.test.ts requires corpus via compareAtFloor"*. The
 * job has no token and no corpus and runs commands taken from a body, so "the whole suite" is not
 * something it can run.
 *
 * **A row's acceptance is written before anybody knows which job will run it**, which is exactly why it
 * has to name the files the change is verified by rather than the command a developer would type. Asking
 * at FILING is the same question `pr-open` asks, at the moment the filer still has the context -- by PR
 * time it costs a rewrite of a section written hours earlier by someone who has moved on.
 *
 * ONE IMPLEMENTATION, NOT A SECOND COPY. `runsTheWholeSuite` and `extractAcceptanceSection` are imported
 * from `acceptance-commands.ts` unchanged, so the same command string gets the same answer here and at
 * PR time. A second parser is the shape that produced `#842`'s and `#71`'s findings on the same day.
 *
 * ONLY THE COMMAND-SHAPE HALF LIFTS, and that is a deliberate limit rather than an oversight.
 * `jobCapabilities(body)` and `unmetCommandRequirements` read a PR BODY and the capabilities a JOB
 * declares -- at filing time there is no PR and no job, so the requirement half stays where it works.
 * This answers only *"is this the whole suite"*, which is a pure function of the command string.
 *
 * AND IT FAILS BY MISSING, WHICH THE ROW SHOULD SAY OUT LOUD. `runsTheWholeSuite` is a positive test for
 * the four `package.json` script names that run a whole `.test.ts` suite -- `test`, `test:ts`, `test:org`
 * and `test:all` (#2153 added the last two, which had been reading as "not whole-suite" and so as
 * *nothing to check*, here as well as at PR time). A spelling that is not one of those -- a shell alias,
 * `pnpm run test --workspaces`, a Makefile target, `node --test` with the glob written out -- still reads
 * as "not whole-suite" and is then classified by whatever files it names, which for a command naming none
 * is *nothing to check*. Moving the check earlier moves that miss earlier too. It does not invent data the
 * way a denylist does; it stays silent. The honest remedy is a check on what a command RUNS rather than a
 * longer alternation, and that is still not this row -- #2153 tied the POPULATION to the script the
 * command names, which is the same fix one layer in, but the set of recognised spellings is still a list.
 *
 * @param {string} body @param {string} tool the CLI to name in the refusal
 * @returns {string | null}
 */
export function wholeSuiteAcceptanceReason(body: string, tool: string): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return null;
  const whole = section.commands.filter((command) => runsTheWholeSuite(command));
  if (whole.length === 0) return null;
  return `${tool}: REFUSING -- the Acceptance section names ${whole.map((c) => `\`${c}\``).join(", ")}, `
    + "and the job that runs a PR body's acceptance commands has no corpus, so the whole suite cannot "
    + "complete there. Name the test files this change is verified by instead. A row's acceptance is "
    + "written before anybody knows which job will run it, which is why it has to name files rather than "
    + "the command a developer would type -- and `pr-open` will refuse the same string later, when it "
    + "costs a rewrite by somebody with less context than you have now.";
}

/** The one config that carries agent-org's `node:test` shim: `package.json`'s `test` passes it, and no other file names it. */
const AGENT_ORG_RSTEST_CONFIG = "scripts/rstest/rstest.config.ts";
/** The repository key a Region entry carries for agent-org (`agent-org:src/x.ts`), and the last segment of its checkout's path. */
const AGENT_ORG_KEY = "agent-org";
/** `rstest run`, whichever launcher precedes it (`pnpm exec`, the package runner, a bare `rstest`). */
const RSTEST_RUN = /\brstest\s+run\b/g;
/** A `cd <dir>`, the dir bare or quoted; what a command's working directory is, for as far as a string can say. */
const CD_TARGET = /\bcd\s+("[^"]+"|'[^']+'|[^\s;&|'"]+)/g;
/** A config flag as rstest reads it, `--config x`, `--config=x` or `-c x`, in the part of one command line after `rstest run`. */
const CONFIG_FLAG = /(?:^|\s)(?:--config|-c)(?:[=\s]|$)/;

/**
 * IS THIS COMMAND RUN FROM AGENT-ORG'S CHECKOUT? `true`, `false`, or `null` for "the string does not say".
 * A `cd` before the `rstest run` decides, and only by the directory's own name: `~/repos/agent-org`, `/home/agent/repos/agent-org`
 * and `$HOME/repos/agent-org` are the same repository and `~/repos/lab` is not. A worktree (`cd ../wt-775`) names neither, so it is
 * `false`: the rule stays silent rather than guess, which is how every refusal in this file fails.
 * @param {string} command @param {number} at where `rstest run` starts in it
 */
function cdIsAgentOrg(command: string, at: number): boolean | null {
  const targets = [...command.slice(0, at).matchAll(CD_TARGET)];
  const last = targets.at(-1)?.[1];
  if (last === undefined) return null;
  const dir = last.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  return dir.split("/").at(-1) === AGENT_ORG_KEY;
}

/**
 * #775: DOES THE ROW'S OWN REGION PUT A COMMAND THAT HAS NO `cd` IN AGENT-ORG? The `agent-org:` key is the row saying so, and it is
 * read two ways: a test file the command names that an `agent-org:` entry covers, or a Region every entry of which is `agent-org:`.
 * A Region of both repositories whose command names no file is not read: either could be where it runs.
 * @param {string} command @param {string[]} region the Region's entries, keys kept
 */
function regionIsAgentOrg(command: string, region: string[]): boolean {
  const files = command.split(/[\s'"]+/).filter((token) => /\.test\.m?ts$/.test(token));
  if (files.some((file) => region.some((entry) => regionCoversIn(entry, AGENT_ORG_KEY, file)))) return true;
  return region.length > 0 && region.every((entry) => splitRegionEntry(entry).key === AGENT_ORG_KEY);
}

/**
 * A ROW WHOSE ACCEPTANCE RUNS `rstest run` AGAINST AGENT-ORG WITHOUT A CONFIG CAN NEVER PASS -- #775. The `node:test` shim lives only in
 * `scripts/rstest/rstest.config.ts` and a bare `rstest run <file>` prints "No test suites found" for every test file there. Three rows
 * carried it inside an hour (a11ign#4900, #4902, #4904); two workers hit it and reported it on the pull request, because the row text is
 * merge-blocking and its claim hash covers it, so the worker who finds the defect cannot correct it and the literal command stays
 * unrunnable. The sibling of `wholeSuiteAcceptanceReason`, asked at the same place and for the same reason: the filer still has the context.
 *
 * WHICH REPOSITORY IS READ FROM THE STRING, in this order: a `cd` before the `rstest run` (by the directory's name), otherwise the
 * Region's `agent-org:` key (see `regionIsAgentOrg`). `rstest run` in another repository's directory is that repository's, whose own
 * config this does not know. The test is "no config flag at all", not "not this file": a `--config` naming a file that is not there is
 * `acceptancePathsReason`'s refusal, and a second reader of the same token is the drift #1943 was.
 *
 * ROW-FILE ONLY. Nothing at claim reads it, so a row already open with this Acceptance is not shelved; `row-file --promote=` asks
 * `fileRefusalReason`, so a backlog row that carries it is refused its promotion, as it is for the whole suite.
 *
 * @param {string} body @param {string} tool the CLI to name in the refusal
 * @returns {string | null}
 */
export function bareRstestRunReason(body: string, tool: string): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return null;
  const region = declaredRegionFiles(body, { rootFiles: new Set() }) ?? [];
  const corrected: { command: string; fixed: string; }[] = [];
  for (const command of section.commands) {
    for (const run of command.matchAll(RSTEST_RUN)) {
      const at = run.index ?? 0;
      const rest = command.slice(at + run[0].length).split(/&&|\|\||[;|]/)[0];
      if (CONFIG_FLAG.test(rest)) continue;
      const inAgentOrg = cdIsAgentOrg(command, at) ?? regionIsAgentOrg(command, region);
      if (!inAgentOrg) continue;
      const fixed = `${command.slice(0, at + run[0].length)} --config ${AGENT_ORG_RSTEST_CONFIG}${command.slice(at + run[0].length)}`;
      corrected.push({ command, fixed });
      break;
    }
  }
  if (corrected.length === 0) return null;
  return `${tool}: REFUSING -- the Acceptance section runs \`rstest run\` against agent-org without \`--config ${AGENT_ORG_RSTEST_CONFIG}\`: `
    + corrected.map(({ command }) => `\`${command}\``).join(", ")
    + `. The \`node:test\` shim lives only in that config (\`package.json\`'s \`test\` passes it), so the bare form prints "No test suites found" `
    + "for every test file there and the row can never pass; a worker cannot amend a row under its own claim, so the literal command would "
    + "stay unrunnable. Write the corrected command instead: "
    + corrected.map(({ fixed }) => `\`${fixed}\``).join(", ")
    + ". (Nothing was filed.)";
}

/**
 * The refusal reason for `sessionEligibilityReason`, or `null` when the row is complete. Named fields,
 * not a count -- see this file's own header.
 * @param {string} body @param {number} issueNumber
 * @returns {string | null}
 */
export function templateFieldsReason(body: string, issueNumber: number): string | null {
  const missing = missingTemplateFields(body);
  if (missing.length === 0) return null;
  return `#${issueNumber} is missing ${missing.join(", ")} -- the issue template requires all three `
    + "(Region, Acceptance, Open-check) but the web form that enforces that does not apply to a row filed "
    + "with `gh issue create`. Add the missing section(s) as a `## <Field>` heading with real content "
    + "under it, then claim again.";
}

/**
 * This row's own body, read fresh -- `null` on a failed lookup OR a response with no `body` key at all.
 * The same CANNOT-ASK shape every other lookup in this rule set uses (`lookupMyRegionFiles`,
 * `lookupOwnPrHealth`), and the `"body" in parsed` check matters for a reason specific to this lookup: a
 * genuinely EMPTY body (`body: ""`) is a real, checkable fact -- every field is missing -- while a
 * response that never carried a `body` key at all (a shape `gh` did not return, or a caller's `run`
 * answering a DIFFERENT `--json` request the same way) is "asked the wrong question", not "asked and the
 * row has nothing". Collapsing the two via `parsed.body ?? ""` would read the second as the first and
 * refuse every claim.
 * #2617: `repo` is the TRACKER the row lives in, as the project's declaration names it (default the first).
 * #732: it asks `bodyAndLabelsOf` (`body,labels`), the SAME argv as `lookupMyRegionFiles`, so the claim's batched read serves both
 * from one `gh issue view`; the labels are ignored here, and an answer with no `body` still throws.
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string, repo?: string }} [deps]
 * @returns {string | null}
 */
export function lookupIssueBody(issueNumber: number, { run = gh, repo = REPO }: { run?: (args: string[]) => string; repo?: string; } = {}): string | null {
  return lookup(() => {
    const parsed = rows().bodyAndLabelsOf({ repo, number: issueNumber, run });
    if (!("body" in parsed)) throw new Error("response carried no body field");
    return parsed.body ?? "";
  });
}
