// no-token: gh -- the hook decides on text; the one real process is `node` running `bin.ts ticket:hook`, to prove the command a settings file names works
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, main, prReviewEvent, protectedFiles, publishConnectors, publisherSkills, readOutcomeFile, resolveWritePath, stopVerdict, toolVerdict, writerGrants } from "./hook.ts";
import { buildCatalog, defaultCatalog } from "../plugins/registry.ts";
import { FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, OPENED_FILE, PROTECTED_FILE, QUESTION_FILE, READY_FILE, defaultBinDir, protectedPaths } from "./worker-files.ts";
import { lineForm } from "./blocker-findings-check.ts";
import { outcomeWritten } from "./pool-outcome.ts";
import { CREATED_FILE } from "./writer.ts";

const bash = (command: string) => toolVerdict("Bash", { command }).code;

test("a worker opens a draft and nothing past it: ready, merge, review, reviewers, workflows, force pushes and assumego are refused", () => {
  assert.equal(bash("gh pr create --title t --body b"), 2, "a pull request that is not a draft");
  assert.equal(bash("gh pr create --draft --title t --body b"), 0, "POSITIVE CONTROL: a draft is allowed");
  for (const refused of ["gh pr ready 12", "gh pr merge 12 --squash", "gh pr review 12 --approve", "gh pr edit 12 --add-reviewer x", "gh workflow run ci.yml",
    "git push --force origin b", "git push -f origin b", "git push --force-with-lease", "git push origin +b", "assumego prod"]) {
    assert.equal(bash(refused), 2, refused);
  }
  for (const allowed of ["git push -u origin nbf-1270-refresh", "gh pr view 12", "gh pr edit 12 --body x", "npm test", "git commit -m 'fix: x'"]) {
    assert.equal(bash(allowed), 0, allowed);
  }
});

test("every connector is refused when the machine names none, and so is the skill that announces a pull request", () => {
  assert.equal(toolVerdict("mcp__fake__save_comment", {}).code, 2);
  assert.equal(toolVerdict("mcp__plugin_slack_slack__slack_send_message", {}).code, 2);
  assert.equal(toolVerdict("Skill", { skill: "post-pr-to-slack" }).code, 2);
  assert.equal(toolVerdict("Skill", { skill: "clean-code-review" }).code, 0, "POSITIVE CONTROL: the review the brief asks for is allowed");
  assert.equal(toolVerdict("Skill", { skill: "nbl-ui:tool-screenshot" }).code, 0, "a machine's own screenshot skill is allowed");
  assert.equal(toolVerdict("Edit", { file_path: "/x" }).code, 0);
});

const FAKE_READS = [/^mcp__fake__(get|list|search|extract)_/];

test("a connector tool the machine names is allowed, and every other connector, a write to the same one included, is still refused", () => {
  for (const read of ["mcp__fake__get_issue", "mcp__fake__list_comments", "mcp__fake__search_documentation"]) {
    assert.equal(toolVerdict(read, {}, { connectors: FAKE_READS }).code, 0, read);
  }
  for (const refused of ["mcp__fake__delete_attachment", "mcp__plugin_slack_slack__slack_send_message", "mcp__claude_ai_Gmail__create_draft"]) {
    const verdict = toolVerdict(refused, {}, { connectors: FAKE_READS });
    assert.equal(verdict.code, 2, refused);
    assert.match(verdict.say[0], /tickets\.connectors does not allow/);
  }
});

/** A pre-tool-use call for `tool` in a ticket dir holding `connectors` as its copy of the machine's allowed connectors. */
function withConnectors(connectors: string, tool: string) {
  const dir = tmpDir("ticket-hook-connectors-");
  writeFileSync(join(dir, "connectors.json"), connectors);
  return main(JSON.stringify({ tool_name: tool, tool_input: {} }), ["pre-tool-use", dir]);
}

test("the hook reads the machine's allowed connectors beside the outcome file, and one it cannot read allows none, out loud", () => {
  const reads = JSON.stringify(["^mcp__fake__(get|list)_"]);
  assert.equal(withConnectors(reads, "mcp__fake__get_issue").code, 0);
  assert.equal(withConnectors(reads, "mcp__fake__save_comment").code, 2);
  const broken = withConnectors("{not json", "mcp__fake__get_issue");
  assert.equal(broken.code, 2);
  assert.match(broken.say[0], /could not read .*connectors\.json, so every connector is refused/);
  assert.equal(main(JSON.stringify({ tool_name: "mcp__fake__get_issue", tool_input: {} }), ["pre-tool-use", tmpDir("ticket-hook-none-")]).code, 2,
    "no copy at all: every connector is refused");
});

/** A pre-tool-use call for `command` in a ticket dir holding `deny` as its copy of the machine's refusals. */
function withDeny(deny: string, command: string) {
  const dir = tmpDir("ticket-hook-deny-");
  writeFileSync(join(dir, "deny.json"), deny);
  // The pool writes the protected list beside every run's outcome file, so a run's directory always has one.
  writeFileSync(join(dir, PROTECTED_FILE), JSON.stringify(protectedPaths(defaultBinDir(homedir()))));
  return main(JSON.stringify({ tool_name: "Bash", tool_input: { command } }), ["pre-tool-use", dir]);
}

test("a review run may mark ready the pull requests the person approved, by URL, and nothing else of the person's is lifted", () => {
  const url = "https://github.com/x/app/pull/1";
  const review = (command: string) => toolVerdict("Bash", { command }, { approved: [url] }).code;
  assert.equal(review(`gh pr ready ${url}`), 0);
  assert.equal(review(`gh pr ready ${url}2`), 2, "a pull request whose URL only starts with an approved one");
  assert.equal(review("gh pr ready https://github.com/x/app/pull/7"), 2, "a pull request the person did not approve");
  assert.equal(review("gh pr ready 1"), 2, "a pull request named by number only");
  assert.equal(review(`gh pr ready ${url} --undo`), 2, "turning one back into a draft");
  for (const refused of ["gh pr merge 12 --squash", "gh pr review 12 --approve", "gh pr edit 12 --add-reviewer x", "gh workflow run ci.yml", "git push --force origin x"]) {
    assert.equal(review(refused), 2, refused);
  }
  assert.equal(bash("gh pr ready 12"), 2, "POSITIVE CONTROL: any other run is refused it");
});

test("the hook treats a run as a review run while the pool's review mark is beside its outcome file", () => {
  const dir = tmpDir("ticket-hook-review-");
  const ready = () => main(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr ready 5" } }), ["pre-tool-use", dir]).code;
  assert.equal(ready(), 2, "no mark: refused");
  writeFileSync(join(dir, "review-run"), "[]\n");
  assert.equal(ready(), 2, "a mark naming no pull request allows none");
  writeFileSync(join(dir, "review-run"), `${JSON.stringify([{ repo: "app", url: "https://github.com/x/app/pull/5" }])}\n`);
  const named = main(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr ready https://github.com/x/app/pull/5" } }), ["pre-tool-use", dir]).code;
  assert.equal(named, 0);
});

test("no worker may write the review mark, by a command or a file tool, since it would lift a refusal", () => {
  assert.equal(bash("echo '[]' > /state/tickets/NBF-1/review-run"), 2);
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/review-run", content: "[]" }).code, 2);
  assert.equal(toolVerdict("Edit", { file_path: "/state/tickets/NBF-1/review-run.md" }).code, 2);
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/outcome.json", content: "{}" }).code, 0, "POSITIVE CONTROL: the outcome file is the worker's");
});

test("this machine's own refusals apply after the built-in ones, each with its own reason", () => {
  const deny = JSON.stringify([{ pattern: "\\bnpm\\s+run\\s+(dev|preview)\\b(?!:atomic)", reason: "a fixed port collides with other workers" }]);
  const refused = withDeny(deny, "npm run dev -w packages/ui-netbox");
  assert.equal(refused.code, 2);
  assert.match(refused.say[0], /a fixed port collides with other workers/);
  assert.equal(withDeny(deny, "npm run dev:atomic:standalone").code, 0, "POSITIVE CONTROL: what the rule leaves out is allowed");
  assert.equal(withDeny(deny, "gh pr ready 5").code, 2, "the built-in refusals still apply");
});

test("a copy of the machine's refusals that cannot be read is reported and skipped, and the built-in refusals still apply", () => {
  const ready = withDeny("{not json", "gh pr ready 5");
  assert.equal(ready.code, 2);
  assert.match(ready.say[0], /could not read .*deny\.json, so only the built-in refusals apply/);
  assert.equal(withDeny("{not json", "npm run dev").code, 0);
});

test("A11-152: an outcome written at or before the board's stale mark is no outcome, and a newer one is judged as written", () => {
  const dir = tmpDir("ticket-hook-stale-");
  const outcome = join(dir, "outcome.json");
  writeFileSync(outcome, JSON.stringify({ kind: "needs-human", reason: "which colour?", escalation: "reserved" }));
  utimesSync(outcome, 1000, 1000);
  writeFileSync(join(dir, "outcome-stale-before"), "1000000\n");
  const refused = stopVerdict(dir);
  assert.match(refused.say[0], /write .*outcome\.json before you stop/, "with the words a missing outcome gets");
  assert.equal(refused.code, 2, "the file the run parked on is refused");
  utimesSync(outcome, 2000, 2000);
  assert.equal(stopVerdict(dir).code, 0, "a file newer than the mark is judged as written");
});

test("A11-152: a stale mark it cannot read makes every outcome stale, and the count still bounds the refusal", () => {
  const dir = tmpDir("ticket-hook-stale-garbled-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "r", escalation: "reserved" }));
  writeFileSync(join(dir, "outcome-stale-before"), "not a time");
  assert.deepEqual(Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => stopVerdict(dir).code), [2, 2, 0]);
});

test("A11-152: the stop reads the outcome once, and a read that finds no file is not repeated", () => {
  const dir = tmpDir("ticket-hook-read-once-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "r", escalation: "reserved" }));
  let reads = 0;
  const readOutcome = (path: string) => {
    reads += 1;
    if (reads > 1) throw new Error(`${path} was read again`);
    return null;
  };
  assert.equal(stopVerdict(dir, { readOutcome }).code, 2, "a read that finds no file is a missing outcome");
  assert.equal(reads, 1, "one read");
});

test("A11-152: readOutcomeFile takes the text and the mtime from one open file, and is null only for a file that is not there", () => {
  const dir = tmpDir("ticket-hook-read-file-");
  const path = join(dir, "outcome.json");
  assert.equal(readOutcomeFile(path), null);
  writeFileSync(path, "{}");
  utimesSync(path, 3, 3);
  assert.deepEqual(readOutcomeFile(path), { text: "{}", mtime: 3000 });
});

test("A11-152: a stop holds its stop-active mark while it reads the outcome, and takes the mark off whatever it decides", () => {
  const dir = tmpDir("ticket-hook-active-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "r", escalation: "reserved" }));
  let seen = false;
  const readOutcome = (path: string) => {
    seen = existsSync(join(dir, "stop-active"));
    return readOutcomeFile(path);
  };
  assert.equal(stopVerdict(dir, { readOutcome }).code, 0);
  assert.equal(seen, true, "the mark is there while the outcome is read");
  assert.equal(existsSync(join(dir, "stop-active")), false, "and gone once the stop is judged");
  const empty = tmpDir("ticket-hook-active-none-");
  assert.equal(stopVerdict(empty).code, 2);
  assert.equal(existsSync(join(empty, "stop-active")), false, "a refused stop takes it off too");
});

test("A11-152: a worker may not write the stale mark or the stop hook's own file", () => {
  assert.equal(bash("echo 0 > outcome-stale-before"), 2);
  assert.equal(bash("rm -f stop-active"), 2);
});

test("a stop with no outcome is refused twice in a row, then allowed; an outcome allows it and resets the count", () => {
  const dir = tmpDir("ticket-hook-stop-");
  const verdicts = Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => stopVerdict(dir).code);
  assert.deepEqual(verdicts, [2, 2, 0]);
  writeFileSync(join(dir, "outcome.json"), "{\"kind\":\"needs-human\",\"reason\":\"r\",\"escalation\":\"reserved\"}");
  assert.equal(stopVerdict(dir).code, 0);
  writeFileSync(join(dir, "outcome.json"), "");
  const empty = stopVerdict(dir);
  assert.equal(empty.code, 2, "an empty file is not an outcome the board can read, so it is refused");
  assert.match(empty.say[0], /the file is not JSON/, "and the refusal says why");
});

test("A11-124: a grill writer may end its turn with no outcome while it waits on the person; a quick writer may not, and a mark that names no mode is not grill", () => {
  const grill = tmpDir("ticket-hook-grill-");
  writeFileSync(join(grill, "writer-run"), "{\"mode\":\"grill\"}\n");
  assert.equal(stopVerdict(grill).code, 0, "POSITIVE CONTROL: the grill run's turn ends while it waits for an answer");
  assert.equal(readFileSync(join(grill, "stop-refusals"), "utf8").trim(), "0", "and nothing is counted as a refusal");
  const quick = tmpDir("ticket-hook-quick-");
  writeFileSync(join(quick, "writer-run"), "{\"mode\":\"quick\"}\n");
  assert.equal(stopVerdict(quick).code, 2, "a quick run with no outcome is refused, as before");
  const unnamed = tmpDir("ticket-hook-unnamed-");
  writeFileSync(join(unnamed, "writer-run"), "{}\n");
  assert.equal(stopVerdict(unnamed).code, 2, "a mark that names no mode is not grill");
});

test("A11-129: a grill turn that ends with no outcome records its question beside the outcome file: the payload's last message, else the transcript's last assistant text, else an empty one", () => {
  const dir = tmpDir("ticket-hook-question-");
  writeFileSync(join(dir, "writer-run"), "{\"mode\":\"grill\"}\n");
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { content: "Read the brief" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Q1: editable or read-only?" }] } }),
  ].join("\n"));
  const recorded = () => JSON.parse(readFileSync(join(dir, "waiting.json"), "utf8")) as { question: string; at: number };
  assert.equal(main(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Q1: editable or read-only?" }), ["stop", dir]).code, 0);
  assert.equal(recorded().question, "Q1: editable or read-only?", "the payload's last message is the question");
  assert.equal(typeof recorded().at, "number", "and when it was recorded");
  assert.equal(main(JSON.stringify({ transcript_path: transcript }), ["stop", dir]).code, 0);
  assert.equal(recorded().question, "Q1: editable or read-only?", "with no message in the payload, the transcript's last assistant text is the question");
  assert.equal(main(JSON.stringify({ transcript_path: join(dir, "no-such.jsonl") }), ["stop", dir]).code, 0);
  assert.equal(recorded().question, "", "with neither, the question is empty, and the board shows its fixed line");
  const quick = tmpDir("ticket-hook-question-quick-");
  writeFileSync(join(quick, "writer-run"), "{\"mode\":\"quick\"}\n");
  assert.equal(main(JSON.stringify({ last_assistant_message: "a question" }), ["stop", quick]).code, 2, "a quick run is refused, as before");
  assert.equal(existsSync(join(quick, "waiting.json")), false, "and no question is recorded for it");
});

test("A11-129: no worker may write a grill run's question or its moved outcome, by a file tool or a command", () => {
  for (const file of ["waiting.json", "asked.json"]) {
    const path = join(tmpDir("ticket-hook-board-file-"), file);
    assert.equal(toolVerdict("Write", { file_path: path }).code, 2, `${file}: a file tool may not write it`);
    assert.equal(toolVerdict("Bash", { command: `echo '{}' > ${path}` }).code, 2, `${file}: a command may not write it`);
  }
  assert.equal(toolVerdict("Write", { file_path: join(tmpDir("ticket-hook-agent-"), "outcome.json") }).code, 0, "CONTROL: the outcome file is the worker's to write");
});

test("A11-118: a ready-pr with `pr` for `prs` is refused at the stop naming prs; the corrected file is allowed and the count is reset", () => {
  const dir = tmpDir("ticket-hook-shape-");
  const outcome = join(dir, "outcome.json");
  writeFileSync(outcome, JSON.stringify({ kind: "ready-pr", pr: "https://github.com/a11ign/control/pull/119", reason: "x" }));
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2, "POSITIVE: the near miss is refused, so the worker writes the contract's file in the same turn");
  assert.match(refused.say[0], /ready-pr needs prs: \[\{repo, url\}\], you wrote pr/);
  assert.equal(readFileSync(join(dir, "stop-refusals"), "utf8").trim(), "1", "the refusal counts");
  writeFileSync(outcome, JSON.stringify({ kind: "ready-pr", prs: [{ repo: "a11ign/control", url: "https://github.com/a11ign/control/pull/119" }], reason: "x" }));
  assert.equal(stopVerdict(dir).code, 0, "CONTROL: the corrected file is allowed");
  assert.equal(readFileSync(join(dir, "stop-refusals"), "utf8").trim(), "0", "and the count is reset");
});

test("A11-118: each wrong shape is refused with the field it names, and the publish and new-ticket kinds are allowed", () => {
  const named = [
    [{ kind: "needs-human", why: "the question" }, /needs-human needs reason: a string, you wrote why/],
    [{ kind: "wrong-repo" }, /wrong-repo needs where: a string, you wrote no where/],
    [{ kind: "merged" }, /kind "merged" is not one of/],
    [{ kind: "ready-pr", prs: [{ repo: "a11ign/control", link: "https://github.com/a11ign/control/pull/119" }] }, /ready-pr prs\[0\] needs url: a string, you wrote link/],
  ] as const;
  for (const [file, problem] of named) {
    const dir = tmpDir("ticket-hook-kinds-");
    writeFileSync(join(dir, "outcome.json"), JSON.stringify(file));
    const verdict = stopVerdict(dir);
    assert.equal(verdict.code, 2, JSON.stringify(file));
    assert.match(verdict.say[0], problem);
  }
  for (const file of [{ kind: "published" }, { kind: "drafted" }, { kind: "planned" }]) {
    const dir = tmpDir("ticket-hook-kinds-");
    writeFileSync(join(dir, "outcome.json"), JSON.stringify(file));
    assert.equal(stopVerdict(dir).code, 0, `${file.kind} is a kind some run writes, and its file has nothing beyond it`);
  }
});


/** The verdicts of stopping on an outcome file that holds `text`, up to the count's limit and one stop past it (A11-118). */
function stopsOn(text: string) {
  const dir = tmpDir("ticket-hook-stuck-");
  writeFileSync(join(dir, "outcome.json"), text);
  return Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => stopVerdict(dir));
}

test("A11-118: a worker that cannot fix its wrong-shape file is let through after the count, and the stop says the file is invalid", () => {
  const verdicts = stopsOn(JSON.stringify({ kind: "ready-pr", prs: "one" }));
  assert.deepEqual(verdicts.map((verdict) => verdict.code), [2, 2, 0]);
  assert.match(verdicts[2].say[0], /2 stops in a row on the same invalid outcome in .*outcome\.json, so this one is allowed and the board hands the run back for a person/);
});

test("A11-118: a near miss the worker never fixes is let through after the count, and the stop says the pool records the pull request it names", () => {
  const verdicts = stopsOn(JSON.stringify({ kind: "ready-pr", pr: "https://github.com/a11ign/control/pull/119" }));
  assert.deepEqual(verdicts.map((verdict) => verdict.code), [2, 2, 0]);
  assert.match(verdicts[2].say[0], /2 stops in a row on the same outcome in .*outcome\.json, which names one pull request in pr, so this one is allowed and the board records that pull request/);
});

test("`stop_hook_active` does not let a stop through: the nbl-ui gates set it, and the outcome would be skipped", () => {
  const dir = tmpDir("ticket-hook-active-");
  assert.equal(main(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }), ["stop", dir]).code, 2);
});

/** A ticket dir whose copy of `tickets.prReview` names `skill`, as the pool writes it beside the outcome file. */
function reviewDir(skill = "a11ign:clean-code-review"): string {
  const dir = tmpDir("ticket-hook-pr-review-");
  writeFileSync(join(dir, "pr-review.json"), `${JSON.stringify(skill)}\n`);
  return dir;
}

/** The pre-tool-use verdict for one tool call in `dir`. */
const gateCall = (dir: string, toolName: string, input: Record<string, unknown>) => main(JSON.stringify({ tool_name: toolName, tool_input: input }), ["pre-tool-use", dir]);
const gateBash = (dir: string, command: string) => gateCall(dir, "Bash", { command });
const review = (dir: string, skill = "a11ign:clean-code-review") => gateCall(dir, "Skill", { skill });

/** A ticket dir whose configured review has already run, so the gate sees a reviewed tree. */
function reviewedDir(): string {
  const dir = reviewDir();
  review(dir);
  return dir;
}

test("A11-86: what a tool call is to the gate: the configured skill exactly is a review, and a git command that makes a commit is a commit", () => {
  const skill = "a11ign:clean-code-review";
  assert.equal(prReviewEvent("Skill", { skill }, skill), "review");
  assert.equal(prReviewEvent("Skill", { skill: "/a11ign:clean-code-review" }, skill), "review", "a leading slash names the same skill");
  assert.equal(prReviewEvent("Skill", { skill: "clean-code-review" }, skill), null, "the unprefixed skill is another one");
  for (const command of ["git commit -m x", "git -C /w commit -m x", "git -c user.name=a commit -m x", "git rebase main", "git pull"]) {
    assert.equal(prReviewEvent("Bash", { command }, skill), "commit", command);
  }
  for (const command of ["git --work-tree /w commit -m x", "git -c user.name=\"A B\" commit -m x", "bash -c 'git commit -m x'", "/usr/bin/git -C /w rebase main"]) {
    assert.equal(prReviewEvent("Bash", { command }, skill), "commit", command);
  }
  for (const command of ["git grep commit", "git log --grep=commit", "git push origin b", "git status", "git merge-base main HEAD", "git commit-tree abc"]) {
    assert.equal(prReviewEvent("Bash", { command }, skill), null, command);
  }
});

test("A11-86: with tickets.prReview named, a push or a pull request is refused until the skill has run, and allowed after it", () => {
  const dir = reviewDir();
  for (const command of ["gh pr create --draft --title t --body b", "node bin.ts pr:open create --draft --body-file f", "git push -u origin b", "git -C /w push origin b"]) {
    const refused = gateBash(dir, command);
    assert.equal(refused.code, 2, command);
    assert.match(refused.say.join("\n"), /run the `a11ign:clean-code-review` skill on your whole diff before you push or open a pull request/);
  }
  assert.equal(review(dir).code, 0, "the review itself is allowed");
  assert.equal(gateBash(dir, "git push -u origin b").code, 0, "POSITIVE CONTROL: after the review, the push is allowed");
  assert.equal(gateBash(dir, "gh pr create --draft --title t --body b").code, 0, "and so is the pull request");
  assert.equal(gateBash(dir, "gh pr view 12").code, 0, "a command the gate does not hold is allowed");
});

test("A11-86: a commit after the review makes the push refused again until a second review, and a commit with its push in one command is refused even after one", () => {
  const dir = reviewDir();
  review(dir);
  assert.equal(gateBash(dir, "git commit -m 'fix: x'").code, 0, "the commit is allowed");
  assert.equal(gateBash(dir, "git push -u origin b").code, 2, "the fix was committed after the review, so it is not reviewed");
  review(dir);
  assert.equal(gateBash(dir, "git push -u origin b").code, 0, "POSITIVE CONTROL: the second review covers the last commit");
  assert.equal(gateBash(dir, "git commit -m 'fix: y' && git push origin b").code, 2, "the push would send what no review saw");
});

test("A11-86: only the configured skill counts as the review, and a call another refusal stops is not logged", () => {
  const dir = reviewDir();
  for (const skill of ["clean-code-review", "nbl-ui:tool-screenshot", "a11ign:clean-code-review-v2"]) {
    review(dir, skill);
    assert.equal(gateBash(dir, "git push -u origin b").code, 2, `${skill} is not the review`);
  }
  review(dir);
  assert.equal(gateBash(dir, "git commit -m x && gh pr merge 12").code, 2, "refused by the built-in refusals, so nothing is committed or logged");
  assert.equal(gateBash(dir, "git push -u origin b").code, 0, "POSITIVE CONTROL: the review still covers the last commit, which that refused call did not make");
});

test("A11-86: with no copy of tickets.prReview, nothing is gated and no log is made, as before", () => {
  const dir = tmpDir("ticket-hook-no-pr-review-");
  assert.equal(gateBash(dir, "git push -u origin b").code, 0);
  assert.equal(gateBash(dir, "gh pr create --draft --title t --body b").code, 0);
  assert.equal(gateBash(dir, "node bin.ts pr:open create --draft --body-file f").code, 0);
  assert.equal(gateBash(dir, "git commit -m x").code, 0);
  assert.equal(existsSync(join(dir, "pr-review-log")), false, "no log is made when the setting is absent");
});

test("A11-86: a copy of tickets.prReview that cannot be read or names no skill refuses the pushes and pull requests the gate holds, and keeps its files protected", () => {
  for (const content of ["{not json", "\"\"", "3"]) {
    const dir = tmpDir("ticket-hook-pr-review-broken-");
    writeFileSync(join(dir, "pr-review.json"), `${content}\n`);
    const pushed = gateBash(dir, "git push -u origin b");
    assert.equal(pushed.code, 2, `${content}: fails closed, since the gate cannot tell what the machine asked for`);
    assert.match(pushed.say.join("\n"), /pr-review\.json (cannot be read|names no skill), so the pre-PR review cannot be checked/);
    assert.equal(gateBash(dir, "gh pr view 12").code, 0, "POSITIVE CONTROL: a command the gate does not hold still runs");
    assert.equal(gateBash(dir, "rm pr-review.json").code, 2, "a worker may not delete the copy it cannot read, which would turn the gate off");
    assert.equal(gateCall(dir, "Write", { file_path: join(dir, "pr-review.json"), content: "x" }).code, 2);
  }
});

test("A11-86: a pre-PR review log the gate cannot read refuses the call that needs it, and a call that needs no log still runs", () => {
  const dir = reviewDir();
  mkdirSync(join(dir, "pr-review-log"));
  const pushed = gateBash(dir, "git push -u origin b");
  assert.equal(pushed.code, 2);
  assert.match(pushed.say.join("\n"), /pr-review-log cannot be read/);
  assert.equal(gateBash(dir, "gh pr view 12").code, 0, "a call the gate does not hold needs no log");
});

test("A11-86: with tickets.prReview named, no worker may write or name the pre-PR review's files by a command or a file tool; with it absent nothing is refused for them", () => {
  const dir = reviewDir();
  assert.equal(gateBash(dir, "echo x > /state/tickets/NBF-1/pr-review-log").code, 2);
  assert.equal(gateBash(dir, "cat pr-review.json").code, 2, "a read by command is refused too");
  assert.equal(gateCall(dir, "Write", { file_path: "/state/tickets/NBF-1/pr-review.json", content: "\"x\"" }).code, 2);
  assert.equal(gateCall(dir, "Edit", { file_path: "/state/tickets/NBF-1/pr-review-log" }).code, 2);
  assert.equal(gateCall(dir, "Write", { file_path: "/state/tickets/NBF-1/outcome.json", content: "{}" }).code, 0, "POSITIVE CONTROL: the outcome file is the worker's");
  const plain = tmpDir("ticket-hook-no-pr-review-marks-");
  assert.equal(gateBash(plain, "echo x > /state/tickets/NBF-1/pr-review-log").code, 0, "with no setting, the files are not the gate's, so nothing is refused for them");
});

test("A11-86: the options git takes before its subcommand do not hide a commit or a push from the gate", () => {
  const dir = reviewedDir();
  assert.equal(gateBash(dir, "git --work-tree /w commit -m x").code, 0, "the commit is allowed");
  assert.equal(gateBash(dir, "git --work-tree /w push origin b").code, 2, "and it was logged, so the push is refused");
  review(dir);
  const quoted = gateBash(dir, "git -c user.name=\"A B\" commit -m x");
  assert.equal(quoted.code, 0, "the quoted value does not hide the commit");
  assert.equal(gateBash(dir, "git -c user.name=\"A B\" push origin b").code, 2);
  assert.equal(gateBash(reviewDir(), "git --work-tree /w push origin b").code, 2, "a push with an option before it is refused before any review");
});

test("an unreadable payload or a bad call fails open, out loud", () => {
  const unreadable = main("{not json", ["pre-tool-use", "/x"]);
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.say[0], /ALLOWED/);
  assert.equal(main("{}", ["wrong", "/x"]).code, 0);
});

test("the command a settings file names runs: `node bin.ts ticket:hook pre-tool-use` exits 2 for `gh pr ready`, with the reason on stderr", () => {
  const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
  const result = spawnSync(process.execPath, [bin, "ticket:hook", "pre-tool-use", "/x"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr ready 5" } }), encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /the person's/);
});

test("a worker may link its pull request into a stack with the literal `gh stack link`, and every other gh stack command is the person's", () => {
  for (const link of ["gh stack link https://github.com/o/r/pull/1 https://github.com/o/r/pull/2", "cd r && gh stack link a b"]) {
    assert.equal(bash(link), 0, link);
  }
  for (const refused of ["gh stack push", "gh stack sync", "gh stack merge", "gh stack rebase --upstack", "gh stack", "cd r && gh stack submit",
    "gh extension exec stack push", "gh-stack push", "gh stack link a b; gh stack push",
    "gh extension exec stack link a b", "gh-stack link a b"]) {
    assert.equal(bash(refused), 2, refused);
  }
  assert.match(toolVerdict("Bash", { command: "gh stack push" }).say[0], /a stack's pushes, rebases and merges are the person's: a worker runs only `gh stack link`/);
});

const SLACK = /^mcp__plugin_slack_slack__slack_send_message$/;

test("a publish run may announce pull requests, with the skill and the connectors its mark names, and nothing else of the person's is lifted", () => {
  const publish = (tool: string, input: Record<string, unknown> = {}) => toolVerdict(tool, input, { publish: [SLACK] }).code;
  assert.equal(publish("Skill", { skill: "post-pr-to-slack" }), 0);
  assert.equal(publish("mcp__plugin_slack_slack__slack_send_message"), 0);
  assert.equal(toolVerdict("Skill", { skill: "post-pr-to-slack" }, { publish: [] }).code, 0, "a publish run whose mark names no connector may still run the skill");
  assert.equal(toolVerdict("Skill", { skill: "post-pr-to-slack" }).code, 2, "POSITIVE CONTROL: any other run is refused it");
  assert.equal(toolVerdict("mcp__plugin_slack_slack__slack_send_message", {}).code, 2, "POSITIVE CONTROL: and the connector");
  assert.equal(publish("mcp__plugin_slack_slack__slack_send_message_draft"), 2, "a connector the mark does not name");
  assert.equal(publish("mcp__claude_ai_Gmail__create_draft"), 2);
  for (const refused of ["gh pr merge 12 --squash", "gh pr review 12 --approve", "git push --force origin b", "gh workflow run ci.yml", "gh pr ready 12"]) {
    assert.equal(publish("Bash", { command: refused }), 2, refused);
  }
});

test("A11-161: the skills only a publish run may run are the catalog's publishers' (`tooling.skills` of each manifest, read as data): every other run is refused them, and a publisher added to the catalog is covered with no change to the hook", () => {
  assert.deepEqual(publisherSkills(defaultCatalog()), ["post-pr-to-slack"], "the bundled slack plugin's skill, from its manifest");
  assert.deepEqual(publisherSkills(buildCatalog({ root: "/none", files: { directories: () => [], text: () => null, isFile: () => false } })), [], "a catalog with no publisher refuses nothing");
  const another = ["post-pr-to-slack", "announce-to-teams"];
  assert.equal(toolVerdict("Skill", { skill: "announce-to-teams" }, { publisherSkills: another }).code, 2, "a second publisher's skill is refused to a run that is no publish run");
  assert.equal(toolVerdict("Skill", { skill: "announce-to-teams" }, { publisherSkills: another, publish: [] }).code, 0, "and allowed to the publish run");
  assert.equal(toolVerdict("Skill", { skill: "announce-to-teams" }, { publisherSkills: ["post-pr-to-slack"] }).code, 0, "a skill no publisher declares is not the hook's to refuse");
  assert.match(toolVerdict("Skill", { skill: "plugin:post-pr-to-slack" }).say[0], /the plugin:post-pr-to-slack skill is refused: announcing a pull request is the person's/, "a skill under a plugin's prefix is refused as it was");
});

test("the hook treats a run as a publish run while the board's publish mark is beside its outcome file, and an unreadable mark lifts nothing", () => {
  const dir = tmpDir("ticket-hook-publish-");
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  assert.equal(publishConnectors(dir), null);
  assert.equal(call("Skill", { skill: "post-pr-to-slack" }), 2, "no mark: refused");
  writeFileSync(join(dir, "publish-run"), "not json");
  assert.equal(call("Skill", { skill: "post-pr-to-slack" }), 2, "a mark it cannot read lifts nothing");
  writeFileSync(join(dir, "publish-run"), `${JSON.stringify({ connectors: [SLACK.source] })}\n`);
  assert.equal(call("Skill", { skill: "post-pr-to-slack" }), 0);
  assert.equal(call("mcp__plugin_slack_slack__slack_send_message"), 0);
});

test("no worker may write the publish mark, by a command or a file tool, since it would lift a refusal", () => {
  assert.equal(bash("echo '{}' > /state/tickets/NBF-1/publish-run"), 2);
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/publish-run", content: "{}" }).code, 2);
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/publish/p1/published.json", content: "{}" }).code, 0, "POSITIVE CONTROL: the links file is the run's");
});

test("a drafts-off run may open a ready pull request and a drafts-on run may not: the ready mark decides it, and no worker can write it", () => {
  const ready = (command: string) => toolVerdict("Bash", { command }, { ready: true }).code;
  assert.equal(bash("gh pr create --title t --body b"), 2, "POSITIVE CONTROL: drafts on refuses a pull request that is not a draft");
  assert.equal(ready("gh pr create --title t --body b"), 0, "a ready run may open one");
  assert.equal(ready("gh pr create --draft --title t --body b"), 0, "and a draft");
  // A stacked run bases its pull request on its blocker's branch, which may have no pull request under it (A11-116): the base is not refused.
  assert.equal(ready("gh pr create --base nbf-1-fit --title t --body b"), 0, "a ready pull request based on a stacked branch is allowed");
  assert.equal(bash("gh pr create --base nbf-1-fit --draft --title t --body b"), 0, "and a draft one on a drafts-on machine");
  assert.equal(ready("gh pr ready 12"), 2, "a pull request named by number is none the hook can tie to the run, so it is still refused");
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/ready-run", content: "\n" }).code, 2, "no worker writes the ready mark with a file tool");
  assert.equal(bash("touch /state/tickets/NBF-1/ready-run"), 2, "no worker writes the ready mark with a command");
});

test("A11-358: a drafts-off run marks its own pull requests ready, and a drafts-on run still may not", () => {
  const toolchain60 = "https://github.com/a11ign/toolchain/pull/60";
  const onReady = (command: string, opened: readonly string[] = []) => toolVerdict("Bash", { command }, { ready: true, opened }).code;
  assert.equal(bash("gh pr ready"), 2, "POSITIVE CONTROL: a drafts-on run is refused it, with no argument too");
  assert.equal(onReady("gh pr ready"), 0, "the pull request of the run's branch, with no argument");
  assert.equal(onReady("gh pr ready && echo marked"), 0, "no argument, followed by another command");
  assert.equal(onReady(`gh pr ready ${toolchain60}`, [toolchain60]), 0, "a pull request the run opened, by the URL its creating command printed");
  assert.equal(onReady(`gh pr ready ${toolchain60}`), 2, "a URL the run did not open");
  assert.equal(onReady(`gh pr ready ${toolchain60}1`, [toolchain60]), 2, "a URL that only starts with one it opened");
  const refused: readonly (readonly [string, string])[] = [
    ["gh pr ready 60", "a number names a pull request in the repository the shell is in, which the hook cannot tie to the run"],
    ["gh pr ready some-branch", "a branch name too"],
    ["gh pr ready --undo", "turning one back into a draft is never the run's"],
    [`gh pr ready ${toolchain60} --undo`, "nor an opened one"],
  ];
  for (const [command, why] of refused) assert.equal(onReady(command, [toolchain60]), 2, why);
  assert.equal(toolVerdict("Bash", { command: `gh pr ready ${toolchain60}` }, { opened: [toolchain60] }).code, 2, "a drafts-on run is refused a pull request it opened: the mark decides, not the record");
  assert.match(toolVerdict("Bash", { command: "gh pr ready 60" }, { ready: true }).say[0], /no argument, or with the URL of a pull request this run opened/);
});

test("A11-358: the hook records the pull request a creating command printed, once, and no worker writes the record", () => {
  const dir = tmpDir("ticket-opened-");
  const created = (command: string, stdout: string) => main(JSON.stringify({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout } }), ["post-tool-use", dir]);
  const recorded = () => (existsSync(join(dir, OPENED_FILE)) ? readFileSync(join(dir, OPENED_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  assert.deepEqual(created("gh pr create --title t --body b", "Creating pull request for x into main in a11ign/toolchain\n\nhttps://github.com/a11ign/toolchain/pull/60\n"), { code: 0, say: [] });
  assert.deepEqual(recorded(), [{ repo: "a11ign/toolchain", url: "https://github.com/a11ign/toolchain/pull/60" }]);
  created("gh pr create --title t --body b", "https://github.com/a11ign/toolchain/pull/60\n");
  assert.equal(recorded().length, 1, "the same address is not written twice");
  created("pr:open create --title t --body-file b.md", "https://github.com/a11ign/lab/pull/159\n");
  assert.deepEqual(recorded().map(({ repo }) => repo), ["a11ign/toolchain", "a11ign/lab"], "the tool's own create is recorded too");
  created("grep -rn 'gh pr create' docs/", "docs/a.md:3: https://github.com/a11ign/toolchain/pull/70\n");
  created("cd ../lab && gh pr create --title t", "https://github.com/a11ign/lab/pull/160\n");
  assert.deepEqual(recorded().map(({ url }) => url).slice(-1), ["https://github.com/a11ign/lab/pull/160"], "a creating command after a cd is recorded; one that only names it in an argument is not");
  assert.equal(recorded().length, 3);
  writeFileSync(join(dir, OPENED_FILE), recorded().slice(0, 2).map((pull) => `${JSON.stringify(pull)}\n`).join(""));
  created("gh pr view 60", "https://github.com/a11ign/toolchain/pull/61\n");
  created("echo https://github.com/a11ign/toolchain/pull/62", "https://github.com/a11ign/toolchain/pull/62\n");
  assert.equal(recorded().length, 2, "a command that does not create one records nothing, whatever it prints");
  assert.equal(main(JSON.stringify({ tool_name: "Read", tool_input: {}, tool_response: "https://github.com/a11ign/toolchain/pull/63" }), ["post-tool-use", dir]).code, 0);
  assert.equal(recorded().length, 2, "and a tool other than Bash records nothing");
  assert.equal(toolVerdict("Write", { file_path: `/state/tickets/NBF-1/${OPENED_FILE}`, content: "{}" }).code, 2, "no worker writes the record with a file tool");
  assert.equal(bash(`echo '{}' >> /state/tickets/NBF-1/${OPENED_FILE}`), 2, "no worker writes the record with a command");
  const blocked = tmpDir("ticket-opened-").concat("/missing");
  const refused = main(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: "https://github.com/a11ign/lab/pull/9\n" } }), ["post-tool-use", blocked]);
  assert.equal(refused.code, 2, "a record that cannot be written is said out loud");
  assert.match(refused.say[0], /https:\/\/github.com\/a11ign\/lab\/pull\/9 was opened, but opened-pulls.jsonl cannot be written/);
});

test("A11-358: a drafts-off run marks the pull request it opened ready by its URL, from the record the hook made", () => {
  const dir = tmpDir("ticket-opened-");
  const url = "https://github.com/a11ign/toolchain/pull/60";
  writeFileSync(join(dir, READY_FILE), "\n");
  const ready = (command: string) => main(JSON.stringify({ tool_name: "Bash", tool_input: { command } }), ["pre-tool-use", dir]).code;
  assert.equal(ready(`gh pr ready ${url}`), 2, "before it opened one, the URL is none of its own");
  main(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create --title t" }, tool_response: { stdout: `${url}\n` } }), ["post-tool-use", dir]);
  assert.equal(ready(`gh pr ready ${url}`), 0, "after the record, it is");
  assert.equal(ready("gh pr ready"), 0, "and the pull request of its branch with no argument");
  rmSync(join(dir, READY_FILE));
  assert.equal(ready(`gh pr ready ${url}`), 2, "without the mark the record lifts nothing");
});

/** A transcript that starts a background shell and does not end it: the live work that wakes a worker whose `working` is let through (A11-85). */
const LIVE_SHELL = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm fleet:patch", run_in_background: true } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: bjag9qo4g. Output is being written to: /tmp/x." }] } }),
].join("\n");

/** A session's transcript at a path in `dir`, holding `text`. */
function transcriptIn(dir: string, text: string): string {
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, `${text}\n`);
  return path;
}

/** Writes a `working` outcome in `dir`, dated before any stop, and returns its path. */
function writeWorkingOutcome(dir: string, reason: string): string {
  const outcome = join(dir, "outcome.json");
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason }));
  utimesSync(outcome, 1000, 1000);
  return outcome;
}

test("A11-80: a working outcome lets one stop through while background work runs; a later stop on the same file is refused until it is written again, at most twice", () => {
  const dir = tmpDir("ticket-hook-working-");
  const outcome = join(dir, "outcome.json");
  const transcriptPath = transcriptIn(dir, LIVE_SHELL);
  const stop = () => stopVerdict(dir, { transcriptPath });
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the Ansible roll is still running; a Monitor wakes me" }));
  utimesSync(outcome, 1000, 1000);
  assert.equal(stop().code, 0, "the stop hook accepts working: the worker ends its turn while its own work runs");
  const woken = stop();
  assert.equal(woken.code, 2, "its background work woke it, and it stopped on the same working outcome");
  assert.match(woken.say[0], /still says working from before your background work woke you/);
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the second play is still running" }));
  utimesSync(outcome, 2000, 2000);
  assert.equal(stop().code, 0, "working written again, while more of its work runs, lets the stop through");
  writeFileSync(outcome, JSON.stringify({ kind: "needs-human", reason: "the roll failed on host 3", escalation: "access" }));
  utimesSync(outcome, 2000, 2000);
  assert.equal(stop().code, 0, "a final outcome lets every stop through, whatever its time");
  assert.equal(stop().code, 0);
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "r" }));
  utimesSync(outcome, 3000, 3000);
  assert.deepEqual(Array.from({ length: MAX_STOP_REFUSALS + 2 }, () => stop().code), [0, 2, 2, 0], "bounded by the same count as a missing outcome");
});

test("A11-85: `working` with no live background work is refused with the exact sentence, the count rises, and the stamp is not written", () => {
  const dir = tmpDir("ticket-hook-nothing-");
  writeWorkingOutcome(dir, "the fleet patch runs detached");
  const transcriptPath = transcriptIn(dir, "");
  const first = stopVerdict(dir, { transcriptPath });
  assert.equal(first.code, 2, "POSITIVE: nothing running is refused");
  assert.match(first.say[0], /nothing is running that will wake you; wait in the foreground or arm a Monitor on the process \(its PID or its log\)/);
  assert.equal(existsSync(join(dir, "working-stop")), false, "the stamp is not written");
  assert.equal(readFileSync(join(dir, "stop-refusals"), "utf8").trim(), "1", "the count rises");
  assert.equal(stopVerdict(dir, { transcriptPath }).code, 2, "the second is refused too");
  const third = stopVerdict(dir, { transcriptPath });
  assert.equal(third.code, 0, "the bound: the third stop is allowed");
  assert.match(third.say[0], /2 stops in a row on the same working outcome/, "and the count is said");
});

test("A11-85: `working` with a live background shell or Monitor is accepted and stamped; a Monitor its TaskStop ended is not live", () => {
  const dir = tmpDir("ticket-hook-live-");
  const outcome = writeWorkingOutcome(dir, "the roll runs under a Monitor");
  const monitor = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: "until false; do sleep 5; done" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "Monitor started (task bk1caggue, expires in 30m)." }] } }),
  ].join("\n");
  const accepted = stopVerdict(dir, { transcriptPath: transcriptIn(dir, monitor) });
  assert.deepEqual(accepted, { code: 0, say: [] }, "POSITIVE: a live Monitor lets it through, silently");
  assert.equal(readFileSync(join(dir, "working-stop"), "utf8"), "1000000", "and the stamp is written with the file's time, in ms");
  const stopped = `${monitor}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "k1", name: "TaskStop", input: { task_id: "bk1caggue" } }] } })}`;
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the roll is done, the Monitor stopped" }));
  utimesSync(outcome, 2000, 2000);
  assert.equal(stopVerdict(dir, { transcriptPath: transcriptIn(dir, stopped) }).code, 2, "CONTROL: a Monitor its TaskStop ended wakes nothing, so the stop is refused");
});

test("A11-245: a `working` that declares what it waits on stops with no background work running, because the board wakes the worker; a second stop on the same file is refused, and an undeclared one still is", () => {
  const dir = tmpDir("ticket-hook-declared-");
  const outcome = join(dir, "outcome.json");
  const transcriptPath = transcriptIn(dir, "");
  const stop = () => stopVerdict(dir, { transcriptPath });
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the capture runs on the fleet", waitingOn: [{ fleetJob: "fj-1" }] }));
  utimesSync(outcome, 1000, 1000);
  assert.deepEqual(stop(), { code: 0, say: [] }, "POSITIVE: a declared wait stops with an empty transcript, silently");
  assert.equal(readFileSync(join(dir, "working-stop"), "utf8"), "1000000", "and the stamp is written with the file's time");
  const woken = stop();
  assert.equal(woken.code, 2, "the board woke the worker and it stopped on the same file");
  assert.match(woken.say[0], /still says working from before the board woke you for the wait it declares/);
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "r", waitingOn: "the capture shell" }));
  utimesSync(outcome, 2000, 2000);
  const undeclared = stop();
  assert.equal(undeclared.code, 2, "CONTROL: a string waitingOn is the worker's own work, and with none running it is refused as before");
  assert.match(undeclared.say[0], /nothing is running that will wake you; .*declare what you wait on in waitingOn/);
  const bad = tmpDir("ticket-hook-declared-bad-");
  writeFileSync(join(bad, "outcome.json"), JSON.stringify({ kind: "working", reason: "r", waitingOn: [{ fleetJob: "bad id" }] }));
  assert.match(stopVerdict(bad, { transcriptPath: transcriptIn(bad, LIVE_SHELL) }).say[0], /working waitingOn\[0\] fleetJob needs a job ID/, "a declaration that does not parse is refused by name, whatever runs");
});

test("A11-85: a transcript that cannot be read lets `working` through, out loud, and the board's stall check is the backstop", () => {
  const dir = tmpDir("ticket-hook-unreadable-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "working", reason: "r" }));
  const missing = stopVerdict(dir, { transcriptPath: join(dir, "no-such-transcript.jsonl") });
  assert.equal(missing.code, 0, "allowed");
  assert.match(missing.say[0], /ticket:hook: could not read the transcript \(.*no-such-transcript\.jsonl: .*\), so working is ALLOWED\./, "said out loud");
  const unnamedDir = tmpDir("ticket-hook-unnamed-");
  writeFileSync(join(unnamedDir, "outcome.json"), JSON.stringify({ kind: "working", reason: "r" }));
  const named = stopVerdict(unnamedDir);
  assert.equal(named.code, 0);
  assert.match(named.say[0], /could not read the transcript \(the Stop payload names no transcript_path\), so working is ALLOWED\./, "no transcript named at all is the same");
});

test("A11-85: the stop payload's transcript_path is what the hook reads, through main", () => {
  const dir = tmpDir("ticket-hook-payload-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "working", reason: "r" }));
  const transcript = transcriptIn(dir, LIVE_SHELL);
  assert.equal(main(JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }), ["stop", dir]).code, 0, "POSITIVE: the payload's transcript shows live work");
  const elsewhere = tmpDir("ticket-hook-payload-elsewhere-");
  writeFileSync(join(elsewhere, "outcome.json"), JSON.stringify({ kind: "working", reason: "r" }));
  assert.equal(main(JSON.stringify({ hook_event_name: "Stop", transcript_path: join(dir, "elsewhere.jsonl") }), ["stop", elsewhere]).code, 0, "unreadable: allowed out loud");
  const nothing = tmpDir("ticket-hook-payload-nothing-");
  writeFileSync(join(nothing, "outcome.json"), JSON.stringify({ kind: "working", reason: "r" }));
  writeFileSync(join(nothing, "transcript.jsonl"), "");
  assert.equal(main(JSON.stringify({ hook_event_name: "Stop", transcript_path: join(nothing, "transcript.jsonl") }), ["stop", nothing]).code, 2, "an empty transcript: nothing will wake it");
});

// A11-84: THE HOST'S OWN PROGRAMS. A worker may not write the routing `gh` or the launcher `agent-org` in the host's bin directory, by a file tool or a command,
// and may not run the commands that install them. The reading is the pool's copy, `protected-paths.json`, beside the outcome file.
const HOME_BIN = join(homedir(), ".local", "bin");
const PROTECTED = [`${HOME_BIN}/gh`, `${HOME_BIN}/agent-org`];
const toolWrites = (file_path: string, tool = "Write") => toolVerdict(tool, { file_path }, { hostPrograms: PROTECTED }).code;
const commandWrites = (command: string) => toolVerdict("Bash", { command }, { hostPrograms: PROTECTED }).code;

test("A11-84 POSITIVE: a file tool may not write the host's gh wrapper or launcher, and a command may not write them either", () => {
  assert.equal(toolWrites(`${HOME_BIN}/gh`), 2, "a Write to the wrapper");
  assert.equal(toolWrites(`${HOME_BIN}/gh`, "Edit"), 2, "an Edit to the wrapper");
  assert.equal(toolWrites(`${HOME_BIN}/agent-org`, "MultiEdit"), 2, "a MultiEdit to the launcher");
  for (const written of [
    `cp /tmp/gh ${HOME_BIN}/gh`, `cat x > ${HOME_BIN}/gh`, `echo x >> ~/.local/bin/agent-org`, `mv new $HOME/.local/bin/gh`,
    `sed -i 's/a/b/' ${HOME_BIN}/gh`, "rm -f ~/.local/bin/gh", `chmod 755 ${HOME_BIN}/gh`, `dd if=x of=${HOME_BIN}/gh`,
    "pnpm run host:install", "pnpm run host:check --install", "node src/host-units.ts --install --allow-no-apps",
  ]) {
    assert.equal(commandWrites(written), 2, written);
  }
});

test("A11-84 CONTROL: a read of the wrapper, another program in the bin directory and the host's read-only checks are allowed", () => {
  assert.equal(toolWrites(`${HOME_BIN}/herdr`), 0, "an unrelated program in the bin directory");
  assert.equal(toolWrites(`${HOME_BIN}/gh-real`), 0, "`gh-real` is not `gh`");
  for (const read of [`cat ${HOME_BIN}/gh`, "grep -n APP_ROLES ~/.local/bin/gh", `ls -l ${HOME_BIN}`, `cp ${HOME_BIN}/gh-real /tmp/x`,
    "pnpm run host:check", "pnpm run host:check --json"]) {
    assert.equal(commandWrites(read), 0, read);
  }
});

test("A11-84: a write to the host's program is refused with the file named and whose it is", () => {
  const hit = toolVerdict("Write", { file_path: `${HOME_BIN}/gh` }, { hostPrograms: PROTECTED });
  assert.match(hit.say.join("\n"), /is the host's program, which a worker may not write/);
  assert.ok(hit.say.join("\n").includes(`${HOME_BIN}/gh`), "the refusal names the file");
  const command = toolVerdict("Bash", { command: `cp /tmp/gh ${HOME_BIN}/gh` }, { hostPrograms: PROTECTED });
  assert.ok(command.say.join("\n").includes(`${HOME_BIN}/gh, ${HOME_BIN}/agent-org are the host's programs, which a worker may not write`), command.say.join("\n"));
  assert.equal(toolVerdict("Bash", { command: "npm test" }).code, 0, "with no protected list, nothing is protected");
  assert.equal(toolVerdict("Bash", { command: "pnpm run host:install" }).code, 2, "but the install commands are refused regardless");
});

test("A11-84: a write tool's path is resolved as the disk resolves it, so a link into the bin directory is the same file", () => {
  assert.equal(resolveWritePath("/some/where/link/gh", () => HOME_BIN), `${HOME_BIN}/gh`, "a symbolic link in the directory is followed");
  assert.equal(resolveWritePath("~/x/../gh-real", (dir) => dir), join(homedir(), "gh-real"), "`~` is expanded and `..` is resolved");
});

test("A11-84: the pool's protected-paths file is read beside the outcome file, and one that is missing or unreadable falls back to the default bin directory, out loud", () => {
  const dir = tmpDir("hook-protected-paths-");
  const missing = protectedFiles(dir);
  assert.deepEqual(missing.paths, PROTECTED, "no copy: the default bin directory's programs are protected");
  assert.match(missing.note ?? "", /is missing, so the default bin directory's programs are protected/);
  writeFileSync(join(dir, PROTECTED_FILE), JSON.stringify(PROTECTED));
  assert.deepEqual(protectedFiles(dir), { paths: PROTECTED }, "POSITIVE: the copy names the two programs, with no note");
  writeFileSync(join(dir, PROTECTED_FILE), "{ not json");
  assert.deepEqual(protectedFiles(dir).paths, PROTECTED, "an unreadable copy does not leave the programs open");
  assert.match(protectedFiles(dir).note ?? "", /could not read/);
  writeFileSync(join(dir, PROTECTED_FILE), JSON.stringify([1, 2]));
  assert.match(protectedFiles(dir).note ?? "", /is not a list of paths/, "a copy that is not a list of paths is the same case");
  writeFileSync(join(dir, PROTECTED_FILE), "{ not json");
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: `${HOME_BIN}/gh` } });
  const verdict = main(payload, ["pre-tool-use", dir]);
  assert.equal(verdict.code, 2, "end to end: an unreadable copy still refuses the write to the wrapper");
  assert.match(verdict.say.join("\n"), /could not read .*so the default bin directory's programs are protected/, "and says why it fell back");
});

test("A11-84 CONTROL: a read that names the wrapper, or a host command as an argument, is allowed: only a command that writes the file is refused", () => {
  for (const read of [`grep -n install ${HOME_BIN}/gh`, `ls -ln ${HOME_BIN}/gh`, `cp ${HOME_BIN}/gh /tmp/x`, "grep -n \"host:install\" AGENTS.md", "grep -rn hostUnitsInstall src/"]) {
    assert.equal(commandWrites(read), 0, read);
  }
});

test("A11-84: the protected list is resolved as a write is, so a write through a symbolic link into the bin directory is refused", () => {
  const dir = tmpDir("hook-symlink-");
  const real = join(dir, "real");
  const link = join(dir, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  writeFileSync(join(dir, PROTECTED_FILE), JSON.stringify([join(link, "gh")]));
  const throughRealDir = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(real, "gh") } });
  assert.equal(main(throughRealDir, ["pre-tool-use", dir]).code, 2, "the real directory's file is the protected one");
  const throughLink = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(link, "gh") } });
  assert.equal(main(throughLink, ["pre-tool-use", dir]).code, 2, "and the same file named through the link is refused too");
});

test("A11-94: a new-ticket run may read the tracker through the allowed connectors, and may create nothing, whatever its connectors allow", () => {
  const writer = (tool: string) => toolVerdict(tool, {}, { writer: true, connectors: [FAKE_READS[0], /^mcp__fake__create_ticket$/] }).code;
  assert.equal(writer("mcp__fake__get_ticket"), 0, "POSITIVE CONTROL: a read the connectors allow");
  assert.equal(writer("mcp__fake__list_tickets"), 0);
  assert.equal(writer("mcp__fake__create_ticket"), 2, "a create the connectors name is still refused: the name is a read");
  assert.equal(writer("mcp__fake__save_comment"), 2);
  assert.equal(writer("mcp__plugin_slack_slack__slack_send_message"), 2, "a connector the machine does not allow");
  assert.equal(toolVerdict("mcp__fake__get_ticket", {}, { connectors: FAKE_READS }).code, 0, "a worker keeps its reads as before");
});

test("A11-94: the new-ticket mark is the board's to write, and a new-ticket run reads its own mark through the hook", () => {
  const dir = tmpDir("ticket-hook-writer-");
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  writeFileSync(join(dir, "connectors.json"), `${JSON.stringify(FAKE_READS.map((pattern) => pattern.source))}\n`);
  assert.equal(call("mcp__fake__create_ticket"), 2, "no mark: a worker's connectors are as before, and this one is not named");
  assert.equal(call("mcp__fake__get_ticket"), 0, "no mark: a worker reads as before");
  writeFileSync(join(dir, "writer-run"), "{}\n");
  assert.equal(call("mcp__fake__get_ticket"), 0);
  assert.equal(call("mcp__fake__create_ticket"), 2);
  assert.equal(call("Write", { file_path: join(dir, "writer-run") }), 2, "a worker may not write the mark");
  assert.equal(bash(`echo '{}' > ${dir}/writer-run`), 2);
});

const CREATE = "mcp__fake__create_ticket";
const UPLOAD = "mcp__fake__prepare_upload";
const ATTACH = "mcp__fake__attach_upload";

test("A11-135: a build worker is refused every filing tool by name, and the refusal names New ticket, even where its connectors allow the whole server", () => {
  for (const tool of [CREATE, UPLOAD, ATTACH, "mcp__fake__attach_file"]) {
    const verdict = toolVerdict(tool, {}, { connectors: [/^mcp__fake__/] });
    assert.equal(verdict.code, 2, tool);
    assert.match(verdict.say[0], /workers file no tickets.*use New ticket on the board/, tool);
  }
  assert.equal(toolVerdict("mcp__fake__save_comment", {}, { connectors: [/^mcp__fake__/] }).code, 0, "a comment is still a worker's to write");
});

const GRANTED: { writer: boolean; grants: string[]; created: string[] | null } = { writer: true, grants: [CREATE, UPLOAD, ATTACH], created: ["A11-140"] };

test("A11-135: a new-ticket run may create a ticket with no id and no blocks, and attach a plan only to a ticket it created", () => {
  const verdict = (tool: string, input: Record<string, unknown>, over: Partial<typeof GRANTED> = {}) => toolVerdict(tool, input, { ...GRANTED, ...over }).code;
  assert.equal(verdict(CREATE, { title: "x", team: "A11", parentId: "A11-12", relatedTo: ["A11-9"], blockedBy: ["A11-8"] }), 0, "POSITIVE CONTROL: a creation with its relations to the new ticket");
  assert.equal(verdict(UPLOAD, { ticket: "A11-140", filename: "0001-plan-x.md" }), 0);
  assert.equal(verdict(ATTACH, { ticket: "A11-140", assetUrl: "https://files.example.invalid/x", title: "A11-140-0001-plan-x.md" }), 0);
  assert.match(toolVerdict(CREATE, { id: "A11-9", title: "x" }, GRANTED).say[0], /updates an existing ticket/, "an id is an update");
  assert.equal(verdict(CREATE, { id: "7d1c5e2a-0000-4000-8000-000000000001", title: "x" }), 2, "a UUID id is an update too");
  assert.match(toolVerdict(CREATE, { title: "x", blocks: ["A11-3"] }, GRANTED).say[0], /writes a relation on another ticket/);
  assert.equal(verdict(UPLOAD, { ticket: "A11-3", filename: "x.md" }), 2, "an attachment to a ticket this run did not create");
  assert.equal(verdict(CREATE, { title: "x" }, { created: Array.from({ length: 10 }, (_, i) => `A11-${i + 1}`) }), 2, "an eleventh creation");
  assert.equal(verdict(CREATE, { title: "x" }, { created: null }), 2, "a record that cannot be read refuses a creation");
  assert.equal(verdict(UPLOAD, { ticket: "A11-140" }, { created: null }), 2, "and an attachment");
  assert.equal(toolVerdict("mcp__fake__save_comment", {}, GRANTED).code, 2, "every other write stays refused");
  assert.equal(toolVerdict("mcp__fake__delete_ticket", { id: "x" }, GRANTED).code, 2);
  assert.equal(verdict("mcp__fake__attach_file", { ticket: "A11-140" }), 2, "the plain attachment creator is not granted");
  assert.equal(verdict("mcp__fake__create_ticket", { title: "x" }, { grants: [UPLOAD] }), 2, "a tool the mark does not grant");
});

test("A11-135: the mark grants only the filing tools it names that the hook knows", () => {
  const dir = tmpDir("ticket-hook-grant-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE, "mcp__fake__delete_ticket", ATTACH] }));
  assert.deepEqual(writerGrants(dir), [CREATE, ATTACH]);
  assert.deepEqual(writerGrants(tmpDir("ticket-hook-grant-none-")), [], "no mark, no grant");
  assert.deepEqual(writerGrants(dir, () => "{not json"), [], "a mark it cannot read grants nothing");
});

test("A11-135: each creation is recorded as its result returns, by the hook alone, and a result with no key is refused out loud", () => {
  const dir = tmpDir("ticket-hook-record-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE] }));
  const found = [{ type: "text", text: JSON.stringify({ ticket: { key: "A11-140", title: "x" } }) }];
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: found }), ["post-tool-use", dir]).code, 0);
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: { key: "A11-141" } }), ["post-tool-use", dir]).code, 0);
  assert.equal(readFileSync(join(dir, CREATED_FILE), "utf8"), '{"identifier":"A11-140"}\n{"identifier":"A11-141"}\n');
  const unkeyed = main(JSON.stringify({ tool_name: CREATE, tool_response: "Created the issue." }), ["post-tool-use", dir]);
  assert.equal(unkeyed.code, 2);
  assert.match(unkeyed.say[0], /not in the result, so it is not recorded/);
  assert.equal(main(JSON.stringify({ tool_name: "Bash", tool_response: "" }), ["post-tool-use", dir]).code, 0, "another call is not a creation");
  const worker = tmpDir("ticket-hook-record-worker-");
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: found }), ["post-tool-use", worker]).code, 0);
  assert.equal(existsSync(join(worker, CREATED_FILE)), false, "a run that is not a new-ticket run records nothing");
});

test("A11-135: the record counts a run's creations, fails closed when it cannot be read, and is the board's own file", () => {
  const dir = tmpDir("ticket-hook-count-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE, UPLOAD, ATTACH] }));
  writeFileSync(join(dir, CREATED_FILE), `${Array.from({ length: 10 }, (_, i) => `{"identifier":"A11-${i + 1}"}`).join("\n")}\n`);
  const pre = (tool_name: string, tool_input: Record<string, unknown>) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  assert.equal(pre(CREATE, { title: "x" }), 2, "the eleventh creation");
  assert.equal(pre(UPLOAD, { ticket: "A11-10", filename: "x.md" }), 0, "an attachment to the tenth");
  assert.equal(pre(UPLOAD, { ticket: "A11-11", filename: "x.md" }), 2, "an attachment to a ticket past the record");
  assert.equal(pre("Write", { file_path: join(dir, CREATED_FILE) }), 2, "a worker may not write the record");
  assert.equal(pre("Bash", { command: `echo '{}' >> ${dir}/${CREATED_FILE}` }), 2, "nor append to it");
  writeFileSync(join(dir, CREATED_FILE), "garbage\n");
  assert.equal(pre(UPLOAD, { ticket: "A11-10", filename: "x.md" }), 2, "a record that cannot be read refuses the attachment");
});

const PULL_A = "https://github.com/a11ign/agent-org/pull/1841";
const PULL_B = "https://github.com/a11ign/agent-org/pull/1843";
const PLAN_WITH = (...urls: string[]): string => `# Plan\n\n${urls.length === 0 ? "" : `## What the blockers found\n\n${urls.map((url) => `- ${url}: it applies here.`).join("\n")}\n\n`}## Paths\n\n- \`agent-org:src/a.ts\`\n`;

/** A planning run's ticket dir: its outcome, the list its brief gave, and each ticket's plan folder holding `plans[key]` (file name to text). */
function planningRun(outcome: object, given: readonly { key: string; urls: readonly string[] }[], plans: Record<string, Record<string, string>>) {
  const dir = tmpDir("ticket-hook-findings-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
  const rows = given.map(({ key, urls }) => ({ key, planDir: join(dir, "plan", key), urls }));
  writeFileSync(join(dir, FINDINGS_GIVEN_FILE), JSON.stringify(rows));
  for (const { key, planDir } of rows) {
    mkdirSync(planDir, { recursive: true });
    for (const [name, text] of Object.entries(plans[key] ?? {})) writeFileSync(join(planDir, name), text);
  }
  return { dir, planDir: (key: string) => join(dir, "plan", key) };
}

const PLANNED = { kind: "planned" };

/** The planner writing its outcome again after a retry, as the refusal tells it to: a file newer than the stale mark the retry left. */
function writeOutcomeAgain(dir: string): void {
  const later = Date.now() / 1000 + 5;
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(PLANNED));
  utimesSync(join(dir, "outcome.json"), later, later);
}

test("A11-207: a planned stop whose plan misses a blocker pull request is refused once, naming it and the line form, and the next stop is allowed whatever the plan says", () => {
  const { dir, planDir } = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A, PULL_B] }], { "A11-191": { "plan.md": PLAN_WITH(PULL_B) } });
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2);
  const said = refused.say.join("\n");
  for (const part of [PULL_A, "A11-191", planDir("A11-191"), lineForm([PULL_A]), "the one automatic retry", `write ${join(dir, "outcome.json")} again as the last thing you do`]) {
    assert.ok(said.includes(part), `the refusal says ${part}`);
  }
  assert.equal(said.includes(`- ${PULL_B}: <`), false, "it asks only for what is missing");
  const mark = JSON.parse(readFileSync(join(dir, FINDINGS_RETRIED_FILE), "utf8")) as { at: number; missing: Record<string, string[]> };
  assert.deepEqual(mark.missing, { "A11-191": [PULL_A] });
  assert.equal(typeof mark.at, "number");
  assert.equal(existsSync(join(dir, "stop-refusals")), false, "the retry does not use the outcome refusal count");
  assert.equal(outcomeWritten(dir), false, "the refused outcome is stale, so the board does not settle the plan while the planner fixes it");
  writeFileSync(join(planDir("A11-191"), "plan.md"), PLAN_WITH(PULL_A, PULL_B));
  writeOutcomeAgain(dir);
  assert.equal(outcomeWritten(dir), true, "the outcome the planner writes again is the board's to read");
  assert.equal(stopVerdict(dir).code, 0, "a plan that now names both is allowed");
});

test("A11-207: a second miss is allowed through, for the board's check to send to a person, and the mark is the only thing that bounds the retry", () => {
  const { dir } = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  assert.equal(stopVerdict(dir).code, 2, "the first miss is asked for");
  writeOutcomeAgain(dir);
  assert.deepEqual(Array.from({ length: 3 }, () => stopVerdict(dir).code), [0, 0, 0], "the plan still misses it and every later stop is allowed");
});

test("A11-207: a plan that names every pull request, or a brief that listed none, is never retried, and a blocker with no pull request needs no line", () => {
  const named = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH(PULL_A) } });
  assert.equal(stopVerdict(named.dir).code, 0);
  assert.equal(existsSync(join(named.dir, FINDINGS_RETRIED_FILE)), false, "no mark when nothing was missing");
  const none = planningRun(PLANNED, [{ key: "A11-191", urls: [] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  assert.equal(stopVerdict(none.dir).code, 0, "a ticket whose blockers have no pull request on the list: a plan with no section passes");
  assert.equal(existsSync(join(none.dir, FINDINGS_RETRIED_FILE)), false);
});

test("A11-207: only a planned outcome with a list is retried: a needs-human outcome, a run with no list and a plan folder with a question or no plan are not", () => {
  const asked = planningRun({ kind: "needs-human", reason: "which?", escalation: "reserved" }, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  assert.equal(stopVerdict(asked.dir).code, 0, "a needs-human outcome");
  const unlisted = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  rmSync(join(unlisted.dir, FINDINGS_GIVEN_FILE));
  assert.equal(stopVerdict(unlisted.dir).code, 0, "a run with no findings-given list (a worker's run, or a board older than this)");
  const question = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { [QUESTION_FILE]: "**Escalation:** reserved\n\nwhich?" } });
  assert.equal(stopVerdict(question.dir).code, 0, "a ticket that wrote a question");
  const empty = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], {});
  assert.equal(stopVerdict(empty.dir).code, 0, "a plan folder with no plan is the board's refusal, not a findings one");
  assert.equal(existsSync(join(empty.dir, FINDINGS_RETRIED_FILE)), false);
});

test("A11-207: the plan is read as the board reads it: any plain markdown file of the folder counts, and a file that is not markdown does not", () => {
  const split = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "a.md": PLAN_WITH(), "b.md": `## What the blockers found\n\n- ${PULL_A}: yes.\n` } });
  assert.equal(stopVerdict(split.dir).code, 0, "the section may be in any one file");
  const text = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "a.md": PLAN_WITH(), "notes.txt": PLAN_WITH(PULL_A) } });
  assert.equal(stopVerdict(text.dir).code, 2, "a .txt file is not a plan file");
});

test("A11-207: a batch is checked ticket by ticket, and the retry names only the tickets that missed", () => {
  const { dir } = planningRun(PLANNED, [{ key: "A11-1", urls: [PULL_A] }, { key: "A11-2", urls: [PULL_B] }, { key: "A11-3", urls: [] }],
    { "A11-1": { "plan.md": PLAN_WITH(PULL_A) }, "A11-2": { "plan.md": PLAN_WITH() }, "A11-3": { "plan.md": PLAN_WITH() } });
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2);
  assert.ok(refused.say.join("\n").includes("A11-2") && !refused.say.join("\n").includes("A11-1 "), "only A11-2 is named");
  assert.deepEqual((JSON.parse(readFileSync(join(dir, FINDINGS_RETRIED_FILE), "utf8")) as { missing: object }).missing, { "A11-2": [PULL_B] });
});

test("A11-207: a list or a plan the hook cannot read lets the stop through out loud, and the board's check decides", () => {
  const garbled = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  writeFileSync(join(garbled.dir, FINDINGS_GIVEN_FILE), "{not json");
  const lenient = stopVerdict(garbled.dir);
  assert.equal(lenient.code, 0);
  assert.match(lenient.say.join("\n"), /is not a list of tickets, so the plan was not checked and the stop is ALLOWED/);
  const unreadable = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  const failing = stopVerdict(unreadable.dir, { read: (path) => { if (path.endsWith("plan.md")) throw new Error("EIO"); return readFileSync(path, "utf8"); } });
  assert.equal(failing.code, 0);
  assert.match(failing.say.join("\n"), /could not check the plan against .*findings-given\.json \(EIO\), so the stop is ALLOWED/);
  assert.equal(existsSync(join(unreadable.dir, FINDINGS_RETRIED_FILE)), false, "no retry was spent on a plan the hook could not read");
});

test("A11-207: the retry does not reset or use the outcome refusal count, so an outcome fix and the findings retry each keep their own", () => {
  const { dir, planDir } = planningRun(PLANNED, [{ key: "A11-191", urls: [PULL_A] }], { "A11-191": { "plan.md": PLAN_WITH() } });
  writeFileSync(join(dir, "stop-refusals"), "1");
  assert.equal(stopVerdict(dir).code, 2, "the findings retry");
  assert.equal(readFileSync(join(dir, "stop-refusals"), "utf8"), "1", "the count stays where the outcome problem left it");
  writeFileSync(join(planDir("A11-191"), "plan.md"), PLAN_WITH(PULL_A));
  writeOutcomeAgain(dir);
  assert.equal(stopVerdict(dir).code, 0);
  assert.equal(readFileSync(join(dir, "stop-refusals"), "utf8"), "0", "an outcome that passes resets it, as before");
});

test("A11-207: no worker may write the list its plan is checked against or the mark of its retry, by a command or a file tool", () => {
  for (const name of [FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE]) {
    assert.equal(bash(`echo '[]' > /state/tickets/A11-1/${name}`), 2, name);
    assert.equal(bash(`rm /state/tickets/A11-1/${name}`), 2, `rm ${name}`);
    assert.equal(toolVerdict("Write", { file_path: `/state/tickets/A11-1/${name}`, content: "[]" }).code, 2, `Write ${name}`);
    assert.equal(toolVerdict("Edit", { file_path: `/state/tickets/A11-1/${name}` }).code, 2, `Edit ${name}`);
  }
});

test("A11-358: the hook says when the record of the pull requests a run opened cannot be read whole, and marks nothing ready by an address it did not read", () => {
  const dir = tmpDir("ticket-opened-");
  const url = "https://github.com/a11ign/toolchain/pull/60";
  writeFileSync(join(dir, READY_FILE), "\n");
  writeFileSync(join(dir, OPENED_FILE), `{"repo":"a11ign/toolchain","url":"${url}"}\n{torn\n`);
  const answer = main(JSON.stringify({ tool_name: "Bash", tool_input: { command: `gh pr ready ${url}` } }), ["pre-tool-use", dir]);
  assert.equal(answer.code, 0, "the address it did read is the run's");
  assert.match(answer.say.join("\n"), /ticket:hook: 1 of 2 lines of opened-pulls\.jsonl are not a pull request, so only the pull requests it did read may be marked ready by URL\./);
  const other = main(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr ready https://github.com/a11ign/lab/pull/159" } }), ["pre-tool-use", dir]);
  assert.equal(other.code, 2, "one it did not read is refused");
});
