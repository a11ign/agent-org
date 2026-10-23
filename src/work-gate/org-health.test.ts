// no-token: none -- the org's comments of the day, the label events, the row's state, its newest comment and the label POST of `readProseAndOrder` are the fake code host's rows (A11-160, steps 6 and 8); nothing here reaches `gh`
/**
 * a11ign/a11ign#4679: THE WRITER OF `answer:<session>` ASKS THE GUARD. `boardTruthNow` posts the day's table and, through `readProseAndOrder`, labels the row of every prose finding. On
 * 2026-10-09T23:00Z that labelled closed rows and rows nobody had asked anything, 56 times. Each test below runs the real writer over the fake code host's rows, which hold each row's state
 * and comments and take the label, so "labelled" and "not labelled" are read off the labels the rows carry. Since A11-160 (step 8) the org's comments of the day and the label events (`readProseFacts`) are
 * the code host's reads too, so the same rows answer them; a `run` that spawned `gh` would throw.
 * POSITIVE CONTROL: the open row whose newest comment asks the session is labelled in `LABELLED`, so a writer that labels nothing, or a fixture that no finding reaches, is red there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { boardTruthNow } from "./org-health.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const NOW = Date.parse("2026-10-09T23:00:00Z");
const AT = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const HANDOFF_AGE = 120;

type Fixture = { state?: string; comments: { body: string; createdAt: string; login?: string }[]; labelEvents?: { label: string; createdAt: string; actor: string }[] };

/**
 * The code host's rows hold each fixture row: its state, its comments with their authors (the org's comments of the day and each row's newest comment are READ off them), the label events it carries, and X names the rows whose state and newest comment cannot be read (the row is listed among the day's comments all the same), which the host answers as it answers a row it holds none of.
 */
function world(rows: Record<number, Fixture>, { refuse = [] as number[], listsClosed = false } = {}) {
  const log: string[] = [];
  const host = createFakeCodeHost();
  const code = host.rowsWorld;
  for (const [n, r] of Object.entries(rows)) {
    const number = Number(n);
    const newest = r.comments.map((c) => c.createdAt).sort().at(-1);
    code.rows.set(number, fakeRow(code, number, { state: r.state === "closed" ? "CLOSED" : "OPEN", createdAt: newest, updatedAt: newest, closedAt: r.state === "closed" ? newest : null,
      comments: r.comments.map((c, id) => ({ id: id + 1, body: c.body, createdAt: c.createdAt, author: c.login ?? "a11ign-ai-leads" })) }));
    if (r.labelEvents) code.gate.events.set(number, r.labelEvents.map((e) => ({ event: "labeled" as const, label: e.label, actor: e.actor, at: e.createdAt })));
  }
  const readState = host.rows!.rowStateAndNewestComment;
  host.rows!.rowStateAndNewestComment = (request) => (refuse.includes(request.number) ? null : readState(request));
  const listed = host.rows!.issuesSinceOf;
  if (!listsClosed) host.rows!.issuesSinceOf = (request) => listed(request).filter((issue: { state: string }) => issue.state !== "closed");
  substituteCodeHost(host);
  const posts = (): string[] => [...code.rows.values()].flatMap((row) => row.labels.filter((l) => l.startsWith("answer:")).map((l) => `${row.number} labels[]=${l}`));
  const run = (args: string[]): string => { throw new Error(`every read here is the code host's, not a gh: ${args.join(" ")}`); };
  const post = ({ readProse, repo, run: r, now }: any) => { readProse({ repo, run: r, now }); return "posted"; };
  const agents = () => [{ label: "orchestrator", status: "idle" }];
  const read = () => boardTruthNow({ openRowsRead: [], waitFacts: { items: {} }, now: NOW } as any, { repo: code.repo, run, agents, post, log: (line: string) => log.push(line) } as any);
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
  assert.deepEqual(w.posts(), [`${LABELLED} labels[]=answer:product-manager`]);
  for (const n of [CLOSED, REPORT, REPLAYED, UNREAD]) assert.ok(w.log.some((line) => line.includes(`#${n}:`)), `#${n} is refused ON THE LOG, so a skipped label is a reading`);
  assert.match(w.log.find((l) => l.includes(`#${CLOSED}:`)) ?? "", /closed row/);
  assert.match(w.log.find((l) => l.includes(`#${REPORT}:`)) ?? "", /asks nothing/);
  assert.match(w.log.find((l) => l.includes(`#${REPLAYED}:`)) ?? "", /already labelled/);
  assert.match(w.log.find((l) => l.includes(`#${UNREAD}:`)) ?? "", /could not be read/);
});

test("a closed row is not labelled even when the guard would otherwise allow it: the state, not the comment, decides", () => {
  const w = world({ [CLOSED]: { state: "closed", comments: [handoff(true)] } });
  w.read();
  assert.deepEqual(w.posts(), []);
});

test("the newest comment is read from the row, not from the day's org comments: a later answer by anyone withdraws the question", () => {
  const answered = { body: "orchestrator: yes, protocol 21 is in the corpus.", createdAt: AT(10), login: "someone" };
  const w = world({ [LABELLED]: { comments: [handoff(true), answered] } });
  w.read();
  assert.deepEqual(w.posts(), []);
  assert.match(w.log.join("\n"), /asks nothing/);
});

test("a closed row the issues listing already shows closed raises no finding at all, so it is neither labelled nor refused on the log", () => {
  const w = world({ [LABELLED]: { comments: [handoff(true)] }, [CLOSED]: { state: "closed", comments: [handoff(true)] } }, { listsClosed: true });
  w.read();
  assert.deepEqual(w.posts(), [`${LABELLED} labels[]=answer:product-manager`], "CONTROL: the open row is labelled");
  assert.ok(!w.log.some((line) => line.includes(`#${CLOSED}:`)));
});
