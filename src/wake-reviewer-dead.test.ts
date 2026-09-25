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
function pass(agents: { label: string; status: string }[], registry: Registry, seams: { lines: Line[]; warns: string[] }) {
  return endFinishedReviewers(agents, {
    registry, now: T0, run: () => "", prState: () => "open",
    removeCheckout: () => { throw new Error("an OPEN pull request's checkout must never be removed"); },
    record: () => { throw new Error("no ENDING is recorded for an instance whose pull request is open"); },
    recordAbsence: (line: object) => { seams.lines.push(line as Line); }, warn: (line: string) => seams.warns.push(line),
  });
}

/** `ticks` passes over `agents`, each fed the last one's registry. */
function passes(ticks: number, agents: { label: string; status: string }[], start: Registry) {
  const seams = { lines: [] as Line[], warns: [] as string[] };
  let registry = start;
  const cleared: string[][] = [];
  for (let i = 0; i < ticks; i++) {
    const got = pass(agents, registry, seams);
    registry = got.registry;
    cleared.push(got.cleared);
  }
  return { registry, cleared, ...seams };
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
    absentTicks: 0, needed: REVIEWER_DEAD_AFTER_TICKS, listing: "partial" });
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
