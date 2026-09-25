// no-token: gh -- every `gh` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/wake.mjs`, #2465: A REVIEWER THAT DIES UNDER AN OPEN PULL REQUEST IS CLEARED, AND ONLY WHEN
 * THE LISTING THAT DOES NOT SHOW IT IS ONE THAT COULD HAVE.
 *
 * `spawnableReviewer` refuses to start a second instance under a label the registry holds and herdr does not list,
 * because a PARTIAL workspace list reads every instance as absent. That refusal stays. What was missing is the exit:
 * `endFinishedReviewers` only removed a key when the pull request was no longer open, so an instance that died under
 * an OPEN one was never replaced (#2453 and #2456 waited about seven hours, 2026-09-25).
 *
 * Its own file, and not a block in `wake-reviewer-instance.test.ts`, because the Region of the row names this one.
 * Every fact read here is an injected seam or a stub on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnableReviewer, endFinishedReviewers, reviewerPathsFrom, listingIsComplete, observeOpenReviewer,
  REVIEWER_DEAD_AFTER_TICKS,
} from "./wake.mjs";
import { readReviewerRegistry } from "./work-gate.mjs";

const STUB_MODE = 0o755;
const TICK_ENTRY = fileURLToPath(new URL("./work-tick.mjs", import.meta.url));
const T0 = 1_790_298_923_494;
const DEAD = "reviewer-2453";

const order = { session: DEAD, cause: "draft-awaiting-verdict", causeKey: `${DEAD}/draft-awaiting-verdict/pr-2453/abc12345` };
const panes = (...labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
const COMPLETE = panes("ceo", "orchestrator", "reviewer-2454");
const PARTIAL = panes("reviewer-2454"); // the listing #spawnableReviewer's refusal was written for: no standing pane in it

type Line = Record<string, unknown>;
type Registry = Record<string, { spawnedAt: number; absentTicks?: number; absentNoted?: string }>;

/** One teardown pass over an OPEN pull request, with the seams recorded; returns the registry to feed the next tick. */
function pass(agents: { label: string; status: string }[], registry: Registry, seams: { lines: Line[]; warns: string[]; run?: (args: string[]) => string }) {
  return endFinishedReviewers(agents, {
    registry, now: T0, run: seams.run ?? (() => ""), prState: () => "open",
    removeCheckout: () => { throw new Error("an OPEN pull request's checkout must never be removed"); },
    record: () => { throw new Error("no ENDING is recorded for an instance whose pull request is open"); },
    recordAbsence: (line: object) => { seams.lines.push(line as Line); }, warn: (line: string) => seams.warns.push(line),
  });
}

/** `ticks` passes over `agents`, each fed the last one's registry. */
function passes(ticks: number, agents: { label: string; status: string }[], start: Registry, run?: (args: string[]) => string) {
  const seams = { lines: [] as Line[], warns: [] as string[], run };
  let registry = start;
  const cleared: string[][] = [];
  for (let i = 0; i < ticks; i++) {
    const got = pass(agents, registry, seams);
    registry = got.registry;
    cleared.push(got.cleared);
  }
  return { registry, cleared, lines: seams.lines, warns: seams.warns };
}

test("#2465 (a) a COMPLETE listing that keeps lacking the instance CLEARS it, and the next start is allowed", () => {
  const before = spawnableReviewer(order, COMPLETE, { [DEAD]: { spawnedAt: T0 } });
  assert.match(String((before as { refusal?: string }).refusal), /herdr does not list it now/, "the premise: it refuses today");

  const got = passes(REVIEWER_DEAD_AFTER_TICKS, COMPLETE, { [DEAD]: { spawnedAt: T0 } });

  assert.deepEqual(got.registry, {}, "the key is gone");
  assert.deepEqual(got.cleared, [...Array(REVIEWER_DEAD_AFTER_TICKS - 1).fill([]), [DEAD]], "cleared on the last of N, and not before");
  assert.deepEqual(spawnableReviewer(order, COMPLETE, got.registry), { session: DEAD }, "and a fresh one may start");
  assert.deepEqual(got.lines.map((l) => l.event), [...Array(REVIEWER_DEAD_AFTER_TICKS - 1).fill("absent-seen"), "cleared"],
    "and each step is readable from the ledger");
});

test("#2465 (b) a PARTIAL listing lacking the instance AND the standing panes still REFUSES and clears nothing", () => {
  const start = { [DEAD]: { spawnedAt: T0 } };
  const got = passes(REVIEWER_DEAD_AFTER_TICKS * 3, PARTIAL, start);

  assert.deepEqual(Object.keys(got.registry), [DEAD], "not cleared, however many ticks the listing stays partial");
  assert.ok("refusal" in spawnableReviewer(order, PARTIAL, got.registry), "and the start is still refused");
  assert.deepEqual(got.cleared.flat(), []);
});

test("#2465 one standing pane is not a complete listing, and a listing missing either is partial", () => {
  assert.equal(listingIsComplete(COMPLETE), true, "the positive control: the completeness test CAN say yes");
  assert.equal(listingIsComplete(panes("ceo", "reviewer-2454")), false, "no `orchestrator`");
  assert.equal(listingIsComplete(panes("orchestrator", "reviewer-2454")), false, "no `ceo`");
  assert.equal(listingIsComplete([]), false, "an empty answer is not a complete one");
  const got = passes(REVIEWER_DEAD_AFTER_TICKS * 2, panes("ceo"), { [DEAD]: { spawnedAt: T0 } });
  assert.deepEqual(Object.keys(got.registry), [DEAD]);
});

test("#2465 a listing that SHOWS the instance starts the count again: N absences must be consecutive", () => {
  const start = { [DEAD]: { spawnedAt: T0 } };
  const absent = passes(REVIEWER_DEAD_AFTER_TICKS - 1, COMPLETE, start);
  assert.deepEqual(Object.keys(absent.registry), [DEAD], "one short of the limit: still registered");

  const seen = passes(1, [...COMPLETE, ...panes(DEAD)], absent.registry);
  assert.deepEqual(seen.registry, { [DEAD]: { spawnedAt: T0 } }, "seen once: the counter is gone, spawnedAt untouched");

  const again = passes(REVIEWER_DEAD_AFTER_TICKS - 1, COMPLETE, seen.registry);
  assert.deepEqual(Object.keys(again.registry), [DEAD], "and it takes N more, not one");
});

test("#2465 a partial tick between complete ones neither advances nor resets the count", () => {
  const first = passes(REVIEWER_DEAD_AFTER_TICKS - 1, COMPLETE, { [DEAD]: { spawnedAt: T0 } });
  const middle = passes(5, PARTIAL, first.registry);
  assert.deepEqual(middle.cleared.flat(), [], "a run of partial listings clears nothing");
  const last = passes(1, COMPLETE, middle.registry);
  assert.deepEqual(last.cleared, [[DEAD]], "the Nth COMPLETE absence still counts, so a failing listing cannot starve a real death");
});

test("#2465 the refusal stays READABLE: one absences line per change, naming the PR, the instance and the listing", () => {
  const got = passes(4, PARTIAL, { [DEAD]: { spawnedAt: T0 } });
  assert.equal(got.lines.length, 1, "one line for a state that does not change, not one per tick");
  assert.deepEqual(got.lines[0], { session: DEAD, pr: 2453, at: new Date(T0).toISOString(), event: "absent-unconfirmed",
    absentTicks: 0, needed: REVIEWER_DEAD_AFTER_TICKS, listing: "partial", presence: "absent from the listing" });
  assert.match(got.warns[0], /reviewer-2453.*OPEN PR #2453.*PARTIAL/);
});

test("#2465 observeOpenReviewer: the three verdicts, and a live instance keeps only what it was registered with", () => {
  const entry = { spawnedAt: T0, absentTicks: 2, absentNoted: "seen-2" };
  assert.deepEqual(observeOpenReviewer(entry, { listed: true, complete: false }),
    { entry: { spawnedAt: T0 }, event: null, absentTicks: 0 });
  assert.equal(observeOpenReviewer(entry, { listed: false, complete: true }).entry, null);
  assert.equal(observeOpenReviewer(entry, { listed: false, complete: false }).absentTicks, 2, "held, not reset");
});

test("#2465 THE TICK: a registered reviewer under an OPEN pr that herdr stops listing is cleared and the next start proceeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-tick-dead-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const paths = reviewerPathsFrom(ledger);
    const workspaces = (labels: string[]) => `{"result":{"workspaces":[${labels
      .map((label, i) => `{"label":"${label}","workspace_id":"w${i}","agent_status":"idle"}`).join(",")}]}}`;
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"issue list\"*) printf '%s' '[]' ;;\n"
      + "  *'pulls/2453'*) printf '%s' 'open' ;;\n  *) exit 1 ;;\nesac\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    mkdirSync(join(dir, "reviews", DEAD), { recursive: true });
    writeFileSync(paths.registry, JSON.stringify({ [DEAD]: { spawnedAt: T0 } }));
    const tick = (labels: string[]) => {
      writeFileSync(join(dir, "herdr"), `#!/bin/sh\ncase "$*" in\n  *'workspace list') printf '%s' '${workspaces(labels)}' ;;\n  *) : ;;\nesac\n`);
      chmodSync(join(dir, "herdr"), STUB_MODE);
      return spawnSync(process.execPath, [TICK_ENTRY, `--ledger=${ledger}`], { encoding: "utf8",
        env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    };

    for (let i = 0; i < REVIEWER_DEAD_AFTER_TICKS - 1; i++) tick(["ceo", "orchestrator"]);
    assert.deepEqual(Object.keys(readReviewerRegistry(paths.registry)), [DEAD], "one short of N: kept");
    const last = tick(["ceo", "orchestrator"]);

    assert.deepEqual(readReviewerRegistry(paths.registry), {}, `cleared on the Nth tick; got ${last.stderr}`);
    assert.match(last.stderr, /CLEARED reviewer-2453/);
    assert.equal(existsSync(join(dir, "reviews", DEAD)), true, "its checkout is left for `prepareReviewCheckout` to re-point");
    const lines = readFileSync(paths.absences, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["absent-seen", "absent-seen", "cleared"]);
    assert.equal(existsSync(paths.endings), false, "and no ENDING was written: the pull request is still open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2534: a workspace whose codex EXITED still carries the instance's label, with no agent in it.
const AGENTLESS = [...COMPLETE, { label: DEAD, status: "unknown" }];
const LIVE = [...COMPLETE, { label: DEAD, status: "working" }];

/** A herdr whose `workspace list` shows `agents`, recording every `workspace close` it is asked for. */
function herdr(agents: { label: string; status: string }[], opts: { closeFails?: boolean } = {}) {
  const closed: string[] = [];
  const run = (args: string[]) => {
    if (args.includes("list")) {
      return JSON.stringify({ result: { workspaces: agents.map((a) => ({ label: a.label, workspace_id: `w-${a.label}`, agent_status: a.status })) } });
    }
    if (opts.closeFails) throw new Error("herdr: close refused");
    closed.push(String(args.at(-1)));
    return "";
  };
  return { run, closed };
}

test("#2534 (a) an AGENTLESS instance under an OPEN pr is CLOSED and cleared after N complete listings, and the next start proceeds", () => {
  const before = spawnableReviewer(order, AGENTLESS, { [DEAD]: { spawnedAt: T0 } });
  assert.match(String((before as { refusal?: string }).refusal), /holds NO agent/, "the premise: the label blocks the spawn today, and says why");

  const h = herdr(AGENTLESS);
  const got = passes(REVIEWER_DEAD_AFTER_TICKS, AGENTLESS, { [DEAD]: { spawnedAt: T0 } }, h.run);

  assert.deepEqual(got.registry, {}, "the key is gone");
  assert.deepEqual(h.closed, [`w-${DEAD}`], "the workspace was closed, once, on the last tick and not before");
  assert.deepEqual(got.cleared, [...Array(REVIEWER_DEAD_AFTER_TICKS - 1).fill([]), [DEAD]]);
  assert.deepEqual(spawnableReviewer(order, COMPLETE, got.registry), { session: DEAD }, "with the pane gone the fresh one may start");
  assert.deepEqual(got.lines.map((l) => l.event), [...Array(REVIEWER_DEAD_AFTER_TICKS - 1).fill("agentless-seen"), "cleared"]);
  assert.ok(got.lines.every((l) => l.presence === "workspace with no agent"), "the ledger says a pane was PRESENT with no agent, not that it was absent");
});

test("#2534 (b) the same agentless instance under a PARTIAL listing neither closes nor clears", () => {
  const partial = [...PARTIAL, { label: DEAD, status: "unknown" }];
  const h = herdr(partial);
  const got = passes(REVIEWER_DEAD_AFTER_TICKS * 3, partial, { [DEAD]: { spawnedAt: T0 } }, h.run);

  assert.deepEqual(Object.keys(got.registry), [DEAD]);
  assert.deepEqual(h.closed, [], "nothing closed");
  assert.deepEqual(got.cleared.flat(), []);
  assert.deepEqual(got.lines.map((l) => l.event), ["agentless-unconfirmed"], "one line, for a state that does not change");
});

test("#2534 (c) ONE agentless tick then a live status starts the count again: a pane between create and start closes nothing", () => {
  const first = passes(REVIEWER_DEAD_AFTER_TICKS - 1, AGENTLESS, { [DEAD]: { spawnedAt: T0 } });
  const h = herdr(LIVE);
  const seen = passes(1, LIVE, first.registry, h.run);
  assert.deepEqual(seen.registry, { [DEAD]: { spawnedAt: T0 } }, "the counter is gone");

  const again = passes(REVIEWER_DEAD_AFTER_TICKS - 1, AGENTLESS, seen.registry, h.run);
  assert.deepEqual(Object.keys(again.registry), [DEAD], "and it takes N more");
  assert.deepEqual(h.closed, [], "nothing was ever closed");
  assert.deepEqual(passes(1, AGENTLESS, { [DEAD]: { spawnedAt: T0 } }).cleared, [[]], "a single agentless tick clears nothing");
});

test("#2534 a workspace that will NOT close keeps its key, one tick short of dead, and says so; the retry then succeeds", () => {
  const stuck = herdr(AGENTLESS, { closeFails: true });
  const got = passes(REVIEWER_DEAD_AFTER_TICKS, AGENTLESS, { [DEAD]: { spawnedAt: T0 } }, stuck.run);
  assert.deepEqual(Object.keys(got.registry), [DEAD], "the key stays: clearing it over a live label only moves the refusal");
  assert.deepEqual(got.cleared.flat(), []);
  assert.match(got.warns.join("\n"), /could not be closed/);
  assert.equal(got.lines.at(-1)?.event, "close-failed");

  const ok = herdr(AGENTLESS);
  const retry = passes(1, AGENTLESS, got.registry, ok.run);
  assert.deepEqual(retry.registry, {}, "the next tick closes it and clears the key");
  assert.deepEqual(ok.closed, [`w-${DEAD}`]);
});

test("#2534 a STANDING seat is never closed or cleared by this path, even when it reads `unknown`", () => {
  const ceoGone = [...panes("orchestrator", "reviewer-2454"), { label: "ceo", status: "unknown" }];
  const h = herdr(ceoGone);
  const start = { ceo: { spawnedAt: T0 }, orchestrator: { spawnedAt: T0 } };
  const got = passes(REVIEWER_DEAD_AFTER_TICKS * 2, ceoGone, start, h.run);
  assert.deepEqual(got.registry, start, "nothing cleared");
  assert.deepEqual(h.closed, [], "nothing closed");
  assert.deepEqual(got.lines, [], "and nothing said");
  assert.equal(listingIsComplete(ceoGone), true, "the positive control: the listing IS complete, so only the label kept the seat safe");
});

test("#2534 observeOpenReviewer: an agentless pane counts as absent, and names itself in its events", () => {
  assert.deepEqual(observeOpenReviewer({ spawnedAt: T0 }, { listed: false, complete: true, agentless: true }),
    { entry: { spawnedAt: T0, absentTicks: 1, absentNoted: "seen-1" }, event: "agentless-seen", absentTicks: 1 });
  assert.equal(observeOpenReviewer({ spawnedAt: T0 }, { listed: false, complete: false, agentless: true }).event, "agentless-unconfirmed");
});
