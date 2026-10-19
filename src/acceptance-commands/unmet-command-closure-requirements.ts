import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { changedFiles } from "../lib/changed-files.ts";
import { defectClassReport } from "../defect-class-line.ts";
import { resolveAcceptanceSource, sectionsTextOf, sourceLine, type AcceptanceSource } from "../acceptance-file.ts";
import { CLOSES_FIELD } from "../project-vocabulary.ts";
import { CORPUS_PATTERNS, FLEET_LAB_PATTERNS, FULL_CAPABILITIES, MUTATE_PATTERN, SHELL_BLOCK_KEYWORDS, UNVERIFIABLE_BUILTINS, commandExists, deriveClosureRequirements, firstRealToken, handRunDeclaration, handRunEvidence, hasFullHistoryDeclaration, isFile, jobCapabilities, needsToken, stripLeadingCd, testFileRequirements, tokenRefusal, type Classification, type ClosesDeclaration, type ClosesReference, type JobCapabilities, type Section, unmetClosureRequirements } from "./classification.ts";
import { commandTable, extractAcceptanceSection, extractSection, leadingCdTarget, namedTestFiles, operationalScriptEntries, primaryCheckoutCdReason, runAcceptanceCommand, runsTheWholeSuite, stripTrailingCommentary, testFilesRunBy, tsxAcceptanceReason, tsxTestFileArgs, type CommandTable, unmetCommandRequirements } from "./suite-and-checkout-commands.ts";

/**
 * The #621 counterpart to `unmetCommandRequirements` above -- CLOSURE-DERIVED rather than header-declared,
 * so it catches `board-style.test.ts` (no `// requires:` header at all) the same way it catches a file
 * that declared one honestly. Checked FIRST in `classifyCommand`, because a header that under-declares is
 * itself a refusal (#621's own framing): whatever the header says, the closure is what actually runs.
 *
 * #2724: `operationalScriptEntries` joins `testFilesRunBy` here, and ONLY here -- an operational script
 * carries no `// requires:` header for `unmetCommandRequirements` to read, so widening that one too would
 * add a population it can never say anything about.
 *
 *
 * @param [commands] the tool's command table, for an `agent-org <command>` script body
 */
export function unmetCommandClosureRequirements(command: string, capabilities: JobCapabilities, commands: CommandTable | null = commandTable()): { requirement: string; message: string; }[] {
  const out: { requirement: string; message: string; }[] = [];
  for (const fileArg of [...testFilesRunBy(command), ...operationalScriptEntries(command, commands)]) {
    if (/[*?[{]/.test(fileArg) || !isFile(fileArg)) continue;
    out.push(...unmetClosureRequirements(fileArg, capabilities));
    // SHORT-CIRCUIT ON THE FIRST, and only for the whole-suite case: `classifyCommand` prints one
    // refusal, and walking ~700 files' import closures to collect the other 699 is time spent producing
    // a message nobody reads. A named command still reports every one of the few files it names.
    if (out.length > 0 && runsTheWholeSuite(command)) break;
  }
  return out;
}

/**
 * Does ANY real test file named across `commands` (whatever its runner -- #2221) actually declare
 * `// requires: history`? #497's own stated boundary: "a PR carrying `History: full` and no historical fixture is asking for something it
 * does not use -- worth a warning, not a refusal, since the cost is only time." So this is checked
 * independent of `unmetCommandRequirements` (which asks whether a declared requirement is SATISFIED, not
 * whether the declaration exists at all) -- a file naming `requires: history` always counts as "used" here,
 * whether or not `capabilities.history` happens to be true.
 *
 * #621: ALSO true when the CLOSURE reaches `history` with no header at all -- a file whose `// requires:`
 * header omits `history` but whose real dependency needs it is exactly the shape this whole row exists
 * to stop reading as "unused." Checked via `deriveClosureRequirements` directly, not `capabilities`: this
 * question is "does the command use it," never "does the job have it."
 */
function anyCommandUsesHistory(commands: string[]): boolean {
  return commands.some((command) => {
    return namedTestFiles(command).some((fileArg) => {
      if (/[*?[{]/.test(fileArg) || !isFile(fileArg)) return false;
      if (testFileRequirements(readFileSync(fileArg, "utf8")).includes("history")) return true;
      return deriveClosureRequirements(fileArg).some((hit) => hit.requirement === "history");
    });
  });
}

/**
 * #446/#2178: WHY A LINE'S FIRST TOKEN CANNOT BE A CHECK, or null when it can -- split out of
 * `classifyCommand`, which had reached the complexity ceiling with the shell-keyword reason added.
 */
function proseFirstToken(token: string, exists: (token: string) => boolean): Classification | null {
  const bareToken = token.replace(/^['"]|['"]$/g, "");
  if (UNVERIFIABLE_BUILTINS.has(bareToken)) {
    return { verdict: "prose",
      reason: `cannot verify anything -- \`${bareToken}\`'s exit code says nothing about whether the `
        + "claim in this line is true" };
  }
  if (SHELL_BLOCK_KEYWORDS.has(bareToken)) {
    return { verdict: "prose",
      reason: `starts a shell block: \`${bareToken}\` is a shell keyword, not an executable, so this line is an `
        + "incomplete command on its own -- an Acceptance line is read one command at a time, and a block "
        + "spanning lines is not joined. Put it in a script, or in one `bash -c '...'` line" };
  }
  if (!exists(token)) {
    return { verdict: "prose", reason: `is not a command (no executable "${token}")` };
  }
  return null;
}

/**
 * Pure. Never executes anything -- just decides whether this command is this job's to run.
 *
 * #446: A THIRD VERDICT, "prose", for a line that was never a command at all -- either its first token
 * resolves to no executable anywhere (`"full suite green, 3306 pass 0 fail"` -> no `full`), or it resolves
 * to one of a small set of builtins whose exit code can never verify anything (`echo`, `true`, `:`, `test`,
 * `time`, `[`). Checked AFTER the existing fleet/lab/corpus refusals, deliberately: `pnpm run fleet:deploy`
 * has a perfectly real executable (`pnpm`) as its first token, and must still be REFUSED for the reason
 * already named there, not reclassified as prose for having a valid executable.
 *
 * `commandExists` IS INJECTABLE (`deps.commandExists`), defaulting to the real, subprocess-free `$PATH`
 * check above -- so a test can assert on a specific token resolving or not without depending on what
 * happens to be installed on whichever machine runs the suite.
 *
 * #510: `capabilities` defaults to `FULL_CAPABILITIES` -- every existing caller that never mentions the
 * new parameter keeps behaving exactly as before, because nothing is unmet against a job that can do
 * everything. `main()` passes the REAL job's capabilities; a test passes whatever it wants to exercise.
 *
 * #516: `section` IS OPTIONAL AND DEFAULTS TO `undefined` -- naming `mutate` is perfectly valid on an
 * `Acceptance:` line, where success-is-exit-0 already agrees with `mutate`'s own contract; the inversion
 * (see `MUTATE_PATTERN`'s own comment) exists only under `Refutation:`. Checked FIRST, alongside the
 * fleet/lab/corpus refusals and with the identical verdict (`"refused"`, `ok: true`) -- #516's own stated
 * acceptance is that this is the SAME mechanism, a new pattern in the seam that already refuses a command
 * this job cannot honestly interpret, not a new one. `UNNEGATED` only: `! pnpm run mutate ...` already
 * un-inverts the exit code at the shell level, so it is left alone -- refusing it too would be enforcing
 * an opinion about the rejected #386/#440 idiom rather than catching the actual collision.
 */
export function classifyCommand(command: string,
  { commandExists: exists = commandExists, capabilities = FULL_CAPABILITIES, section, commands }: {
      commandExists?: (token: string) => boolean; capabilities?: JobCapabilities;
      section?: "ACCEPTANCE" | "REFUTATION"; commands?: CommandTable | null;
  } = {}): Classification {
  if (section === "REFUTATION" && MUTATE_PATTERN.test(command) && !/^!\s/.test(command.trim())) {
    return { verdict: "refused",
      reason: "inverts the Refutation: verdict -- mutate's exit 0 means the guard BITES, but Refutation: "
        + "reads success as any NON-ZERO exit (#438), so a guard that did NOT bite (exit 1) would read as "
        + "REFUSED, the passing state. Paste mutate's real output under an unparsed heading instead "
        + "(#504), or move this line to Acceptance: if exit-0-is-good is genuinely what you mean" };
  }
  for (const [pattern, reason] of [...FLEET_LAB_PATTERNS, ...CORPUS_PATTERNS]) {
    if (pattern.test(command)) return { verdict: "refused", reason };
  }
  // #2099: THE FOURTH CAPABILITY, CHECKED THE WAY THE OTHER THREE ARE. A bare `gh ...` line classified
  // `runnable`, so the job RAN it and it died on the missing credential -- the job knows it has no token
  // and the classifier never asked. Beside the fleet/lab/corpus patterns because it is the same kind of
  // fact: a command this job cannot honestly attempt, refused by name rather than by exit code.
  //
  // GUARDED BY `capabilities.token`, for #510's reason: `FULL_CAPABILITIES` is the default, so every
  // caller that never mentions capabilities keeps classifying `gh` exactly as before.
  const noToken = tokenRefusal(command, capabilities, section);
  if (noToken) return noToken;
  // #621: CLOSURE-DERIVED, CHECKED FIRST -- whatever the header says. `board-style.test.ts` has no
  // `// requires:` header at all and is refused here regardless; a file that DOES declare one correctly
  // is refused here too, on the identical evidence, so declaring honestly never changes which branch a
  // command takes -- only whether the message happens to also match a hand-written comma list.
  const [firstUnmetClosure] = unmetCommandClosureRequirements(command, capabilities, commands);
  if (firstUnmetClosure) {
    return { verdict: "refused",
      reason: `needs \`${firstUnmetClosure.requirement}\`, which this job does not have -- `
        + firstUnmetClosure.message };
  }
  const [firstUnmet] = unmetCommandRequirements(command, capabilities);
  if (firstUnmet) {
    return { verdict: "refused",
      reason: `needs \`${firstUnmet.requirement}\`, which this job does not have -- declared by `
        + firstUnmet.files.join(", ") };
  }
  const token = firstRealToken(command);
  if (!token) {
    return { verdict: "prose", reason: "is not a command (the line is empty)" };
  }
  return proseFirstToken(token, exists) ?? { verdict: "runnable" };
}

/**
 * #728: the shell construct that makes a line's `tsx --test` arguments something other than this
 * command's argv, or null when there is none.
 *
 * NAMED RATHER THAN COUNTED, because the message has to be followable: "it contains a pipe" sends the
 * reader to the right character, where "cannot parse" sends them to re-read the whole line.
 *
 * Deliberately NOT a shell parser. This is the list of constructs that relocate the arguments, and
 * anything outside it is still tokenised as before -- a guard that refuses what it does not recognise
 * would refuse every ordinary command the moment someone added a new flag.
 */
function unparseableConstruct(command: string): string | null {
  const withoutTrailingComment = command.replace(/(?:^|\s)#.*$/, "");
  for (const [pattern, name] of ([
    [/\|\|/, "a `||`"],
    [/&&/, "an `&&`"],
    [/\|/, "a pipe"],
    [/\$\(|`/, "a subshell"],
    [/[<>]/, "a redirection"],
    [/;/, "a `;`"],
  ] as [RegExp, string][])) if (pattern.test(withoutTrailingComment)) return name;
  return null;
}

/**
 * DOES A `tsx --test` COMMAND'S FILE/GLOB ARGUMENT ACTUALLY MATCH ANYTHING? -- #353's fifth hazard, found
 * on #350 an hour before this shipped: `pnpm exec tsx --test "packages/lab/src/packaging/nothing-matches-*"`
 * exits 0 with NO diagnostic at all when the pattern matches nothing, and a typo'd path MIXED with one
 * real file exits 0 too -- so "the command exited 0" is not proof the tests it claims to run ever ran.
 * Checked BEFORE running, never inferred from the exit code, because the exit code is exactly the thing
 * this hazard makes unreliable.
 *
 * Scoped to `tsx --test` specifically (never generalised to "any command with a path-shaped argument"):
 * that is the concrete, measured defect, and treating every argument to every command as a file path
 * would produce false refusals on the many acceptance commands that take URLs, flags, or option values
 * that merely look like paths.
 *
 * #419: A TRAILING `# comment` IS NOT A FILE ARGUMENT. Bash itself already treats an unquoted `#` as
 * starting a comment, so `pnpm exec tsx --test foo.test.ts  # 2/2, pass` runs perfectly for real -- but this
 * check tokenised the whole line and read `#`, `2/2` and `pass` as file arguments nothing on disk could
 * ever match. Stripped for TOKEN EXTRACTION only, never from the command that actually runs: bash was
 * always going to ignore it, so removing it here only makes this check agree with what execution already
 * does.
 */
export function testFileArgumentsResolve(command: string): { ok: true; } | { ok: false; missing: string[]; } | { ok: false; unparseable: string; } {
  if (!/\btsx\s+--test\b/.test(command)) return { ok: true };
  // #728: WHAT THIS CANNOT PARSE, IT MUST NOT MAKE CLAIMS ABOUT.
  //
  // `tsxTestFileArgs` splits the WHOLE line on whitespace, so on
  // `node packages/guards/src/tree-wide-guards.mjs | xargs pnpm exec tsx --test` it reported
  // `matched no file: node, |, xargs` -- a claim about the filesystem, and a false one. `|` is not a
  // filename at all, and a reader following that message goes looking for missing test files.
  //
  // #419 closed the BACKTICK form of this and the pipe form was never considered. The refusal is right;
  // the assertion about what it checked is the defect -- the same class as `row-reachability` reporting
  // a Region-scoped search as a whole-tree one (#719).
  // #3596: ASKED OF THE STRIPPED LINE. #3026 declared a leading `cd <dir> &&` legitimate and `tsxTestFileArgs`
  // strips it, but this asked about the whole line, so the `&&` it had just allowed was the construct it
  // refused -- on every row written in the shape the engineer brief prescribes. A SECOND `&&` still is one.
  const construct = unparseableConstruct(stripLeadingCd(command));
  if (construct) return { ok: false, unparseable: construct };
  // The arguments are relative to the `cd` target, so they are looked up THERE: a file that exists only
  // relative to this process is not the file the command runs.
  const base = leadingCdTarget(command) ?? process.cwd();
  const missing = tsxTestFileArgs(command).filter((pattern) => {
    if (/[*?[{]/.test(pattern)) {
      try {
        return globSync(pattern, { cwd: base }).length === 0;
      } catch {
        return true;
      }
    }
    return !existsSync(resolve(base, pattern));
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * #438: A GUARD CAN ONLY BE SHOWN TO BITE BY A COMMAND WHOSE SUCCESS IS A NON-ZERO EXIT, and
 * `acceptanceReport` hardcoded `passed = code === 0` -- so a PR demonstrating a refusal (the guard
 * correctly refusing a known-bad input) was reported as this job's own failure for doing exactly what it
 * set out to prove. Optional, unlike `Acceptance:` -- most PRs never refuse anything, so its absence is
 * not a MISSING verdict, it just means there is nothing more to run.
 */
export function extractRefutationSection(body: string | null | undefined): Section {
  return extractSection("Refutation", body);
}

/**
 * #2307: the `Mutation:` section, read by the ONE section parser rather than a fourth copy of it -- this
 * file's header says to read it before adding a section reader. This job still never RUNS it (see the
 * SCOPED TO `Acceptance:` ONLY note above); the reader is for `pr-open.ts`, which runs it on the AUTHOR's
 * machine, where the objection to executing a mutation on a shared runner does not apply.
 */
export function extractMutationSection(body: string | null | undefined): Section {
  return extractSection("Mutation", body);
}

/**
 * Runs one command and produces its report line and pass/fail -- shared between `Acceptance:` (success is
 * exit 0) and `Refutation:` (success is any NON-zero exit, #438), so classification and the file-argument
 * check cannot drift between the two the way a second, independently-written parser would risk.
 */
function runOneCommand(command: string, run: (command: string) => number, { prefix, isPass, commandExists: exists, capabilities, handRun }: {
        prefix: "ACCEPTANCE" | "REFUTATION"; isPass: (code: number) => boolean;
        commandExists?: (token: string) => boolean; capabilities?: JobCapabilities;
        handRun?: string | null;
    }): { line: string; ok: boolean; executed: boolean; handRun?: boolean; } {
  // #658: truncate for CLASSIFICATION AND EXECUTION only. `command` itself is never reassigned, so every
  // reported line below still shows the ORIGINAL text an author wrote, even on the RAN branch (where
  // "executable" and "command" can now legitimately differ) -- seeing exactly what was written next to
  // what actually ran is what makes this line something a reader can act on, per #655's own rule.
  const executable = stripTrailingCommentary(command);
  const classification = classifyCommand(executable, { commandExists: exists, capabilities, section: prefix });
  // #2099: A DECLARED HAND-RUN IS ITS OWN LINE SHAPE -- not RAN, not REFUSED, not prose. `REFUSED` reads
  // as "not this job's to run and nobody's problem"; this line says a human owes a run and names who and
  // why, which is the whole content of the declaration. `branch-protection.test.ts`'s opt-in live read
  // already prints exactly this word for the identical situation (a check nothing here performed), so the
  // reader meets one vocabulary rather than two.
  //
  // ACCEPTANCE ONLY, and the boundary is what the declaration SAYS rather than a convenience
  // (reviewer-2's blocker on #2105). `handRunAcceptanceReason` reads `extractAcceptanceSection` alone, so
  // `Hand-run:` is a claim about the Acceptance commands and nothing else -- the filer was never asked
  // about the Refutation ones, and nobody promised to run them by hand. Honouring it under `Refutation:`
  // would let one line in the body convert an unrelated `gh` refutation into `NOT RUN ... declared
  // hand-run`, attributing to a human a run they never declared. `Refutation:` keeps its own verdict
  // semantics: a `gh` line there is REFUSED for `token`, exactly as before this row.
  const isRefusedHandRun = prefix === "ACCEPTANCE" && handRun && classification.verdict === "refused"
    && !capabilities?.token && needsToken(executable);
  if (isRefusedHandRun) {
    return { executed: false, handRun: true, ok: true,
      line: `${prefix}: NOT RUN ${command} -> declared hand-run: ${handRun}. This job has no credential `
        + "and did not attempt it; nothing here verified this command. Paste the run into the PR body "
        + "under a `## Hand-run output` heading -- #2118: a body that declares a hand-run and pastes "
        + "nothing is now REFUSED, because the declaration alone is a claim with no evidence behind it." };
  }
  if (classification.verdict === "refused") {
    // A WHOLE-SUITE COMMAND IS THE ONE REFUSAL THAT FAILS. Every other REFUSED is a legitimate "not this
    // job's to run": the author named a file, and this job cannot run that particular file. `pnpm test`
    // names nothing -- so a refusal of it means the PR has declared no acceptance this job can act on at
    // all, and reporting that as a pass is how "verified" comes to mean "unexamined" (ceo, 2026-09-09).
    // The message names the fix rather than the state, because a refusal a reader cannot follow is one
    // they route around.
    if (runsTheWholeSuite(executable)) {
      return { executed: false, line: `${prefix}: REFUSED ${command} -> ${classification.reason}\n`
        + "  Name the files this change is verified by. This job has no token and no corpus, and it runs "
        + "commands taken from a PR body, so it cannot run the whole suite -- a PR whose author cannot "
        + "name a file that verifies it has no acceptance.", ok: false };
    }
    return { executed: false, line: `${prefix}: REFUSED ${command} -> ${classification.reason}`, ok: true };
  }
  // #446: A THIRD, DISTINCT LINE SHAPE -- neither RAN nor REFUSED, so it cannot be mistaken for either.
  // Unlike REFUSED (`ok: true`, a legitimate "not this job's to run"), this IS a failure: the line made a
  // claim the PR body cannot support, and CLAUDE.md's own rule applies -- two different faults ("your
  // command failed" and "that line was never a command") must not print the same word, because they need
  // opposite fixes. Never run -- there is nothing honest a line that was never a command could report by
  // being executed anyway.
  if (classification.verdict === "prose") {
    return { executed: false, line: `${prefix}: "${command}" ${classification.reason}`, ok: false };
  }
  // CHECKED BEFORE RUNNING, never inferred from the exit code -- an unresolved test file/glob is
  // exactly the shape whose exit code cannot be trusted (#353's fifth hazard). Failing this here means
  // the real command never runs at all: there is nothing honest it could report.
  const fileCheck = testFileArgumentsResolve(executable);
  if (!fileCheck.ok) {
    // `executed: true`: the command was ATTEMPTED and answered. A glob matching nothing is a real
    // failure of this line, not a capability this job lacks -- the section examined something and found
    // it wanting, which is the opposite of examining nothing.
    // #728: AN UNPARSEABLE LINE IS `REFUSED`, NOT `RAN`. The command was never attempted, so saying
    // `RAN ... -> fail` is the same false confidence as the message this row replaced, one level up:
    // it reports a verdict about a command that did not execute. `ok: true` because the line may be
    // perfectly good -- this check cannot tell, and failing a PR for containing a pipe is a behaviour
    // this row did not ask for. The section still reports having executed nothing, which is the honest
    // answer and is what stops it reading as a pass.
    if ("unparseable" in fileCheck) {
      return { executed: false, ok: true,
        line: `${prefix}: REFUSED ${command} -> cannot check this line: it contains ${fileCheck.unparseable}, `
          + "so the arguments to `tsx --test` are not this command's argv" };
    }
    return { executed: true,
      line: `${prefix}: RAN ${command} -> fail (matched no file: ${fileCheck.missing.join(", ")})`, ok: false };
  }
  const code = run(executable);
  const passed = isPass(code);
  const verb = prefix === "ACCEPTANCE"
    ? (passed ? "pass" : "fail")
    // #438's own point: a Refutation: command that exits 0 is the FAILURE that matters -- the guard was
    // never shown to bite. "fail" here, not "pass", is what makes that absence loud instead of quiet.
    : (passed ? "refused" : "fail (did not refuse)");
  return { executed: true, line: `${prefix}: RAN ${command} -> ${verb} (exit ${code})`, ok: passed };
}

/**
 * #540: the report line for a DUPLICATE section -- every occurrence's line number and raw text, so an
 * author can find and consolidate them without re-reading the whole body to work out where "the" header
 * even is anymore. Shared between `Acceptance:` and `Refutation:` for the same reason `runOneCommand` is:
 * one wording, never two independently-drifting ones.
 */
function duplicateSectionLine(prefix: "ACCEPTANCE" | "REFUTATION", section: { occurrences: { line: number; text: string; }[]; }): string {
  const named = section.occurrences.map((o) => `line ${o.line}: "${o.text}"`).join(", ");
  return `${prefix}: DUPLICATE -- ${section.occurrences.length} sections found (${named}) -- consolidate `
    + "into one; this parser refuses to guess whether you meant to run every one of them (see this file's "
    + "own header comment for why #540 is not #527's remedy)";
}

/**
 * #2118: THE REFUSAL, AND IT SAYS WHAT IT CHECKED AND WHAT IT DID NOT -- in that order, because a reader
 * who takes only the first sentence must not come away believing more was verified than was.
 *
 * FOLLOWABLE (#1116): it names the exact heading to add, not merely the state it found. A refusal whose
 * remedy the author has to infer is one they route around -- and the route around this one is to delete
 * the `Hand-run:` line, which costs the row the declaration that made it honest.
 */
function missingHandRunOutputLine(prefix: "ACCEPTANCE" | "REFUTATION"): string {
  return `${prefix}: NO HAND-RUN OUTPUT -- every command above is a declared hand-run and this body `
    + "pastes no output, so the only thing asserting the run happened is the line declaring that it "
    + "should. Add a `## Hand-run output` heading (or a `**Hand-run output:**` line) and paste under it "
    + "what you ran and what it printed.\n"
    + "  WHAT THIS CHECKED: that such a section exists and is not empty -- that a human wrote something "
    + "there. WHAT IT DID NOT CHECK: whether that text is this command's output. Nothing in this job "
    + "holds the credential, so nothing here can re-run the command and compare; a human reads it.";
}

/**
 * Runs every command in a `{ kind: "commands" }` section and reports each line, folding failures into
 * `ok`. Split out of `acceptanceReport` purely to keep that function's complexity within this repo's
 * ESLint budget -- the Acceptance and Refutation branches were one algorithm with a different `isPass`,
 * duplicated as two loops.
 */
function runSectionCommands(commands: string[], run: (command: string) => number, options: {
        prefix: "ACCEPTANCE" | "REFUTATION"; isPass: (code: number) => boolean;
        commandExists?: (token: string) => boolean; capabilities?: JobCapabilities;
        handRun?: string | null; handRunEvidence?: string | null;
    }): { lines: string[]; ok: boolean; } {
  let ok = true;
  const lines = [];
  let ran = 0;
  let handRun = 0;
  for (const command of commands) {
    const result = runOneCommand(command, run, options);
    lines.push(result.line);
    if (result.executed) ran += 1;
    if (result.handRun) handRun += 1;
    if (!result.ok) ok = false;
  }
  // #2099: THE ONE CASE THE BRANCH BELOW WAS WRONG ABOUT, AND ONLY IT. That comment's stated assumption --
  // "an Acceptance section has no such case: every refusal there is a capability this job lacks" -- is
  // still true of `token`; what it missed is that a row CAN now say a human holds the credential and will
  // run it, which is a fourth thing a section can honestly report.
  //
  // EVERY COMMAND, never merely one. If a declared hand-run could silence this beside an undeclared
  // fleet refusal, the declaration becomes the line people add to turn a red check green -- the exact
  // failure `History: full` is kept a warning to avoid. A fleet refusal next to it keeps the section red,
  // as today.
  //
  // `ok` STAYS TRUE ONLY WHEN THE RUN IS PASTED -- #2118 closed the half #2099 left open. The trade this
  // comment used to describe was between a check that is green and loud and a row that is unmergeable
  // (#2084 is the live case), and it took the first: the line below says NOT RUN and says nothing was
  // verified, "the PR carries the pasted run, and a reviewer reads both". NOTHING REQUIRED THE PASTED RUN
  // TO EXIST. `Hand-run:` is the one positive claim on this path -- `Acceptance: none -- <reason>` says
  // nothing was run, while this says a human DID run something -- and it was the only one nothing checked.
  // The trade survives intact: a declared, EVIDENCED hand-run is still green and loud and still merges.
  const isAllHandRun = options.prefix === "ACCEPTANCE" && commands.length > 0 && ran === 0 && handRun === commands.length;
  if (isAllHandRun) {
    lines.push(`${options.prefix}: NOTHING RAN HERE -- every command above is a declared hand-run, so `
      + "this job verified NOTHING and is not claiming otherwise. The verdict is the output pasted into "
      + "the PR body by whoever holds the credential, read by a human; this line is not a pass.");
    if (options.handRunEvidence) return { lines, ok };
    lines.push(missingHandRunOutputLine(options.prefix));
    return { lines, ok: false };
  }
  // A SECTION THAT EXECUTED NOTHING IS NOT A SECTION THAT PASSED. This is `evidence:check`'s
  // examined-nothing shape (`2 compared: 2 same` on a 48-case sample) in the acceptance job: every
  // command REFUSED, no command RAN, and the job concluding success.
  //
  // MEASURED, 2026-09-09: 55 of the 145 PRs merged that day had an acceptance job that executed no
  // command, almost all of them `tsx --test packages/lab/src/packaging/<x>.test.ts` refused for `token`
  // -- the tracker and pipeline tooling, which is exactly the code everything else now relies on. Three
  // were found by the PM re-running the declared commands at the merge commit by hand; the shape is
  // generic to the closure walk, not to those three.
  //
  // A REFUSED LINE PASSES ONLY BESIDE A RAN LINE. Refusing one named file while another actually runs is
  // a legitimate partial answer; refusing every one of them is no answer at all.
  // ACCEPTANCE ONLY, and the boundary is #516's rather than a convenience. `Refutation:` is optional and
  // this repo's own rule tells authors to declare `pnpm run mutate` there, which the classifier refuses BY
  // DESIGN -- mutate's exit 0 means the guard BITES and `Refutation:` reads success as non-zero, so
  // running it would invert the verdict. Failing a section for executing nothing when the tree told the
  // author to write exactly that would refuse the body its own rule asks for. An Acceptance section has
  // no such case: every refusal there is a capability this job lacks.
  if (options.prefix === "ACCEPTANCE" && commands.length > 0 && ran === 0) {
    lines.push(`${options.prefix}: EXECUTED NOTHING -- every command above was refused, so this job `
      + "verified nothing and must not report success. Declare at least one command this job can "
      + "actually run: it has no token, no fleet and no corpus, and it runs commands taken from a PR "
      + "body. A refusal beside a command that RAN is a partial answer; a refusal beside no command at "
      + "all is the absence of one.");
    ok = false;
  }
  return { lines, ok };
}

/**
 * THE VERDICT, driven by an injectable `run` so every outcome (including a real exit code) is testable
 * without a subprocess. `run` returns the exit code; it is never asked to interpret one.
 *
 * `Acceptance:` is mandatory -- its absence is the MISSING verdict this whole job exists to catch.
 * `Refutation:` is optional (#438): most PRs demonstrate nothing refusing, so its absence just means
 * there is nothing more to run, never a failure in its own right. A DUPLICATE of either (#540) fails the
 * job exactly like MISSING does -- an ambiguous body is not one this parser should guess at.
 *
 *
 *
 * @param [deps] forwarded
 *   to `classifyCommand` (#446/#510) -- `commandExists` defaults to the real `$PATH` check; `capabilities`
 *   defaults to `jobCapabilities(body)`, so `main()` needs no changes at all to pick up the real job's
 *   environment, and a test overrides either to stay independent of what happens to be true of the machine
 *   or body the suite runs against.
 */
export function acceptanceReport(body: string | null | undefined, run: (command: string) => number, deps: { commandExists?: (token: string) => boolean; capabilities?: JobCapabilities; } = {}): { ok: boolean; lines: string[]; } {
  // #2099: `handRun` is read from the body and is NOT overridable by `deps` -- unlike `capabilities`,
  // which a test overrides to exercise a job it is not running in. The declaration is a fact the body
  // states about itself, and a caller that could pass one the body does not carry could report `NOT RUN`
  // for a row that never declared anything.
  // #2118: `handRunEvidence` is read the same way and for the sharper version of the same reason. It is
  // the one field here that decides whether a POSITIVE claim about work a human performed is believed, so
  // a caller able to supply it could report a run as evidenced by text that is in no body at all.
  const resolvedDeps = { capabilities: jobCapabilities(body), ...deps,
    handRun: handRunDeclaration(body), handRunEvidence: handRunEvidence(body) };
  const section = extractAcceptanceSection(body);
  if (section.kind === "missing") {
    return { ok: false, lines: ["ACCEPTANCE: MISSING"] };
  }
  if (section.kind === "duplicate") {
    return { ok: false, lines: [duplicateSectionLine("ACCEPTANCE", section)] };
  }

  let ok = true;
  const lines = [];
  if (section.kind === "none") {
    lines.push(`ACCEPTANCE: NONE -> ${section.reason}`);
  } else {
    const result = runSectionCommands(section.commands, run,
      { prefix: "ACCEPTANCE", isPass: (code) => code === 0, ...resolvedDeps });
    lines.push(...result.lines);
    if (!result.ok) ok = false;
  }

  const refutation = extractRefutationSection(body);
  if (refutation.kind === "duplicate") {
    lines.push(duplicateSectionLine("REFUTATION", refutation));
    ok = false;
  } else if (refutation.kind === "none") {
    lines.push(`REFUTATION: NONE -> ${refutation.reason}`);
  } else if (refutation.kind === "commands") {
    const result = runSectionCommands(refutation.commands, run,
      { prefix: "REFUTATION", isPass: (code) => code !== 0, ...resolvedDeps });
    lines.push(...result.lines);
    if (!result.ok) ok = false;
  }
  // refutation.kind === "missing" -> nothing to report; the section is optional.

  // #497's OWN STATED BOUNDARY: "a PR carrying `History: full` and no historical fixture is asking for
  // something it does not use -- worth a warning, not a refusal, since the cost is only time." So this
  // never touches `ok` -- the one thing it must not become is a flag people add to make a red check green,
  // and a warning that could fail the job would be exactly that in the other direction.
  if (hasFullHistoryDeclaration(body)) {
    const allCommands = [
      ...(section.kind === "commands" ? section.commands : []),
      ...(refutation.kind === "commands" ? refutation.commands : []),
    ];
    if (!anyCommandUsesHistory(allCommands)) {
      lines.push("WARNING: `History: full` is declared, but no named test file declares "
        + "`// requires: history` -- this checkout is being deepened for nothing this PR uses.");
    }
  }

  return { ok, lines };
}

/**
 * Runs a command for real, via a shell (these are arbitrary shell strings out of a PR body, potentially
 * carrying flags/pipes/quoting -- the same trust boundary `merge-guard.ts`'s `--ci-gate` and this
 * project's other CI-invoked scripts already accept, contained by `pull_request`'s read-only token and
 * fork checkout rather than by refusing shell syntax). #859: in the worktree, by `runAcceptanceCommand`.
 */
function runForReal(command: string): number {
  return runAcceptanceCommand(command);
}

// #471: A PR MUST DECLARE WHAT IT CLOSES, and an unrecognised body must not read as an honest opt-out.
// #468 -- the first merge armed under the PAT -- proved the pipeline works and produced this gap in the
// same run: `close-rows` correctly closed nothing, because the PR body declared nothing, and A0's own row
// stayed open while the work that closes it landed on main. The fix is the same shape #446 already built
// for `Acceptance:` -- "nobody wrote one" and "this deliberately has none" must read as different states --
// applied to the other half of the body.
//
// `Closes: none` with NO reason is MALFORMED, never folded into the opt-out -- the identical rule
// `extractSection`'s own `noneMatch` applies to `Acceptance:`, reused rather than re-derived.
//
// NEVER INFERS. Guessing the row from a branch name or a title would close the wrong issue the day the
// guess is wrong, and a wrongly-closed row is worse than an open one -- it leaves work that looks done.
// The declaration is the author's, in the body, or this reports MISSING/MALFORMED and the job fails.
const CLOSES_NONE_PATTERN = new RegExp(`\\b${CLOSES_FIELD}:\\s*none\\b([^\\n]*)`, "i");
// #2617 (child 3b of #69): A ROW CAN BE NAMED ACROSS REPOSITORIES -- `Closes owner/repo#7`, the form a layer repository's
// pull request uses for a row that lives in the project's tracker (ADR 0040, decision 2). Measured by RUNNING this parser on it
// before the change: `Closes owner/repo#7` read MALFORMED, because the list pattern wanted `#` straight after the word, so a
// layer PR could not have declared its row at all. The qualifier is `owner/name` exactly (the two halves `project-config.ts`
// accepts), and NOTHING ELSE is a qualifier: `owner#7`, `owner/#7`, `a/b/c#7` and `owner/repo#` are each still malformed.
const REPO_QUALIFIER = "[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+";
const CLOSES_REF = `(?:${REPO_QUALIFIER})?#\\d+`;
const CLOSES_LIST_PATTERN = new RegExp(`\\b${CLOSES_FIELD}:?\\s*(${CLOSES_REF}(?:\\s*(?:,|and)\\s*${CLOSES_REF})*)`, "i");
const CLOSES_REF_GLOBAL = new RegExp(`(?:(${REPO_QUALIFIER}))?#(\\d+)`, "g");
// What follows a list the pattern stopped at: a `,`/`and` and then something with a `#` in it that the pattern could not read is a
// reference that was TRIED and got wrong (`Closes #7, a11ign#8`). Reading the list up to it and dropping it would report a row
// fewer than the author named, silently; prose after a comma (`Closes #7, and updates the docs`) has no `#` and is left alone.
const CLOSES_UNREAD_TAIL = /^\s*(?:,|and)\s*([A-Za-z0-9_./-]*#\S*)/i;
// #527: GLOBAL, because an author writing `Closes #510` on one line and `Closes #497` on another -- a
// form GitHub itself accepts and closes both for -- is a SECOND, independent match of the same pattern,
// not a continuation of the first. `CLOSES_LIST_PATTERN` stays singular (`.exec()` reads naturally as
// "does this line have one"); this is the walk that must never stop after the first hit.
const CLOSES_LIST_PATTERN_GLOBAL = new RegExp(CLOSES_LIST_PATTERN.source, `${CLOSES_LIST_PATTERN.flags}g`);
const CLOSES_MENTIONED_PATTERN = new RegExp(`\\b${CLOSES_FIELD}\\b`, "i");

/**
 * Pure. Never infers a row from anything but the words the author wrote.
 *
 * Three shapes, and only three: `Closes #451` (also `Closes #451, #452`), `Closes: none — <reason>` (a
 * deliberate opt-out, reason required), and neither -- MISSING. A fourth shape exists and must not be
 * folded into any of those: the word "Closes" present but unparseable (prose with no number, or a number
 * that isn't digits) is MALFORMED, distinct from MISSING for the same reason `Acceptance:`'s own malformed
 * "none" is distinct from silence -- a check that cannot tell "wrote something wrong" from "wrote nothing"
 * cannot tell an author who tried from one who never noticed the field.
 */
export function extractClosesDeclaration(body: string | null | undefined): ClosesDeclaration {
  const text = body ?? "";
  const noneMatch = CLOSES_NONE_PATTERN.exec(text);
  if (noneMatch) {
    const reason = noneMatch[1].replace(/^[\s:—-]+/, "").trim();
    return reason.length > 0
      ? { kind: "none", reason }
      : { kind: "malformed", detail: "`Closes: none` names no reason" };
  }
  // #527: EVERY match, not the first. `.exec()` once made `Closes #510\nCloses #497` report only #510 --
  // both close for real (`close-rows-for-merged-pr.ts` reads GitHub's own `closingIssuesReferences`,
  // never this regex), so the gate was silently under-reporting a fact GitHub and this file both see.
  const listMatches = [...text.matchAll(CLOSES_LIST_PATTERN_GLOBAL)];
  if (listMatches.length > 0) {
    const unread = listMatches.map((match) => CLOSES_UNREAD_TAIL.exec(text.slice(match.index + match[0].length))?.[1]);
    const first = unread.find((token) => token !== undefined);
    if (first !== undefined) {
      return { kind: "malformed", detail: `\`${first}\` is not a row reference: write \`#<number>\` or \`owner/repo#<number>\`` };
    }
    const references = listMatches.flatMap((match) =>
      [...match[1].matchAll(CLOSES_REF_GLOBAL)].map((m) => ({ repo: m[1] ?? null, number: Number(m[2]) })));
    const numbers = references.map((reference) => reference.number);
    // A body that names only bare rows returns EXACTLY what it always did; `references` appears only when a repository was named.
    return references.some((reference) => reference.repo !== null) ? { kind: "closes", numbers, references } : { kind: "closes", numbers };
  }
  if (CLOSES_MENTIONED_PATTERN.test(text)) {
    return { kind: "malformed",
      detail: "mentions \"Closes\" but names no `#<number>` and no `none — <reason>` opt-out" };
  }
  return { kind: "missing" };
}

/**
 * THE VERDICT. `ok: false` on both MISSING and MALFORMED -- deliberately the same boolean, because both
 * mean this job cannot tell what the PR closes, and a job that fails on one but not the other invites an
 * author to reach for the vaguer of the two whenever the precise one is inconvenient.
 */
export function closesDeclarationReport(body: string | null | undefined): { ok: boolean; line: string; } {
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind === "missing") {
    return { ok: false,
      line: "CLOSES: MISSING -- no `Closes #N` or `Closes: none — <reason>` declaration" };
  }
  if (declaration.kind === "malformed") {
    return { ok: false, line: `CLOSES: MALFORMED -- ${declaration.detail}` };
  }
  if (declaration.kind === "none") {
    return { ok: true, line: `CLOSES: NONE -> ${declaration.reason}` };
  }
  const named = (declaration.references ?? []).map((reference) => `${reference.repo ?? ""}#${reference.number}`);
  return { ok: true, line: declaration.references ? `CLOSES: ${named.join(", ")}` : `CLOSES: #${declaration.numbers.join(", #")}` };
}

/**
 * #2617: every row a `closes` declaration names, WITH the repository each lives in -- `repo` null for a bare `#N`, which is the pull
 * request's OWN repository's. A declaration that never named a repository has no `references`, so they are built from `numbers`.
 */
export function closesReferences(declaration: { kind: "closes"; numbers: number[]; references?: ClosesReference[]; }): ClosesReference[] {
  return declaration.references ?? declaration.numbers.map((number) => ({ repo: null, number }));
}

// #2305: A PR THAT ADDS OR CHANGES A TEST MUST CARRY A `Mutation:` RECORD, or `Mutation: none -- <reason>`.
// `ceo`'s ruling, 2026-09-24: 11 of 46 first-review refusals over the 80 most recent merged PRs were "the
// test passes without testing its claim", each found by a reviewer running a mutant the author never ran.
// The template already had the line and NOTHING READ IT.
//
// AMENDED (a11ign/a11ign#3282, decided on #3213): A MISSING RECORD IS PRINTED, NOT FAILING. A check that the line EXISTS is
// paperwork, and it failed pull requests for it (8 of the 9 acceptance failures sampled on #928). The project now posts the
// survivors of a machine-chosen mutant set as a comment. The line is still printed, so the omission stays visible; a
// DUPLICATE header still fails, because that is a body this parser cannot read as one record.
//
// SHAPE, NOT EXECUTION. This job still never runs a `Mutation:` command (see the SCOPED TO `Acceptance:`
// ONLY note above; `pr:open` runs it on the author's machine and only WARNS, #2307). What it certifies is
// that the line EXISTS -- the cheap half. It cannot say a mutant ran, and must not be read as saying so.
//
// `Mutation: none -- <reason>` is the escape hatch; a reasonless `none` reads as MISSING, the same distinction as
// `Closes: none` and `Acceptance: none`: "nobody wrote one" and "deliberately none" stay different states.
// `extractSection` already reads a reasonless `none` as MISSING, so this needs no dialect of its own.
//
// THE DIFF IS READ FROM GIT, NOT FROM THE BODY. A body is the author's own claim about what changed.
const MUTATION_FILES_NAMED = 3;
const MERGE_PARENTS = 2;
const TEST_FILE_PATTERN = /(?:\.test\.(?:ts|tsx|mjs|cjs|js)|(?:^|\/)test_[^/]+\.py|_test\.py)$/;

/**
 * Pure. Which of these repo-relative paths are test files -- the ones a `Mutation:` record is owed for.
 */
export function testFilesAmong(paths: string[]): string[] {
  return paths.filter((path) => TEST_FILE_PATTERN.test(path));
}

/**
 * `added` is the subset the pull request ADDS (git's `A`, not `M` or `C`): the only files CI reads an Acceptance from (ADR 0044). A caller that
 * predates it leaves it off and reads the body, the fallback; an UNREADABLE diff is the `ok: false` arm, which says so.
 */
export type DiffReading = { ok: true, files: string[], added?: string[] } | { ok: false, why: string };

/**
 * THE VERDICT for `Mutation:`. Four outcomes, and a MISSING record is no longer one that fails (a11ign/a11ign#3282, decided
 * on #3213): no test in the diff (nothing owed), a record present, a record MISSING (PRINTED, NOT FAILING), a duplicate
 * header (fails: that is a malformed body, not an omission), and a diff this job COULD NOT READ -- UNCHECKED, loud, and
 * not a failure, because a job that goes red on a git hiccup blocks the queue for a reason no author can fix and trains
 * them to reach for the escape hatch.
 *
 * WHY MISSING STOPPED FAILING. It checked that a LINE EXISTED, never that a mutant ran, so it failed a pull request on
 * paperwork. The project's `mutation-comment.yml` now runs a machine-chosen mutant set on the lines the pull request
 * added and posts the survivors as a comment; the line stays, printed, so the omission is still visible to a reviewer.
 */
export function mutationRecordReport({ body, diff }: { body: string | null | undefined; diff: DiffReading; }): { ok: boolean; line: string; } {
  if (!diff.ok) {
    return { ok: true, line: `MUTATION: UNCHECKED -- could not read the diff (${diff.why}); `
      + "a PR that changes a test still owes a `Mutation:` record" };
  }
  const tests = testFilesAmong(diff.files);
  if (tests.length === 0) return { ok: true, line: "MUTATION: NOT REQUIRED -- no test file in the diff" };
  const section = extractMutationSection(body);
  if (section.kind === "none") return { ok: true, line: `MUTATION: NONE -> ${section.reason}` };
  // An inline `Mutation: <!-- what you broke -->` is the template's own placeholder, not a record.
  if (section.kind === "commands" && section.commands.some((line) => line.replace(/<!--.*?-->/g, "").trim())) {
    return { ok: true, line: `MUTATION: RECORDED (${tests.length} test file(s) in the diff)` };
  }
  if (section.kind === "duplicate") {
    return { ok: false, line: "MUTATION: DUPLICATE -- more than one `Mutation:` header; keep one" };
  }
  const named = tests.slice(0, MUTATION_FILES_NAMED);
  return { ok: true, line: `MUTATION: MISSING (printed, not failing) -- the diff changes ${tests.length} test file(s) (`
    + `${named.join(", ")}${tests.length > named.length ? ", ..." : ""}) and the body carries no `
    + "`Mutation:` record. Optional: write what you broke and that the test went red (`pnpm run mutate` makes it "
    + "cheap), or `Mutation: none -- <reason>`. CI posts the survivors of a machine-chosen mutant set as a comment" };
}

// #2308: A NUMBER IN A PR BODY SITS UNDER A `## Measured` SECTION, WITH ITS COMMAND AND THE OUTPUT IT PRINTED.
// Part c of `ceo`'s 2026-09-24 ruling on #2305: 7 of 46 first-review refusals were a count or population claim
// ("25 merged pull requests", "every package.json is 0.0.0") that was not true at the head under review.
//
// SCOPED TO A DECLARED SECTION, DELIBERATELY. A machine cannot find "the numbers" in prose, and a scan that
// guessed would refuse honest bodies and miss dishonest ones. So the author who cites a measured figure
// declares `## Measured`, and THIS reads what the declaration holds. The ABSENCE of the section is not a
// refusal -- it is the reviewer's cue that the body claims no measurement.
//
// THE HEADING FORM ONLY, and outside HTML comments. `extractLabeledSection` also accepts a bare
// `Measured:` line, and prose like "Measured: 25 PRs" is exactly the claim this exists to catch, not a
// declaration of the section -- while the template's own guidance comment names the heading and must
// not count as one.
//
// THE SHAPE is `row-file.ts`'s Open-check rule (`hasAdjacentTranscript`, #1174): a fenced block with a
// command line and, directly under it, a line it printed. That helper is copied rather than imported
// because `row-file.ts` drags the board and claim machinery into a job that must stay a plain parser.
// A copy can drift; the tests below pin the shapes this side accepts.
//
// WHAT THIS CANNOT DO, as #1174 says of its own: it cannot tell a pasted run from an invented adjacent
// pair. It removes the defect that happened -- a figure with no run beside it -- and certifies no more.
const MEASURED_HEADING = /^\s*#{1,6}\s*Measured\s*(?:[:\u2014\u2013-].*)?$/i;
const ANY_HEADING = /^\s*#{1,6}\s+\S/;
const FENCE_LINE = /^\s*```/;
const PROMPTED_COMMAND = /^\s*\$\s+\S/;
const UNPROMPTED_COMMAND = /^\s*(?:pnpm|npx|npm|node|git|gh|grep|rg|sed|awk|cat|ls|find|python3?|bash|sh|wc)\b/;

function looksLikeCommand(line: string | undefined): boolean {
  return line !== undefined && (PROMPTED_COMMAND.test(line) || UNPROMPTED_COMMAND.test(line));
}

/**
 * The body of every `## Measured` heading, each up to the next heading OUTSIDE a fence -- a `# comment`
 * line inside a fenced block is shell text, not a heading.
 */
function measuredSections(body: string): string[][] {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r\n|\r|\n/);
  const sections: string[][] = [];
  let current: string[] | null = null;
  let inFence = false;
  for (const line of lines) {
    if (!inFence && MEASURED_HEADING.test(line)) { current = []; sections.push(current); continue; }
    if (!inFence && ANY_HEADING.test(line)) { current = null; continue; }
    if (FENCE_LINE.test(line)) inFence = !inFence;
    current?.push(line);
  }
  return sections;
}

/**
 * Does one of the section's fenced blocks hold a command with something it printed directly beneath?
 */
function hasCommandWithOutput(section: string[]): boolean {
  for (const fence of section.join("\n").match(/```[\s\S]*?```/g) ?? []) {
    const lines = fence.split("\n").slice(1, -1).filter((line) => line.trim() !== "");
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (looksLikeCommand(lines[i]) && !looksLikeCommand(lines[i + 1])) return true;
    }
  }
  return false;
}

/**
 * THE VERDICT for `## Measured`: absent (nothing claimed), present with a command and its output beneath
 * (passes), present without one, or declared twice (both fail, as a duplicate `Mutation:` does).
 */
export function measuredSectionReport(body: string | null | undefined): { ok: boolean; line: string; } {
  const sections = measuredSections(body ?? "");
  if (sections.length === 0) {
    return { ok: true, line: "MEASURED: NOT DECLARED -- the body claims no measurement" };
  }
  if (sections.length > 1) {
    return { ok: false, line: "MEASURED: DUPLICATE -- more than one `## Measured` section; keep one" };
  }
  if (hasCommandWithOutput(sections[0])) return { ok: true, line: "MEASURED: RECORDED" };
  return { ok: false, line: "MEASURED: MALFORMED -- a `## Measured` section holds no fenced block with a "
    + "command and, on the line directly under it, what it printed. Paste the run at the head being "
    + "opened (command, then its output, in one fence), or delete the section if the body claims no measurement" };
}

/**
 * The files THIS pull request adds or changes, read from the merge commit `actions/checkout` builds for a
 * `pull_request` event: its first parent is the base, so `HEAD^1..HEAD` is the PR's own diff and not
 * whatever the base did since. The checkout is depth 1, so the parent is fetched when it is missing. A HEAD that is not
 * a merge commit would show only its LAST commit and under-read the PR, so it is UNREADABLE, not guessed at.
 * Deleted files are excluded: there is no test left to owe a mutant.
 */
export function changedFilesOfThisPullRequest(cwd: string = process.cwd()): DiffReading {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
  try {
    const parentCount = () => git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/).length - 1;
    // A depth-1 checkout has cut HEAD's parents off; ask for one more level only when they are missing, so
    // a complete clone (`History: full`, a local run) never spends a fetch it does not need.
    if (parentCount() < MERGE_PARENTS) git("fetch", "--deepen=1", "origin");
    // agent-org#1524: a merge commit that has lost its parents is a SUPERSEDED one that GitHub's merge ref still names; a rerun checks it out again, so the reader says what to do.
    if (parentCount() < MERGE_PARENTS) return { ok: false, why: "the merge commit this run checked out is not a parent-bearing merge: re-push or update the branch; a rerun reuses it" };
    // Through the one reader of "which paths changed" (#939): with renames detected a moved test file
    // lists only where it WENT. `--no-renames` reads a move as delete + add, and the add is what ACMR keeps.
    const files = changedFiles(["--diff-filter=ACMR", "HEAD^1", "HEAD"], { repoRoot: cwd });
    return { ok: true, files, added: changedFiles(["--diff-filter=A", "HEAD^1", "HEAD"], { repoRoot: cwd }) };
  } catch (error) {
    return { ok: false, why: `git said: ${(error as Error).message.split("\n")[0]}` };
  }
}

/**
 * Does this command re-run a suite that `ci.yml`'s `ts` job is already running?
 *
 * NOT `runsTheWholeSuite`, AND THE DIFFERENCE IS THE POINT -- the first version of this reused it and
 * silently missed the case it was written for. That predicate asks "what population does this command
 * execute", to decide which CAPABILITIES it needs, and its own comment explains why it deliberately
 * excludes `test:python`: a pytest tree is not the `.test.ts` glob its callers walk. This asks a
 * different question -- "is this work `ts` has already done" -- and `test:org` and `test:all` answer yes
 * to it while answering no to the other. Two questions, two predicates; widening the capability one to
 * serve this would break the gate it exists for.
 */
function duplicatesTheTsJob(command: string) {
  return /(?:^|&&|\|\||;)\s*p?npm\s+(?:run\s+)?(?:test|test:ts|test:org|test:all)(?![:\w-])/
    .test(command.trim());
}

/**
 * A NOTE, NEVER A REFUSAL, when a PR's Acceptance re-runs what `ts` is already running.
 *
 * `ci.yml`'s `ts` job runs every test the diff reaches, IN PARALLEL WITH THIS JOB, on the same tree. So a
 * suite-wide command here runs tests that are already running. Measured 2026-09-19 over four runs: `ts`
 * 154-176 s beside `acceptance` 186-193 s for one change -- roughly half the wall clock of landing
 * anything, and it was the chairman's own habit in every PR written that day.
 *
 * IT IS A NOTE AND NOT A REFUSAL ON PURPOSE. A suite-wide command is genuinely right for a runner
 * upgrade, a dependency bump, or a config change with no single owner, and nothing here can tell those
 * from a habit. Guessing at intent is the defect this file warns about elsewhere, so it states the cost
 * and leaves the judgment with the author -- the way `no-magic-numbers` is a warning in this repo rather
 * than an error.
 *
 * @param commands the Acceptance commands as declared
 * @returns zero or one note line
 */
export function wholeSuiteNote(commands: string[]): string[] {
  const offenders = commands.filter((command) => duplicatesTheTsJob(command));
  if (offenders.length === 0) return [];
  return [`NOTE: Acceptance re-runs a suite ci.yml's \`ts\` job is already running in parallel on this `
    + `same tree (${offenders.join("; ")}) -- about 190s paid twice. Name what proves THIS row instead, `
    + "unless the row's claim really is \"the whole suite still passes\" (a runner or dependency "
    + "change), in which case say so on the row."];
}

/**
 * `rowLabels` is the caller's reader of a row's labels (#4123); it throws when the read is refused and is absent where the caller cannot ask, which `defect-class-line.ts` prints as NOT CHECKED
 */
export type BodyReportInput = { body: string, run: (command: string) => number, diff: DiffReading, rowLabels?: (row: { repo: string | null, number: number }) => string[],
  /** ADR 0044: where the `Acceptance:` family is read from. Absent, it is resolved from `diff.added` and `readFile`, so no caller has to. */
  acceptance?: AcceptanceSource, readFile?: (path: string) => string,
  /** The pull request's author (`PR_AUTHOR`), handed to the acceptance reader and used for nothing yet (agent-org#666). Absent when unknown, never `""`. */
  author?: string,
  /** The reader `acceptanceSourceOf` calls. A seam, so a test can see WHAT it was handed (the reader ignores `author`, so no verdict shows it). */
  resolveSource?: typeof resolveAcceptanceSource };
export type BodyReport = { name: string, report: (input: BodyReportInput) => { ok: boolean, lines: string[] } };

/**
 * #3209: THE REPORTS CI'S ACCEPTANCE JOB RUNS OVER A PR BODY, AS ONE LIST. `main` below and `pr-open.ts`'s
 * `checkBody` both iterate THIS value, so a fifth body check reaches `pr:open` and `pr:edit` with no second edit.
 * It was two spellings of one list: the CLI entry grew a `Mutation:` and a `## Measured` report and `checkBody`
 * kept its copy of two, so a body passed `pr:open` and went red in CI on `MUTATION: MISSING` -- 8 of the 9
 * acceptance failures sampled on #928, paperwork knowable before the pull request existed.
 *
 * ORDER IS THE ORDER CI PRINTS THEM IN, and `acceptance` is first because it is the one that RUNS something.
 * Not frozen, so a test can add an entry and watch `checkBody` run it; nothing in the tree appends to it.
 */
export const CI_BODY_REPORTS: BodyReport[] = [
  { name: "acceptance", report: (input) => {
    const source = acceptanceSourceOf(input);
    const named = sourceLine(source);
    const text = sectionsTextOf(source);
    // Two files are refused as two `Acceptance:` headers in one body are, and nothing is run from either.
    if (text === null) return { ok: false, lines: [`ACCEPTANCE: DUPLICATE -- ${named}; a pull request adds ONE acceptance file`] };
    // #4322: BEFORE the command runs, because running it is the harm on the host -- it would read the primary checkout.
    const primary = primaryCheckoutCdReason(text, "ACCEPTANCE");
    if (primary) return { ok: false, lines: [named, primary] };
    // agent-org#870: for the same reason -- `pr:open` and CI run the line, and it cannot load `tsx`.
    const tsx = tsxAcceptanceReason(text, "ACCEPTANCE");
    if (tsx) return { ok: false, lines: [named, tsx] };
    const report = acceptanceReport(text, input.run);
    const declared = extractAcceptanceSection(text);
    const notes = declared.kind === "commands" ? wholeSuiteNote(declared.commands) : [];
    return { ok: report.ok, lines: [named, ...report.lines, ...notes] };
  } },
  { name: "closes", report: ({ body }) => oneLine(closesDeclarationReport(body)) },
  { name: "class", report: ({ body, rowLabels }) => oneLine(defectClassReport({ body, rows: closedRowsOf(body), rowLabels })) },
  { name: "mutation", report: (input) => oneLine(mutationRecordReport({ body: sectionsTextOf(acceptanceSourceOf(input)) ?? input.body, diff: input.diff })) },
  { name: "measured", report: ({ body }) => oneLine(measuredSectionReport(body)) },
];

/**
 * ADR 0044: THE SOURCE THE `Acceptance:` FAMILY IS READ FROM, resolved once per input. The file the pull request ADDS under `.acceptance/` when
 * it adds one, else the body. A caller that resolved it already (`checkBody` does, to leak-check the file's text) hands it in.
 */
export function acceptanceSourceOf({ body, diff, acceptance, readFile = (path) => readFileSync(path, "utf8"), author, resolveSource = resolveAcceptanceSource }: BodyReportInput): AcceptanceSource {
  if (acceptance !== undefined) return acceptance;
  return resolveSource({ body, added: diff.ok ? (diff.added ?? []) : undefined, read: readFile, author });
}

/**
 * The same, for a caller that holds only the body: the public entry for the workflow's own reads of the sections (`hasFullHistoryDeclaration`),
 * which must come from the same text the commands do. Reads the checkout at `cwd`.
 */
export function acceptanceSourceOfThisPullRequest(body: string, cwd: string = process.cwd(), author?: string, extra: Partial<BodyReportInput> = {}): AcceptanceSource {
  return acceptanceSourceOf(thisPullRequestInput(body, cwd, author, extra));
}

/**
 * The input a report run over THIS pull request is handed: its diff and files read from the checkout at `cwd`, `extra` laid over it. Apart from
 * `acceptanceSourceOfThisPullRequest` and `ciInputOf`, which both lay `extra` over it, so a test can see the `author` each hands the reader.
 */
export function thisPullRequestInput(body: string, cwd: string, author?: string, extra: Partial<BodyReportInput> = {}): BodyReportInput {
  return { body, run: () => 0, diff: changedFilesOfThisPullRequest(cwd), readFile: (path) => readFileSync(join(cwd, path), "utf8"), author, ...extra };
}

/**
 * What the CLI entry hands the reports: the body from `PR_BODY` and the author from `PR_AUTHOR` (`prAuthorFromEnv`), the rest from `env` and the
 * checkout at `cwd`. `main` is this and a print, so a test reads the whole wiring without spawning it.
 */
export function ciInputOf(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): BodyReportInput {
  return thisPullRequestInput(env.PR_BODY ?? "", cwd, prAuthorFromEnv(env), { run: runForReal, rowLabels: rowLabelsFromEnv(env) });
}

/**
 * agent-org#666: THE PULL REQUEST'S AUTHOR, FROM `PR_AUTHOR` ALONE. One opaque string from the environment, never argv (as `PR_BODY` is not) and
 * never read from the body, a label or a branch name, which the author controls. Unset or empty is `undefined`, so "no author given" and "an
 * author" are never one value.
 */
export function prAuthorFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.PR_AUTHOR ? env.PR_AUTHOR : undefined;
}

/**
 * #4123: the rows the body's `Closes` names, none for `Closes: none`, missing or malformed (the `closes` report refuses those itself).
 */
function closedRowsOf(body: string): { repo: string | null; number: number; }[] {
  const declaration = extractClosesDeclaration(body);
  return declaration.kind === "closes" ? closesReferences(declaration) : [];
}

/**
 * #4123: THE LABELS CI'S ACCEPTANCE STEP IS GIVEN, NOT ONES IT FETCHES. That step runs the author's own command and is tracker-less on purpose
 * (`reusable-acceptance.yml`: no `GH_TOKEN`), so it cannot ask GitHub. A step BEFORE it, which runs no author code, may write
 * `ACCEPTANCE_ROW_LABELS={"owner/repo#7":["defect",...]}`; with none set there is no reader, and the class report says NOT CHECKED rather than pass.
 * A row the map does not name THROWS, so a half-filled map is UNKNOWN for that row and not "no defect label".
 */
export function rowLabelsFromEnv(env: NodeJS.ProcessEnv): ((row: { repo: string | null; number: number; }) => string[]) | undefined {
  if (!env.ACCEPTANCE_ROW_LABELS) return undefined;
  const supplied = JSON.parse(env.ACCEPTANCE_ROW_LABELS);
  return (row) => {
    const key = `${row.repo ?? env.GITHUB_REPOSITORY ?? ""}#${row.number}`;
    if (!Array.isArray(supplied[key])) throw new Error(`ACCEPTANCE_ROW_LABELS names no labels for ${key}`);
    return supplied[key];
  };
}

function oneLine({ ok, line }: { ok: boolean; line: string; }) {
  return { ok, lines: [line] };
}

/**
 * Every report in `reports`, run in order and ALL of them, so an author fixing a body is told every refusal at
 * once rather than one per round trip. `reports` is read at call time, which is what lets a test see a
 * report added to `CI_BODY_REPORTS` reach a caller that never named it.
 */
export function runCiBodyReports(input: BodyReportInput, reports: BodyReport[] = CI_BODY_REPORTS): { ok: boolean; lines: string[]; } {
  // Resolved once, so the file is read once and every report that reads the `Acceptance:` family reads the same text.
  const resolved = { ...input, acceptance: acceptanceSourceOf(input) };
  const results = reports.map(({ report }) => report(resolved));
  return { ok: results.every((result) => result.ok), lines: results.flatMap((result) => result.lines) };
}
