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
// same reason `owned-path-signoff.mjs` (#603) names each unstated fact rather than saying "sign-off
// missing": a reader fixing the row needs to know WHICH of the three to add, not that something is wrong.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { hasTemplateField } from "../region-paths.mjs";
import { extractAcceptanceSection, runsTheWholeSuite } from "../acceptance-commands.mjs";

/** The three fields the issue template requires, in the order they appear in the form. */
export const REQUIRED_FIELDS = ["Region", "Acceptance", "Open-check"];

/**
 * THE VERDICT, PURE -- every required field this body does NOT state a non-empty value for, in
 * `REQUIRED_FIELDS` order. `[]` means the row is complete.
 * @param {string} body
 * @returns {string[]}
 */
export function missingTemplateFields(body) {
  return REQUIRED_FIELDS.filter((field) => !hasTemplateField(body, field));
}

/**
 * DOES THIS ROW'S ACCEPTANCE NAME A COMMAND THE ACCEPTANCE JOB CANNOT RUN? -- #879.
 *
 * `pr-open` already refuses `npm test` in a PR body, and it caught the only instance: *"needs `corpus`,
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
 * from `acceptance-commands.mjs` unchanged, so the same command string gets the same answer here and at
 * PR time. A second parser is the shape that produced `#842`'s and `#71`'s findings on the same day.
 *
 * ONLY THE COMMAND-SHAPE HALF LIFTS, and that is a deliberate limit rather than an oversight.
 * `jobCapabilities(body)` and `unmetCommandRequirements` read a PR BODY and the capabilities a JOB
 * declares -- at filing time there is no PR and no job, so the requirement half stays where it works.
 * This answers only *"is this the whole suite"*, which is a pure function of the command string.
 *
 * AND IT FAILS BY MISSING, WHICH THE ROW SHOULD SAY OUT LOUD. `runsTheWholeSuite` is a positive test for
 * two spellings, `npm test` and `npm run test:ts`. A third spelling of the same thing -- a shell alias,
 * `npm run test --workspaces`, a Makefile target, `node --test` with the glob written out -- reads as
 * "not whole-suite" and is then classified by whatever files it names, which for a command naming none is
 * *nothing to check*. Moving the check earlier moves that miss earlier too. It does not invent data the
 * way a denylist does; it stays silent. The honest remedy is a check on what a command RUNS rather than a
 * longer alternation, and that is not this row.
 *
 * @param {string} body @param {string} tool the CLI to name in the refusal
 * @returns {string | null}
 */
export function wholeSuiteAcceptanceReason(body, tool) {
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

/**
 * The refusal reason for `sessionEligibilityReason`, or `null` when the row is complete. Named fields,
 * not a count -- see this file's own header.
 * @param {string} body @param {number} issueNumber
 * @returns {string | null}
 */
export function templateFieldsReason(body, issueNumber) {
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
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {string | null}
 */
export function lookupIssueBody(issueNumber, { run = gh } = {}) {
  return lookup(() => {
    const raw = run(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body"]);
    /** @type {{ body?: string }} */
    const parsed = JSON.parse(raw);
    if (!("body" in parsed)) throw new Error("response carried no body field");
    return parsed.body ?? "";
  });
}
