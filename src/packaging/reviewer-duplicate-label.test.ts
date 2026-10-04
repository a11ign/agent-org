// no-token: gh -- `wake.mjs` spawns `gh` and `herdr`; every call here goes through an injected `run`, `prState` or `removeCheckout`
/**
 * #3482: TWO HERDR WORKSPACES UNDER ONE REVIEWER LABEL ARE BOTH ENDED, AND THE DUPLICATE IS SEEN WHILE THE PULL REQUEST IS OPEN.
 *
 * Read 2026-10-04T15:45Z on #3458: `w16B` (`reviewer-3460`, idle, codex running) and `w16N` (`reviewer-3460`, status `unknown`, a
 * bare shell). `closeReviewer` closed a workspace only when its label was held EXACTLY ONCE, so the day #3460 merged both would
 * have stayed, with "left running" repeated on every tick.
 *
 * Every listing is injected. The positive control is the first test: it fails on the tree before this row, which closes neither.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { endFinishedReviewers } from "../wake.mjs";

const LABEL = "reviewer-9001";
const T0 = 1_790_298_923_494;

type Workspace = { label: string; status: string; id: string };
type Line = Record<string, unknown>;

/** The listing as herdr prints it, and the tick's view of it (`agents`) -- one entry per workspace, labels repeated. */
const listing = (...held: Workspace[]) => ({
  agents: held.map(({ label, status }) => ({ label, status })),
  json: JSON.stringify({ result: { workspaces: held.map((w) => ({ label: w.label, agent_status: w.status, workspace_id: w.id })) } }),
});

/** One teardown pass; `prState` says whether the pull request is open, `failing` names ids whose close throws. */
function pass(held: Workspace[], over: { prState?: string; failing?: string[]; registry?: Record<string, object> } = {}) {
  const { agents, json } = listing(...held);
  const closed: string[] = [];
  const endings: Line[] = [];
  const absences: Line[] = [];
  const warned: string[] = [];
  const run = (args: string[]) => {
    if (args.at(-1) === "list") return json;
    const id = String(args.at(-1));
    if (over.failing?.includes(id)) throw new Error(`herdr: ${id} would not close`);
    closed.push(id);
    return "{}";
  };
  const got = endFinishedReviewers(agents, { registry: (over.registry ?? { [LABEL]: { spawnedAt: T0 } }) as never, now: T0 + 3_600_000, run,
    prState: () => over.prState ?? "closed", removeCheckout: () => null,
    record: (line: object) => endings.push(line as Line), recordAbsence: (line: object) => absences.push(line as Line),
    warn: (line: string) => warned.push(line) });
  return { got, closed, endings, absences, warned };
}

const idle = (id: string): Workspace => ({ label: LABEL, status: "idle", id });
const bare = (id: string): Workspace => ({ label: LABEL, status: "unknown", id });

test("#3482 (positive control): two workspaces under one label, a merged pull request -- BOTH are closed, one ledger line, the key goes", () => {
  const { got, closed, endings, warned } = pass([idle("w16B"), idle("w16N")]);
  assert.deepEqual(closed, ["w16B", "w16N"], "one `workspace close` each, by id");
  assert.deepEqual(got.ended, [LABEL]);
  assert.deepEqual(got.registry, {}, "and the instance leaves the registry");
  assert.equal(endings.length, 1, "ONE ledger line for the ending, not one per workspace");
  assert.equal(endings[0].workspace, "closed");
  assert.ok(warned.some((w) => /held 2 workspaces \(w16B, w16N\); 2 closed/.test(w)), `the warning names the count: ${warned.join(" | ")}`);
});

test("#3482: the real shape -- an idle reviewer beside an AGENTLESS duplicate -- is ended too, and the duplicate does not stop it", () => {
  // `unknown` is not in WAKEABLE, so judged by the FIRST holder (w16N, listed first) the instance was never "between turns".
  const { got, closed } = pass([bare("w16N"), idle("w16B")]);
  assert.deepEqual(closed.sort(), ["w16B", "w16N"]);
  assert.deepEqual(got.ended, [LABEL]);
});

test("#3482: a WORKING workspace under the label still defers the ending, duplicate or not", () => {
  const { got, closed } = pass([{ label: LABEL, status: "working", id: "w16B" }, bare("w16N")]);
  assert.deepEqual(closed, [], "nothing closes while a reviewer is mid-turn");
  assert.deepEqual(got.ended, []);
  assert.deepEqual(Object.keys(got.registry), [LABEL]);
});

test("#3482: one failing close leaves the instance REGISTERED and writes no ledger line; the other is still closed", () => {
  const { got, closed, endings, warned } = pass([idle("w16B"), idle("w16N")], { failing: ["w16N"] });
  assert.deepEqual(closed, ["w16B"], "the failure does not stop the other close");
  assert.deepEqual(got.ended, []);
  assert.deepEqual(Object.keys(got.registry), [LABEL], "the key stays so the next tick retries");
  assert.deepEqual(endings, [], "no ending line for an ending that did not happen");
  assert.ok(warned.some((w) => /\(w16N\) could not be closed/.test(w)));
});

test("#3482: a label held by ONE workspace behaves exactly as before -- one close, no count in the warning", () => {
  const { got, closed, warned } = pass([idle("w1")]);
  assert.deepEqual(closed, ["w1"]);
  assert.deepEqual(got.ended, [LABEL]);
  assert.deepEqual(warned, [], "a single workspace says nothing");
});

test("#3482 (2): an agentless duplicate beside an agent-holding workspace, PR open, is reported ONCE, and the live reviewer is not called dead", () => {
  const held = [bare("w16N"), idle("w16B")];
  let registry: Record<string, object> = { [LABEL]: { spawnedAt: T0 } };
  const seen: Line[] = [];
  for (let tick = 0; tick < 5; tick++) { // more than REVIEWER_DEAD_AFTER_TICKS: the duplicate must not run the count
    const got = pass(held, { prState: "open", registry });
    registry = got.got.registry;
    seen.push(...got.absences);
    assert.deepEqual(got.closed, [], "an OPEN pull request's workspaces are never closed");
  }
  assert.deepEqual(Object.keys(registry), [LABEL], "the instance is still registered after five ticks");
  assert.equal(seen.length, 1, "one line, not one per tick");
  assert.deepEqual([seen[0].session, seen[0].event, seen[0].duplicates], [LABEL, "duplicate-agentless", 1]);
});

test("#3482 (2): the duplicate is reported again if it goes and comes back, and a lone agent-holding workspace reports nothing", () => {
  let registry: Record<string, object> = { [LABEL]: { spawnedAt: T0 } };
  const lines: Line[] = [];
  for (const held of [[idle("w1")], [idle("w1"), bare("w2")], [idle("w1")], [idle("w1"), bare("w3")]]) {
    const got = pass(held, { prState: "open", registry });
    registry = got.got.registry;
    lines.push(...got.absences);
  }
  assert.deepEqual(lines.map((l) => l.event), ["duplicate-agentless", "duplicate-agentless"]);
  assert.deepEqual(registry, { [LABEL]: { spawnedAt: T0, duplicateNoted: 1 } });
});

test("#3482 (2) negative: two workspaces that BOTH hold an agent are not an AGENTLESS duplicate, and a lone agentless one is still the #2534 case", () => {
  const both = pass([idle("w1"), idle("w2")], { prState: "open" });
  assert.deepEqual(both.absences, []);
  const alone = pass([bare("w1")], { prState: "open" });
  assert.deepEqual(alone.absences.map((l) => l.event), ["agentless-unconfirmed"], "unchanged (a listing with no standing pane is PARTIAL): the #2534 line, not a duplicate report");
});
