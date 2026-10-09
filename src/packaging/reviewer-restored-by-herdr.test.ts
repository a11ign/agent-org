// no-token: gh -- every `gh`, `herdr` and `git` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #3458: A REVIEWER THE TEARDOWN ENDED CAME BACK WHEN HERDR RESTARTED AND RESTORED ITS WORKSPACE, AND NOTHING LOOKED AT IT AGAIN (agent-org #35, #36).
 *
 * Measured 2026-10-02: `endFinishedReviewers` closed `reviewer-agent-org-35` and `-36` at 19:10:39Z, `herdr` panicked at 19:10:42Z, and the workspaces
 * were restored at 19:10:50Z with `codex resume` in `/home/agent`, stopped at Codex's working-directory picker for two days. An ending deletes the
 * registry key and the teardown walked only the keys, so a workspace that came back after one was, to it, a pane nobody started.
 *
 * WHAT IS PINNED, in the row's own words: a workspace on the listing that carries an instance's label and is NOT in the registry is asked of its pull
 * request's OWN repository and ended when that is closed or merged (the positive control, which fails on the code before #3458 because it never reads
 * one); left when open; left when the state cannot be read; and `reviewer-2`, `reviewer-1` and every other name that is not an instance are never
 * touched. The same sweep is reached by the tick's entry (`tearDownReviewers`) with an EMPTY registry, which is exactly the shape of the incident and
 * the line that used to return before looking. Every clock and listing is injected; the process-level one is a stub on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endFinishedReviewers, restoredReviewers, tearDownReviewers, reviewerPathsFrom, promptOnScreen, readPromptPanes, panePromptOrdersNow, PROMPT_SCREENS } from "../wake.ts";
import { panePromptReading, PANE_PROMPT_MINUTES, SIGNALS } from "../org-health.ts";
import { REPO } from "../project-identity.ts";

const T0 = 1_791_000_000_000;
const STUB_MODE = 0o755;
const RESTORED = "reviewer-agent-org-36";

type Live = Record<string, string>;

/** One teardown pass with the seams recorded: `states` answers each `repo-key/number` it is asked about, and a missing one is "could not read". */
function sweep(live: Live, { registry = {}, states = { "agent-org/36": "closed" } as Record<string, string | null> } = {}) {
  const asked: string[] = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const warns: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: Object.entries(live).map(([label, agent_status], i) => ({ label, agent_status, workspace_id: `w${i}` })) } });
    }
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const got = endFinishedReviewers(Object.entries(live).map(([label, status]) => ({ label, status })), {
    registry, now: T0, run,
    prState: (pr: number, key: string) => { asked.push(`${key}/${pr}`); return states[`${key}/${pr}`] ?? null; },
    removeCheckout: (session: string, pr: number, key: string) => { removed.push(`${session}:${pr}:${key}`); return null; },
    record: (line: object) => lines.push(line as Record<string, unknown>), warn: (line: string) => warns.push(line),
  } as never);
  return { got, asked, closed, removed, lines, warns };
}

test("#3458 (positive control) a restored workspace with an EMPTY registry and a MERGED pull request is ended, as a registered one is", () => {
  const { got, asked, closed, removed, lines } = sweep({ ceo: "working", [RESTORED]: "unknown" });
  assert.deepEqual(got.ended, [RESTORED], "this is the assertion that fails on the code before #3458, which walked the registry's keys and nothing else");
  assert.deepEqual(asked, ["agent-org/36"], "asked of the pull request's OWN repository, by key, never the primary's");
  assert.equal(closed.length, 1, "the workspace is closed, by its id");
  assert.match(closed[0], /workspace close w1$/);
  assert.deepEqual(removed, [`${RESTORED}:36:agent-org`], "its checkout goes with it, as an ordinary ending's does");
  assert.deepEqual([lines[0].session, lines[0].pr, lines[0].state, lines[0].workspace, lines[0].checkout], [RESTORED, 36, "closed", "closed", "removed"],
    "the SAME ledger line an ordinary ending writes");
  assert.deepEqual(Object.keys(got.registry), [], "nothing was added to the registry");
});

test("#3458 the same workspace under an OPEN pull request is left, and so is one whose state cannot be read", () => {
  const open = sweep({ ceo: "working", [RESTORED]: "idle" }, { states: { "agent-org/36": "open" } });
  assert.deepEqual([open.asked, open.got.ended, open.closed, open.removed, open.lines], [["agent-org/36"], [], [], [], []],
    "the positive control above shows it WOULD be ended, so this is the state deciding and not a sweep that never fires");
  const unreadable = sweep({ ceo: "working", [RESTORED]: "idle" }, { states: {} });
  assert.deepEqual([unreadable.asked, unreadable.got.ended, unreadable.closed, unreadable.lines], [["agent-org/36"], [], [], []], "a lookup that cannot ask ends nothing");
  assert.match(unreadable.warns.join("\n"), /could not read PR .*leaving "reviewer-agent-org-36" running/);
});

test("#3458 the standing panes and every other name are untouched: `reviewer-2` (retired), `reviewer-1`, a bare `reviewer`, and what is not an instance's shape", () => {
  const live = { ceo: "working", reviewer: "idle", "reviewer-1": "idle", "reviewer-2": "idle", "reviewer-x": "idle", "worker-36": "idle", "reviewer-007": "idle" };
  const everything = new Proxy({}, { get: () => "closed" }) as Record<string, string | null>;
  const { got, asked, closed } = sweep(live, { states: everything });
  assert.deepEqual([got.ended, asked, closed], [[], [], []], "not one of them was even ASKED about, which is the stronger claim than not ending it");
  assert.deepEqual(restoredReviewers(Object.keys(live).map((label) => ({ label })), {}), [], "the sweep's own population is empty for these names");
  assert.deepEqual(restoredReviewers([{ label: RESTORED }, { label: RESTORED }, { label: "reviewer-7" }], { "reviewer-7": {} }), [RESTORED],
    "positive control for the line above: a real instance label is found, once, and a registered one is not the sweep's");
});

test("#3458 a restored workspace that is WORKING is left; one at a prompt (idle, done or unknown) is not a review in progress", () => {
  assert.deepEqual(sweep({ ceo: "working", [RESTORED]: "working" }).got.ended, []);
  for (const status of ["idle", "done", "unknown", "blocked"]) assert.deepEqual(sweep({ ceo: "working", [RESTORED]: status }).got.ended, [RESTORED], status);
});

test("#3458 two workspaces under ONE label are BOTH closed, by id (#3482 reversed #3458's \"left and said\": the label is the instance's, so every workspace under it goes)", () => {
  const closed: string[] = [];
  const warns: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: [{ label: RESTORED, workspace_id: "wA" }, { label: RESTORED, workspace_id: "wB" }] } });
    }
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const got = endFinishedReviewers([{ label: RESTORED, status: "idle" }, { label: RESTORED, status: "unknown" }], {
    registry: {}, now: T0, run, prState: () => "closed", removeCheckout: () => null, record: () => undefined, warn: (l: string) => warns.push(l),
  } as never);
  assert.deepEqual([got.ended, closed], [[RESTORED], ["--session org workspace close wA", "--session org workspace close wB"]]);
  assert.match(warns.join("\n"), /held 2 workspaces \(wA, wB\); 2 closed/);
});

/** A directory of stubs for `herdr` (a fixed listing, its calls logged), `gh` (every pull request is closed) and `git` (every call logged and succeeding). */
function stubs(dir: string, listing: Live) {
  const body = JSON.stringify({ result: { workspaces: Object.entries(listing).map(([label, agent_status], i) => ({ label, agent_status, workspace_id: `w${i}` })) } });
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$*" >> "${join(dir, "herdr-calls")}"\ncase "$*" in\n  *"workspace list") echo '${body}' ;;\n  *) echo '{}' ;;\nesac\n`);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${join(dir, "gh-calls")}"\necho closed\n`);
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$*" >> "${join(dir, "git-calls")}"\n`);
  for (const name of ["herdr", "gh", "git"]) chmodSync(join(dir, name), STUB_MODE);
}

test("#3458 THE TICK'S ENTRY reaches the sweep with an EMPTY registry -- the incident's shape, and the early return that used to hide it", () => {
  const dir = mkdtempSync(join(tmpdir(), "restored-reviewer-3458-"));
  const savedPath = process.env.PATH;
  try {
    const ledger = join(dir, "wake-ledger");
    const paths = reviewerPathsFrom(ledger);
    const live = { ceo: "working", orchestrator: "working", "reviewer-36": "unknown", "reviewer-2": "idle" };
    stubs(dir, live);
    process.env.PATH = `${dir}:${savedPath}`;
    const said: string[] = [];
    tearDownReviewers(Object.entries(live).map(([label, status]) => ({ label, status })), ledger, (line) => said.push(line));
    assert.deepEqual(said.filter((l) => l.startsWith("ENDED")), ["ENDED reviewer-36: its pull request is no longer open\n"], said.join(""));
    assert.match(readFileSync(join(dir, "herdr-calls"), "utf8"), /workspace close w2/, "the restored workspace was closed, by its own id");
    assert.doesNotMatch(readFileSync(join(dir, "herdr-calls"), "utf8"), /workspace close w3/, "and `reviewer-2` was not");
    assert.match(readFileSync(join(dir, "gh-calls"), "utf8"), new RegExp(`repos/${REPO}/pulls/36`), "the state was asked of the project's own repository");
    const [line] = readFileSync(paths.endings, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual([line.session, line.pr, line.state, line.workspace], ["reviewer-36", 36, "closed", "closed"]);
    assert.ok(existsSync(paths.registry), "the registry is written back (still empty)");
    // And with nothing to look at -- an empty registry and no instance-shaped label -- the tick still returns before any call, as before.
    rmSync(join(dir, "herdr-calls")); rmSync(join(dir, "gh-calls"));
    tearDownReviewers([{ label: "ceo", status: "working" }, { label: "reviewer-2", status: "idle" }], ledger, (line) => said.push(line));
    assert.equal(existsSync(join(dir, "gh-calls")), false, "no pull request was asked about");
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Done-when 3: a pane stopped at an interactive prompt is a stall the gate reports ----

const MINUTE = 60_000;
/** The wording the row quotes for Codex's picker. NOT a capture (see `PROMPT_SCREENS`): the panes were closed unread. */
const CODEX_PICKER = "Choose working directory to resume this session\n\n  > 1. Use session directory (/home/agent/reviews/reviewer-agent-org-36)\n    2. Use current directory (/home/agent)\n\n  Press enter to continue";
const CLAUDE_TRUST = "Do you trust the files in this folder?\n\n  /home/agent/reviews/reviewer-36\n\n  > 1. Yes, proceed\n    2. No, exit";
/** MEASURED 2026-10-04 off a live idle reviewer: `herdr --session org pane read w16G:p1 --source visible` -- the screen a healthy idle pane shows. */
const HEALTHY_IDLE = "› Ask Codex to do anything\n\n  GPT-5.6-Luna medium · ~/reviews/reviewer-agent-org-149 · Review agent-org#149\n  ? for shortcuts      ⚠ 1 warning · f2 to view";

test("#3458 a prompt is named by its heading AND a choice: the two stalls are raised, an idle pane and a `git status` that says `working directory clean` are not", () => {
  assert.equal(promptOnScreen(CODEX_PICKER), "Codex's working-directory picker");
  assert.equal(promptOnScreen(CLAUDE_TRUST), "a trust prompt");
  assert.equal(promptOnScreen(HEALTHY_IDLE), null, "a pane that reads as idle with no prompt is not raised");
  assert.equal(promptOnScreen("On branch main\nnothing to commit, working directory clean"), null, "one phrase alone is not a prompt");
  assert.equal(PROMPT_SCREENS.length, 2, "the two named cases; a third is a deliberate addition");
});

test("#3458 the reading: unread is UNKNOWN, a short wait is clear, a wait strictly over the bound is tripped and names the session, the pane and how long", () => {
  const panes = (since: number) => [{ session: RESTORED, pane: "w16N:p1", prompt: "Codex's working-directory picker", since }];
  assert.equal(panePromptReading({ now: T0, panes: null }).status, "unknown", "a refused read is never a clear");
  assert.equal(panePromptReading({ now: T0, panes: [] }).status, "clear");
  assert.equal(PANE_PROMPT_MINUTES, 15, "written out: the chairman's quarter hour (#3448)");
  assert.equal(panePromptReading({ now: T0, panes: panes(T0 - 15 * MINUTE) }).status, "clear", "AT the bound is not over it");
  const tripped = panePromptReading({ now: T0, panes: panes(T0 - 16 * MINUTE) });
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /reviewer-agent-org-36 \(pane w16N:p1, Codex's working-directory picker, 16 min\)/);
  assert.equal(tripped.discriminator, `${SIGNALS.PANE_AT_PROMPT}@${RESTORED}:w16N:p1`);
});

/** herdr's answers for `workspaces` (label by id), each with one pane and a screen. */
function herdr(workspaces: { id: string; label: string; status: string; screen: string | Error }[]) {
  const reads: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) return JSON.stringify({ result: { workspaces: workspaces.map((w) => ({ workspace_id: w.id, label: w.label })) } });
    if (said.endsWith("pane list")) return JSON.stringify({ result: { panes: workspaces.map((w) => ({ pane_id: `${w.id}:p1`, workspace_id: w.id, agent_status: w.status })) } });
    const read = /pane read (\S+) --source visible/.exec(said);
    if (read === null) throw new Error(`unexpected herdr call: ${said}`);
    reads.push(read[1]);
    const screen = workspaces.find((w) => `${w.id}:p1` === read[1])?.screen;
    if (screen instanceof Error) throw screen;
    return String(screen);
  };
  return { run, reads };
}

test("#3458 the read: a working pane is not read at all, a failed read skips that pane only, and a failed LISTING is null rather than []", () => {
  const live = herdr([
    { id: "w1", label: "ceo", status: "working", screen: CODEX_PICKER },
    { id: "w2", label: RESTORED, status: "unknown", screen: CODEX_PICKER },
    { id: "w3", label: "reviewer-agent-org-149", status: "idle", screen: HEALTHY_IDLE },
    { id: "w4", label: "worker-1", status: "idle", screen: new Error("pane gone") },
    { id: "w5", label: "worker-2", status: "idle", screen: CLAUDE_TRUST },
  ]);
  assert.deepEqual(readPromptPanes(live.run), [
    { session: RESTORED, pane: "w2:p1", prompt: "Codex's working-directory picker" },
    { session: "worker-2", pane: "w5:p1", prompt: "a trust prompt" },
  ]);
  assert.deepEqual(live.reads, ["w2:p1", "w3:p1", "w4:p1", "w5:p1"], "the working pane `ceo` was never read");
  assert.equal(readPromptPanes(() => { throw new Error("herdr did not answer"); }), null);
  assert.deepEqual(readPromptPanes(herdr([]).run), [], "an answered, empty org is [] and not null");
});

test("#3458 THE ORDER: the first sighting starts the clock and raises nothing; sixteen minutes later `ceo` is told once; a pane that answered drops out of the record", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-prompt-3458-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const log: string[] = [];
    const stuck = herdr([{ id: "w2", label: RESTORED, status: "unknown", screen: CODEX_PICKER }]);
    assert.deepEqual(panePromptOrdersNow({ ledgerPath: ledger, now: T0, run: stuck.run, log: (l) => log.push(l) }), [], "first seen NOW: no age yet");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "pane-prompts"), "utf8")), { [`${RESTORED}/w2:p1`]: T0 });
    assert.deepEqual(panePromptOrdersNow({ ledgerPath: ledger, now: T0 + 15 * MINUTE, run: stuck.run }), [], "at the bound: still not over it");
    const orders = panePromptOrdersNow({ ledgerPath: ledger, now: T0 + 16 * MINUTE, run: stuck.run });
    assert.equal(orders.length, 1);
    assert.deepEqual([orders[0].session, orders[0].cause, orders[0].subject], ["ceo", "org-health", SIGNALS.PANE_AT_PROMPT]);
    assert.match(orders[0].prompt, /reviewer-agent-org-36 \(pane w2:p1, Codex's working-directory picker, 16 min\)/);
    assert.match(orders[0].prompt, /pane send-keys/, "the remedy names the act");
    const sameAgain = panePromptOrdersNow({ ledgerPath: ledger, now: T0 + 18 * MINUTE, run: stuck.run });
    assert.equal(sameAgain[0].causeKey, orders[0].causeKey, "one stuck pane is one cause however many ticks it lasts");
    const answered = herdr([{ id: "w2", label: RESTORED, status: "idle", screen: HEALTHY_IDLE }]);
    assert.deepEqual(panePromptOrdersNow({ ledgerPath: ledger, now: T0 + 20 * MINUTE, run: answered.run }), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "pane-prompts"), "utf8")), {}, "the record is rewritten from what THIS tick saw");
    const refused = panePromptOrdersNow({ ledgerPath: ledger, now: T0 + 22 * MINUTE, run: () => { throw new Error("no"); }, log: (l) => log.push(l) });
    assert.deepEqual(refused, []);
    assert.match(log.join(""), /pane-stopped-at-a-prompt UNKNOWN -- herdr's panes could not be read; it is not read as clear/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
