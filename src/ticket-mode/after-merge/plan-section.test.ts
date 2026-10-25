// no-token: gh -- herdr, the tracker and the clock are all injected for the pool test; the rest is pure text
// A11-277: a plan's `## After-merge checks` section names each check's runner, and the plan check refuses an owner-less After-merge line the section leaves out
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
import { withMoves } from "../after-merge-move.ts";
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

test("A11-277: a section's checks are read with their runner, escalation item, observe spec and evidence, a line holding backticks quoted in double backticks", () => {
  const read = plannedChecks([planWith(`${BOARD_MAJOR}\n- \`\`${RELEASE_LINE}\`\`\n  - Runner: person\n  - Escalation: outward\n  - Evidence: the release note, posted`)]);
  assert.deepEqual(read, { checks: [
    { line: OWNERLESS, runner: "board", observe: { kind: "sweep-ticket", scope: "a11ign/agent-org:typescript" }, evidence: "the ticket the dependency sweep filed for the next TypeScript major" },
    { line: RELEASE_LINE, runner: "person", escalation: "outward", evidence: "the release note, posted" },
  ] });
  assert.deepEqual(plannedChecks([NO_SECTION]), { checks: [] }, "a plan with no section names nothing");
  assert.deepEqual(plannedChecks([`${planWith("```md\n- `x`\n  - Runner: nobody\n```")}`]), { checks: [] }, "an example inside a fence is no check");
});

test("A11-277: a plan for a ticket with an owner-less After-merge line and no section is refused, naming the line", () => {
  assert.equal(afterMergeChecksRefusal([NO_SECTION], TICKET, []),
    `the ticket's After-merge line "${OWNERLESS}" names nobody to run it: add it to the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section with its runner`);
  assert.equal(afterMergeChecksRefusal([NO_SECTION, planWith(BOARD_MAJOR)], TICKET, []), null, "POSITIVE CONTROL: the section in another of the plan's files gives it a runner");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], TICKET.replace(OWNERLESS, `The chairman: ${OWNERLESS}`), []), null, "a line that names its owner needs no section");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], "## Done-when\n\n### After merge\n\n* None.\n", []), null, "a ticket with no After-merge line has nothing to name");
});

/** Each section that is refused, with what the refusal says. */
const REFUSED: readonly (readonly [bullets: string, says: RegExp])[] = [
  [`- \`${OWNED}\`\n  - Runner: release manager\n  - Evidence: x`, /"Chairman session: .*" has the runner "release manager", which is not `session`, `person` or `board`$/],
  [`- \`${OWNED}\`\n  - Runner: person\n  - Escalation: urgent\n  - Evidence: x`, /names the escalation item "urgent", which is not on the list \(outward, access, discard, frozen, legal, reserved, contradicts\)$/],
  [`- \`${OWNED}\`\n  - Runner: person\n  - Evidence: x`, /is the person's and names no escalation item: a check the person would run that is not on the list is the session's$/],
  [`- \`${OWNED}\`\n  - Runner: board\n  - Observe: release-notes\n  - Evidence: x`, /is the board's and its observe spec `release-notes` is not one of `sweep-ticket \[<repo>:<package>\]`, /],
  [`- \`${OWNED}\`\n  - Runner: board\n  - Evidence: x`, /is the board's and its observe spec is missing$/],
  [`- \`${OWNED}\`\n  - Runner: session\n  - Observe: wake\n  - Evidence: x`, /is the session's and names what the board observes, which only a `board` runner does$/],
  [`- \`A line the ticket never had.\`\n  - Runner: session\n  - Evidence: x\n${BOARD_MAJOR}`, /quotes "A line the ticket never had\.", which is not one of the ticket's After-merge lines$/],
  [`- \`${OWNED}\`\n  - Runner: session`, /needs its evidence on one line$/],
  [`- \`${OWNED}\`\n  - Runner: session\n  - Evidence: what was seen,\n    and where`, /needs its evidence on one line$/],
  [`- \`${OWNED}\`\n  - Runner: session\n  - Evidence: ${"x".repeat(201)}`, /gives evidence of 201 characters, more than 200: shorten it to one line of at most 200$/],
  [`- ${OWNED}\n  - Runner: session\n  - Evidence: x`, /its bullet ".*" is not `` - `<the After-merge line>` ``$/],
];

test("A11-277: a section with an unknown runner, an off-list escalation id, an unknown observe spec, or a quoted line that is not an After-merge line is refused", () => {
  for (const [bullets, says] of REFUSED) assert.match(afterMergeChecksRefusal([planWith(bullets)], TICKET, []) ?? "", says, bullets);
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
  const named = planWith(`${BOARD_MAJOR}\n- \`\`${RELEASE_LINE}\`\`\n  - Runner: session\n  - Evidence: the update log`);
  assert.equal(afterMergeChecksRefusal([named], TICKET, [move]), null, "a line the plan moves");
  assert.equal(afterMergeChecksRefusal([named], withMoves(TICKET, [move], "2026-10-25"), []), null, "a line the board moved already, quoted as it was");
  assert.match(afterMergeChecksRefusal([named], TICKET, []) ?? "", /which is not one of the ticket's After-merge lines$/, "POSITIVE CONTROL: not moved, it is a Before-merge line");
});

test("A11-277: a line the board moved names who runs it, so it needs no section even when its who is too long to read as an owner", () => {
  const moved = withMoves(TICKET.replace(`* ${OWNERLESS}\n`, ""), [{ line: RELEASE_LINE, reason: "release", who: "the person's session on the agents host, once a release is out" }], "2026-10-25");
  assert.equal(afterMergeChecksRefusal([NO_SECTION], moved, []), null);
});

test("A11-277: the planner's rule names the section, its fields, the three runners and the four observe specs", () => {
  for (const words of [AFTER_MERGE_CHECKS_HEADING, "- Runner: session", "- Escalation: <id>", "- Observe: <spec>", "- Evidence:", "sweep-ticket [<repo>:<package>]", "review <pull request URL>", "queue-merge <owner/repo>", "wake [fleetJob|ciRun|pullRequest|ticket]"]) {
    assert.ok(AFTER_MERGE_CHECKS_RULE.includes(words), words);
  }
  assert.match(AFTER_MERGE_CHECKS_RULE, /a check the person would run that is not on it is written as `session`/);
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

test("A11-277: the board refuses to attach a plan that leaves an owner-less After-merge line out of its section, and attaches one that names its runner", async () => {
  const refused = await settledPlan(NO_SECTION);
  assert.equal(refused.outcome, undefined, "A11-288: the refusal goes back to the planner, not to a person");
  assert.deepEqual(refused.attached, []);
  const attached = await settledPlan(planWith(BOARD_MAJOR));
  assert.equal(attached.outcome, undefined);
  assert.deepEqual(attached.attached, ["A11-277"]);
});

const QUOTED_LINE = "Chairman session: none shows \"The UI build is missing\" after `agent-org update`.";
const QUOTED_TICKET = ["Fix it.", "", "## Done-when", "", "### Before merge", "", "* The tests pass.", "", "### After merge", "", `* ${QUOTED_LINE}`, ""].join("\n");
const checkOf = (quoted: string): string => planWith(`- ${quoted}\n  - Runner: session\n  - Evidence: the update log`);

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
  const section = planWith(`- \`Chairman session: a release lands.\`\n  - Runner: session\n  - Evidence: the log\n- \`${line.replace(/"/g, "\u201C")}\`\n  - Runner: session\n  - Evidence: the log`);
  assert.equal(afterMergeChecksRefusal([section], ticket, [move]), null);
  assert.match(afterMergeChecksRefusal([section], ticket, []) ?? "", /which is not one of the ticket's After-merge lines$/, "POSITIVE CONTROL: not moved, it is a Before-merge line");
});

test("A11-288: the evidence refusal names the length it found and the bound", () => {
  const long = "x".repeat(250);
  const refusal = afterMergeChecksRefusal([planWith(`- \`${OWNED}\`\n  - Runner: session\n  - Evidence: ${long}`)], TICKET, []);
  assert.match(refusal ?? "", /gives evidence of 250 characters, more than 200: shorten it to one line of at most 200/);
});

test("A11-288: both planner briefs carry the section's exact format and its worked example", () => {
  for (const words of ["- `<the After-merge line, copied verbatim from the ticket>`", "  - Runner: session | person | board", "  - Evidence: <one line, at most 200 characters", "  - Escalation: <id>", "  - Observe: <spec>", "A worked example:", "  - Runner: session\n  - Evidence: each machine's update log"]) {
    assert.ok(AFTER_MERGE_CHECKS_FORMAT.includes(words), words);
  }
  const ticket = { key: "A11-1", title: "t", description: "d", url: "https://linear.app/x/A11-1", branch: "a11-1", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 };
  const single = planBriefText({ ticket, ticketDir: "/t/A11-1", planDir: "/t/A11-1/plan", attachments: [], clones: {}, run: "x" } as unknown as Parameters<typeof planBriefText>[0]);
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/r", planDir: "/r/plan", clones: {}, run: "x" } as unknown as Parameters<typeof batchPlanBriefText>[0]);
  assert.ok(single.includes(AFTER_MERGE_CHECKS_FORMAT), "the single brief");
  assert.ok(batch.includes(AFTER_MERGE_CHECKS_FORMAT), "the batch brief");
});

test("A11-288: the brief's worked example, written into a plan outside its fence, is a section the board takes", () => {
  const example = AFTER_MERGE_CHECKS_FORMAT.split("```md\n").at(-1)!.split("\n```")[0];
  const line = "Chairman session: the next release reaches every machine with its UI build.";
  const ticket = ["Fix it.", "", "## Done-when", "", "### After merge", "", `* ${line}`, ""].join("\n");
  const plan = `# Plan\n\n${example}\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;
  assert.deepEqual(plannedChecks([plan]), { checks: [{ line, runner: "session", evidence: "each machine's update log for the next release, quoted on this ticket" }] });
  assert.equal(afterMergeChecksRefusal([plan], ticket, []), null);
  assert.deepEqual(plannedChecks([`# Plan\n\n${AFTER_MERGE_CHECKS_FORMAT}\n`]), { checks: [] }, "the fenced skeleton and example in plan prose are no checks");
});
