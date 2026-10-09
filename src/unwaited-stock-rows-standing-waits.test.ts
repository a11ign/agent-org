// no-token: gh -- every read here goes through a fake tracker reader; no `gh` call is made.
// #4323: a `needs:chairman` row and a `meta` row are not "unwaited". The first has `chairman-blocked`'s daily reminder as the wait that moves it, the second is a
// declared standing row with no condition to wait for. The exemption is the LABEL and nothing else, so each control below removes the label and expects the count back.
import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore -- a leaf .mjs with JSDoc types
import { unwaitedStockRows } from "./unwaited-stock-rows.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T00:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const row = (number: number, labels: string[]) => ({
  number, title: `row ${number}`, body: "## What it is\n\nNothing waits on this.\n",
  labels: labels.map((name) => ({ name })), blockedBy: { nodes: [] },
});
const STANDING = [
  row(20, ["backlog", "meta", "out-of-release"]), // the daily board report's issue, as read on 2026-10-09
  row(2568, ["backlog", "lane:any", "needs:chairman"]), // a chairman wait, as read on 2026-10-09
  row(30, ["parked", "needs:chairman"]),
];
const bare = (rows: ReturnType<typeof row>[]) => rows.map((r) => row(r.number, r.labels.map((l) => l.name).filter((n) => n !== "meta" && n !== "needs:chairman")));

const reading = (rows: ReturnType<typeof row>[]) => unwaitedStockRows({
  now: NOW,
  reader: {
    listRows: () => rows,
    timeline: (number: number) => {
      const stock = rows.find((r) => r.number === number)!.labels.map((l) => l.name).find((n) => n === "backlog" || n === "parked");
      return [{ event: "labeled", created_at: ago(48), label: { name: stock } }];
    },
  },
});

test("control (a): every stock row carrying needs:chairman or meta, past 24h with no other wait, is not counted, and the population is not empty", () => {
  assert.ok(STANDING.length >= 2, "the derived population is at least the two rows the 2026-10-09 report counted");
  const stock = reading(STANDING);
  assert.equal(stock.status, "read");
  assert.deepEqual(stock.rows.map((r: { number: number }) => r.number), []);
});

test("control (b): the SAME rows without the label ARE counted, so the exemption is the label and nothing else", () => {
  const stock = reading(bare(STANDING));
  assert.equal(stock.status, "read");
  assert.deepEqual(stock.rows.map((r: { number: number }) => r.number).sort((a: number, b: number) => a - b), STANDING.map((r) => r.number).sort((a, b) => a - b));
});

test("control (c): a stock row with neither label and no wait is still counted beside the exempt ones", () => {
  const stock = reading([...STANDING, row(4122, ["backlog", "lane:ceo"])]);
  assert.equal(stock.status, "read");
  assert.deepEqual(stock.rows.map((r: { number: number }) => r.number), [4122]);
});

test("an exempt row is not aged: no timeline is read for it", () => {
  const reads: number[] = [];
  const stock = unwaitedStockRows({ now: NOW, reader: { listRows: () => STANDING, timeline: (n: number) => { reads.push(n); throw new Error("refused"); } } });
  assert.equal(stock.status, "read");
  assert.deepEqual(reads, []);
});
