// no-token: gh -- texts in, texts out; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import { heldClaims } from "./board-view/overlap-hold.ts";
import { parseOrder } from "./batch-order.ts";
import { claimsRetryAsk, claimsText, folderClaimAsk, folderClaimMisses, folderClaimRefusal, folderClaimRetriedRefusal, type HeldClaim, parseClaimsGiven, planClaimPaths, siblingClaims } from "./path-claims.ts";

/** Tickets as the A11-200 / A11-196 morning had them: Tickets running, holding whole folders, and Settings about to claim files in each. */
const TICKETS_RUN: HeldClaim = { key: "A11-196", state: "running", paths: ["agent-org:ui/src/shell/", "agent-org:ui/test/", "agent-org:ui/captures/", "agent-org:ui/src/pages/tickets/Tickets.tsx"] };
const FIXTURES: HeldClaim = { key: "A11-198", state: "queued", paths: ["agent-org:ui/test/fixtures.ts"] };

test("A11-212: a folder claim that another ticket writes inside is a miss, naming the ticket and its paths inside the folder", () => {
  const misses = folderClaimMisses(["agent-org:ui/test/", "agent-org:ui/src/pages/settings/"], [{ ...TICKETS_RUN, paths: ["agent-org:ui/test/fixtures.ts"] }]);
  assert.deepEqual(misses, [{ folder: "agent-org:ui/test/", holders: [{ key: "A11-196", paths: ["agent-org:ui/test/fixtures.ts"] }] }]);
});

test("A11-212: a folder two tickets both claim is a miss, and so is a folder that holds a file one of them claims; each holder is named once with its own paths", () => {
  const misses = folderClaimMisses(["agent-org:ui/test/"], [TICKETS_RUN, FIXTURES]);
  assert.deepEqual(misses, [{ folder: "agent-org:ui/test/", holders: [{ key: "A11-196", paths: ["agent-org:ui/test/"] }, { key: "A11-198", paths: ["agent-org:ui/test/fixtures.ts"] }] }]);
});

test("A11-212: a file claim is never a miss, even for a file another ticket claims too: two tickets naming one file share it for real", () => {
  assert.deepEqual(folderClaimMisses(["agent-org:ui/test/fixtures.ts", "agent-org:ui/src/shell/App.tsx"], [TICKETS_RUN, FIXTURES]), []);
});

test("A11-212: a folder only this ticket writes in is not a miss: a sibling folder, a folder nobody holds, a folder inside another ticket's folder, and another repository", () => {
  const claims: HeldClaim[] = [{ key: "A11-196", state: "running", paths: ["agent-org:ui/src/pages/tickets/", "agent-org:ui/test/", "other:ui/src/pages/settings/x.ts"] }];
  assert.deepEqual(folderClaimMisses(["agent-org:ui/src/pages/settings/"], claims), [], "a sibling folder, and the same path in another repository");
  assert.deepEqual(folderClaimMisses(["agent-org:ui/test/settings/"], claims), [], "a folder inside a folder another ticket claims is this ticket's narrow claim, and the other's to narrow");
  assert.deepEqual(folderClaimMisses(["agent-org:ui/src/pages/tickets-extra/"], claims), [], "a name that only begins the same");
  assert.deepEqual(folderClaimMisses(["agent-org:docs/"], claims), [], "nobody holds anything there");
});

test("A11-212: the scaffolding directories, the plan's own and the other tickets', are never counted", () => {
  const claims: HeldClaim[] = [{ key: "A11-196", state: "running", paths: ["agent-org:.acceptance/a.md", "agent-org:.changeset/b.md"] }];
  assert.deepEqual(folderClaimMisses(["agent-org:.acceptance/", "agent-org:.changeset/"], claims), []);
});

test("A11-212: a plan's paths are its Paths bullets and every step section's, each once", () => {
  const plan = "# Plan\n\n### Step 1 of 2: shell\n\n- `agent-org:b.ts`\n- `agent-org:c/`\n\n### Step 2 of 2: page\n\n- `agent-org:d.ts`\n\n## Paths\n\n- `agent-org:a/`\n- `agent-org:b.ts`\n";
  assert.deepEqual(planClaimPaths(plan), ["agent-org:a/", "agent-org:b.ts", "agent-org:c/", "agent-org:d.ts"]);
  assert.deepEqual(planClaimPaths("# Plan with no paths\n"), []);
});

test("A11-212: the ask names the folder, who else writes in it and where, and the narrower forms; one ask per folder", () => {
  const ask = folderClaimAsk(folderClaimMisses(["agent-org:ui/test/"], [{ ...TICKETS_RUN, paths: ["agent-org:ui/test/fixtures.ts"] }]));
  assert.equal(ask, "`agent-org:ui/test/` is a folder A11-196 (`ui/test/fixtures.ts`) also writes into. Claim the files this ticket writes there, or a folder of its own such as `ui/test/<feature>/`, instead.");
  const two = folderClaimAsk(folderClaimMisses(["agent-org:ui/test/", "agent-org:ui/captures/"], [TICKETS_RUN, FIXTURES]));
  assert.match(two, /`agent-org:ui\/test\/` is a folder A11-196 \(`ui\/test\/`\) and A11-198 \(`ui\/test\/fixtures\.ts`\) also write into\./);
  assert.match(two, /`agent-org:ui\/captures\/` is a folder A11-196 \(`ui\/captures\/`\) also writes into\. Claim the files this ticket writes there, or a folder of its own such as `ui\/captures\/<feature>\/`, instead\.$/);
});

test("A11-212: the board's refusal says the planner was asked once, when the retry was made", () => {
  const misses = folderClaimMisses(["agent-org:ui/test/"], [FIXTURES]);
  assert.match(folderClaimRefusal(misses), /^the plan claims a folder that other queued or running tickets also write into\. `agent-org:ui\/test\/` is a folder A11-198 \(`ui\/test\/fixtures\.ts`\) also writes into\./);
  assert.equal(folderClaimRefusal(misses).includes("automatic retry"), false);
  assert.match(folderClaimRetriedRefusal(misses), /One automatic retry was made, asking for narrower paths, and the plan still claims `agent-org:ui\/test\/`$/);
});

test("A11-212: the hook's retry ask names each ticket's plan folder and the outcome file to write again, and says it is the one retry", () => {
  const folders = folderClaimMisses(["agent-org:ui/test/"], [FIXTURES]);
  const ask = claimsRetryAsk([{ key: "A11-212", planDir: "/d/plan", folders }], "/d/outcome.json");
  for (const part of ["A11-212 (plan in /d/plan)", "`agent-org:ui/test/` is a folder A11-198", "`## Paths` section", "write /d/outcome.json again as the last thing you do", "the one automatic retry"]) {
    assert.ok(ask.includes(part), `the ask says ${part}`);
  }
});

test("A11-212: the brief lists the held paths grouped by repository, a line for each ticket, and says so when nothing is held", () => {
  const text = claimsText([TICKETS_RUN, FIXTURES, { key: "A11-300", state: "open pull request", paths: ["screenreader-worker:src/a.ts", "agent-org:ui/src/shell/App.tsx", "agent-org:.changeset/x.md"] }]);
  assert.equal(text, [
    "### agent-org", "",
    "- A11-196 (running): `agent-org:ui/src/shell/`, `agent-org:ui/test/`, `agent-org:ui/captures/`, `agent-org:ui/src/pages/tickets/Tickets.tsx`",
    "- A11-198 (queued): `agent-org:ui/test/fixtures.ts`",
    "- A11-300 (open pull request): `agent-org:ui/src/shell/App.tsx`", "",
    "### screenreader-worker", "",
    "- A11-300 (open pull request): `screenreader-worker:src/a.ts`",
  ].join("\n"));
  assert.equal(claimsText([]), "No other queued or running ticket holds a path.");
  assert.equal(claimsText([{ key: "A11-1", state: "queued", paths: ["agent-org:.acceptance/x.md"] }]), "No other queued or running ticket holds a path.", "scaffolding is not a claim");
});

test("A11-212: the list the board writes beside the run reads back as it was, and a text that is no list reads as none", () => {
  const given = [TICKETS_RUN, FIXTURES];
  assert.deepEqual(parseClaimsGiven(JSON.stringify(given)), given);
  assert.equal(parseClaimsGiven("{}"), null);
  assert.equal(parseClaimsGiven("not json"), null);
  assert.equal(parseClaimsGiven(JSON.stringify([{ key: "A", state: "queued", paths: [1] }])), null);
});

/** The `after` order of a batch, parsed as the board reads `order.json`. */
function orderOf(after: Record<string, string[]>) {
  const parsed = parseOrder(JSON.stringify(Object.fromEntries(Object.entries(after).map(([key, list]) => [key, { repo: "agent-org", after: list }]))), Object.keys(after));
  assert.ok("order" in parsed);
  return parsed.order;
}

test("A11-212: the other tickets of a batch hold their plan paths against a ticket, unless the batch's order sequences them, directly or through the tickets between", () => {
  const plans = [{ key: "A", paths: ["agent-org:ui/test/"] }, { key: "B", paths: ["agent-org:ui/test/b.ts"] }, { key: "C", paths: [] }, { key: "D", paths: ["agent-org:d.ts"] }];
  assert.deepEqual(siblingClaims("A", plans, null), [{ key: "B", state: "planned in this batch", paths: ["agent-org:ui/test/b.ts"] }, { key: "D", state: "planned in this batch", paths: ["agent-org:d.ts"] }], "no order yet: every sibling holding a path, and not the ticket itself");
  assert.deepEqual(siblingClaims("A", plans, orderOf({ A: [], B: ["A"], C: [], D: [] })).map(({ key }) => key), ["D"], "B is after A: they run in turn");
  assert.deepEqual(siblingClaims("A", plans, orderOf({ A: [], B: ["D"], C: [], D: ["A"] })).map(({ key }) => key), [], "D is after A and B is after D, so both are in turn with A");
  assert.deepEqual(siblingClaims("B", plans, orderOf({ A: ["B"], B: [], C: [], D: [] })).map(({ key }) => key), ["D"], "and from the other side");
});

/** A run as the board holds it. */
const run = (key: string, patch: Partial<ViewEntry>): ViewEntry => ({ ticket: { key }, phase: "queued", ...patch }) as ViewEntry;
const pull = (url: string) => ({ url, repo: "agent-org" });

test("A11-212: the board lists what each queued and running run holds, with why, and leaves out the ticket itself, the runs sequenced with it, runs that hold nothing, and scaffolding", () => {
  const self = run("A11-212", { plan: { model: "opus", effort: "max" }, blockers: [{ key: "A11-213", state: "started", status: "In Progress", pulls: {} }] });
  const url = "https://github.com/a11ign/agent-org/pull/12";
  const entries = [
    self,
    run("A11-196", { phase: "running", paths: ["agent-org:ui/src/shell/", "agent-org:.changeset/"] }),
    run("A11-198", { paths: ["agent-org:ui/test/fixtures.ts"] }),
    run("A11-199", { phase: "finished", outcome: { kind: "draft-pr", prs: [pull(url)] }, paths: ["agent-org:ui/src/pages/x.ts"], pullFiles: { [url]: ["ui/src/pages/y.ts"] } }),
    run("A11-213", { phase: "running", paths: ["agent-org:src/ticket-mode/worker-files.ts"] }),
    run("A11-214", { phase: "finished", paths: ["agent-org:src/z.ts"] }),
    run("A11-215", { paths: [] }),
    run("A11-216", { plan: { model: "opus", effort: "max" }, paths: ["agent-org:q.ts"] }),
  ];
  assert.deepEqual(heldClaims(entries, [self]), [
    { key: "A11-196", state: "running", paths: ["agent-org:ui/src/shell/"] },
    { key: "A11-198", state: "queued", paths: ["agent-org:ui/test/fixtures.ts"] },
    { key: "A11-199", state: "open pull request", paths: ["agent-org:ui/src/pages/x.ts", "agent-org:ui/src/pages/y.ts"] },
  ]);
});

test("A11-212: a run the ticket blocks is left out too, and a batch leaves out all of its own tickets", () => {
  const blocked = run("A11-300", { paths: ["agent-org:a.ts"], blockers: [{ key: "A11-212", state: "started", status: "In Progress", pulls: {} }] });
  const self = run("A11-212", { plan: { model: "opus", effort: "max" } });
  const sibling = run("A11-211", { plan: { model: "opus", effort: "max" } });
  const other = run("A11-400", { phase: "running", paths: ["agent-org:b.ts"] });
  assert.deepEqual(heldClaims([self, blocked, other], [self]).map(({ key }) => key), ["A11-400"], "the run it blocks is sequenced after it on purpose");
  assert.deepEqual(heldClaims([self, sibling, other, run("A11-401", { paths: ["agent-org:c.ts"] })], [self, sibling]).map(({ key }) => key), ["A11-400", "A11-401"]);
});
