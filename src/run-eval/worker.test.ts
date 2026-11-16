// no-token: gh -- builds text and reads JSON; nothing here reaches `gh`, `git`, `claude` or the tracker
/** A11-431: the eval's worker gets the brief the board would write today, the worker's settings without the board's hooks, the board's flags headless, and its tokens are read from its result. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYWORDS, type Ticket } from "../ticket-mode/source.ts";
import { ticketReadOf } from "../ticket-mode/ticket-read.ts";
import { briefText, workerFlags } from "../ticket-mode/worker-files.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lessonsDir, lessonsPath, writeLessons, type Lesson } from "../ticket-mode/retro/lessons-store.ts";
import { evalBrief, evalSettings, hostLessons, tokensOfResult, workerArgs, type HostBrief, type Place } from "./worker.ts";

const TICKET: Ticket = { key: "A11-1", title: "Fix the thing", description: "## Acceptance criteria\n\nIt works.", url: "https://linear.app/a11ign/issue/A11-1", branch: "admin/a11-1-fix",
  status: "Done", statusOrder: 0, team: "A11", project: null, priority: 2, parent: null, updatedAt: "2026-11-01T00:00:00.000Z" };
const PLACE: Place = { folder: "/eval/folder", ticketDir: "/eval/ticket", clones: { "agent-org": "/eval/clone" }, standIns: "/eval/bin" };
const HOST: HostBrief = { notes: "# House rules\n", plugins: ["a11ign@a11ign"], drafts: false, prReview: null, localReview: false, lessons: [], keywords: DEFAULT_KEYWORDS, binDir: "/home/x/.local/bin" };

test("the brief is today's `briefText` with the ticket's parent, pointed at the eval's clone and its stand-in commands, with no connector", () => {
  const parent = { ticket: { ...TICKET, key: "A11-0", title: "The epic" }, attachments: ["/eval/ticket/parent/epic-plan.md"] };
  const brief = evalBrief({ ticket: TICKET, attachments: ["/eval/ticket/plan.md"], parent, place: PLACE, host: HOST, repo: "agent-org", now: 5 });
  assert.equal(brief, briefText({ ticket: TICKET, folder: PLACE.folder, ticketDir: PLACE.ticketDir, attachments: ["/eval/ticket/plan.md"], parent, clones: PLACE.clones, repo: "agent-org",
    worktreeCommand: "/eval/bin/eval-worktree", prOpenCommand: "/eval/bin/eval-pr-open", notes: HOST.notes, connectors: [], drafts: false, designTools: false, capture: false, prReview: null,
    keywords: DEFAULT_KEYWORDS, read: ticketReadOf(TICKET, 5), lessons: [] }));
  assert.match(brief, /`\/eval\/bin\/eval-worktree <repo>`/);
  assert.match(brief, /# House rules/);
  assert.match(brief, /A11-0: The epic/, "the parent's Decisions bind the worker, so the parent is in its brief");
  assert.match(brief, /epic-plan\.md/);
  assert.doesNotMatch(brief, /ticket:worktree|pr:open create/, "no command of the real board is named");
});

const LESSON: Lesson = { id: "L1", text: "Add a changeset for every user-visible change", runs: ["A11-7@100", "A11-8@200"], since: 100, confirmedAt: 200 };

test("A11-432: the brief carries the lessons of its own repository from the host, and no other repository's", () => {
  const host: HostBrief = { ...HOST, lessons: [{ repo: "agent-org", lessons: [LESSON] }, { repo: "control", lessons: [{ ...LESSON, id: "L2", text: "Run the play on one box first" }] }] };
  const brief = evalBrief({ ticket: TICKET, attachments: [], parent: null, place: PLACE, host, repo: "agent-org", now: 5 });
  assert.match(brief, /## Lessons from earlier runs/);
  assert.match(brief, /- Add a changeset for every user-visible change \(runs: A11-7@100, A11-8@200\)/);
  assert.doesNotMatch(brief, /Run the play on one box first/, "lessons are never shared across repositories");
  assert.doesNotMatch(evalBrief({ ticket: TICKET, attachments: [], parent: null, place: PLACE, host: HOST, repo: "agent-org", now: 5 }), /Lessons from earlier runs/);
});

test("A11-432: the host's lessons are every repository's file while tickets.lessons is on, and none while it is off", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "eval-lessons-"));
  try {
    writeLessons(stateDir, "agent-org", [LESSON]);
    writeLessons(stateDir, "control", []);
    const said: string[] = [];
    assert.deepEqual(hostLessons({ on: true, stateDir, log: (line) => said.push(line) }), [{ repo: "agent-org", lessons: [LESSON] }]);
    assert.deepEqual(hostLessons({ on: false, stateDir, log: (line) => said.push(line) }), [], "off, the files are not read into the brief");
    writeFileSync(lessonsPath(stateDir, "control"), "{ not json");
    assert.deepEqual(hostLessons({ on: true, stateDir, log: (line) => said.push(line) }), [{ repo: "agent-org", lessons: [LESSON] }]);
    assert.match(said.join("\n"), /the lessons of control are left out of the brief/, "a file that cannot be read is said and left out");
    rmSync(lessonsDir(stateDir), { recursive: true });
    writeFileSync(lessonsDir(stateDir), "not a folder");
    assert.deepEqual(hostLessons({ on: true, stateDir, log: (line) => said.push(line) }), [], "a folder that cannot be listed carries no lessons, and stops nothing");
    assert.match(said.join("\n"), /no lessons are carried: their folder cannot be listed/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("with tickets.localReview on, the brief asks for the review of the local diff before the pull request opens, by the eval's stand-in; off, it asks for none (A11-440)", () => {
  const brief = (localReview: boolean) => evalBrief({ ticket: TICKET, attachments: [], parent: null, place: PLACE, host: { ...HOST, localReview }, repo: "agent-org", now: 5 });
  assert.equal(brief(true), briefText({ ticket: TICKET, folder: PLACE.folder, ticketDir: PLACE.ticketDir, attachments: [], parent: null, clones: PLACE.clones, repo: "agent-org",
    worktreeCommand: "/eval/bin/eval-worktree", prOpenCommand: "/eval/bin/eval-pr-open", localReviewCommand: "/eval/bin/eval-review-local", notes: HOST.notes, connectors: [], drafts: false,
    designTools: false, capture: false, prReview: null, keywords: DEFAULT_KEYWORDS, read: ticketReadOf(TICKET, 5) }));
  assert.match(brief(true), /^5b\. .*`\/eval\/bin\/eval-review-local`/m);
  assert.doesNotMatch(brief(true), /ticket:review-local/, "no command of the real board is named");
  assert.doesNotMatch(brief(false), /^5b\. |eval-review-local/m);
});

test("the settings are a worker's without the board's hooks, with the host's own gh and agent-org denied by path", () => {
  const settings = evalSettings({ model: "opus", place: PLACE, host: HOST });
  assert.equal("hooks" in settings, false);
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.enabledPlugins, { "a11ign@a11ign": true });
  assert.deepEqual(settings.permissions, { defaultMode: "bypassPermissions", additionalDirectories: ["/eval/ticket", "/eval/clone"],
    deny: ["Bash(/home/x/.local/bin/gh:*)", "Bash(/home/x/.local/bin/agent-org:*)"] });
});

test("the command line is headless, with no MCP server, and ends with the board's own worker flags", () => {
  const args = workerArgs({ name: "eval-A11-1", model: "sonnet", effort: "medium", ticketDir: "/eval/ticket" });
  assert.deepEqual(args.slice(0, 5), ["Read /eval/ticket/brief.md and follow it.", "-p", "--output-format", "json", "--strict-mcp-config"]);
  assert.deepEqual(args.slice(5), workerFlags({ name: "eval-A11-1", model: "sonnet", effort: "medium", addDirs: ["/eval/ticket"] }));
});

test("tokens are every model's from the result, else the main thread's usage, and unknown when there is no result", () => {
  const result = { type: "result", usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-opus": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 4000 }, "claude-haiku": { inputTokens: 5, outputTokens: 0 } } };
  assert.equal(tokensOfResult(`${JSON.stringify(result)}\n`), 4335);
  assert.equal(tokensOfResult(JSON.stringify({ type: "result", usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } })), 18);
  assert.equal(tokensOfResult("Error: not logged in"), null);
  assert.equal(tokensOfResult(JSON.stringify({ type: "result" })), null);
  assert.equal(tokensOfResult("null"), null);
});
