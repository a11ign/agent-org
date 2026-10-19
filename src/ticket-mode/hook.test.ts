// no-token: gh -- the hook decides on text; the one real process is `node` running `bin.ts ticket:hook`, to prove the command a settings file names works
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, main, prReviewEvent, protectedFiles, publishConnectors, resolveWritePath, stopVerdict, toolVerdict } from "./hook.ts";
import { PROTECTED_FILE, defaultBinDir, protectedPaths } from "./worker-files.ts";

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
  assert.equal(toolVerdict("mcp__claude_ai_Linear__save_comment", {}).code, 2);
  assert.equal(toolVerdict("mcp__plugin_slack_slack__slack_send_message", {}).code, 2);
  assert.equal(toolVerdict("Skill", { skill: "post-pr-to-slack" }).code, 2);
  assert.equal(toolVerdict("Skill", { skill: "clean-code-review" }).code, 0, "POSITIVE CONTROL: the review the brief asks for is allowed");
  assert.equal(toolVerdict("Skill", { skill: "nbl-ui:tool-screenshot" }).code, 0, "a machine's own screenshot skill is allowed");
  assert.equal(toolVerdict("Edit", { file_path: "/x" }).code, 0);
});

const LINEAR_READS = [/^mcp__claude_ai_Linear__(get|list|search|extract)_/];

test("a connector tool the machine names is allowed, and every other connector, a write to the same one included, is still refused", () => {
  for (const read of ["mcp__claude_ai_Linear__get_issue", "mcp__claude_ai_Linear__list_comments", "mcp__claude_ai_Linear__search_documentation"]) {
    assert.equal(toolVerdict(read, {}, { connectors: LINEAR_READS }).code, 0, read);
  }
  for (const refused of ["mcp__claude_ai_Linear__save_issue", "mcp__claude_ai_Linear__delete_attachment", "mcp__plugin_slack_slack__slack_send_message", "mcp__claude_ai_Gmail__create_draft"]) {
    const verdict = toolVerdict(refused, {}, { connectors: LINEAR_READS });
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
  const linear = JSON.stringify(["^mcp__claude_ai_Linear__(get|list)_"]);
  assert.equal(withConnectors(linear, "mcp__claude_ai_Linear__get_issue").code, 0);
  assert.equal(withConnectors(linear, "mcp__claude_ai_Linear__save_comment").code, 2);
  const broken = withConnectors("{not json", "mcp__claude_ai_Linear__get_issue");
  assert.equal(broken.code, 2);
  assert.match(broken.say[0], /could not read .*connectors\.json, so every connector is refused/);
  assert.equal(main(JSON.stringify({ tool_name: "mcp__claude_ai_Linear__get_issue", tool_input: {} }), ["pre-tool-use", tmpDir("ticket-hook-none-")]).code, 2,
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

test("a stop with no outcome is refused twice in a row, then allowed; an outcome allows it and resets the count", () => {
  const dir = tmpDir("ticket-hook-stop-");
  const verdicts = Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => stopVerdict(dir).code);
  assert.deepEqual(verdicts, [2, 2, 0]);
  writeFileSync(join(dir, "outcome.json"), "{\"kind\":\"needs-human\",\"reason\":\"r\"}");
  assert.equal(stopVerdict(dir).code, 0);
  writeFileSync(join(dir, "outcome.json"), "");
  assert.equal(stopVerdict(dir).code, 0, "the outcome file's presence decides; the pool reads what it says");
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
  assert.equal(ready("gh pr ready 12"), 2, "marking a pull request ready is still refused");
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/ready-run", content: "\n" }).code, 2, "no worker writes the ready mark with a file tool");
  assert.equal(bash("touch /state/tickets/NBF-1/ready-run"), 2, "no worker writes the ready mark with a command");
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
  writeFileSync(outcome, JSON.stringify({ kind: "needs-human", reason: "the roll failed on host 3" }));
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
  const writer = (tool: string) => toolVerdict(tool, {}, { writer: true, connectors: [LINEAR_READS[0], /^mcp__claude_ai_Linear__save_issue$/] }).code;
  assert.equal(writer("mcp__claude_ai_Linear__get_issue"), 0, "POSITIVE CONTROL: a read the connectors allow");
  assert.equal(writer("mcp__claude_ai_Linear__list_issues"), 0);
  assert.equal(writer("mcp__claude_ai_Linear__save_issue"), 2, "a create the connectors name is still refused: the name is a read");
  assert.equal(writer("mcp__claude_ai_Linear__save_comment"), 2);
  assert.equal(writer("mcp__plugin_slack_slack__slack_send_message"), 2, "a connector the machine does not allow");
  assert.equal(toolVerdict("mcp__claude_ai_Linear__get_issue", {}, { connectors: LINEAR_READS }).code, 0, "a worker keeps its reads as before");
});

test("A11-94: the new-ticket mark is the board's to write, and a new-ticket run reads its own mark through the hook", () => {
  const dir = tmpDir("ticket-hook-writer-");
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  writeFileSync(join(dir, "connectors.json"), `${JSON.stringify(LINEAR_READS.map((pattern) => pattern.source))}\n`);
  assert.equal(call("mcp__claude_ai_Linear__save_issue"), 2, "no mark: a worker's connectors are as before, and this one is not named");
  assert.equal(call("mcp__claude_ai_Linear__get_issue"), 0, "no mark: a worker reads as before");
  writeFileSync(join(dir, "writer-run"), "{}\n");
  assert.equal(call("mcp__claude_ai_Linear__get_issue"), 0);
  assert.equal(call("mcp__claude_ai_Linear__save_issue"), 2);
  assert.equal(call("Write", { file_path: join(dir, "writer-run") }), 2, "a worker may not write the mark");
  assert.equal(bash(`echo '{}' > ${dir}/writer-run`), 2);
});
