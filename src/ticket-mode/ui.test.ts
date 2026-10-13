// no-token: gh -- the page's own script runs against a fake DOM and a canned fetch, with the tested board-view module as its import; no browser, no socket
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as view from "./board-view.ts";

/**
 * The page's module script, run as the browser would run it but in a `vm` context: its one import (`/board-view.js`, which the server sends as
 * `board-view.ts` with the types stripped) is supplied from the tested module itself, and its top-level `await` runs inside an async wrapper.
 */
const MODULE = /<script type="module">([\s\S]*)<\/script>/.exec(readFileSync(new URL("./ui.html", import.meta.url), "utf8"))![1];
const IMPORT = /^import \{[^}]*\} from "\/board-view\.js";$/m;
if (!IMPORT.test(MODULE)) throw new Error("the page's script no longer imports /board-view.js as this test expects");
const SCRIPT = `(async () => {\n${MODULE.replace(IMPORT, "")}\n})();`;

class Node_ {
  children: Node_[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: { stopPropagation(): void }) => void)[]> = {};
  parent: Node_ | null = null;
  className = "";
  textContent = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: (Node_ | string)[]) {
    for (const n of nodes) this.children.push(Object.assign(typeof n === "string" ? Object.assign(new Node_("#text"), { textContent: n }) : n, { parent: this }));
  }
  replaceChildren(...nodes: Node_[]) { this.children = []; this.append(...nodes); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(type: string, fn: (event: { stopPropagation(): void }) => void) { (this.listeners[type] ??= []).push(fn); }
  /** Dispatch `type` here and bubble it up the parents, as a browser does, until a listener stops it. */
  fire(type: string) {
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };
    for (let node: Node_ | null = this; node !== null && !stopped; node = node.parent) for (const fn of node.listeners[type] ?? []) fn(event);
  }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(""); }
  all(): Node_[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

const TICKETS = [
  { key: "T-1", title: "one", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "" },
  { key: "T-2", title: "two", status: "Backlog", statusOrder: 0, priority: 2, project: "Beta", url: "" },
  { key: "T-3", title: "three", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "" },
  { key: "T-4", title: "four", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "" },
];

/** Run the page's script against a fake document, with `storage` as its localStorage. Resolves once the first render has happened. */
async function page(storage: Map<string, string>, config: Record<string, unknown> = {}, entries: unknown[] = [], tickets: unknown[] = TICKETS, parents: unknown[] = []) {
  const byId = new Map<string, Node_>();
  const posts: { path: string; body: any }[] = [];
  const document = {
    getElementById: (id: string) => { if (!byId.has(id)) byId.set(id, new Node_(`#${id}`)); return byId.get(id)!; },
    createElement: (tag: string) => new Node_(tag),
    querySelectorAll: () => [],
    activeElement: null,
  };
  const fetch = async (path: string, init: { method: string; body?: string } = { method: "GET" }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    if (init.method === "POST") posts.push({ path, body });
    const value = path === "/api/config" ? { models: ["opus"], efforts: ["high"], choice: { model: "opus", effort: "high" }, max: 3, ...config }
      : path === "/api/tickets" ? tickets : path === "/api/parents" ? parents : { entries, max: 3, paused: true };
    return { ok: true, json: async () => value, statusText: "" };
  };
  const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } };
  runInNewContext(SCRIPT, { ...view, document, fetch, window: { localStorage }, setInterval: () => 0, Date, JSON, Object, Array, Set, Map, String, Number, Boolean, Math });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  const $ = (id: string) => document.getElementById(id);
  const groups = () => $("groups").children;
  const shownKeys = () => $("groups").all().filter((n) => n.className.startsWith("row")).map((n) => n.children[1].text());
  const chip = (name: string) => $("projects").children.find((c) => c.tag === "button" && c.children[0]?.text() === name || c.textContent === name)!;
  return { $, groups, shownKeys, chip, posts };
}

test("a project chip filters the list, several can be chosen at once, and All projects clears them; the choice is kept in localStorage", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage);
  assert.deepEqual(p.shownKeys(), ["T-1", "T-2", "T-3", "T-4"]);
  for (const chipText of ["Alpha2", "Beta1", "(no project)1"]) assert.ok(p.$("projects").text().includes(chipText), `a chip with its count: ${chipText}`);
  p.chip("Beta").fire("click");
  assert.deepEqual(p.shownKeys(), ["T-2"]);
  p.chip("(no project)").fire("click");
  assert.deepEqual(p.shownKeys(), ["T-2", "T-4"], "a second chip adds its tickets");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.projects")!).sort(), ["(no project)", "Beta"]);
  p.chip("All projects").fire("click");
  assert.deepEqual(p.shownKeys(), ["T-1", "T-2", "T-3", "T-4"]);
  assert.equal(storage.get("ticket-mode.projects"), "[]");
});

test("a remembered project filter is applied when the page loads again", async () => {
  const p = await page(new Map([["ticket-mode.projects", JSON.stringify(["Alpha"])]]));
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"]);
});

/** Which status sections are collapsed, in order. */
const collapsed = (p: Awaited<ReturnType<typeof page>>) => p.groups().map((g) => g.className.includes("collapsed"));

test("status sections start collapsed, open and close from anywhere on their header, and stay as left after a reload", async () => {
  const storage = new Map<string, string>();
  const first = await page(storage);
  assert.deepEqual(collapsed(first), [true, true], "a first visit sees every section collapsed");
  first.groups()[0].children[0].all().find((n) => n.className === "name")!.fire("click");
  assert.deepEqual(collapsed(first), [false, true], "a click on the section's name opens only that section");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.open")!), ["Backlog"]);
  const reloaded = await page(storage);
  assert.deepEqual(collapsed(reloaded), [false, true], "the reload keeps it open");
  reloaded.groups()[0].children[0].all().find((n) => n.className === "fold")!.fire("click");
  assert.deepEqual(collapsed(reloaded), [true, true], "the arrow closes it");
  assert.equal(storage.get("ticket-mode.open"), "[]");
});

const EPIC = [
  { key: "E-1", title: "epic", status: "In Progress", statusOrder: 2, priority: 2, project: null, url: "", parent: null },
  { key: "C-1", title: "child", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-1" },
  { key: "G-1", title: "grandchild", status: "Backlog", statusOrder: 0, priority: 2, project: null, url: "", parent: "C-1" },
];
type Page = Awaited<ReturnType<typeof page>>;
const rowsOf = (p: Page) => p.$("groups").all().filter((n) => n.className.startsWith("row"));
const rowFor = (p: Page, key: string) => rowsOf(p).find((r) => r.children[1].text() === key)!;
const foldOf = (p: Page, key: string) => rowFor(p, key).all().find((n) => n.className === "fold")!;
const tickOf = (p: Page, key: string) => rowFor(p, key).all().find((n) => n.tag === "input")!;

test("a parent starts folded, opens to list the tickets under it, indented, each naming its own status, and stays as left after a reload", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, {}, [], EPIC);
  assert.equal(p.groups().length, 1, "one section, the epic's");
  assert.deepEqual(p.shownKeys(), ["E-1"], "folded, the epic is one row");
  assert.match(rowFor(p, "E-1").text(), /2 tickets under it/);
  foldOf(p, "E-1").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1", "C-1"], "the child is a parent too, and folded");
  foldOf(p, "C-1").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1", "C-1", "G-1"]);
  assert.deepEqual(rowsOf(p).map((r) => r.attrs.style), [undefined, "--depth: 1", "--depth: 2"]);
  assert.match(rowFor(p, "C-1").text(), /child · Todo/);
  assert.equal(rowFor(p, "E-1").text().includes("· In Progress"), false, "a top-level ticket's status is its section's");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.open-parents")!), ["E-1", "C-1"]);
  assert.deepEqual((await page(storage, {}, [], EPIC)).shownKeys(), ["E-1", "C-1", "G-1"], "the reload keeps them open");
  foldOf(p, "E-1").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1"], "folding the epic hides everything under it");
});

test("ticking a parent picks the tickets under it that can still be picked, never the parent, and part ticks it when only some are picked", async () => {
  const tickets = [...EPIC, { key: "C-2", title: "queued", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-1" }];
  const p = await page(new Map(), {}, [entry("C-2", { phase: "queued" })], tickets);
  tickOf(p, "E-1").checked = true;
  tickOf(p, "E-1").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket", "only G-1: C-1 is a parent, and C-2 is on the queue already");
  assert.equal(tickOf(p, "E-1").checked, true);
  foldOf(p, "E-1").fire("click");
  assert.equal(tickOf(p, "C-1").checked, true, "a parent under it shows its own tickets picked");
  p.$("queue").fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.posts.find((x) => x.path === "/api/queue")?.body.keys, ["G-1"]);
});

test("a parent with some of its tickets picked is part ticked, and one with none left to pick cannot be ticked", async () => {
  const tickets = [
    { key: "E-1", title: "epic", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null },
    ...["C-1", "C-2"].map((key) => ({ key, title: key, status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-1" })),
    { key: "E-2", title: "done epic", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null },
    { key: "C-3", title: "queued", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-2" },
  ];
  const p = await page(new Map([["ticket-mode.open-parents", JSON.stringify(["E-1"])]]), {}, [entry("C-3", { phase: "queued" })], tickets);
  tickOf(p, "C-1").checked = true;
  tickOf(p, "C-1").fire("change");
  assert.deepEqual([tickOf(p, "E-1").checked, (tickOf(p, "E-1") as unknown as { indeterminate: boolean }).indeterminate], [false, true]);
  assert.equal(tickOf(p, "E-2").disabled, true, "its one ticket is on the queue");
});

test("a parent that is not the person's heads its children with a checkbox that picks them, and says it is not theirs", async () => {
  const p = await page(new Map(), {}, [], ["VE-65", "VE-66"].map((key) => ({ key, title: key, status: "Backlog", statusOrder: 0, priority: 2, project: null, url: "", parent: "NBF-1917" })),
    [{ key: "NBF-1917", title: "lint rules", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null }]);
  assert.deepEqual(rowsOf(p).map((r) => r.className), ["row parent context"], "folded, as every parent starts");
  assert.match(rowFor(p, "NBF-1917").text(), /Not assigned to you/);
  tickOf(p, "NBF-1917").checked = true;
  tickOf(p, "NBF-1917").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 2 tickets");
  foldOf(p, "NBF-1917").fire("click");
  assert.deepEqual(rowsOf(p).map((r) => [r.className, r.attrs.style]), [["row parent context", undefined], ["row child", "--depth: 1"], ["row child", "--depth: 1"]]);
});

test("Select all takes every ticket under a parent, folded or not, and never the parent", async () => {
  const p = await page(new Map(), {}, [], EPIC);
  p.$("all").checked = true;
  p.$("all").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket", "only G-1");
  assert.equal(p.$("all").checked, true);
});

test("Expand all opens every parent with the sections, and Collapse all folds them again", async () => {
  const p = await page(new Map(), {}, [], EPIC);
  p.$("fold-all").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1", "C-1", "G-1"]);
  assert.equal(p.$("fold-all").textContent, "Collapse all");
  p.$("fold-all").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1"]);
  assert.equal(p.$("fold-all").textContent, "Expand all");
});

test("ticking a section's checkbox selects its tickets and leaves the section as it was", async () => {
  const p = await page(new Map());
  const tick = p.groups()[0].children[0].all().find((n) => n.tag === "input")!;
  tick.checked = true;
  tick.fire("click");
  tick.fire("change");
  assert.deepEqual(collapsed(p), [true, true]);
  assert.equal(p.$("queue").textContent, "Queue 3 tickets");
});

test("Expand all opens every section and becomes Collapse all, which closes them again", async () => {
  const p = await page(new Map());
  assert.equal(p.$("fold-all").textContent, "Expand all");
  p.$("fold-all").fire("click");
  assert.deepEqual(collapsed(p), [false, false]);
  assert.equal(p.$("fold-all").textContent, "Collapse all");
  p.$("fold-all").fire("click");
  assert.deepEqual(collapsed(p), [true, true]);
});

test("Select all takes the visible tickets, and Queue sends exactly those with the model and effort and no repository", async () => {
  const p = await page(new Map([["ticket-mode.projects", JSON.stringify(["Alpha"])]]));
  p.$("all").checked = true;
  p.$("all").fire("change");
  p.$("queue").fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  const body = p.posts.find((x) => x.path === "/api/queue")?.body;
  assert.deepEqual(body?.keys, ["T-1", "T-3"], "T-2 and T-4 are filtered out");
  assert.equal("repos" in (body ?? {}), false, "the worker chooses the repository");
});

const entry = (key: string, fields: Record<string, unknown>) => ({ ticket: { key, title: `title ${key}`, url: "" }, repos: [], model: "opus", effort: "high", queuedAt: 1, ...fields });
const RUNS = [
  entry("Q-1", { phase: "queued" }),
  entry("R-1", { phase: "running", startedAt: 5 }),
  entry("W-1", { phase: "running", startedAt: 6, waiting: true }),
  entry("D-1", { phase: "finished", startedAt: 2, finishedAt: 7, outcome: { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/y/pull/12" }] } }),
  entry("M-1", { phase: "finished", startedAt: 2, finishedAt: 8, trackerState: "completed", outcome: { kind: "draft-pr", prs: [] } }),
  entry("F-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "crashed", reason: "herdr refused" } }),
];
/** The runs view's rows and filter buttons, as the page drew them. */
const runRows = (p: Awaited<ReturnType<typeof page>>) => p.$("runs").children.filter((n) => n.className === "run");
const filterButton = (p: Awaited<ReturnType<typeof page>>, label: string) => p.$("filters").children.find((b) => b.children.some((c) => c.text() === label))!;

test("the runs view lists every run with its status icon, most recently active first", async () => {
  const p = await page(new Map(), {}, RUNS);
  const rows = runRows(p);
  assert.equal(rows.length, 6);
  const icons = rows.map((r) => r.children[0].className);
  assert.deepEqual(icons, ["icon st-completed", "icon st-awaiting-review", "icon st-needs-you", "icon st-working", "icon st-failed", "icon st-queued"]);
});

test("a run waiting on a blocker is Blocked, with its own filter, and names what it waits on", async () => {
  const runs = [
    entry("APP-1", { phase: "queued", blockers: [{ key: "LIB-1", state: "started", status: "In Review" }] }),
    entry("LIB-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "draft-pr", prs: [{ repo: "libs", url: "https://github.com/x/libs/pull/3" }] } }),
    entry("APP-2", { phase: "queued", blockers: [{ key: "LIB-2", state: "started", status: "In Review" }] }),
    entry("LIB-2", { phase: "finished", startedAt: 2, finishedAt: 4, outcome: { kind: "draft-pr", prs: [{ repo: "libs", url: "https://github.com/x/libs/pull/4" }] },
      pullStates: { "https://github.com/x/libs/pull/4": "merged" } }),
  ];
  const p = await page(new Map(), {}, runs);
  const blocked = runRows(p).find((r) => r.text().includes("APP-1"))!;
  assert.equal(blocked.children[0].className, "icon st-blocked");
  assert.match(blocked.text(), /Waits on LIB-1 \(In Review\)/);
  assert.equal(runRows(p).find((r) => r.text().includes("APP-2"))!.children[0].className, "icon st-queued", "its blocker merged on the queue");
  filterButton(p, "Blocked").fire("click");
  assert.deepEqual(runRows(p).map((r) => r.text().match(/APP-\d|LIB-\d/)![0]), ["APP-1"]);
  assert.equal(filterButton(p, "Blocked").children.find((c) => c.className === "n")!.text(), "1");
});

test("the In progress filter is a still dot, and a working run's own icon is the spinning ring", async () => {
  const p = await page(new Map(), {}, RUNS);
  const railIcon = filterButton(p, "In progress").children[0] as Node_ & { innerHTML: string };
  const rowIcon = runRows(p).map((r) => r.children[0]).find((i) => i.className === "icon st-working") as Node_ & { innerHTML: string };
  assert.equal(railIcon.className, "icon st-working", "it keeps the status's colour");
  assert.match(railIcon.innerHTML, /<circle cx="8" cy="8" r="5" fill="currentColor"\/>/);
  assert.doesNotMatch(railIcon.innerHTML, /<path/, "no arc to turn");
  assert.match(rowIcon.innerHTML, /<path d="M8 2a6 6 0 0 1 6 6"/);
});

test("each filter shows its count, and choosing one shows only its runs and is remembered", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, {}, RUNS);
  assert.equal(filterButton(p, "All runs").children.at(-1)!.text(), "6");
  assert.equal(filterButton(p, "Needs you").children.at(-1)!.text(), "1");
  assert.equal(filterButton(p, "Completed").children.at(-1)!.text(), "1");
  assert.equal(filterButton(p, "Cancelled").children.at(-1)!.text(), "0");
  filterButton(p, "Failed").fire("click");
  assert.deepEqual(runRows(p).map((r) => r.children[0].className), ["icon st-failed"]);
  assert.equal(filterButton(p, "Failed").attrs["aria-pressed"], "true");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.run-filter")!), ["failed"]);
  filterButton(p, "Cancelled").fire("click");
  assert.equal(p.$("runs").text(), "No runs are cancelled.");
});

test("a row offers only the actions its state allows, and a completed run is not retried", async () => {
  const p = await page(new Map(), {}, RUNS);
  const buttons = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.tag === "button").map((b) => b.textContent);
  assert.deepEqual(buttons("Q-1"), ["Remove"]);
  assert.deepEqual(buttons("R-1"), ["Stop"]);
  assert.deepEqual(buttons("F-1"), ["Retry"]);
  assert.deepEqual(buttons("M-1"), []);
  assert.ok(runRows(p).find((r) => r.text().includes("D-1"))!.text().includes("nbl-ui-netbox #12"), "the draft's pull request is linked by repo and number");
});

test("a live or parked run links its terminal when the machine serves one, and a parked run offers Close, which goes to the board", async () => {
  const runs = [
    entry("R-1", { phase: "running", startedAt: 5, workspace: "w1", pane: "w1:p1" }),
    entry("P-1", { phase: "finished", startedAt: 2, finishedAt: 4, workspace: "w2", pane: "w2:p1", outcome: { kind: "needs-human", reason: "which colour?" } }),
    entry("F-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "crashed", reason: "herdr refused" } }),
  ];
  const p = await page(new Map(), { terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" }, runs);
  const row = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  const link = (key: string) => row(key).all().find((n) => n.className === "terminal") as (Node_ & { href?: string; target?: string }) | undefined;
  assert.equal(link("R-1")?.href, "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal");
  assert.equal(link("R-1")?.target, "_blank", "it opens in its own tab: the terminal page refuses to be framed");
  assert.equal(link("P-1")?.href, "http://127.0.0.1:7318/?ws=w2&pane=w2%3Ap1&view=terminal");
  assert.equal(link("F-1"), undefined, "a run with no workspace has no terminal");
  assert.ok(row("P-1").text().includes("Still open"), "a parked run says it can still be answered");
  const close = row("P-1").all().find((n) => n.tag === "button")!;
  assert.equal(close.textContent, "Close");
  close.fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(p.posts.some((x) => x.path === "/api/queue/P-1/close"));
  const none = await page(new Map(), {}, runs);
  assert.equal(runRows(none).flatMap((r) => r.all()).find((n) => n.className === "terminal"), undefined, "a machine that serves no terminal shows no link");
});
