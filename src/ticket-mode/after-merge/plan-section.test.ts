// no-token: gh -- herdr, the tracker and the clock are all injected for the pool test; the rest is pure text
// A11-277, A11-302: a plan's `## After-merge checks` section names each check's runner (board, agent or person), and the plan check refuses a line the section leaves out and any use of the session
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeTracker } from "../../plugins/fakes/tracker.ts";
import { herdrName } from "../pool.ts";
import { poolFixture } from "../pool-fixture.ts";
import type { Outcome } from "../queue/queue-entries-and-outcomes.ts";
import type { TicketSource } from "../source.ts";
import { ticketDir } from "../ticket-paths.ts";
import { afterMergeLines } from "../done-when.ts";
import { withMoves } from "../after-merge-move.ts";
import { namesLine, seedChecks } from "./checks.ts";
import { AFTER_MERGE_CHECKS_FORMAT, AFTER_MERGE_CHECKS_HEADING, AFTER_MERGE_CHECKS_RULE, afterMergeChecksRefusal, plannedChecks } from "./plan-section.ts";
import { batchPlanBriefText, planBriefText } from "../worker-files.ts";

const OWNERLESS = "The next major arrives as a ticket.";
const OWNED = "Chairman session: the next stacked step merges with no person.";
const RELEASE_LINE = "A real `agent-org update` installs the UI build.";
const TICKET = ["Fix it.", "", "## Done-when", "", "### Before merge", "", "* The tests pass.", `* ${RELEASE_LINE}`, "", "### After merge", "", `* ${OWNERLESS}`, `* ${OWNED}`, ""].join("\n");

/** A plan whose `## After-merge checks` section holds `bullets`. */
const planWith = (bullets: string): string => `# Plan\n\n## Approach\n\nDo it.\n\n${AFTER_MERGE_CHECKS_HEADING}\n\n${bullets}\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;
const NO_SECTION = "# Plan\n\n## Approach\n\nDo it.\n\n## Paths\n\n- `agent-org:src/a.ts`\n";
const BOARD_MAJOR = `- \`${OWNERLESS}\`\n  - Runner: board\n  - Observe: \`sweep-ticket a11ign/agent-org:typescript\`\n  - Evidence: the ticket the dependency sweep filed for the next TypeScript major`;
const AGENT_OWNED = `- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: the board's log for the next stacked step, quoted`;

test("A11-277: a section's checks are read with their runner, escalation item, observe spec and evidence, a line holding backticks quoted in double backticks", () => {
  const read = plannedChecks([planWith(`${BOARD_MAJOR}\n- \`\`${RELEASE_LINE}\`\`\n  - Runner: person\n  - Escalation: outward\n  - Evidence: the release note, posted`)]);
  assert.deepEqual(read, { checks: [
    { line: OWNERLESS, runner: "board", observe: { kind: "sweep-ticket", scope: "a11ign/agent-org:typescript" }, evidence: "the ticket the dependency sweep filed for the next TypeScript major" },
    { line: RELEASE_LINE, runner: "person", escalation: "outward", evidence: "the release note, posted" },
  ] });
  assert.deepEqual(plannedChecks([NO_SECTION]), { checks: [] }, "a plan with no section names nothing");
  assert.deepEqual(plannedChecks([`${planWith("```md\n- `x`\n  - Runner: nobody\n```")}`]), { checks: [] }, "an example inside a fence is no check");
});

test("A11-302: a plan that leaves any After-merge line out of its section is refused, naming the line, whoever the line names", () => {
  const missing = (line: string) => `the ticket's After-merge line "${line}" has no runner in the plan: add it to the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section with its runner (\`board\`, \`agent\` or \`person\`)`;
  assert.equal(afterMergeChecksRefusal([NO_SECTION], TICKET, []), missing(OWNERLESS));
  assert.equal(afterMergeChecksRefusal([planWith(BOARD_MAJOR)], TICKET, []), missing(OWNED), "a line that names the chairman's session is refused until the plan gives it a runner");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], TICKET.replace(OWNERLESS, `The chairman: ${OWNERLESS}`), []), missing(`The chairman: ${OWNERLESS}`), "a line that names its owner needs a runner too");
  assert.equal(afterMergeChecksRefusal([NO_SECTION, planWith(`${BOARD_MAJOR}\n${AGENT_OWNED}`)], TICKET, []), null, "POSITIVE CONTROL: the section in another of the plan's files gives each line a runner");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], "## Done-when\n\n### After merge\n\n* None.\n", []), null, "a ticket with no After-merge line has nothing to name");
});

test("A11-302: a line that names the chairman's session is given the runner board or agent by the plan, which is the way out of the refusal", () => {
  const read = plannedChecks([planWith(`${BOARD_MAJOR}\n${AGENT_OWNED}`)]);
  assert.ok("checks" in read);
  assert.deepEqual(read.checks.map(({ line, runner }) => [line, runner]), [[OWNERLESS, "board"], [OWNED, "agent"]]);
});

/** Each section that is refused, with what the refusal says. */
const REFUSED: readonly (readonly [bullets: string, says: RegExp])[] = [
  [`- \`${OWNED}\`\n  - Runner: release manager\n  - Evidence: x`, /"Chairman session: .*" has the runner "release manager", which is not `board`, `agent` or `person`$/],
  [`- \`${OWNED}\`\n  - Runner: person\n  - Escalation: urgent\n  - Evidence: x`, /names the escalation item "urgent", which is not on the list \(outward, access, discard, frozen, legal, reserved, contradicts\)$/],
  [`- \`${OWNED}\`\n  - Runner: person\n  - Evidence: x`, /is the person's and names no escalation item: a check the person would run that is not on the list is an `agent` check$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Escalation: legal\n  - Evidence: x`, /is the agent's and names an escalation item, which only a `person` runner does$/],
  [`- \`${OWNED}\`\n  - Runner: board\n  - Observe: release-notes\n  - Evidence: x`, /is the board's and its observe spec `release-notes` is not one of `sweep-ticket \[<repo>:<package>\]`, /],
  [`- \`${OWNED}\`\n  - Runner: board\n  - Evidence: x`, /is the board's and its observe spec is missing$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Observe: wake\n  - Evidence: x`, /is the agent's and names what the board observes \(Observe, Pass or Window\), which only a `board` runner does$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Window: 7d\n  - Evidence: x`, /is the agent's and names what the board observes \(Observe, Pass or Window\), which only a `board` runner does$/],
  [`- \`A line the ticket never had.\`\n  - Runner: agent\n  - Evidence: x\n${BOARD_MAJOR}`, /quotes "A line the ticket never had\.", which is not one of the ticket's After-merge lines$/],
  [`- \`${OWNED}\`\n  - Runner: agent`, /needs its evidence on one line$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: what was seen,\n    and where`, /needs its evidence on one line$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: ${"x".repeat(201)}`, /gives evidence of 201 characters, more than 200: shorten it to one line of at most 200$/],
  [`- ${OWNED}\n  - Runner: agent\n  - Evidence: x`, /its bullet ".*" is not `` - `<the After-merge line>` ``$/],
  // A11-302: the person's session is no runner, and no field may name the chairman's session.
  [`- \`${OWNED}\`\n  - Runner: session\n  - Evidence: x`, /has the runner "session", which is no runner: the person's session runs no check\. Use `board` \(with `Observe:`\) for what the board can see, `agent` for a verifier run after release, or `person` with an `Escalation:` item$/],
  [`- \`${OWNED}\`\n  - Runner: Session\n  - Evidence: x`, /has the runner "Session", which is no runner/],
  [`- \`${OWNED}\`\n  - Runner: Chairman session\n  - Evidence: x`, /names the chairman's session in its runner, which runs no check: the org verifies its own work, so give the line the runner `board` or `agent`$/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: the Chairman session reads the log`, /names the chairman's session in its evidence, which runs no check/],
  [`- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: the chairman\u2019s session reads the log`, /names the chairman's session in its evidence/],
];

test("A11-277: a section with an unknown runner, an off-list escalation id, an unknown observe spec, or a quoted line that is not an After-merge line is refused", () => {
  for (const [bullets, says] of REFUSED) assert.match(afterMergeChecksRefusal([planWith(bullets)], TICKET, []) ?? "", says, bullets);
});

test("A11-302: the windowed specs are read from Observe, Pass and Window, and a plan that leaves Pass or Window out is refused", () => {
  const read = (observe: string, extra: string) => plannedChecks([planWith(`- \`${OWNERLESS}\`\n  - Runner: board\n  - Observe: ${observe}\n${extra}  - Evidence: x`)]);
  const ok = read("run-log finished \"lost in a restart\"", "  - Pass: absent\n  - Window: 7d\n");
  assert.deepEqual("checks" in ok && ok.checks[0].observe, { kind: "run-log", event: "finished", match: "lost in a restart", pass: "absent", windowMs: 7 * 24 * 60 * 60_000 });
  assert.match(JSON.stringify(read("run-log finished", "  - Window: 7d\n")), /needs `Pass: absent \| present`/);
  assert.match(JSON.stringify(read("run-log finished", "  - Pass: absent\n")), /the window is missing/);
  assert.match(JSON.stringify(read("wake", "  - Pass: absent\n  - Window: 7d\n")), /takes no Pass or Window/);
  assert.match(afterMergeChecksRefusal([planWith(`${AGENT_OWNED}\n- \`${OWNERLESS}\`\n  - Runner: board\n  - Observe: doctor here node\n  - Pass: present\n  - Evidence: x`)], TICKET, []) ?? "", /the window is missing/);
});

test("A11-277: each of the four observe specs is read, and a malformed argument is not", () => {
  const spec = (observe: string) => {
    const read = plannedChecks([planWith(`- \`${OWNERLESS}\`\n  - Runner: board\n  - Observe: ${observe}\n  - Evidence: x`)]);
    return "checks" in read ? read.checks[0].observe : read.refusal;
  };
  assert.deepEqual(spec("sweep-ticket"), { kind: "sweep-ticket" });
  assert.deepEqual(spec("`review https://github.com/a11ign/lab/pull/12`"), { kind: "review", url: "https://github.com/a11ign/lab/pull/12" });
  assert.deepEqual(spec("queue-merge a11ign/agent-org"), { kind: "queue-merge", repository: "a11ign/agent-org" });
  assert.deepEqual(spec("wake"), { kind: "wake" });
  assert.deepEqual(spec("wake fleetJob"), { kind: "wake", wait: "fleetJob" });
  for (const bad of ["review", "review https://github.com/a11ign/lab/issues/12", "queue-merge agent-org", "wake fleet", "sweep-ticket typescript"]) assert.match(String(spec(bad)), /is not one of/, bad);
});

test("A11-277: a Before-merge line the plan moves to After merge (A11-275) may be named, as quoted or as the board moved it, and an owner-less moved line is never refused", () => {
  const move = { line: RELEASE_LINE, reason: "release" as const, who: "Chairman session" };
  const named = planWith(`${BOARD_MAJOR}\n${AGENT_OWNED}\n- \`\`${RELEASE_LINE}\`\`\n  - Runner: agent\n  - Evidence: the update log`);
  assert.equal(afterMergeChecksRefusal([named], TICKET, [move]), null, "a line the plan moves");
  assert.equal(afterMergeChecksRefusal([named], withMoves(TICKET, [move], "2026-10-25"), []), null, "a line the board moved already, quoted as it was");
  assert.match(afterMergeChecksRefusal([named], TICKET, []) ?? "", /which is not one of the ticket's After-merge lines$/, "POSITIVE CONTROL: not moved, it is a Before-merge line");
});

test("A11-277: a line the board moved names who runs it, so it needs no section even when its who is too long to read as an owner", () => {
  const moved = withMoves(TICKET.replace(`* ${OWNERLESS}\n`, "").replace(`* ${OWNED}\n`, ""), [{ line: RELEASE_LINE, reason: "release", who: "the person's session on the agents host, once a release is out" }], "2026-10-25");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], moved, []), null);
});

test("A11-302: the planner's rule names the section, its fields, the three runners, the nine observe specs, and refuses the session", () => {
  for (const words of [AFTER_MERGE_CHECKS_HEADING, "`- Runner: board`, `agent` or `person`", "- Escalation: <id>", "- Observe: <spec>", "- Pass: absent | present", "- Window: <30m | 6h | 7d>", "- Evidence:",
    "sweep-ticket [<repo>:<package>]", "review <pull request URL>", "queue-merge <owner/repo>", "wake [fleetJob|ciRun|pullRequest|ticket]",
    "run-log <event kind> [<text>]", "merge-queue <owner/repo> [<failed job>]", "ci-history <owner/repo> <workflow> [<branch>]", "doctor <host> <check>", "release-assets <owner/repo> <asset> [<count>]"]) {
    assert.ok(AFTER_MERGE_CHECKS_RULE.includes(words), words);
  }
  assert.match(AFTER_MERGE_CHECKS_RULE, /The org verifies its own work: `session` is not a runner, and the plan is refused if it names it or names the chairman's session in any field/);
  assert.match(AFTER_MERGE_CHECKS_RULE, /A week-long check \("for a week, no X happens"\) is a `board` check with `Pass: absent` and `Window: 7d`: it passes when the window closes clean, and fails on the first breach, citing the event/);
  assert.match(AFTER_MERGE_CHECKS_RULE, /A check a person would merely run is an `agent` check/);
  assert.ok(!/is written as `session`/.test(AFTER_MERGE_CHECKS_RULE), "the old rule is gone");
});

const fake = createFakeTracker();
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A planner for A11-277 whose ticket is {@link TICKET} ends on the plan `text`: what the board did with it. */
async function settledPlan(text: string) {
  const attached: string[] = [];
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, keywords: fake.keywords, download: fake.download, attachPlan: async (key) => { attached.push(key); return null; } };
  const made = poolFixture({ keys: ["A11-277"], max: 1, source, planFirst: ["A11-277"], descriptions: { "A11-277": TICKET },
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } } });
  await made.pool.tick();
  const dir = ticketDir(made.settings, "A11-277");
  writeFileSync(join(dir, "plan", "A11-277-0001-plan-checks.md"), text);
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  made.status.set(herdrName("A11-277"), "idle");
  await made.pool.tick();
  await settled();
  const outcome = made.entry("A11-277").outcome;
  return { outcome, reason: reasonOf(outcome), attached };
}

test("A11-302: the board refuses to attach a plan that leaves an After-merge line out of its section, or runs one on the session, and attaches one that names a runner for each", async () => {
  const refused = await settledPlan(NO_SECTION);
  assert.equal(refused.outcome, undefined, "A11-288: the refusal goes back to the planner, not to a person");
  assert.deepEqual(refused.attached, []);
  const onSession = await settledPlan(planWith(`${BOARD_MAJOR}\n- \`${OWNED}\`\n  - Runner: session\n  - Evidence: x`));
  assert.equal(onSession.outcome, undefined, "a plan that names the session is sent back to the planner too");
  assert.deepEqual(onSession.attached, []);
  const attached = await settledPlan(planWith(`${BOARD_MAJOR}\n${AGENT_OWNED}`));
  assert.equal(attached.outcome, undefined);
  assert.deepEqual(attached.attached, ["A11-277"]);
});

const QUOTED_LINE = "Chairman session: none shows \"The UI build is missing\" after `agent-org update`.";
const QUOTED_TICKET = ["Fix it.", "", "## Done-when", "", "### Before merge", "", "* The tests pass.", "", "### After merge", "", `* ${QUOTED_LINE}`, ""].join("\n");
const checkOf = (quoted: string): string => planWith(`- ${quoted}\n  - Runner: agent\n  - Evidence: the update log`);

test("A11-288: a ticket line with inner double quotes and a backtick is matched by its copy in double backticks, with curly quotes, with an escaped quote, and with a doubled space", () => {
  const copies = {
    "double backticks": `\`\`${QUOTED_LINE}\`\``,
    "curly quotes": `\`\`${QUOTED_LINE.replace(/"The UI build is missing"/, "\u201CThe UI build is missing\u201D")}\`\``,
    "escaped quote": `\`\`${QUOTED_LINE.replace(/"/g, '\\"')}\`\``,
    "doubled space": `\`\`${QUOTED_LINE.replace("none shows", "none  shows")}\`\``,
    "no inner backticks": `\`\`${QUOTED_LINE.replaceAll("`", "")}\`\``,
  };
  for (const [what, copy] of Object.entries(copies)) assert.equal(afterMergeChecksRefusal([checkOf(copy)], QUOTED_TICKET, []), null, what);
  assert.match(afterMergeChecksRefusal([checkOf(`\`\`${QUOTED_LINE.replace("missing", "present")}\`\``)], QUOTED_TICKET, []) ?? "", /which is not one of the ticket's After-merge lines$/, "POSITIVE CONTROL: a word changed is another line");
});

test("A11-288: a moved line with inner quotes matches its copy in the plan's section", () => {
  const line = "The banner says \"UI build missing\" no more.";
  const ticket = ["Fix it.", "", "## Done-when", "", "### Before merge", "", `* ${line}`, "", "### After merge", "", "* Chairman session: a release lands.", ""].join("\n");
  const move = { line, reason: "release" as const, who: "Chairman session" };
  const section = planWith(`- \`Chairman session: a release lands.\`\n  - Runner: agent\n  - Evidence: the log\n- \`${line.replace(/"/g, "\u201C")}\`\n  - Runner: agent\n  - Evidence: the log`);
  assert.equal(afterMergeChecksRefusal([section], ticket, [move]), null);
  assert.match(afterMergeChecksRefusal([section], ticket, []) ?? "", /which is not one of the ticket's After-merge lines$/, "POSITIVE CONTROL: not moved, it is a Before-merge line");
});

test("A11-288: the evidence refusal names the length it found and the bound", () => {
  const long = "x".repeat(250);
  const refusal = afterMergeChecksRefusal([planWith(`- \`${OWNED}\`\n  - Runner: agent\n  - Evidence: ${long}`)], TICKET, []);
  assert.match(refusal ?? "", /gives evidence of 250 characters, more than 200: shorten it to one line of at most 200/);
});

test("A11-302: both planner briefs carry the section's exact format and its worked examples", () => {
  for (const words of ["- `<the After-merge line, copied verbatim from the ticket>`", "  - Runner: board | agent | person", "  - Evidence: <one line, at most 200 characters", "  - Escalation: <id>", "  - Observe: <spec>", "  - Pass: absent | present", "  - Window: <30m | 6h | 7d>",
    "A worked example of a `board` check, and of an `agent` check:", "  - Runner: board\n  - Observe: run-log finished \"lost in a restart\"\n  - Pass: absent\n  - Window: 7d", "  - Runner: agent\n  - Evidence: a screenshot of the settings page on the host",
    "`session` is not a runner, and no field names the chairman's session"]) {
    assert.ok(AFTER_MERGE_CHECKS_FORMAT.includes(words), words);
  }
  const ticket = { key: "A11-1", title: "t", description: "d", url: "https://linear.app/x/A11-1", branch: "a11-1", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 };
  const single = planBriefText({ ticket, ticketDir: "/t/A11-1", planDir: "/t/A11-1/plan", attachments: [], clones: {}, run: "x" } as unknown as Parameters<typeof planBriefText>[0]);
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/r", planDir: "/r/plan", clones: {}, run: "x" } as unknown as Parameters<typeof batchPlanBriefText>[0]);
  assert.ok(single.includes(AFTER_MERGE_CHECKS_FORMAT), "the single brief");
  assert.ok(batch.includes(AFTER_MERGE_CHECKS_FORMAT), "the batch brief");
});

test("A11-302: the brief's worked examples, written into a plan outside their fence, are a section the board takes, and each is a runner the board records", () => {
  const example = AFTER_MERGE_CHECKS_FORMAT.split("```md\n").at(-1)!.split("\n```")[0];
  const lines = ["For a week after release, no run is lost in a restart.", "The next release's settings page shows the new field."];
  const ticket = ["Fix it.", "", "## Done-when", "", "### After merge", "", ...lines.map((line) => `* ${line}`), ""].join("\n");
  const plan = `# Plan\n\n${example}\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;
  const read = plannedChecks([plan]);
  assert.deepEqual(read, { checks: [
    { line: lines[0], runner: "board", observe: { kind: "run-log", event: "finished", match: "lost in a restart", pass: "absent", windowMs: 7 * 24 * 60 * 60_000 }, evidence: "the run log of every ticket, quoted if a run was lost" },
    { line: lines[1], runner: "agent", evidence: "a screenshot of the settings page on the host, quoted on this ticket" },
  ] });
  assert.equal(afterMergeChecksRefusal([plan], ticket, []), null);
  assert.deepEqual(plannedChecks([`# Plan\n\n${AFTER_MERGE_CHECKS_FORMAT}\n`]), { checks: [] }, "the fenced skeleton and example in plan prose are no checks");
});

test("A11-288: a plan's copy of a moved line, with other quotes, still names the line the board moved, so the sweep gives its record the plan's runner", () => {
  const line = "The banner says \"UI build missing\" no more.";
  const moved = withMoves(["Fix it.", "", "## Done-when", "", "### Before merge", "", `* ${line}`, "", "### After merge", "", "* Chairman session: a release lands.", ""].join("\n"), [{ line, reason: "release", who: "Chairman session" }], "2026-10-25");
  const [, boardMoved] = afterMergeLines(moved);
  const copy = line.replace(/"/g, "\u201C");
  assert.equal(namesLine(copy, boardMoved.line), true);
  assert.equal(namesLine(copy.replace("no more", "any more"), boardMoved.line), false, "POSITIVE CONTROL: a word changed is another line");
  const file = seedChecks({ checks: {} }, [{ ticket: { key: "NBF-1" }, afterMerge: [boardMoved] }], 1, new Map([["NBF-1", [{ line: copy, runner: "person" as const, escalation: "outward", evidence: "the release note" }]]]));
  assert.equal(file.checks["NBF-1#1"].runner, "person");
  assert.equal(file.checks["NBF-1#1"].evidence, "the release note");
});
