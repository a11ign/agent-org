// no-token: gh -- the hook decides on text; the one real process is `node` running `bin.ts ticket:hook`, to prove the command a settings file names works
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, main, prReviewEvent, publishConnectors, stopVerdict, toolVerdict } from "./hook.ts";

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
    assert.equal(toolVerdict(read, {}, [], LINEAR_READS).code, 0, read);
  }
  for (const refused of ["mcp__claude_ai_Linear__save_issue", "mcp__claude_ai_Linear__delete_attachment", "mcp__plugin_slack_slack__slack_send_message", "mcp__claude_ai_Gmail__create_draft"]) {
    const verdict = toolVerdict(refused, {}, [], LINEAR_READS);
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
  return main(JSON.stringify({ tool_name: "Bash", tool_input: { command } }), ["pre-tool-use", dir]);
}

test("a review run may mark ready the pull requests the person approved, by URL, and nothing else of the person's is lifted", () => {
  const url = "https://github.com/x/app/pull/1";
  const review = (command: string) => toolVerdict("Bash", { command }, [], [], [url]).code;
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
    assert.match(refused.say[0], /run the `a11ign:clean-code-review` skill on your whole diff before you push or open a pull request/);
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
    assert.match(pushed.say[0], /pr-review\.json (cannot be read|names no skill), so the pre-PR review cannot be checked/);
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
  assert.match(pushed.say[0], /pr-review-log cannot be read/);
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
  const dir = reviewDir();
  review(dir);
  assert.equal(gateBash(dir, "git --work-tree /w commit -m x").code, 0, "the commit is allowed");
  assert.equal(gateBash(dir, "git --work-tree /w push origin b").code, 2, "and it was logged, so the push is refused");
  review(dir);
  assert.equal(gateBash(dir, "git -c user.name=\"A B\" commit -m x").code, 0, "the quoted value does not hide the commit");
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
  const publish = (tool: string, input: Record<string, unknown> = {}) => toolVerdict(tool, input, [], [], [], [SLACK]).code;
  assert.equal(publish("Skill", { skill: "post-pr-to-slack" }), 0);
  assert.equal(publish("mcp__plugin_slack_slack__slack_send_message"), 0);
  assert.equal(toolVerdict("Skill", { skill: "post-pr-to-slack" }, [], [], [], []).code, 0, "a publish run whose mark names no connector may still run the skill");
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
  const ready = (command: string) => toolVerdict("Bash", { command }, [], [], [], null, true).code;
  assert.equal(bash("gh pr create --title t --body b"), 2, "POSITIVE CONTROL: drafts on refuses a pull request that is not a draft");
  assert.equal(ready("gh pr create --title t --body b"), 0, "a ready run may open one");
  assert.equal(ready("gh pr create --draft --title t --body b"), 0, "and a draft");
  assert.equal(ready("gh pr ready 12"), 2, "marking a pull request ready is still refused");
  assert.equal(toolVerdict("Write", { file_path: "/state/tickets/NBF-1/ready-run", content: "\n" }).code, 2, "no worker writes the ready mark with a file tool");
  assert.equal(bash("touch /state/tickets/NBF-1/ready-run"), 2, "no worker writes the ready mark with a command");
});

test("A11-80: a working outcome lets one stop through; a later stop on the same file is refused until it is written again, at most twice", () => {
  const dir = tmpDir("ticket-hook-working-");
  const outcome = join(dir, "outcome.json");
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the Ansible roll is still running; a Monitor wakes me" }));
  utimesSync(outcome, 1000, 1000);
  assert.equal(stopVerdict(dir).code, 0, "the stop hook accepts working: the worker ends its turn while its own work runs");
  const woken = stopVerdict(dir);
  assert.equal(woken.code, 2, "its background work woke it, and it stopped on the same working outcome");
  assert.match(woken.say[0], /still says working from before your background work woke you/);
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the second play is still running" }));
  utimesSync(outcome, 2000, 2000);
  assert.equal(stopVerdict(dir).code, 0, "working written again, while more of its work runs, lets the stop through");
  writeFileSync(outcome, JSON.stringify({ kind: "needs-human", reason: "the roll failed on host 3" }));
  utimesSync(outcome, 2000, 2000);
  assert.equal(stopVerdict(dir).code, 0, "a final outcome lets every stop through, whatever its time");
  assert.equal(stopVerdict(dir).code, 0);
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "r" }));
  utimesSync(outcome, 3000, 3000);
  assert.deepEqual(Array.from({ length: MAX_STOP_REFUSALS + 2 }, () => stopVerdict(dir).code), [0, 2, 2, 0], "bounded by the same count as a missing outcome");
});
