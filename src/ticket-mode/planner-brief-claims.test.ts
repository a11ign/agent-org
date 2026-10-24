// no-token: gh -- pure builders
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HeldClaim } from "./path-claims.ts";
import { batchPlanBriefText, planBriefText } from "./worker-files.ts";
import type { Ticket } from "./source.ts";

const ticket = { key: "A11-200", title: "Atomaut Settings", description: "The Settings page.", url: "https://linear.app/x/issue/A11-200",
  branch: "a11-200-settings", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 3 } as Ticket;
const clones = { "agent-org": "/work/agent-org", "screenreader-worker": "/work/screenreader-worker" };
const held: HeldClaim[] = [{ key: "A11-196", state: "running", paths: ["agent-org:ui/src/shell/", "agent-org:ui/test/"] }, { key: "A11-198", state: "queued", paths: ["screenreader-worker:src/a.ts"] }];

const single = (claims?: readonly HeldClaim[]) => planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", ...(claims ? { claims } : {}) });
const batch = (claims?: readonly HeldClaim[]) => batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}", ...(claims ? { claims } : {}) });

test("A11-212: both planner briefs list the paths every other queued and running ticket holds, grouped by repository, with why each is held", () => {
  for (const [name, brief] of [["single", single(held)], ["batch", batch(held)]] as const) {
    assert.ok(brief.includes("## Paths other tickets hold"), `${name}: the section`);
    assert.ok(brief.includes("### agent-org\n\n- A11-196 (running): `agent-org:ui/src/shell/`, `agent-org:ui/test/`"), `${name}: a line for the ticket in its repository`);
    assert.ok(brief.includes("### screenreader-worker\n\n- A11-198 (queued): `screenreader-worker:src/a.ts`"), `${name}: and the other repository`);
  }
});

test("A11-212: both briefs say so when nothing is held", () => {
  for (const brief of [single(), batch([])]) assert.ok(brief.includes("No other queued or running ticket holds a path."));
});

test("A11-212: both briefs carry the narrowest-path, parallel-planning, integration-point and steps rules", () => {
  for (const [name, brief] of [["single", single(held)], ["batch", batch(held)]] as const) {
    const rules = [
      "**Claim the narrowest paths that hold the change:** files, or a folder only this ticket writes into. Never a shared parent such as a repository's whole `test/` or `captures/`. The board refuses a plan that claims a folder another queued or running ticket writes into, and names the narrower paths to use.",
      "per-feature folders, per-feature test data beside its tests, and no edit to a shared registration point that another ticket already prepared. Say in the plan, under `## Overlaps that remain`, which held paths it still shares and why.",
      "**A shared integration point many tickets would edit** (a route table, a registry, a fixtures file) is named in the plan of the ticket that first creates it. That ticket prepares it, with per-feature entries or placeholders, so later tickets do not edit it.",
      "prefer steps that can be worked side by side over a chain. A step depends on another only when it needs that step's code, never just because they touch the same folder.",
      "list the narrowest paths that hold the work, and no more: each file the work changes, or a folder only this ticket writes into.",
    ];
    for (const rule of rules) assert.ok(brief.includes(rule), `${name}: ${rule.slice(0, 60)}`);
  }
});

test("A11-212: the batch brief says its tickets are held against each other, and orders a ticket after another only for its code or a shared file", () => {
  const brief = batch(held);
  assert.ok(brief.includes("**The tickets of this batch are held against each other the same way:** a folder two of them claim is refused, unless `order.json` orders them."));
  assert.ok(brief.includes("Order a ticket after another only when it needs that ticket's code, or both must change the same file. Tickets whose paths do not overlap get no `after` and run side by side"));
  assert.equal(brief.includes("whose work touches the same area"), false, "the old chain-making rule is gone");
  assert.equal(single(held).includes("held against each other"), false, "a ticket planned alone has no siblings");
});
