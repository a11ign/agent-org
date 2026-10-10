// no-token: gh -- every `gh api` read and write of `readProseAndOrder` goes through the `run` fake below; nothing here reaches GitHub
/**
 * a11ign/a11ign#4679: THE WRITER OF `answer:<session>` ASKS THE GUARD. `boardTruthNow` posts the day's table and, through `readProseAndOrder`, labels the row of every prose finding. On
 * 2026-10-09T23:00Z that labelled closed rows and rows nobody had asked anything, 56 times. Each test below runs the real writer with a fake `run` that records the label POSTs,
 * so "labelled" and "not labelled" are read off the calls made.
 * POSITIVE CONTROL: the open row whose newest comment asks the session is labelled in `LABELLED`, so a writer that labels nothing, or a fixture that no finding reaches, is red there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardTruthNow } from "./org-health.ts";

const NOW = Date.parse("2026-10-09T23:00:00Z");
const AT = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const HANDOFF_AGE = 120;

type Fixture = { state?: string; comments: { body: string; createdAt: string; login?: string }[]; labelEvents?: { label: string; createdAt: string; actor: string }[] };

/** The `gh api` surface `readProseFacts`, `readLabelFacts` and the label POST use, answered from `rows`; every call is recorded. */
function world(rows: Record<number, Fixture>, { refuse = [] as number[] } = {}) {
  const posts: string[] = [];
  const log: string[] = [];
  const run = (args: string[]): string => {
    const path = args[0] === "api" ? args.find((a) => a.startsWith("repos/")) ?? "" : "";
    if (args[0] !== "api") return "[]";
    if (path.includes("/issues/comments?")) return Object.entries(rows).flatMap(([n, r]) => r.comments.map((c) => JSON.stringify({ number: Number(n), author: { login: c.login ?? "a11ign-ai-leads" }, body: c.body, createdAt: c.createdAt, url: "" }))).join("\n");
    if (path.includes("/issues?state=all")) return "";
    const events = path.match(/issues\/(\d+)\/events/);
    if (events) return (rows[Number(events[1])]?.labelEvents ?? []).map((e) => JSON.stringify({ number: Number(events[1]), ...e })).join("\n");
    const label = path.match(/issues\/(\d+)\/labels$/);
    if (label) { posts.push(`${label[1]} ${args[args.length - 1]}`); return "[]"; }
    const page = path.match(/issues\/(\d+)\/comments\?per_page=1&page=(\d+)/);
    if (page) { const r = rows[Number(page[1])]; return JSON.stringify(refuse.includes(Number(page[1])) ? {} : r.comments[Number(page[2]) - 1]); }
    const issue = path.match(/issues\/(\d+)$/);
    if (issue) { const r = rows[Number(issue[1])]; return JSON.stringify({ state: r.state ?? "open", comments: r.comments.length }); }
    return "[]";
  };
  const post = ({ readProse, repo, run: r, now }: any) => { readProse({ repo, run: r, now }); return "posted"; };
  const agents = () => [{ label: "orchestrator", status: "idle" }];
  const read = () => boardTruthNow({ openRowsRead: [], waitFacts: { items: {} }, now: NOW } as any, { repo: "a/b", run, agents, post, log: (line: string) => log.push(line) } as any);
  return { posts, log, read };
}

/** A comment of `product-manager`'s that hands off in prose (a finding after its 15-minute grace) and, when `asks`, asks `orchestrator` something. */
const handoff = (asks: boolean, minutesAgo = HANDOFF_AGE) => ({
  body: `product-manager, to orchestrator: the corpus read goes to orchestrator${asks ? "; does the lab corpus carry protocol 21 captures?" : "."}`,
  createdAt: AT(minutesAgo),
});

const LABELLED = 7;
const CLOSED = 8;
const REPORT = 9;
const REPLAYED = 10;
const UNREAD = 11;

test("an open row whose newest comment asks the session is labelled; the closed row, the plain report, the replayed question and the unreadable row are not", () => {
  const w = world({
    [LABELLED]: { comments: [handoff(true)] },
    [CLOSED]: { state: "closed", comments: [handoff(true)] },
    [REPORT]: { comments: [handoff(false)] },
    [REPLAYED]: { comments: [handoff(true)], labelEvents: [{ label: "answer:product-manager", createdAt: AT(30), actor: "a11ign-ai-leads" }] },
    [UNREAD]: { comments: [handoff(true)] },
  }, { refuse: [UNREAD] });
  w.read();
  assert.deepEqual(w.posts, [`${LABELLED} labels[]=answer:product-manager`]);
  for (const n of [CLOSED, REPORT, REPLAYED, UNREAD]) assert.ok(w.log.some((line) => line.includes(`#${n}:`)), `#${n} is refused ON THE LOG, so a skipped label is a reading`);
  assert.match(w.log.find((l) => l.includes(`#${CLOSED}:`)) ?? "", /closed row/);
  assert.match(w.log.find((l) => l.includes(`#${REPORT}:`)) ?? "", /asks nothing/);
  assert.match(w.log.find((l) => l.includes(`#${REPLAYED}:`)) ?? "", /already labelled/);
  assert.match(w.log.find((l) => l.includes(`#${UNREAD}:`)) ?? "", /could not be read/);
});

test("a closed row is not labelled even when the guard would otherwise allow it: the state, not the comment, decides", () => {
  const w = world({ [CLOSED]: { state: "closed", comments: [handoff(true)] } });
  w.read();
  assert.deepEqual(w.posts, []);
});

test("the newest comment is read from the row, not from the day's org comments: a later answer by anyone withdraws the question", () => {
  const answered = { body: "orchestrator: yes, protocol 21 is in the corpus.", createdAt: AT(10), login: "someone" };
  const w = world({ [LABELLED]: { comments: [handoff(true), answered] } });
  w.read();
  assert.deepEqual(w.posts, []);
  assert.match(w.log.join("\n"), /asks nothing/);
});
