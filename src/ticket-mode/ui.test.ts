// no-token: gh -- the page's own script runs against a fake DOM and a canned fetch, with the tested board-view, label-filters and assignee-filter modules as its imports; no browser, no socket
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as view_0 from "./board-view.ts";
import * as view_1 from "./board-view/pull-status-and-notes.ts";
import * as view_2 from "./board-view/view-types-and-filters.ts";
import * as view_3 from "./board-view/run-reason.ts";
import * as view_4 from "./board-view/pull-review-state.ts";
import * as view_5 from "./board-view/update-banner.ts";
import * as view_6 from "./board-view/ticket-change.ts";
import * as view_7 from "./board-view/run-terminal.ts";
import * as view_8 from "./board-view/overlap-hold.ts";
import * as labelFilters from "./label-filters.ts";
import * as assigneeFilter from "./assignee-filter.ts";
import * as settingsSearch from "./settings-search.ts";
import * as pluginsSection from "./plugins-section.ts";
import { testEach } from "../lib/test-each.ts";

/**
 * The page's module script, run as the browser would run it but in a `vm` context: its imports (`/board-view.js`, `/label-filters.js` and
 * `/assignee-filter.js`, which the server sends as the `.ts` modules with the types stripped) are supplied from the tested modules themselves,
 * and its top-level `await` runs inside an async wrapper.
 */
const MODULE = /<script type="module">([\s\S]*)<\/script>/.exec(readFileSync(new URL("./ui.html", import.meta.url), "utf8"))![1];
const IMPORTS = /^import \{[^}]*\} from "\/(board-view|label-filters|assignee-filter|settings-search|plugins-section)\.js";$/gm;
const imported = [...MODULE.matchAll(IMPORTS)].map((m) => m[1]).sort();
if (imported.join() !== "assignee-filter,board-view,label-filters,plugins-section,settings-search") throw new Error(`the page's script imports ${imported.join() || "nothing"}, not /board-view.js, /label-filters.js, /assignee-filter.js, /settings-search.js and /plugins-section.js as this test expects`);
const SCRIPT = `(async () => {\n${MODULE.replace(IMPORTS, "")}\n})();`;

class Node_ {
  children: Node_[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: { stopPropagation(): void }) => void)[]> = {};
  parent: Node_ | null = null;
  className = "";
  textContent = "";
  title = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  open = false;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: (Node_ | string)[]) {
    for (const n of nodes) this.children.push(Object.assign(typeof n === "string" ? Object.assign(new Node_("#text"), { textContent: n }) : n, { parent: this }));
  }
  replaceChildren(...nodes: Node_[]) { this.children = []; this.append(...nodes); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  /** Set by the page when it scrolls a card into view, as a test of the link to a run checks. */
  scrolled = false;
  scrollIntoView() { this.scrolled = true; }
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
/** The same tickets, all in one project, for the tests that are not about projects: the Pick list shows one project, so these list every ticket. */
const inOneProject = <T extends { project: string | null }>(tickets: readonly T[]) => tickets.map((t) => ({ ...t, project: "Alpha" }));
const ONE_PROJECT = inOneProject(TICKETS);

/** An element of the fake document. Focus is recorded as an attribute, so a test can check focus went back to the control that opened Settings. */
const fakeElement = (id: string) => {
  const node = new Node_(`#${id}`);
  return Object.assign(node, { focus: () => { node.attrs.focused = "true"; } });
};

/** Run the page's script against a fake document, with `storage` as its localStorage. Resolves once the first render has happened. */
/** A browser as the page sees it: the tabs it opens (none while `blockTabs`, as a pop-up blocker does), the timers it sets and the poll it runs, for a test to run by hand. */
function browserStubs(blockTabs: boolean) {
  const tabs: { closed: boolean; location: { href: string }; close: () => void }[] = [];
  const timers: (() => void)[] = [];
  const polls: (() => void)[] = [];
  // A tab opened under a name is the one every later open of that name finds, as a browser's named windows are (A11-171).
  const named = new Map<string, (typeof tabs)[number]>();
  const open = (_url?: string, name?: string) => {
    if (blockTabs) return null;
    const known = name === undefined || name === "_blank" ? undefined : named.get(name);
    if (known !== undefined) return known;
    const tab = { closed: false, location: { href: "" }, close() { this.closed = true; } };
    tabs.push(tab);
    if (name !== undefined && name !== "_blank") named.set(name, tab);
    return tab;
  };
  return { tabs, timers, polls, open, setInterval: (fn: () => void) => { polls.push(fn); return 0; }, setTimeout: (fn: () => void) => { timers.push(fn); return 0; } };
}

type PageOptions = { config?: Record<string, unknown>; entries?: unknown[]; tickets?: unknown[]; parents?: unknown[]; refused?: string[]; publish?: unknown;
  /** The review state the pool read of each open pull request, by url, as the queue carries it (A11-119). */
  pulls?: Record<string, string>;
  /** The one line for review claims GitHub refuses, as the queue carries it (A11-172). */
  claimWarning?: string | null;
  connections?: unknown; errors?: Record<string, string>; hold?: Record<string, unknown>; pick?: unknown; children?: unknown;
  /** The new-ticket requests the board reads, and what a writer route answers for a path and body (default: the requests, as they are). */
  writers?: { runs: unknown[] }; writerReply?: (path: string, body: any) => unknown;
  /** A browser that blocks a new tab: `window.open` answers null, as a pop-up blocker does. */
  blockTabs?: boolean;
  /** The address the page was opened at: its query (`?connection=...`) and its hash (the card to scroll to). */
  search?: string; hash?: string;
  /** An instance that reads scopes on demand: who holds the open tickets, and the pages of a scope (`/api/tickets?assignee=...`) by that query's text. */
  held?: unknown; scoped?: Record<string, { tickets: unknown[]; next: string | null }>;
  /** Why this instance starts no run (`tickets.preflight`), as its queue answer carries it. */
  queueHeld?: { name: string; reason: string; since: number };
  /** What the instance's Settings page reads (`/api/settings`), by default an instance with nothing to describe. */
  settings?: unknown;
  /** What the queue says of the instance's version and a breaking update that drains (`update`, A11-169). */
  update?: unknown;
  /** What the instance's Plugins section reads (`/api/plugins`), and what it answers an action with; the text Copy puts on the clipboard goes to `clipboard`. */
  plugins?: unknown; pluginActions?: (body: any) => unknown; clipboard?: string[];
  /** What the instance answers a Settings edit with (`/api/settings/preview`, `save` and `restore`), by its path and body. */
  edits?: (path: string, body: any) => unknown };
const NOTHING_TO_DESCRIBE = { refusals: [], notes: [], groups: [], plugins: [], words: [], contract: [] };
async function page(storage: Map<string, string>, { config = {}, entries = [], tickets = TICKETS, parents = [], refused = [], publish, connections, errors = {}, hold = {}, pick, children, pulls, claimWarning,
  writers = { runs: [] }, writerReply, held, scoped, queueHeld, blockTabs = false, search = "", hash = "", settings = NOTHING_TO_DESCRIBE, edits, plugins, pluginActions, clipboard = [], update }: PageOptions = {}) {
  const byId = new Map<string, Node_>();
  const posts: { path: string; body: any }[] = [], requested: string[] = [];
  // A path in `hold` answers its value only once the test calls `release`, as a slow remote does.
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const document = {
    // eslint-disable-next-line clean-code/names-describe-side-effects -- the DOM's getElementById, which the page script calls by this name; the fake creates and caches the node on first request
    getElementById: (id: string) => { if (!byId.has(id)) byId.set(id, fakeElement(id)); return byId.get(id)!; },
    createElement: (tag: string) => new Node_(tag),
    querySelectorAll: () => [],
  };
  // The board's saved choice, which a POST to /api/choice changes part by part, as the server does, and its saved number of workers.
  let saved = { model: "opus", effort: "high", ...(config.choice as object | undefined) };
  let max = 3;
  const fetch = async (path: string, init: { method: string; body?: string } = { method: "GET" }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    if (init.method === "POST") posts.push({ path, body });
    requested.push(path);
    if (path in hold) {
      await gate;
      return { ok: true, json: async () => hold[path], statusText: "" };
    }
    if (refused.includes(path)) return { ok: false, json: async () => ({ error: errors[path] ?? `${path} refused` }), statusText: "" };
    if (path.replace(/^\/c\/[^/]+(?=\/api\/)/, "").startsWith("/api/writer")) {
      const reply = writerReply === undefined ? writers : writerReply(path, body);
      return { ok: true, json: async () => reply, statusText: "" };
    }
    const scopedQuery = path.replace(/^\/c\/[^/]+(?=\/api\/)/, "").split("/api/tickets?")[1];
    if (scopedQuery !== undefined) {
      const reply = scoped?.[scopedQuery];
      return reply === undefined ? { ok: false, json: async () => ({ error: `no page for ${scopedQuery}` }), statusText: "" } : { ok: true, json: async () => reply, statusText: "" };
    }
    // Each connection's instance answers as one instance does, under its prefix.
    const answers: Record<string, () => unknown> = {
      ...(connections === undefined ? {} : { "/api/connections": () => connections }),
      "/api/config": () => ({ models: ["opus"], efforts: ["high"], max: 3, ...config, choice: saved }),
      "/api/tickets": () => tickets,
      "/api/parents": () => parents,
      ...(held === undefined ? {} : { "/api/people": () => held }),
      ...(pick === undefined ? {} : { "/api/pick": () => pick }),
      "/api/choice": () => { saved = { ...saved, ...body }; return { choice: saved }; },
      "/api/max": () => { max = body.max; return { entries, max, paused: true }; },
      ...(children === undefined ? {} : { "/api/queue-children": () => children }),
      "/api/settings": () => settings,
      ...(plugins === undefined ? {} : { "/api/plugins": () => plugins }), ...(pluginActions === undefined ? {} : { "/api/plugins/action": () => pluginActions(body) }),
      ...(edits === undefined ? {} : { "/api/settings/preview": () => edits("/api/settings/preview", body), "/api/settings/save": () => edits("/api/settings/save", body), "/api/settings/restore": () => edits("/api/settings/restore", body) }),
    };
    const value = (answers[path] ?? answers[path.replace(/^\/c\/[^/]+(?=\/api\/)/, "")])?.() ?? { entries, max, paused: true, ...(publish ? { publish } : {}), ...(queueHeld ? { held: queueHeld } : {}), ...(update === undefined ? {} : { update }), pulls: pulls ?? {}, ...(claimWarning === undefined ? {} : { claimWarning }) };
    return { ok: true, json: async () => value, statusText: "" };
  };
  const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } };
  const browser = browserStubs(blockTabs);
  // The page's address, which its links and buttons change, and the `hashchange` listeners a browser calls when it does.
  const location = { search, hash };
  const hashListeners: (() => void)[] = [];
  runInNewContext(SCRIPT, { ...view_0, ...view_1, ...view_2, ...view_3, ...view_4, ...view_5, ...view_6, ...view_7, ...view_8, ...labelFilters, ...assigneeFilter, ...settingsSearch, ...pluginsSection, document, fetch,
    window: { localStorage, open: browser.open, navigator: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } }, addEventListener: (type: string, fn: () => void) => { if (type === "hashchange") hashListeners.push(fn); } },
    location, URLSearchParams, setInterval: browser.setInterval, setTimeout: browser.setTimeout, Date, JSON, Object, Array, Set, Map, String, Number,
    Boolean, Math });
  for (let i = 0; i < 10; i++) await settle();
  const $ = (id: string) => document.getElementById(id);
  const groups = () => $("groups").children;
  const shownKeys = () => $("groups").all().filter((n) => n.className.startsWith("row")).map((n) => n.children[1].text());
  /** The chip labelled `name` in a row of chips: the projects, unless another row is named. */
  const chip = (name: string, row = "projects") => $(row).children.find((c) => c.tag === "button" && (c.children[0]?.text() === name || c.textContent === name))!;
  /** Another page saves `change` to the board's choice, or `workers` as its number of workers at once. */
  const saveElsewhere = ({ workers, ...change }: { model?: string; effort?: string; workers?: number }) => {
    saved = { ...saved, ...change };
    max = workers ?? max;
  };
  /** Run the page's poll once, as its five-second interval does, and let what it starts settle. */
  const poll = async () => { for (const fn of browser.polls) fn(); for (let i = 0; i < 10; i++) await settle(); };
  /** Run the timers the page set, and let what they start settle. */
  const runTimers = async () => { for (const fn of browser.timers.splice(0)) fn(); for (let i = 0; i < 10; i++) await settle(); };
  /** The browser's `hashchange`, after the page has changed its address. */
  const hashChange = async () => { for (const fn of hashListeners) fn(); for (let i = 0; i < 10; i++) await settle(); };
  return { $, groups, shownKeys, chip, posts, saveElsewhere, requested, release, tabs: browser.tabs, poll, runTimers, location, hashChange };
}

/** Let the page's pending fetches and their handlers run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const BY_PRIORITY = [
  { key: "U-1", title: "urgent", status: "Backlog", statusOrder: 0, priority: 1, project: "Alpha", url: "" },
  { key: "H-1", title: "high", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "" },
  { key: "N-1", title: "none", status: "Backlog", statusOrder: 0, priority: 0, project: "Alpha", url: "" },
];

test("a priority chip filters the list, several can be chosen at once, and All priorities clears them; the choice is kept in localStorage", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { tickets: BY_PRIORITY });
  for (const chipText of ["Urgent1", "High1", "No priority1"]) assert.ok(p.$("priorities").text().includes(chipText), `a chip with its count: ${chipText}`);
  assert.equal(p.$("priorities").text().includes("Low"), false, "a priority no ticket has gets no chip");
  p.chip("Urgent", "priorities").fire("click");
  assert.deepEqual(p.shownKeys(), ["U-1"]);
  p.chip("No priority", "priorities").fire("click");
  assert.deepEqual(p.shownKeys(), ["U-1", "N-1"]);
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.priorities")!).sort(), ["0", "1"]);
  p.chip("All priorities", "priorities").fire("click");
  assert.deepEqual(p.shownKeys(), ["U-1", "H-1", "N-1"]);
});

test("a remembered priority filter is applied when the page loads again", async () => {
  const p = await page(new Map([["ticket-mode.priorities", JSON.stringify(["2"])]]), { tickets: BY_PRIORITY });
  assert.deepEqual(p.shownKeys(), ["H-1"]);
});

test("A11-119: a needs-human run shows its pull request's review state beside its question, and a pull request no run lists is in the Pull requests section", async () => {
  const review = [{ url: "https://github.com/a11ign/control/pull/119", repo: "a11ign/control" }];
  const reviews = { "https://github.com/a11ign/control/pull/119": "awaiting review at 91bf0677", "https://github.com/a11ign/agent-org/pull/1800": "reviewing" };
  const p = await page(new Map(), { entries: [entry("N-1", { phase: "finished", finishedAt: 7, outcome: { kind: "needs-human", reason: "which colour?" }, review })], pulls: reviews });
  assert.ok(p.$("runs").text().includes("which colour?"), "the question is shown");
  assert.ok(p.$("runs").text().includes("a11ign/control #119: awaiting review at 91bf0677"), "beside it, the pull request's review state");
  assert.equal(p.$("pull-requests").hidden, false, "the section is shown for the one no run lists");
  assert.ok(p.$("pull-requests").text().includes("a11ign/agent-org #1800") && p.$("pull-requests").text().includes("reviewing"), "with its label and its review state");
  assert.equal(p.$("pull-requests").text().includes("#119"), false, "and not the one a run lists");
});

test("A11-153: a needs-human run its pull request answered says so in place of its question, which stays one click away, and a note on the card is said once", async () => {
  const url = "https://github.com/a11ign/agent-org/pull/1800";
  const review = [{ url, repo: "a11ign/agent-org" }];
  const needsHuman = (fields: Record<string, unknown>, reason = "Does a copy run satisfy the done-when?") =>
    entry("N-1", { phase: "finished", finishedAt: 7, outcome: { kind: "needs-human", reason }, review, pullStates: { [url]: "open" }, outcomeHeads: { [url]: "h1" }, ...fields });
  const asking = await page(new Map(), { entries: [needsHuman({})] });
  assert.ok(asking.$("runs").text().includes("Does a copy run satisfy the done-when?"), "unanswered, the question is the card's line");
  assert.equal(asking.$("runs").all().some((n) => n.tag === "details"), false, "and there is nothing to open");
  const answered = await page(new Map(), { entries: [needsHuman({ pullHeads: { [url]: { head: "h2", approved: false } } })] });
  assert.ok(answered.$("runs").text().includes("Answered: awaiting review"), "a head that moved on reads Answered");
  const [question] = answered.$("runs").all().filter((n) => n.tag === "details");
  assert.ok(question.text().includes("The question it asked") && question.text().includes("Does a copy run satisfy the done-when?"), "the old question is under a disclosure");
  const approved = await page(new Map(), { entries: [needsHuman({ pullHeads: { [url]: { head: "h1", approved: true } } })] });
  assert.ok(approved.$("runs").text().includes("Approved"), "an approval at the head reads Approved");
  const note = "Resolving a conflict with A11-144 in doctor.ts";
  const stackBase = { key: "A11-144", repo: "agent-org", branch: "b", sha: "a".repeat(40), conflict: { head: "b".repeat(40), files: ["src/install/doctor.ts"] } };
  const twice = await page(new Map(), { entries: [needsHuman({ stackBase }, note)] });
  assert.equal(twice.$("runs").text().split(note).length - 1, 1, "a reason that is the rebase note is on the card once");
});

test("A11-119: the Pull requests section is hidden when every pull request the pool has read belongs to a run", async () => {
  const review = [{ url: "https://github.com/a11ign/control/pull/119", repo: "a11ign/control" }];
  const p = await page(new Map(), { entries: [entry("N-1", { phase: "finished", finishedAt: 7, outcome: { kind: "needs-human", reason: "which colour?" }, review })],
    pulls: { "https://github.com/a11ign/control/pull/119": "reviewing" } });
  assert.equal(p.$("pull-requests").hidden, true);
});

test("A11-173: the After-merge checks section renders one row per line with its ticket and owner, and is hidden when no run has listed any", async () => {
  const url = "https://github.com/a11ign/agent-org/pull/1802";
  const merged = { phase: "finished", finishedAt: 7, outcome: { kind: "ready-pr", prs: [{ url, repo: "a11ign/agent-org" }] }, pullStates: { [url]: "merged" } };
  const listed = await page(new Map(), { entries: [entry("A-145", { ...merged, afterMerge: [{ line: "The laptop run shows 3 of 3.", owner: "The chairman" }, { line: "A second check", owner: null }] }), entry("A-146", merged)] });
  assert.equal(listed.$("after-merge").hidden, false);
  const text = listed.$("after-merge").text();
  assert.ok(text.includes("After-merge checks") && text.includes("A-145") && text.includes("The laptop run shows 3 of 3.") && text.includes("Runs it: The chairman"), "the ticket, the line and who runs it");
  assert.ok(text.includes("A second check") && text.includes("Runs it: owner not named"), "a line with no owner says so");
  assert.equal(text.includes("A-146"), false, "a run that listed none adds no row");
  assert.ok(listed.$("runs").text().includes("completed: a11ign/agent-org #1802 merged; 2 after-merge checks listed"), "and its card says they were listed");
  const none = await page(new Map(), { entries: [entry("A-146", merged)] });
  assert.equal(none.$("after-merge").hidden, true);
  assert.equal((await page(new Map(), { entries: [] })).$("after-merge").hidden, true, "and with no run at all");
});

/** Which status sections are collapsed, in order. */
const collapsed = (p: Awaited<ReturnType<typeof page>>) => p.groups().map((g) => g.className.includes("collapsed"));

test("status sections start collapsed, open and close from anywhere on their header, and stay as left after a reload", async () => {
  const storage = new Map<string, string>();
  const first = await page(storage, { tickets: ONE_PROJECT });
  assert.deepEqual(collapsed(first), [true, true], "a first visit sees every section collapsed");
  first.groups()[0].children[0].all().find((n) => n.className === "name")!.fire("click");
  assert.deepEqual(collapsed(first), [false, true], "a click on the section's name opens only that section");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.open")!), ["Backlog"]);
  const reloaded = await page(storage, { tickets: ONE_PROJECT });
  assert.deepEqual(collapsed(reloaded), [false, true], "the reload keeps it open");
  const fold = reloaded.groups()[0].children[0].all().find((n) => n.className === "fold")!;
  fold.fire("click");
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

const PLAN = "-plan-[^/]*\\.md$";
const ticketIn = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, status: "Backlog", statusOrder: 0, priority: 2, project: null, url: "", ...extra });
// P-1 is an epic with a plan over P-3, which has none; P-2 has none, and P-4 has one.
const PLANS = [
  ticketIn("P-1", { uploads: ["P-1-0001-plan-x.md"] }),
  ticketIn("P-2", { uploads: ["shot.png"] }),
  ticketIn("P-3", { parent: "P-1" }),
  ticketIn("P-4", { uploads: ["P-4-0001-plan-y.md"] }),
];
const markOf = (p: Page, key: string) => rowFor(p, key).all().find((n) => n.className.startsWith("no-plan")) as (Node_ & { title?: string }) | undefined;
const planChip = (p: Page, label: string) => p.$("plans").children.find((c) => c.tag === "button" && c.children[0]?.text() === label)!;

test("on a machine that names a plan's pattern, a ticket with no plan is marked, muted when its parent's plan covers it, and an epic is never marked", async () => {
  const p = await page(new Map(), { config: { plan: PLAN }, tickets: PLANS });
  foldOf(p, "P-1").fire("click");
  assert.equal(markOf(p, "P-4"), undefined, "it has a plan");
  assert.equal(markOf(p, "P-2")?.className, "no-plan");
  assert.equal(markOf(p, "P-2")?.attrs["aria-label"], "No plan attached. Attach one before a worker starts this.");
  assert.equal(markOf(p, "P-3")?.className, "no-plan covered");
  assert.equal(markOf(p, "P-3")?.title, "No plan of its own. A worker reads its parent P-1's plan.");
  assert.equal(markOf(p, "P-1"), undefined);
  const bareEpic = await page(new Map(), { config: { plan: PLAN }, tickets: [ticketIn("B-1"), ticketIn("B-2", { parent: "B-1" })] });
  assert.equal(markOf(bareEpic, "B-1"), undefined, "an epic with no plan is not marked either: no worker starts it");
});

test("a ticket under someone else's epic is covered by that epic's plan once the parents load", async () => {
  const theirs = ticketIn("X-1", { uploads: ["X-1-0001-plan-z.md"] });
  const p = await page(new Map(), { config: { plan: PLAN }, tickets: [ticketIn("C-9", { parent: "X-1" })], parents: [theirs] });
  foldOf(p, "X-1").fire("click");
  assert.equal(markOf(p, "C-9")?.className, "no-plan covered");
});

test("a machine that names no plan pattern marks no ticket and has no plan filter", async () => {
  const p = await page(new Map(), { tickets: PLANS });
  foldOf(p, "P-1").fire("click");
  assert.deepEqual(["P-1", "P-2", "P-3", "P-4"].map((key) => markOf(p, key)), [undefined, undefined, undefined, undefined]);
  assert.equal(p.$("plans").hidden, true);
});

test("the plan filter counts the tickets a worker can be given with a plan and without, shows only the chosen ones, and is remembered", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { config: { plan: PLAN }, tickets: PLANS });
  assert.equal(p.$("plans").hidden, false);
  assert.equal(planChip(p, "With a plan").text(), "With a plan1", "P-4; the epic P-1's own plan is not counted");
  assert.equal(planChip(p, "Without a plan").text(), "Without a plan2");
  planChip(p, "Without a plan").fire("click");
  assert.deepEqual(p.shownKeys(), ["P-1", "P-2"], "P-3 stays under its epic, folded");
  assert.equal(planChip(p, "Without a plan").attrs["aria-pressed"], "true");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.plan")!), ["without"]);
  assert.deepEqual((await page(storage, { config: { plan: PLAN }, tickets: PLANS })).shownKeys(), ["P-1", "P-2"], "the reload keeps the filter");
  planChip(p, "With a plan").fire("click");
  assert.deepEqual(p.shownKeys(), ["P-4"]);
  planChip(p, "All").fire("click");
  assert.deepEqual(p.shownKeys(), ["P-1", "P-2", "P-4"]);
  assert.equal(storage.get("ticket-mode.plan"), "[]");
  assert.deepEqual((await page(storage, { config: { plan: PLAN }, tickets: PLANS })).shownKeys(), ["P-1", "P-2", "P-4"], "the reload shows every ticket");
});

test("a parent starts folded, opens to list the tickets under it, indented, each naming its own status, and stays as left after a reload", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { tickets: EPIC });
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
  assert.deepEqual((await page(storage, { tickets: EPIC })).shownKeys(), ["E-1", "C-1", "G-1"], "the reload keeps them open");
  foldOf(p, "E-1").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1"], "folding the epic hides everything under it");
});

test("ticking a parent picks the tickets under it that can still be picked, never the parent, and part ticks it when only some are picked", async () => {
  const tickets = [...EPIC, { key: "C-2", title: "queued", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-1" }];
  const p = await page(new Map(), { entries: [entry("C-2", { phase: "queued" })], tickets });
  tickOf(p, "E-1").checked = true;
  tickOf(p, "E-1").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket", "only G-1: C-1 is a parent, and C-2 is on the queue already");
  assert.equal(tickOf(p, "E-1").checked, true);
  foldOf(p, "E-1").fire("click");
  assert.equal(tickOf(p, "C-1").checked, true, "a parent under it shows its own tickets picked");
  p.$("queue").fire("click");
  await settle();
  assert.deepEqual(p.posts.find((x) => x.path === "/api/queue")?.body.keys, ["G-1"]);
});

test("a parent with some of its tickets picked is part ticked, and one with none left to pick cannot be ticked", async () => {
  const tickets = [
    { key: "E-1", title: "epic", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null },
    ...["C-1", "C-2"].map((key) => ({ key, title: key, status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-1" })),
    { key: "E-2", title: "done epic", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null },
    { key: "C-3", title: "queued", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: "E-2" },
  ];
  const p = await page(new Map([["ticket-mode.open-parents", JSON.stringify(["E-1"])]]), { entries: [entry("C-3", { phase: "queued" })], tickets });
  tickOf(p, "C-1").checked = true;
  tickOf(p, "C-1").fire("change");
  assert.deepEqual([tickOf(p, "E-1").checked, (tickOf(p, "E-1") as unknown as { indeterminate: boolean }).indeterminate], [false, true]);
  assert.equal(tickOf(p, "E-2").disabled, true, "its one ticket is on the queue");
});

test("a parent that is not the person's heads its children with a checkbox that picks them, and says it is not theirs", async () => {
  const p = await page(new Map(), { tickets: ["VE-65", "VE-66"].map((key) => ({ key, title: key, status: "Backlog", statusOrder: 0, priority: 2, project: null, url: "", parent: "NBF-1917" })), parents: [{ key: "NBF-1917", title: "lint rules", status: "Todo", statusOrder: 1, priority: 2, project: null, url: "", parent: null }] });
  assert.deepEqual(rowsOf(p).map((r) => r.className), ["row parent context"], "folded, as every parent starts");
  assert.match(rowFor(p, "NBF-1917").text(), /Not in this view/);
  tickOf(p, "NBF-1917").checked = true;
  tickOf(p, "NBF-1917").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 2 tickets");
  foldOf(p, "NBF-1917").fire("click");
  assert.deepEqual(rowsOf(p).map((r) => [r.className, r.attrs.style]), [["row parent context", undefined], ["row child", "--depth: 1"], ["row child", "--depth: 1"]]);
});

test("Select all takes every ticket under a parent, folded or not, and never the parent", async () => {
  const p = await page(new Map(), { tickets: EPIC });
  p.$("all").checked = true;
  p.$("all").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket", "only G-1");
  assert.equal(p.$("all").checked, true);
});

test("Expand all opens every parent with the sections, and Collapse all folds them again", async () => {
  const p = await page(new Map(), { tickets: EPIC });
  p.$("fold-all").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1", "C-1", "G-1"]);
  assert.equal(p.$("fold-all").textContent, "Collapse all");
  p.$("fold-all").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1"]);
  assert.equal(p.$("fold-all").textContent, "Expand all");
});

test("ticking a section's checkbox selects its tickets and leaves the section as it was", async () => {
  const p = await page(new Map(), { tickets: ONE_PROJECT });
  const tick = p.groups()[0].children[0].all().find((n) => n.tag === "input")!;
  tick.checked = true;
  tick.fire("click");
  tick.fire("change");
  assert.deepEqual(collapsed(p), [true, true]);
  assert.equal(p.$("queue").textContent, "Queue 3 tickets");
});

test("Expand all opens every section and becomes Collapse all, which closes them again", async () => {
  const p = await page(new Map(), { tickets: ONE_PROJECT });
  assert.equal(p.$("fold-all").textContent, "Expand all");
  p.$("fold-all").fire("click");
  assert.deepEqual(collapsed(p), [false, false]);
  assert.equal(p.$("fold-all").textContent, "Collapse all");
  p.$("fold-all").fire("click");
  assert.deepEqual(collapsed(p), [true, true]);
});

test("Select all takes the visible tickets, and Queue sends exactly those with the model and effort and no repository", async () => {
  const p = await page(new Map([["ticket-mode.project", JSON.stringify(["Alpha"])]]));
  const body = await queueAll(p);
  assert.deepEqual(body?.keys, ["T-1", "T-3"], "T-2 and T-4 are filtered out");
  assert.equal("repos" in (body ?? {}), false, "the worker chooses the repository");
});

const SETTINGS = { models: ["opus", "sonnet"], efforts: ["high", "max"], choice: { model: "opus", effort: "high" } };

/** Open Settings from `button`, as the browser does: the button changes the address, and the page hears of it. */
async function openFrom(p: Page, button: string) {
  p.$(button).fire("click");
  await p.hashChange();
}
/** Change one control, in Settings or the Pick footer, and let what it does come back. */
async function change(p: Page, id: string, value: string) {
  p.$(id).value = value;
  p.$(id).fire("change");
  await settle();
}
/** Open Settings from `button`, then change one of its controls. */
async function changeFrom(p: Page, button: string, id: string, value: string) {
  await openFrom(p, button);
  await change(p, id, value);
}
/** A page with Settings opened from its button, as a person who opened it sees it. */
async function settingsPage(options: Parameters<typeof page>[1]) {
  const p = await page(new Map(), options);
  await openFrom(p, "open-settings");
  return p;
}
/** Choose another instance in the switcher, and let the page load it. */
async function chooseInstance(p: Page, name: string) {
  p.$("connection").value = name;
  p.$("connection").fire("change");
  await settle();
}
/** Press Queue, and let the board answer. */
async function pressQueue(p: Page) {
  p.$("queue").fire("click");
  await settle();
}

/** The model and effort the Pick footer shows for the tickets queued next. */
const footerChoice = (p: Page) => [p.$("batch-model").value, p.$("batch-effort").value];
/** Select every ticket shown, press Queue, and return what was sent. */
async function queueAll(p: Page) {
  p.$("all").checked = true;
  p.$("all").fire("change");
  p.$("queue").fire("click");
  await settle();
  return p.posts.filter((x) => x.path === "/api/queue").at(-1)?.body;
}
/** The model and effort that Queue sends for the selected tickets. */
async function queuedChoice(p: Page) {
  const queued = await queueAll(p);
  return [queued?.model, queued?.effort];
}

test("the Pick footer says what a queued ticket runs with, Settings saves each part on its own, and Queue sends what is saved", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  assert.deepEqual(footerChoice(p), ["opus", "high"]);
  await openFrom(p, "change-choice");
  assert.equal(p.location.hash, "#/settings", "Change opens the settings page");
  assert.equal(p.$("settings-page").hidden, false);
  await change(p, "model", "sonnet");
  assert.deepEqual(p.posts.at(-1), { path: "/api/choice", body: { model: "sonnet" } });
  assert.deepEqual(footerChoice(p), ["sonnet", "high"]);
  await change(p, "effort", "max");
  assert.deepEqual(p.posts.at(-1), { path: "/api/choice", body: { effort: "max" } });
  assert.deepEqual(footerChoice(p), ["sonnet", "max"]);
  assert.equal(p.$("settings-status").textContent, "Saved");
  assert.deepEqual(await queuedChoice(p), ["sonnet", "max"]);
});

test("Settings shows what another page saved, and changing one part keeps the other page's change to the other", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  p.saveElsewhere({ model: "sonnet" });
  await openFrom(p, "open-settings");
  assert.equal(p.$("model").value, "sonnet");
  assert.deepEqual(footerChoice(p), ["sonnet", "high"]);
  await change(p, "effort", "max");
  assert.deepEqual(p.posts.at(-1)?.body, { effort: "max" });
  assert.deepEqual(footerChoice(p), ["sonnet", "max"]);
});

test("workers at once is set in Settings, opened from the Board's Change, and the Board says how many run at once", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  assert.equal(p.$("max-note").textContent, "Up to 3 workers at once");
  await openFrom(p, "change-max");
  assert.equal(p.$("settings-page").hidden, false, "the Board's Change opens the settings page");
  assert.equal(p.$("max").value, "3", "the control shows what is saved");
  await change(p, "max", "5");
  assert.deepEqual(p.posts.at(-1), { path: "/api/max", body: { max: 5 } });
  assert.equal(p.$("max-note").textContent, "Up to 5 workers at once");
  assert.equal(p.$("settings-status").textContent, "Saved");
  await openFrom(p, "open-settings");
  assert.equal(p.$("settings-status").textContent, "", "opening Settings again clears what the last change said");
});

test("a number of workers the board refuses goes back to what is saved, and the refusal shows in Settings, where it can be seen", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/max"] });
  await openFrom(p, "open-settings");
  await change(p, "max", "0");
  assert.equal(p.$("max").value, "3");
  assert.equal(p.$("settings-status").textContent, "/api/max refused");
  assert.equal(p.$("settings-status").className, "hint failed");
  assert.equal(p.$("max-note").textContent, "Up to 3 workers at once");
});

test("a model the board refuses goes back to what is saved, and the footer keeps what is saved", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/choice"] });
  await changeFrom(p, "open-settings", "model", "sonnet");
  assert.equal(p.$("model").value, "opus");
  assert.equal(p.$("settings-status").textContent, "/api/choice refused");
  assert.deepEqual(footerChoice(p), ["opus", "high"]);
});

test("a refused change reads what is saved again, so what another page saved since Settings opened is what shows and what Queue sends", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/choice"] });
  await openFrom(p, "open-settings");
  p.saveElsewhere({ model: "sonnet" });
  await change(p, "effort", "max");
  await settle();
  assert.equal(p.$("settings-status").textContent, "/api/choice refused");
  assert.deepEqual([p.$("model").value, p.$("effort").value], ["sonnet", "high"]);
  assert.deepEqual(footerChoice(p), ["sonnet", "high"]);
  const queued = await queueAll(p);
  assert.deepEqual([queued?.model, queued?.effort], ["sonnet", "high"]);
});

test("a refused number of workers reads what is saved again, so what another page saved since Settings opened is what shows", async () => {
  const p = await settingsPage({ config: SETTINGS, refused: ["/api/max"] });
  p.saveElsewhere({ workers: 5 });
  await change(p, "max", "0");
  await settle();
  const max = p.$("max");
  assert.equal(max.value, "5");
  assert.equal(p.$("max-note").textContent, "Up to 5 workers at once");
});

test("a batch runs on its own model and effort: Queue sends them, the default is not saved, and the next batch starts from the default", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  assert.equal(p.$("batch-note").textContent, "The default");
  assert.equal(p.$("batch-reset").hidden, true);
  await change(p, "batch-model", "sonnet");
  assert.deepEqual(footerChoice(p), ["sonnet", "high"]);
  assert.equal(p.$("batch-note").textContent, "These tickets only. The default is opus at high effort");
  assert.equal(p.$("batch-reset").hidden, false);
  const queued = await queueAll(p);
  assert.deepEqual([queued?.model, queued?.effort], ["sonnet", "high"]);
  assert.equal(p.posts.some((x) => x.path === "/api/choice"), false, "the default is not saved");
  assert.deepEqual(footerChoice(p), ["opus", "high"], "the next batch starts from the default");
  assert.equal(p.$("batch-note").textContent, "The default");
  await openFrom(p, "open-settings");
  assert.deepEqual([p.$("model").value, p.$("effort").value], ["opus", "high"]);
});

test("Use the default puts a batch back on the default, and so does choosing the default's own values", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  await change(p, "batch-effort", "max");
  p.$("batch-reset").fire("click");
  assert.deepEqual(footerChoice(p), ["opus", "high"]);
  assert.equal(p.$("batch-note").textContent, "The default");
  await change(p, "batch-model", "sonnet");
  await change(p, "batch-model", "opus");
  assert.equal(p.$("batch-note").textContent, "The default");
  assert.equal(p.$("batch-reset").hidden, true);
});

test("a default that catches up to a batch's choice makes the batch the default again", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  await change(p, "batch-effort", "max");
  await changeFrom(p, "change-choice", "effort", "max");
  assert.equal(p.$("batch-note").textContent, "The default");
  assert.equal(p.$("batch-reset").hidden, true);
});

test("a batch keeps the part it chose when the default changes, and follows the default in the part it did not", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  await change(p, "batch-model", "sonnet");
  await changeFrom(p, "change-choice", "effort", "max");
  assert.deepEqual(footerChoice(p), ["sonnet", "max"]);
  assert.equal(p.$("batch-note").textContent, "These tickets only. The default is opus at max effort");
  assert.deepEqual(await queuedChoice(p), ["sonnet", "max"]);
});

test("a batch chosen while the last one is being queued is kept for the next, and the last one is sent as it was", async () => {
  const p = await page(new Map(), { config: SETTINGS });
  p.$("all").checked = true;
  p.$("all").fire("change");
  p.$("queue").fire("click");
  p.$("batch-model").value = "sonnet";
  p.$("batch-model").fire("change");
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(p.posts.find((x) => x.path === "/api/queue")?.body.model, "opus");
  assert.deepEqual(footerChoice(p), ["sonnet", "high"]);
});

test("a queue the board refuses keeps the batch's own model and effort, and queueing again sends them again", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/queue"] });
  await change(p, "batch-effort", "max");
  const first = await queueAll(p);
  assert.deepEqual(footerChoice(p), ["opus", "max"]);
  assert.equal(p.$("batch-reset").hidden, false);
  const again = await queueAll(p);
  assert.deepEqual([first?.effort, again?.effort], ["max", "max"]);
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
  const p = await page(new Map(), { entries: RUNS });
  const rows = runRows(p);
  assert.equal(rows.length, 6);
  const icons = rows.map((r) => r.children[0].className);
  assert.deepEqual(icons, ["icon st-completed", "icon st-awaiting-review", "icon st-needs-you", "icon st-working", "icon st-failed", "icon st-queued"]);
});

const BLOCKER_PR = "https://github.com/x/libs/pull/3";
const BLOCKERS = [{ key: "LIB-1", state: "started", status: "In Review", branch: "lib-1", pulls: { [BLOCKER_PR]: "open" } }];
const BLOCKED_RUNS = [
  { name: "stacked on its blocker's open pull request, so it is Queued and says what it is stacked on", fields: { phase: "queued", plannedRepo: "libs", blockers: BLOCKERS }, icon: "icon st-queued", says: /Stacked on LIB-1 #3/, absent: "Waits on" },
  { name: "A11-77: held by its planner until a blocker merges, so it is Blocked, says it waits for that merge, and is not stacked on the open pull request", fields: { phase: "queued", plannedRepo: "libs", waitMerged: ["LIB-1"], blockers: BLOCKERS }, icon: "icon st-blocked", says: /Waits for LIB-1 to merge/, absent: "Stacked on" },
];

test("A11-117: a queued run whose paths are known says which holder's file list is cut short, and says nothing when every file is listed", async () => {
  const url = "https://github.com/x/nbl-ui-netbox/pull/5";
  const holder = (files: string[]) => entry("APP-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url }] }, pullFiles: { [url]: files } });
  const queued = entry("APP-2", { phase: "queued", paths: ["nbl-ui-netbox:docs/unrelated.md"] });
  const cut = await page(new Map(), { entries: [holder(["src/a.ts", ""]), queued] });
  const cutRow = runRows(cut).find((r) => r.text().includes("APP-2"))!;
  assert.match(cutRow.text(), /APP-1 #5 lists only part of its changed files, so a clash in the rest shows only as a conflict on the pull request\./);
  assert.equal(cutRow.text().includes("Waits on"), false, "the note is not a wait: nothing the run touches is held");
  const complete = await page(new Map(), { entries: [holder(["src/a.ts"]), queued] });
  const completeRow = runRows(complete).find((r) => r.text().includes("APP-2"))!;
  assert.equal(completeRow.text().includes("lists only part"), false, "a complete list has no note");
});

testEach("a run on a blocker's open pull request is Queued when stacked on it, and Blocked when its planner holds it for the merge", BLOCKED_RUNS, async (c) => {
  const p = await page(new Map(), { entries: [entry("APP-1", c.fields)] });
  const row = runRows(p)[0];
  assert.equal(row.children[0].className, c.icon);
  assert.match(row.text(), c.says);
  assert.equal(row.text().includes(c.absent), false);
});

test("a run waiting on a blocker is Blocked, with its own filter, and names what it waits on", async () => {
  const runs = [
    entry("APP-1", { phase: "queued", blockers: [{ key: "LIB-1", state: "started", status: "In Review" }] }),
    entry("LIB-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "draft-pr", prs: [{ repo: "libs", url: "https://github.com/x/libs/pull/3" }] } }),
    entry("APP-2", { phase: "queued", blockers: [{ key: "LIB-2", state: "started", status: "In Review" }] }),
    entry("LIB-2", { phase: "finished", startedAt: 2, finishedAt: 4, outcome: { kind: "draft-pr", prs: [{ repo: "libs", url: "https://github.com/x/libs/pull/4" }] },
      pullStates: { "https://github.com/x/libs/pull/4": "merged" } }),
  ];
  const p = await page(new Map(), { entries: runs });
  const blocked = runRows(p).find((r) => r.text().includes("APP-1"))!;
  assert.equal(blocked.children[0].className, "icon st-blocked");
  assert.match(blocked.text(), /Waits on LIB-1 \(In Review\)/);
  assert.equal(runRows(p).find((r) => r.text().includes("APP-2"))!.children[0].className, "icon st-queued", "its blocker merged on the queue");
  filterButton(p, "Blocked").fire("click");
  assert.deepEqual(runRows(p).map((r) => r.text().match(/APP-\d|LIB-\d/)![0]), ["APP-1"]);
  assert.equal(filterButton(p, "Blocked").children.find((c) => c.className === "n")!.text(), "1");
});

test("the In progress filter is a still dot, and a working run's own icon is the spinning ring", async () => {
  const p = await page(new Map(), { entries: RUNS });
  const railIcon = filterButton(p, "In progress").children[0] as Node_ & { innerHTML: string };
  const rowIcon = runRows(p).map((r) => r.children[0]).find((i) => i.className === "icon st-working") as Node_ & { innerHTML: string };
  assert.equal(railIcon.className, "icon st-working", "it keeps the status's colour");
  assert.match(railIcon.innerHTML, /<circle cx="8" cy="8" r="5" fill="currentColor"\/>/);
  assert.doesNotMatch(railIcon.innerHTML, /<path/, "no arc to turn");
  assert.match(rowIcon.innerHTML, /<path d="M8 2a6 6 0 0 1 6 6"/);
});

test("each filter shows its count, and choosing one shows only its runs and is remembered", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { entries: RUNS });
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

test("a row offers only the actions its state allows, a completed run is not retried, and every finished run can be dismissed", async () => {
  const p = await page(new Map(), { entries: RUNS });
  const buttons = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.tag === "button").map((b) => b.text());
  assert.deepEqual(buttons("Q-1"), ["Remove"]);
  assert.deepEqual(buttons("R-1"), ["Stop"]);
  assert.deepEqual(buttons("F-1"), ["Retry", "Talk to it", "Dismiss"]);
  assert.deepEqual(buttons("M-1"), ["Dismiss"]);
  assert.ok(runRows(p).find((r) => r.text().includes("D-1"))!.text().includes("nbl-ui-netbox"), "the draft's pull request is linked by repo");
});

test("a draft pull request awaiting review offers Approve, titled as a person's approval, which goes to the board", async () => {
  const p = await page(new Map(), { entries: RUNS });
  const approve = runRows(p).find((r) => r.text().includes("D-1"))!.all().find((n) => n.tag === "button") as Node_ & { title?: string };
  assert.equal(approve.text(), "Approve");
  assert.match(approve.title ?? "", /^Drafts reviewed and approved/);
  approve.fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/D-1/approve"));
});

test("a review run reads as Reviewing while it works, and its reviewed pull requests as Ready to merge, still linked", async () => {
  const prs = [{ repo: "nbl-ui-netbox", url: "https://github.com/x/y/pull/12" }];
  const p = await page(new Map(), { entries: [
    entry("V-1", { phase: "running", startedAt: 5, review: prs }),
    entry("V-2", { phase: "finished", startedAt: 2, finishedAt: 7, outcome: { kind: "reviewed", prs }, pullHeads: readyHeads(prs) }),
  ] });
  const row = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  assert.equal(row("V-1").children[0].className, "icon st-reviewing");
  assert.ok(row("V-1").text().includes("#12") && row("V-1").text().includes("nbl-ui-netbox"), "the pull requests under review stay linked while it works");
  assert.equal(row("V-2").children[0].className, "icon st-ready-to-merge");
  assert.ok(row("V-2").text().includes("#12") && row("V-2").text().includes("nbl-ui-netbox"));
});

test("a live or parked run links its terminal when the machine serves one, and a parked run offers Close, which goes to the board", async () => {
  const runs = [
    entry("R-1", { phase: "running", startedAt: 5, workspace: "w1", pane: "w1:p1" }),
    entry("P-1", { phase: "finished", startedAt: 2, finishedAt: 4, workspace: "w2", pane: "w2:p1", outcome: { kind: "needs-human", reason: "which colour?" } }),
    entry("F-1", { phase: "finished", startedAt: 2, finishedAt: 3, outcome: { kind: "crashed", reason: "herdr refused" } }),
  ];
  const p = await page(new Map(), { connections: WORK_ALONE, config: { terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" }, entries: runs });
  const row = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  const link = (key: string) => row(key).all().find((n) => n.className.split(" ").includes("terminal")) as (Node_ & { href?: string; target?: string }) | undefined;
  assert.equal(link("R-1")?.href, opens("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal"), "the page's worker link, which pairs the terminal on the way");
  assert.ok(link("R-1")?.title.includes("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal"), "the plain address is kept in the title");
  assert.equal(link("R-1")?.target, "_blank", "it opens in its own tab: the terminal page refuses to be framed");
  assert.equal(link("P-1")?.href, opens("http://127.0.0.1:7318/?ws=w2&pane=w2%3Ap1&view=terminal"));
  assert.equal(link("F-1"), undefined, "a run with no workspace has no terminal");
  assert.ok(row("P-1").text().includes("Still open"), "a parked run says it can still be answered");
  const close = row("P-1").all().find((n) => n.tag === "button")!;
  assert.equal(close.text(), "Close");
  close.fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/c/work/api/queue/P-1/close"), "Close goes to the connection the run is shown on");
  const none = await page(new Map(), { entries: runs });
  assert.equal(runRows(none).flatMap((r) => r.all()).find((n) => n.className.split(" ").includes("terminal")), undefined, "a machine that serves no terminal shows no link");
});

const PLANNING = { ...SETTINGS, plan: "-plan-[^/]*\\.md$", planner: true, choice: { model: "opus", effort: "high", planModel: "opus", planEffort: "max" } };
const PLAN_TICKETS = [
  { key: "T-1", title: "one", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "", uploads: ["T-1-0001-plan-a.md"] },
  { key: "T-2", title: "two", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "" },
];
/** Select every ticket shown. */
function selectAll(p: Page) {
  p.$("all").checked = true;
  p.$("all").fire("change");
}

test("Plan first shows once a selected ticket has no plan, Queue says how many it plans first, and the queue is told to plan them", async () => {
  const p = await page(new Map(), { config: PLANNING, tickets: PLAN_TICKETS });
  assert.equal(p.$("plan-first-label").hidden, true, "nothing is selected yet");
  selectAll(p);
  assert.equal(p.$("plan-first-label").hidden, false);
  assert.equal(p.$("queue").textContent, "Queue 2 tickets, planning 1 first");
  await pressQueue(p);
  assert.equal(p.posts.find((x) => x.path === "/api/queue")?.body.plan, true);
});

test("unticking Plan first queues every selected ticket to be worked as it is", async () => {
  const p = await page(new Map(), { config: PLANNING, tickets: PLAN_TICKETS });
  selectAll(p);
  p.$("plan-first").checked = false;
  p.$("plan-first").fire("change");
  assert.equal(p.$("queue").textContent, "Queue 2 tickets");
  await pressQueue(p);
  assert.equal(p.posts.find((x) => x.path === "/api/queue")?.body.plan, false);
});

test("a board that plans nothing shows neither Plan first nor the planning settings, and asks for no planning", async () => {
  const p = await page(new Map(), { config: { ...SETTINGS, plan: "-plan-[^/]*\\.md$" }, tickets: PLAN_TICKETS });
  selectAll(p);
  assert.equal(p.$("planning-settings").hidden, true);
  assert.equal(p.$("queue").textContent, "Queue 2 tickets");
  assert.equal(p.$("plan-first-label").hidden, true);
  await pressQueue(p);
  const sent = p.posts.find((x) => x.path === "/api/queue")?.body.plan;
  assert.equal(sent, false);
});

test("the planning model and effort are set in Settings part by part, apart from the run's", async () => {
  const p = await page(new Map(), { config: PLANNING, tickets: PLAN_TICKETS });
  await openFrom(p, "open-settings");
  assert.equal(p.$("planning-settings").hidden, false);
  assert.deepEqual([p.$("planModel").value, p.$("planEffort").value], ["opus", "max"]);
  await change(p, "planModel", "sonnet");
  assert.deepEqual(p.posts.at(-1), { path: "/api/choice", body: { planModel: "sonnet" } });
  assert.deepEqual(footerChoice(p), ["opus", "high"], "the run's choice is unchanged");
});

test("a planning run is Planning on the Board, and its row names the planning model before the run's", async () => {
  const p = await page(new Map(), { entries: [entry("P-1", { phase: "running", startedAt: 5, model: "sonnet", plan: { model: "opus", effort: "max" } })] });
  const [row] = runRows(p);
  assert.equal(row.children[0].className, "icon st-planning");
  assert.match(row.text(), /Planning · .*plan on opus\/max, then sonnet\/high/);
});

const SHIPPED = [{ repo: "nbl-ui-netbox", url: "https://github.com/x/y/pull/12" }];
/** The heads the watch read as ready to merge for pull requests `prs`: approved at them, no required check red or running (A11-179). */
const readyHeads = (prs: readonly { url: string }[]) => Object.fromEntries(prs.map(({ url }) => [url, { head: "h1", approved: true, review: "approved", red: [], pending: [] }]));
const PUBLISHABLE = [
  entry("P-1", { phase: "finished", startedAt: 2, finishedAt: 7, outcome: { kind: "reviewed", prs: SHIPPED }, pullHeads: readyHeads(SHIPPED) }),
  entry("P-2", { phase: "finished", startedAt: 2, finishedAt: 8, outcome: { kind: "reviewed", prs: SHIPPED }, pullHeads: readyHeads(SHIPPED) }),
  entry("P-3", { phase: "finished", startedAt: 2, finishedAt: 9, outcome: { kind: "reviewed", prs: SHIPPED }, pullHeads: readyHeads(SHIPPED), published: { link: "https://x.slack.com/archives/C1/p1", at: 9 } }),
  entry("D-1", { phase: "finished", startedAt: 2, finishedAt: 6, outcome: { kind: "draft-pr", prs: SHIPPED } }),
];
const tickFor = (p: Page, key: string) => runRows(p).find((r) => r.text().includes(key))!.all().find((n) => n.tag === "input");

test("on a machine that publishes, each run Ready to merge has a Publish tick, and one press publishes every ticked run together", async () => {
  const p = await page(new Map(), { config: { publish: true }, entries: PUBLISHABLE });
  assert.equal(p.$("publish").hidden, false);
  assert.deepEqual([p.$("publish").textContent, p.$("publish").disabled], ["Publish selected (0)", true]);
  assert.equal(tickFor(p, "P-3"), undefined, "a published run has no tick: no double posting");
  assert.equal(tickFor(p, "D-1"), undefined, "nothing reaches Slack before a person approved it and it passed review");
  tickFor(p, "P-1")!.fire("change");
  tickFor(p, "P-2")!.fire("change");
  assert.equal(p.$("publish").textContent, "Publish selected (2)");
  p.$("publish").fire("click");
  await settle();
  assert.deepEqual(p.posts.filter((x) => x.path === "/api/publish").map((x) => x.body), [{ keys: ["P-1", "P-2"] }]);
});

test("a Published run reads as Published and links its Slack message, and a machine that publishes nothing shows no tick and no button", async () => {
  const p = await page(new Map(), { config: { publish: true }, entries: PUBLISHABLE });
  const published = runRows(p).find((r) => r.text().includes("P-3"))!;
  assert.equal(published.children[0].className, "icon st-published");
  const link = published.all().find((n) => n.text() === "Slack message") as Node_ & { href?: string };
  assert.equal(link.href, "https://x.slack.com/archives/C1/p1");
  const off = await page(new Map(), { entries: PUBLISHABLE });
  assert.equal(off.$("publish").hidden, true);
  assert.equal(tickFor(off, "P-1"), undefined);
});

test("the Board says why the last publish run failed", async () => {
  const p = await page(new Map(), { config: { publish: true }, entries: PUBLISHABLE });
  assert.equal(p.$("publish-note").textContent, "");
  const failed = await page(new Map(), { config: { publish: true }, entries: PUBLISHABLE, publish: { keys: ["P-1"], phase: "finished", failure: "no channel" } });
  assert.equal(failed.$("publish-note").textContent, "Publishing 1 run failed: no channel");
});

const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
/** A run's "Open terminal" href: the page's worker link for `connection`, which carries the plain address `plain` for the redirect (A11-93). */
const opens = (plain: string, connection = "work") => `/c/${connection}/terminal?link=${encodeURIComponent(plain)}`;
const PUBLISHING = { keys: ["P-1", "P-2"], phase: "running", workspace: "w9", pane: "w9:p1" };
const terminalOf = (p: Page, key: string) =>
  runRows(p).find((r) => r.text().includes(key))!.all().find((n) => n.className.split(" ").includes("terminal") && n.text() === "Open terminal") as (Node_ & { href?: string; target?: string }) | undefined;

test("each run the publish run is posting is Publishing, with the spinning ring, and cannot be ticked again", async () => {
  const p = await page(new Map(), { connections: WORK_ALONE, config: { publish: true, terminal: TERMINAL }, entries: PUBLISHABLE, publish: PUBLISHING });
  const publishing = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  for (const key of ["P-1", "P-2"]) {
    const icon = publishing(key).children[0] as Node_ & { innerHTML: string };
    assert.equal(icon.className, "icon st-publishing", key);
    assert.equal(icon.attrs["aria-label"], "Publishing", key);
    assert.match(icon.innerHTML, /<path d="M8 2a6 6 0 0 1 6 6"/, `${key}: the arc that spins`);
    assert.match(publishing(key).text(), /Publishing · /, key);
    assert.equal(tickFor(p, key), undefined, `${key}: a run the publish run holds cannot be ticked again`);
  }
  assert.equal(publishing("P-3").children[0].className, "icon st-published", "a run it does not post keeps its status");
  assert.equal(p.$("publish-note").textContent, "Publishing 2 runs");
});

test("each Publishing run links the publish run's own pane, and no other run does", async () => {
  const p = await page(new Map(), { connections: WORK_ALONE, config: { publish: true, terminal: TERMINAL }, entries: PUBLISHABLE, publish: PUBLISHING });
  for (const key of ["P-1", "P-2"]) {
    assert.equal(terminalOf(p, key)?.href, opens("http://127.0.0.1:7318/?ws=w9&pane=w9%3Ap1&view=terminal"), key);
    assert.equal(terminalOf(p, key)?.target, "_blank", `${key}: it opens in its own tab`);
  }
  assert.equal(terminalOf(p, "P-3"), undefined, "a run it does not post");
  assert.equal(terminalOf(p, "D-1"), undefined);
});

test("the Publishing filter counts the runs being posted and shows them, with a still dot in the rail", async () => {
  const p = await page(new Map(), { connections: WORK_ALONE, config: { publish: true, terminal: TERMINAL }, entries: PUBLISHABLE, publish: PUBLISHING });
  assert.equal(filterButton(p, "Publishing").children.at(-1)!.text(), "2");
  assert.equal(filterButton(p, "Ready to merge").children.at(-1)!.text(), "0");
  const rail = filterButton(p, "Publishing").children[0] as Node_ & { innerHTML: string };
  assert.equal(rail.className, "icon st-publishing", "it keeps the status's colour");
  assert.match(rail.innerHTML, /<circle cx="8" cy="8" r="5" fill="currentColor"\/>/);
  assert.doesNotMatch(rail.innerHTML, /<path/, "no arc to turn");
  filterButton(p, "Publishing").fire("click");
  assert.deepEqual(runRows(p).map((r) => r.text().match(/P-\d/)![0]).sort(), ["P-1", "P-2"]);
});

test("once the publish run ends, its runs are Ready to merge again with no terminal, and the Board says why when it failed", async () => {
  const failed = await page(new Map(), { connections: WORK_ALONE, config: { publish: true, terminal: TERMINAL }, entries: PUBLISHABLE, publish: { keys: ["P-1", "P-2"], phase: "finished", failure: "no channel" } });
  assert.deepEqual(["P-1", "P-2"].map((key) => runRows(failed).find((r) => r.text().includes(key))!.children[0].className), ["icon st-ready-to-merge", "icon st-ready-to-merge"]);
  assert.equal(terminalOf(failed, "P-1"), undefined);
  assert.equal(filterButton(failed, "Publishing").children.at(-1)!.text(), "0");
  assert.equal(failed.$("publish-note").textContent, "Publishing 2 runs failed: no channel");
});

test("a publish run that has no pane yet, or a machine that serves no terminal, leaves its runs Publishing with no terminal link", async () => {
  const starting = await page(new Map(), { connections: WORK_ALONE, config: { publish: true, terminal: TERMINAL }, entries: PUBLISHABLE, publish: { keys: ["P-1"], phase: "queued" } });
  assert.equal(runRows(starting).find((r) => r.text().includes("P-1"))!.children[0].className, "icon st-publishing");
  assert.equal(terminalOf(starting, "P-1"), undefined);
  const none = await page(new Map(), { config: { publish: true }, entries: PUBLISHABLE, publish: PUBLISHING });
  assert.equal(runRows(none).find((r) => r.text().includes("P-1"))!.children[0].className, "icon st-publishing");
  assert.equal(terminalOf(none, "P-1"), undefined);
});

test("a run Ready to merge, Published, handed back by the board, or ended needs-human with a pull request open offers Respond to review with its reply icon, and a draft offers Approve alone", async () => {
  const p = await page(new Map(), { entries: [...PUBLISHABLE,
    entry("H-1", { phase: "finished", startedAt: 2, finishedAt: 5, outcome: { kind: "reviewed", prs: SHIPPED }, handedBack: "keeps getting feedback" }),
    entry("N-1", { phase: "finished", startedAt: 2, finishedAt: 5, outcome: { kind: "needs-human", reason: "which colour?" }, review: SHIPPED, pullStates: { [SHIPPED[0].url]: "open" } })] });
  const actions = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.tag === "button") as (Node_ & { title?: string })[];
  for (const key of ["P-1", "P-3", "H-1"]) {
    const [respond] = actions(key);
    assert.deepEqual(actions(key).map((b) => b.text()), ["Respond to review", "Talk to it", "Dismiss"], key);
    assert.match(respond.title ?? "", /^Answer the feedback on these pull requests/);
    assert.ok(respond.all().some((n) => n.className === "action-icon"), "the reply icon");
  }
  assert.deepEqual(actions("N-1").map((b) => b.text()), ["Respond to review", "Retry", "Talk to it", "Dismiss"], "a needs-human run with a pull request open is answered too (A11-154)");
  assert.deepEqual(actions("D-1").map((b) => b.text()), ["Approve", "Talk to it", "Dismiss"]);
  assert.match(actions("D-1")[0].title ?? "", /^Drafts reviewed and approved/);
  actions("P-1")[0].fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/P-1/respond"));
});

test("A11-125: a queued run Blocked on an overlap offers Start anyway beside Remove, and a run started anyway says what it overlapped", async () => {
  const runs = [
    entry("H-1", { phase: "running", startedAt: 2, paths: ["nbl-ui-netbox:src/pool.ts"] }),
    entry("Q-2", { phase: "queued", paths: ["nbl-ui-netbox:src/"] }),
    entry("Q-3", { phase: "queued", paths: ["nbl-ui-netbox:docs/"] }),
    entry("S-4", { phase: "running", startedAt: 3, overlapOverride: { holder: "H-1", pull: "12", path: "src/pool.ts", at: 4 } }),
  ];
  const p = await page(new Map(), { entries: runs });
  const actions = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.tag === "button") as (Node_ & { title?: string })[];
  assert.deepEqual(actions("Q-2").map((b) => b.text()), ["Start anyway", "Remove"]);
  assert.match(actions("Q-2")[0].title ?? "", /^Start this run now, beside the run that holds a path it shares/);
  assert.deepEqual(actions("Q-3").map((b) => b.text()), ["Remove"], "a run that overlaps nothing is started on its own");
  assert.match(runRows(p).find((r) => r.text().includes("S-4"))!.text(), /Started anyway: it overlapped H-1 #12 on src\/pool\.ts; a person overrode the wait/);
  actions("Q-2")[0].fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/Q-2/start-anyway"));
});

const WORK_AND_PERSONAL = { connections: [{ name: "work", kind: "local" }, { name: "personal", kind: "ssh" }], refusal: null };
/** This machine's instance alone, which the service shows when no connections file names others. */
const WORK_ALONE = { connections: [{ name: "work", kind: "local" }], refusal: null };
const settleAll = async () => { for (let i = 0; i < 10; i++) await settle(); };

test("with one connection the header shows no switcher, and every call goes to that instance", async () => {
  const one = await page(new Map(), { connections: { connections: [{ name: "local", kind: "local" }], refusal: null } });
  assert.equal(one.$("connection-label").hidden, true, "one connection is nothing to switch between");
  assert.deepEqual([...new Set(one.requested)].sort(), ["/api/connections", "/c/local/api/config", "/c/local/api/parents", "/c/local/api/queue", "/c/local/api/tickets"]);
});

test("the switcher lists the connections, starts on this machine's, and choosing another reads every view from it and is remembered in this browser", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { connections: WORK_AND_PERSONAL });
  assert.equal(p.$("connection-label").hidden, false);
  assert.deepEqual(p.$("connection").children.map((o) => o.textContent), ["work (this machine)", "personal"]);
  assert.equal(p.$("connection").value, "work");
  assert.deepEqual([...new Set(p.requested)].sort(), ["/api/connections", "/c/work/api/config", "/c/work/api/parents", "/c/work/api/queue", "/c/work/api/tickets"]);
  p.requested.length = 0;
  p.$("connection").value = "personal";
  p.$("connection").fire("change");
  await settleAll();
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.connection")!), ["personal"]);
  assert.deepEqual([...new Set(p.requested)].sort(), ["/c/personal/api/config", "/c/personal/api/parents", "/c/personal/api/queue", "/c/personal/api/tickets"]);
  p.$("toggle-pause").fire("click");
  await settle();
  assert.equal(p.posts.at(-1)!.path, "/c/personal/api/paused", "an action goes to the instance shown");
  const reloaded = await page(storage, { connections: WORK_AND_PERSONAL });
  assert.equal(reloaded.$("connection").value, "personal");
  assert.ok(reloaded.requested.includes("/c/personal/api/tickets"), "the remembered connection is read on the next load");
});

test("Publish and a run's terminal link work per connection: each goes to, and links through, the connection shown", async () => {
  const storage = new Map([["ticket-mode.connection", JSON.stringify(["personal"])]]);
  const runs = [...PUBLISHABLE, entry("R-1", { phase: "running", startedAt: 5, workspace: "w1", pane: "w1:p1" })];
  const p = await page(storage, { connections: WORK_AND_PERSONAL, entries: runs, config: { publish: true, terminal: "http://127.0.0.1:50001/?ws={workspace}" } });
  const link = runRows(p).find((r) => r.text().includes("R-1"))!.all().find((n) => n.className.split(" ").includes("terminal")) as (Node_ & { href?: string }) | undefined;
  assert.equal(link?.href, opens("http://127.0.0.1:50001/?ws=w1", "personal"), "the terminal address the connection's config gave, which the page's service rewrote for it, reached through that connection");
  tickFor(p, "P-1")!.fire("change");
  p.$("publish").fire("click");
  await settle();
  assert.deepEqual(p.posts.filter((x) => x.path.endsWith("/api/publish")).map((x) => [x.path, x.body]), [["/c/personal/api/publish", { keys: ["P-1"] }]]);
});

test("a remembered connection that is no longer listed falls back to this machine's", async () => {
  const p = await page(new Map([["ticket-mode.connection", JSON.stringify(["gone"])]]), { connections: WORK_AND_PERSONAL });
  assert.equal(p.$("connection").value, "work");
  assert.equal(p.requested.some((path) => path.startsWith("/c/gone/")), false);
});

test("a connection that cannot be reached is named in the page, and switching to another shows that instance's board", async () => {
  const storage = new Map([["ticket-mode.connection", JSON.stringify(["personal"])]]);
  const reason = "cannot reach personal over SSH: agents: Permission denied (publickey).";
  const p = await page(storage, { connections: WORK_AND_PERSONAL, refused: ["/c/personal/api/config"], errors: { "/c/personal/api/config": reason } });
  assert.equal(p.$("error").textContent, reason);
  p.$("connection").value = "work";
  p.$("connection").fire("change");
  await settleAll();
  assert.equal(p.$("error").textContent, "");
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"], "the first project of work's list");
});

test("a connections file the service refused is named above the board, which still shows this machine's instance", async () => {
  const refusal = "connections.json is refused, so only this machine's instance is shown: it is not valid JSON";
  const p = await page(new Map(), { connections: { connections: [{ name: "local", kind: "local" }], refusal } });
  assert.equal(p.$("connections-note").hidden, false);
  assert.equal(p.$("connections-note").textContent, refusal);
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"], "the first project of this machine's list");
});

test("a run's links that are not http addresses, as a remote board could send, are drawn with no address", async () => {
  const entries = [{ ticket: { key: "R-1", title: "one", url: "javascript:alert(1)" }, status: "running", repos: [], model: "opus", effort: "high", queuedAt: 1, workspace: "w1", pane: "w1:p1" }];
  const p = await page(new Map(), { entries, config: { terminal: "javascript:alert(2)//{workspace}" } });
  const anchors = p.$("runs").all().filter((n) => n.tag === "a") as (Node_ & { href?: string; className?: string })[];
  assert.deepEqual(anchors.map((a) => a.href), [""], "the ticket is drawn with no address");
  assert.equal(anchors.find((a) => a.className.split(" ").includes("terminal")), undefined, "and its terminal is not drawn at all");
});

test("an answer from the instance shown before a switch is dropped, so it never lands on the one chosen after it", async () => {
  const storage = new Map([["ticket-mode.connection", JSON.stringify(["personal"])]]);
  const p = await page(storage, { connections: WORK_AND_PERSONAL, hold: { "/c/personal/api/tickets": [ticketIn("P-9")] } });
  p.$("connection").value = "work";
  p.$("connection").fire("change");
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"]);
  p.release();
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"], "personal's late tickets did not replace work's");
  assert.equal(p.$("error").textContent, "", "and dropping it is not an error");
});

test("a checked run shows Checked with its reason, not Needs you, and its Dismiss, titled as leaving the ticket alone, goes to the board", async () => {
  const p = await page(new Map(), { entries: [entry("C-1", { phase: "finished", startedAt: 2, finishedAt: 4, outcome: { kind: "checked", reason: "A11-24 is an epic: queue A11-25 and A11-26" } })] });
  const row = runRows(p).find((r) => r.text().includes("C-1"))!;
  assert.equal(row.children[0].className, "icon st-checked");
  assert.ok(row.text().includes("A11-24 is an epic: queue A11-25 and A11-26"), "the reason it finished with");
  assert.equal(filterButton(p, "Needs you").children.find((c) => c.className === "n")?.text(), "0");
  const dismiss = row.all().find((n) => n.tag === "button") as Node_ & { title?: string };
  assert.equal(dismiss.text(), "Dismiss");
  const dismissTitle = dismiss.title ?? "";
  assert.match(dismissTitle, /The ticket, its branch and its pull requests are left as they are/);
  dismiss.fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/C-1/dismiss"));
});

test("A11-91: a done run shows Completed with its reason and each evidence line, and offers no Retry", async () => {
  const p = await page(new Map(), { entries: [entry("D-1", { phase: "finished", startedAt: 2, finishedAt: 4, outcome: { kind: "done", reason: "every Done-when holds", evidence: ["npm test: 12 pass", "toast.ts:40 shows it on refresh"] } })] });
  const row = runRows(p).find((r) => r.text().includes("D-1"))!;
  assert.equal(row.children[0].className, "icon st-completed");
  assert.ok(row.text().includes("every Done-when holds"), "the reason it completed with");
  assert.ok(row.text().includes("npm test: 12 pass") && row.text().includes("toast.ts:40 shows it on refresh"), "each line of its evidence");
  assert.deepEqual(row.all().filter((n) => n.tag === "button").map((n) => n.text()), ["Dismiss"]);
});

test("A11-91: a run that proposes an edit shows it beside the ticket's current text, and Apply edit and Discard edit post to their routes", async () => {
  const edit = { title: "Right title", why: "the title names the wrong thing", base: { title: "Wrong title", description: "the text" } };
  const p = await page(new Map(), { entries: [entry("E-9", { phase: "finished", startedAt: 2, finishedAt: 4, outcome: { kind: "checked", reason: "nothing to change", edit } })] });
  const row = runRows(p).find((r) => r.text().includes("E-9"))!;
  assert.ok(row.text().includes("Proposed edit to the ticket: the title names the wrong thing"), "why it is proposed");
  assert.ok(row.text().includes("Wrong title") && row.text().includes("Right title"), "the current and the proposed title");
  const buttons = row.all().filter((n) => n.tag === "button");
  assert.deepEqual(buttons.map((n) => n.text()), ["Apply edit", "Discard edit", "Dismiss"]);
  assert.match((buttons[2] as Node_ & { title?: string }).title ?? "", /Its proposed edit to the ticket's text is dropped too/, "Dismiss says the proposal goes with the run");
  buttons[0].fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/E-9/apply-edit"));
  buttons[1].fire("click");
  await settle();
  assert.ok(p.posts.some((x) => x.path === "/api/queue/E-9/discard-edit"));
});

test("A11-69: an empty Pick view says why in the instance's words, and the count says whose tickets it lists", async () => {
  const empty = 'Team A11 has no open tickets, or Linear has no team with that key. tickets.pick in the host file names it.';
  const p = await page(new Map(), { tickets: [], config: { pick: "open in team A11" }, pick: { empty } });
  const shown = p.$("groups").all().filter((n) => n.className === "empty");
  assert.deepEqual(shown.map((n) => n.text()), [empty]);
  assert.equal(p.$("loaded").textContent, "0 of 0 open in team A11 shown, 0 selected");
  const older = await page(new Map(), { tickets: [] });
  assert.deepEqual(older.$("groups").all().filter((n) => n.className === "empty").map((n) => n.text()), ["No open tickets to list."], "an instance that cannot say why keeps a plain line");
  assert.equal(older.$("loaded").textContent, "0 of 0 assigned to you shown, 0 selected", "an instance that names no pick lists the key's own, as before");
  const full = await page(new Map(), { pick: { empty } });
  assert.equal(full.requested.includes("/api/pick"), false, "a list with tickets asks no reason");
  assert.equal(full.$("groups").all().some((n) => n.className === "empty"), false);
});

// E-1 is an epic whose open sub-issues are not in the list; D-1 was one, but its sub-issues are all done; T-1 is ordinary.
const PARENTS = [
  ticketIn("E-1", { children: ["S-2", "S-1"] }),
  ticketIn("D-1", { children: [] }),
  ticketIn("T-1"),
];

test("A11-76: a ticket with open sub-issues is shown as a parent, counting them, with no checkbox to tick and Queue its children in its place", async () => {
  const p = await page(new Map(), { tickets: PARENTS });
  assert.deepEqual(p.shownKeys(), ["E-1", "D-1", "T-1"]);
  const epic = rowFor(p, "E-1");
  assert.ok(epic.className.includes("parent"), "marked as a parent");
  assert.ok(epic.text().includes("Parent · 2 open sub-issues"), epic.text());
  assert.equal(tickOf(p, "E-1").disabled, true, "no plain Queue for it");
  const button = epic.all().find((n) => n.tag === "button" && n.textContent === view_2.QUEUE_CHILDREN);
  assert.ok(button, "Queue its children is offered");
  assert.equal(rowFor(p, "D-1").all().some((n) => n.textContent === view_2.QUEUE_CHILDREN), false, "an epic whose sub-issues are all done is an ordinary ticket");
  assert.equal(tickOf(p, "D-1").disabled, false);
  assert.equal(rowFor(p, "D-1").text().includes("Parent"), false);
  p.$("all").checked = true;
  p.$("all").fire("change");
  p.$("queue").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(p.posts.filter((x) => x.path === "/api/queue").map((x) => x.body.keys), [["D-1", "T-1"]], "Select all never takes a parent");
});

test("A11-76: Queue its children asks the instance to queue the parent's sub-issues on the footer's choice, and shows the order it used", async () => {
  const children = { queue: { entries: [], max: 3, paused: true }, keys: ["S-1", "S-2"], note: "the tracker gives no blocking order, so they are queued in identifier order" };
  const p = await page(new Map(), { tickets: PARENTS, children });
  rowFor(p, "E-1").all().find((n) => n.tag === "button" && n.textContent === view_2.QUEUE_CHILDREN)!.fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(p.posts.filter((x) => x.path === "/api/queue-children").map((x) => x.body), [{ key: "E-1", model: "opus", effort: "high", plan: false }]);
  assert.equal(p.$("children-note").hidden, false);
  assert.equal(p.$("children-note").textContent, "Queued E-1's children: S-1, S-2. Note: the tracker gives no blocking order, so they are queued in identifier order.");
  assert.equal(p.$("error").textContent, "");
});

test("A11-76: a parent shown with its sub-issues under it offers Queue its children too, beside its own checkbox for the ones in the list", async () => {
  const p = await page(new Map(), { tickets: [ticketIn("E-1", { children: ["S-1", "S-2"] }), ticketIn("S-1", { parent: "E-1" })] });
  const epic = rowFor(p, "E-1");
  assert.ok(epic.text().includes("1 ticket under it · Parent · 2 open sub-issues"), epic.text());
  assert.ok(epic.all().some((n) => n.tag === "button" && n.textContent === view_2.QUEUE_CHILDREN));
});

const LABELLED = [
  { key: "L-1", title: "one", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "", labels: [{ name: "Fleet", group: "Goal" }, { name: "Bug", group: null }] },
  { key: "L-2", title: "two", status: "Backlog", statusOrder: 0, priority: 2, project: "Beta", url: "", labels: [{ name: "Ticket mode", group: "Goal" }] },
  { key: "L-3", title: "three", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "", labels: [{ name: "Fleet", group: "Goal" }] },
  { key: "L-4", title: "four", status: "Backlog", statusOrder: 0, priority: 2, project: "Alpha", url: "" },
];

test("a row of chips for each label group, named after it, and a Labels row for the labels in no group, each chip with its count", async () => {
  const p = await page(new Map(), { tickets: inOneProject(LABELLED) });
  const rows = p.$("label-rows").children;
  assert.deepEqual(rows.map((r) => r.children[0].text()), ["Goal", "Labels"], "each row is named after its group");
  for (const chipText of ["All", "Fleet2", "Ticket mode1", "(no Goal)1"]) assert.ok(rows[0].text().includes(chipText), `a chip with its count: ${chipText}`);
  for (const chipText of ["Bug1", "(no label)3"]) assert.ok(rows[1].text().includes(chipText), `a chip with its count: ${chipText}`);
  assert.equal(rows[0].children[1].getAttribute("aria-pressed"), "true", "All is pressed while nothing in the row is chosen");
});

test("a list with no labels shows no label row, and a list with no label outside a group shows no Labels row", async () => {
  assert.deepEqual((await page(new Map())).$("label-rows").children, []);
  const grouped = await page(new Map(), { tickets: LABELLED.slice(1) });
  assert.deepEqual(grouped.$("label-rows").children.map((r) => r.children[0].text()), ["Goal"]);
});

test("label chips choose several at once within a row, combine with AND across rows and with the chosen project, All clears the row, and the choice is kept", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { tickets: LABELLED });
  const rowChip = (row: number, name: string) => p.$("label-rows").children[row].children.find((c) => c.tag === "button" && (c.children[0]?.text() ?? c.textContent) === name)!;
  rowChip(0, "Fleet").fire("click");
  assert.deepEqual(p.shownKeys(), ["L-1", "L-3"], "Alpha, the first project, has both Fleet tickets");
  rowChip(1, "Bug").fire("click");
  assert.deepEqual(p.shownKeys(), ["L-1"], "rows combine with AND");
  rowChip(1, "All").fire("click");
  p.chip("Beta").fire("click");
  assert.deepEqual(p.shownKeys(), [], "Beta has no Fleet ticket, so the Fleet chip reads 0 and the list is empty while it is chosen");
  assert.equal(rowChip(0, "Fleet").children[1].text(), "0");
  assert.equal(rowChip(0, "Fleet").getAttribute("aria-pressed"), "true", "and stays pressed");
  rowChip(0, "Ticket mode").fire("click");
  assert.deepEqual(p.shownKeys(), ["L-2"], "a chip with a ticket in the project adds it");
  p.chip("Alpha").fire("click");
  assert.deepEqual(p.shownKeys(), ["L-1", "L-3"], "back in Alpha, Ticket mode adds nothing: its one ticket is Beta's");
  assert.deepEqual(JSON.parse(storage.get("ticket-mode.labels")!).length, 2, "the Goal row's two choices are remembered");
  const again = await page(storage, { tickets: LABELLED });
  assert.deepEqual(again.shownKeys(), ["L-1", "L-3"], "a new page starts from the remembered choices and the remembered project");
  const clear = again.$("label-rows").children[0].children.find((c) => c.tag === "button" && (c.children[0]?.text() ?? c.textContent) === "All")!;
  clear.fire("click");
  assert.deepEqual(again.shownKeys(), ["L-1", "L-3", "L-4"]);
  assert.equal(storage.get("ticket-mode.labels"), "[]");
});

test("each ticket row shows its group labels as small tags, titled with their group, and not its labels in no group", async () => {
  const p = await page(new Map(), { tickets: LABELLED });
  const row = p.$("groups").all().find((n) => n.className.startsWith("row") && n.children[1].text() === "L-1")!;
  const tags = row.all().filter((n) => n.className === "tag");
  assert.deepEqual(tags.map((t) => [t.text(), t.title]), [["Fleet", "Goal"]]);
});

test("A11-80: a run whose worker wrote working shows In progress with its reason, not Needs you, and a stalled one is flagged", async () => {
  const p = await page(new Map(), { entries: [
    entry("W-1", { phase: "running", startedAt: 2, workspace: "w1", pane: "w1:p1", working: { reason: "the Ansible roll is still running", at: 3 } }),
    entry("W-2", { phase: "running", startedAt: 2, workspace: "w2", pane: "w2:p1", working: { reason: "waiting on the second play", at: 3, stalled: true } })] });
  const row = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  assert.equal(row("W-1").children[0].className, "icon st-working");
  assert.ok(row("W-1").text().includes("the Ansible roll is still running"), "its reason is the run's latest note");
  assert.equal(row("W-1").all().some((n) => n.className === "waiting stalled"), false);
  assert.equal(filterButton(p, "Needs you").children.find((c) => c.className === "n")?.text(), "0");
  assert.equal(row("W-2").children[0].className, "icon st-working", "a stalled run is still In progress");
  const flag = row("W-2").all().find((n) => n.className === "waiting stalled");
  assert.equal(flag?.text(), "Stalled: idle with no newer outcome since it said: waiting on the second play");
});

test("A11-174: a run whose safety prompt was declined shows 'A safety prompt was declined automatically' with its command, and no 'Waiting on a person'", async () => {
  const p = await page(new Map(), { entries: [
    entry("S-1", { phase: "running", startedAt: 2, workspace: "w1", pane: "w1:p1", declined: { command: "rm -f $SC/*.done", warning: "Dangerous rm operation on possibly-empty variable path", at: 3, count: 1, told: true } })] });
  const row = runRows(p)[0];
  const lines = row.all().filter((n) => n.className === "waiting").map((n) => n.text());
  assert.deepEqual(lines, ["A safety prompt was declined automatically: rm -f $SC/*.done"]);
  assert.ok(!row.text().includes("Waiting on a person"));
});

test("A11-174: a waiting run shows 'Waiting on a person: <first line>', and 'Waiting on a person' alone when no dialog could be read", async () => {
  const p = await page(new Map(), { entries: [
    entry("S-1", { phase: "running", startedAt: 2, waiting: true, prompt: "Which database should the migration use?" }),
    entry("S-2", { phase: "running", startedAt: 3, waiting: true })] });
  const lineOf = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.className === "waiting").map((n) => n.text());
  assert.deepEqual(lineOf("S-1"), ["Waiting on a person: Which database should the migration use?"]);
  assert.deepEqual(lineOf("S-2"), ["Waiting on a person"]);
});

/*
 * New tickets (A11-94): the form, a run's card, and a draft reviewed in place. The page creates nothing itself: each button posts to its route.
 */

const WRITER_CONFIG = { writer: true, writerGrill: true, repos: ["nbl-ui-netbox", "platform-monorepo"], priorities: ["urgent", "high", "medium", "low", "none"] };
const RUN = { id: "w7", request: "Show the requests a person made", mode: "quick", phase: "finished", status: "done", form: {}, tickets: [] };
/** The New ticket form, filled with a grill request, and sent. */
async function sendGrill(p: Awaited<ReturnType<typeof page>>) {
  p.$("new-ticket").fire("click");
  p.$("writer-request").value = "Show requests";
  p.$("writer-mode").value = "grill";
  p.$("writer-start").fire("click");
  await settle();
}
/** The card of the first run on the page. */
const cardOf = (p: Awaited<ReturnType<typeof page>>) => p.$("writers-list").all().find((n) => n.className === "writer")!;

const WRITER_SETTINGS = { ...SETTINGS, ...WRITER_CONFIG, writerDefault: { model: "sonnet", effort: "high" } };
/** A select's options as the page drew them: each one's value and its text. */
const optionsOf = (p: Page, id: string) => p.$(id).children.map((option) => [option.value, option.textContent]);

test("the Ticket writer's model and effort are set in Settings beside the others, on a machine that names tickets.writer, the first option being the host's", async () => {
  const off = await page(new Map(), { config: SETTINGS });
  await openFrom(off, "open-settings");
  assert.equal(off.$("writer-settings").hidden, true, "no writer, no writer settings");
  const p = await page(new Map(), { config: WRITER_SETTINGS });
  await openFrom(p, "open-settings");
  assert.equal(p.$("writer-settings").hidden, false);
  assert.deepEqual(optionsOf(p, "writerModel").slice(1), optionsOf(p, "planModel"), "the same model choices, with the same wording");
  assert.deepEqual(optionsOf(p, "writerEffort").slice(1), optionsOf(p, "planEffort"), "the same effort choices, with the same wording");
  assert.deepEqual([optionsOf(p, "writerModel")[0], optionsOf(p, "writerEffort")[0]], [["", "Host default: sonnet"], ["", "Host default: high"]]);
  assert.deepEqual([p.$("writerModel").value, p.$("writerEffort").value], ["", ""], "nothing chosen: the host default shows");
});

test("a Ticket writer choice is saved as it changes, the run's choice is left alone, and the host default clears it", async () => {
  const p = await page(new Map(), { config: WRITER_SETTINGS });
  await openFrom(p, "open-settings");
  await change(p, "writerEffort", "max");
  assert.deepEqual(p.posts.at(-1), { path: "/api/choice", body: { writerEffort: "max" } });
  assert.equal(p.$("writerEffort").value, "max");
  assert.deepEqual(footerChoice(p), ["opus", "high"], "the run's choice is unchanged");
  await change(p, "writerModel", "");
  assert.deepEqual(p.posts.at(-1), { path: "/api/choice", body: { writerModel: "" } }, "the host default posts an empty value, which clears the choice");
});

test("a Ticket writer choice the board refuses goes back to what is saved", async () => {
  const p = await page(new Map(), { config: { ...WRITER_SETTINGS, choice: { writerEffort: "max" } }, refused: ["/api/choice"] });
  await changeFrom(p, "open-settings", "writerEffort", "high");
  assert.equal(p.$("writerEffort").value, "max", "the control reads what is saved again");
});

test("New ticket is shown only on a machine that names tickets.writer, and Grill is disabled with its reason on one with no terminal", async () => {
  const off = await page(new Map(), { config: {} });
  assert.equal(off.$("new-ticket").hidden, true, "no writer, no New ticket");
  const on = await page(new Map(), { config: { ...WRITER_CONFIG, writerGrill: false } });
  assert.equal(on.$("new-ticket").hidden, false);
  on.$("new-ticket").fire("click");
  assert.equal(on.$("new-ticket-dialog").open, true);
  assert.equal(on.$("writer-grill").disabled, true);
  const note = on.$("writer-grill-note");
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Grill needs a terminal: name tickets.terminal/);
});

test("a request is sent with the choices the form made, and the run it starts shows as Writing with its request", async () => {
  const p = await page(new Map(), { config: WRITER_CONFIG, tickets: TICKETS, writers: { runs: [{ ...RUN, phase: "running", status: "writing", workspace: "w1", pane: "w1:p1" }] } });
  p.$("new-ticket").fire("click");
  for (const [id, value] of [["writer-request", "  Show the requests a person made  "], ["writer-repo", "nbl-ui-netbox"], ["writer-priority", "high"]] as const) p.$(id).value = value;
  p.$("writer-start").fire("click");
  await settle();
  const sent = p.posts.find(({ path }) => path === "/api/writer")!;
  assert.deepEqual(sent.body, { request: "Show the requests a person made", mode: "quick", repo: "nbl-ui-netbox", priority: "high" });
  assert.equal(p.$("new-ticket-dialog").open, false, "the dialog closes once the request is queued");
  assert.ok(p.$("writers-list").text().includes("Writing"));
  assert.equal(p.tabs.length, 0, "a quick request opens no terminal tab");
});

test("a grill request opens its tab in the click, and points the tab at the run's terminal once the run has a workspace", async () => {
  let run: Record<string, unknown> = { ...RUN, phase: "queued", status: "queued" };
  const p = await page(new Map(), { config: { ...WRITER_CONFIG, terminal: TERMINAL }, connections: WORK_ALONE, writerReply: () => ({ runs: [run] }) });
  await sendGrill(p);
  assert.equal(p.tabs.length, 1, "POSITIVE CONTROL: the tab is opened in the click, before the run has a workspace");
  assert.equal(p.tabs[0].location.href, "", "and it is still blank");
  run = { ...RUN, phase: "running", status: "writing", workspace: "w4", pane: "w4:p1" };
  await p.runTimers();
  assert.equal(p.tabs[0].location.href, opens("http://127.0.0.1:7318/?ws=w4&pane=w4%3Ap1&view=terminal"), "the tab goes to the run's terminal");
});

test("a grill tab the browser blocks is not used, and the run's card offers Open terminal instead", async () => {
  const run = { ...RUN, phase: "running", status: "writing", workspace: "w4", pane: "w4:p1" };
  const p = await page(new Map(), { config: { ...WRITER_CONFIG, terminal: TERMINAL }, connections: WORK_ALONE, blockTabs: true, writers: { runs: [run] } });
  await sendGrill(p);
  assert.equal(p.tabs.length, 0, "the browser opened nothing");
  const terminal = cardOf(p).all().find((n) => n.tag === "a" && n.textContent === "Open terminal") as (Node_ & { href?: string }) | undefined;
  assert.equal(terminal?.href, opens("http://127.0.0.1:7318/?ws=w4&pane=w4%3Ap1&view=terminal"), "the run's card links its terminal");
  assert.ok(p.posts.some(({ path }) => path.endsWith("/api/writer")), "the request is still sent: only the tab was blocked");
});

test("A11-129: a grill run waiting for the person shows Waiting for you, its question and Open terminal; a finished run has no Open terminal", async () => {
  const waiting = { ...RUN, phase: "running", status: "waiting", workspace: "w4", pane: "w4:p1", waiting: { question: "Q1: editable or read-only?", since: 10 } };
  const p = await page(new Map(), { config: { ...WRITER_CONFIG, terminal: TERMINAL }, connections: WORK_ALONE, writers: { runs: [waiting] } });
  assert.ok(cardOf(p).text().includes("Waiting for you"), "the status is said in words");
  assert.ok(cardOf(p).text().includes("Q1: editable or read-only?"), "the question is on the card");
  assert.equal((cardOf(p).all().find((n) => n.tag === "a" && n.textContent === "Open terminal") as (Node_ & { href?: string }) | undefined)?.href,
    opens("http://127.0.0.1:7318/?ws=w4&pane=w4%3Ap1&view=terminal"), "Open terminal stays while it waits, for the answer");
  const finished = await page(new Map(), { config: { ...WRITER_CONFIG, terminal: TERMINAL }, connections: WORK_ALONE, writers: { runs: [RUN] } });
  assert.equal(cardOf(finished).all().some((n) => n.tag === "a" && n.textContent === "Open terminal"), false, "a finished run has no terminal to open");
});

test("A11-129: a board opened from a link to a run chooses that run's connection, and scrolls to its card", async () => {
  const p = await page(new Map(), { config: WRITER_CONFIG, connections: WORK_AND_PERSONAL, writers: { runs: [RUN] }, search: "?connection=personal", hash: "#writer-w7" });
  assert.ok(p.requested.some((path) => path.startsWith("/c/personal/api/")), "the link's connection is the one the page reads");
  assert.ok(!p.requested.some((path) => path.startsWith("/c/work/api/")), "and the one remembered or local is not");
  assert.equal(p.$("writer-w7").scrolled, true, "the card the link names is scrolled to");
});

test("A11-129: a board opened with a hash that is not a valid encoding loads without an error, as one opened with no hash does", async () => {
  const p = await page(new Map(), { config: WRITER_CONFIG, connections: WORK_ALONE, writers: { runs: [RUN] }, hash: "#%E0%A4%A" });
  assert.equal(p.$("error").textContent, "", "a malformed hash names no card, and is not shown as the page's error");
  assert.equal(p.$("writers-list").children.length, 1, "the board still draws its runs");
});

test("a run that made its tickets shows each as a link by its key, and says so when Pick does not list it", async () => {
  const made = { ...RUN, tickets: [
    { key: "NBF-101", url: "https://linear.app/x/NBF-101", inPick: true },
    { key: "NBF-102", url: "https://linear.app/x/NBF-102", inPick: false },
  ] };
  const p = await page(new Map(), { config: WRITER_CONFIG, writers: { runs: [{ ...made, status: "done" }] } });
  const links = cardOf(p).all().filter((n) => n.tag === "a").map((a) => [a.textContent, (a as Node_ & { href?: string }).href]);
  assert.deepEqual(links, [["Created NBF-101", "https://linear.app/x/NBF-101"], ["Created NBF-102", "https://linear.app/x/NBF-102"]]);
  assert.ok(cardOf(p).text().includes("It is outside the list Pick shows, so it is not in it."), "the one Pick does not list is said");
  const unaddressed = await page(new Map(), { config: WRITER_CONFIG, writers: { runs: [{ ...RUN, status: "failed", failure: "it names NBF-9, a ticket it did not create",
    tickets: [{ key: "NBF-103", url: null, inPick: true }] }] } });
  assert.ok(cardOf(unaddressed).text().includes("Created NBF-103"), "a ticket the tracker has no address for is named, without a link");
  assert.equal(cardOf(unaddressed).all().some((n) => n.tag === "a" && n.textContent === "Created NBF-103"), false, "and is not a link");
});

test("the card has no review: no Approve, Approve and queue or Discard, and a failed run shows why and the ticket it made", async () => {
  const failed = { ...RUN, status: "failed", failure: "NBF-9 is not in the tracker; NBF-10 has no plan attached", tickets: [{ key: "NBF-10", url: "https://linear.app/x/NBF-10", inPick: true }] };
  const p = await page(new Map(), { config: WRITER_CONFIG, writers: { runs: [failed] } });
  const labels = cardOf(p).all().filter((n) => n.tag === "button").map((n) => n.textContent);
  assert.deepEqual(labels, ["Dismiss"], "a finished run offers Dismiss, and nothing to approve");
  assert.ok(cardOf(p).text().includes("Failed"));
  assert.ok(cardOf(p).text().includes("NBF-9 is not in the tracker; NBF-10 has no plan attached"), "why it failed");
  assert.ok(cardOf(p).text().includes("Created NBF-10"), "the ticket it made stays shown with the failure");
  assert.equal(p.$("writers-list").all().filter((n) => n.className === "draft").length, 0);
});

test("a run's Stop and Dismiss post to their routes, and Open terminal links to its workspace while it works", async () => {
  const working = { ...RUN, phase: "running", status: "writing", workspace: "w3", pane: "w3:p1" };
  const p = await page(new Map(), { config: { ...WRITER_CONFIG, terminal: TERMINAL }, writers: { runs: [working] }, connections: WORK_ALONE,
    writerReply: (path) => (path.endsWith("/stop") || path.endsWith("/dismiss") ? { runs: [{ ...RUN, phase: "finished", status: "done" }] } : { runs: [working] }) });
  const terminal = cardOf(p).all().find((n) => n.tag === "a" && n.textContent === "Open terminal") as (Node_ & { href?: string }) | undefined;
  assert.ok(terminal?.href?.includes("/terminal?link="), "the terminal opens while the agent works");
  assert.equal(terminal!.href, opens("http://127.0.0.1:7318/?ws=w3&pane=w3%3Ap1&view=terminal"), "the link names the run's workspace and pane, as a ticket's does");
  const button = (label: string) => cardOf(p).all().find((n) => n.tag === "button" && n.textContent === label)!;
  button("Stop").fire("click");
  await settle();
  assert.ok(p.posts.some(({ path }) => path.endsWith("/api/writer/w7/stop")), "posted to the shown instance");
});

test("a new-ticket run's card names the model and effort it runs on", async () => {
  const p = await page(new Map(), { config: WRITER_CONFIG, writers: { runs: [{ ...RUN, model: "sonnet", effort: "max", phase: "running", status: "writing", workspace: "w1", pane: "w1:p1" }] } });
  assert.ok(p.$("writers-list").text().includes("sonnet/max"));
});

test("a run that made a ticket reads Pick again on the page's poll, so the ticket shows there", async () => {
  let runs: Record<string, unknown>[] = [{ ...RUN, phase: "running", status: "writing", workspace: "w1", pane: "w1:p1" }];
  const p = await page(new Map(), { config: WRITER_CONFIG, writerReply: () => ({ runs }) });
  const reads = () => p.requested.filter((path) => path === "/api/tickets").length;
  const before = reads();
  await p.poll();
  assert.equal(reads(), before, "nothing changed: Pick is not read again");
  runs = [{ ...RUN, status: "done", tickets: [{ key: "NBF-101", url: "u", inPick: true }] }];
  await p.poll();
  assert.equal(reads(), before + 1, "a ticket made: Pick is read again, and it shows there");
});

test("A11-106: a finished run's stacked pull request note is shown in its row as a waiting line, and a run with none shows no such line", async () => {
  const note = "Needs retarget: https://github.com/a11ign/agent-org/pull/1749 still targets nbf-1-fit, whose branch is gone: retarget it by hand";
  const p = await page(new Map(), { entries: [
    entry("S-1", { phase: "finished", startedAt: 2, finishedAt: 7, outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/1754" }] },
      retargets: { "https://github.com/a11ign/agent-org/pull/1749": note } }),
    entry("S-2", { phase: "finished", startedAt: 2, finishedAt: 8, outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/1755" }] } }),
  ] });
  const row = (key: string) => runRows(p).find((r) => r.text().includes(key))!;
  assert.equal(row("S-1").all().filter((n) => n.className === "waiting" && n.text() === note).length, 1, "the note is a waiting line of its run");
  assert.equal(row("S-2").all().some((n) => n.className === "waiting" && n.text().startsWith("Needs retarget")), false, "a run with no note shows none");
});

test("A11-154: a run's rerun checks and the Talk session the board closed before its round are shown in its row, and a queued round says what it waits for", async () => {
  const rerun = "Reran test on 1a2b3c4d: a runner was lost or a rate limit was hit";
  const closed = "Closed the Talk session in w9 before this round";
  const waiting = "Waits for the Talk session in w3 to end";
  const pr = { repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/1802" };
  const p = await page(new Map(), { entries: [
    entry("C-1", { phase: "finished", startedAt: 2, finishedAt: 7, outcome: { kind: "ready-pr", prs: [pr] }, checkHeads: { [pr.url]: { head: "1a2b3c4d5e6f", step: "rerun", note: rerun } } }),
    entry("C-2", { phase: "running", startedAt: 3, review: [pr], sessionNote: closed }),
    entry("C-3", { phase: "queued", review: [pr], sessionWait: waiting }),
    entry("C-4", { phase: "finished", startedAt: 2, finishedAt: 9, outcome: { kind: "ready-pr", prs: [pr] } }),
  ] });
  const lines = (key: string) => runRows(p).find((r) => r.text().includes(key))!.all().filter((n) => n.className === "waiting" || n.className === "meta").map((n) => n.text());
  assert.ok(lines("C-1").includes(rerun), "the rerun is a line of its run");
  assert.ok(lines("C-2").includes(closed), "so is the leftover the board closed");
  assert.ok(lines("C-3").includes(waiting), "and a held round says what it waits for");
  assert.ok(![rerun, closed, waiting].some((text) => lines("C-4").includes(text)), "a run with none shows none");
});

// The Assignee filter (A11-108): Dan Beck is the signed-in person. Ana Ruiz and Dan have two open tickets each, Ben Park one, and M-3 nobody.
const DAN = { id: "dan", name: "Dan Beck" };
const ANA = { id: "ana", name: "Ana Ruiz" };
const BEN = { id: "ben", name: "Ben Park" };
const ASSIGNED = [
  ticketIn("M-1", { assignee: DAN }),
  ticketIn("M-2", { assignee: ANA }),
  ticketIn("M-3", { assignee: null }),
  ticketIn("M-4", { assignee: DAN }),
  ticketIn("M-5", { assignee: BEN }),
  ticketIn("M-6", { assignee: ANA }),
];
const WITH_ASSIGNEES = { viewer: DAN, pickDefault: "you" };
/** Each chip of the Assignee row as its text, its count and whether it is pressed. */
const assigneeChips = (p: Page) => p.$("assignees").children.filter((c) => c.tag === "button")
  .map((c) => [c.children[0].text(), c.children[1]?.text() ?? "none", c.getAttribute("aria-pressed")]);

test("A11-108: the list starts on the signed-in person's tickets, the counter says so, and the rows of other people's tickets are not in it", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  assert.deepEqual(p.shownKeys(), ["M-1", "M-4"]);
  assert.equal(p.$("loaded").textContent, "2 of 2 assigned to you shown, 0 selected");
  assert.equal(p.$("assignees").hidden, false, "the Assignee row is drawn");
  assert.equal(p.$("assignees").children[0].text(), "Assignee");
  assert.deepEqual(assigneeChips(p), [
    ["Dan Beck (you)", "2", "true"], ["Anyone", "6", "false"], ["Unassigned", "1", "false"], ["Ana Ruiz", "2", "false"], ["Ben Park", "1", "false"],
  ], "the person, Anyone and Unassigned, then each other person with an open ticket by count and then name");
  assert.equal(rowFor(p, "M-1").text().includes("Dan Beck"), false, "a row in the person's own list names no owner");
});

test("A11-108: Unassigned lists only the tickets nobody has, each with its owner, and the counter says unassigned", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  p.chip("Unassigned", "assignees").fire("click");
  assert.deepEqual(p.shownKeys(), ["M-3"]);
  assert.equal(p.$("loaded").textContent, "1 of 1 unassigned shown, 0 selected");
  assert.ok(rowFor(p, "M-3").text().includes("Unassigned"), "the row says it has no owner");
  assert.equal(rowFor(p, "M-3").all().some((n) => n.className === "pill" && n.text() === "Unassigned"), true, "the owner is a pill of its own");
});

test("A11-108: Anyone lists every ticket with its owner, and the counter says open", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  p.chip("Anyone", "assignees").fire("click");
  assert.deepEqual([...p.shownKeys()].sort(), ["M-1", "M-2", "M-3", "M-4", "M-5", "M-6"]);
  assert.equal(p.$("loaded").textContent, "6 of 6 open shown, 0 selected");
  assert.ok(rowFor(p, "M-2").text().includes("Ana Ruiz"), "a row of someone else's ticket names them");
});

test("A11-108: another person's chip lists only theirs, each with the owner, the counter says assigned to them, and choosing it sends no request", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  const sent = p.requested.length;
  p.chip("Ana Ruiz", "assignees").fire("click");
  assert.deepEqual(p.shownKeys(), ["M-2", "M-6"]);
  assert.equal(p.$("loaded").textContent, "2 of 2 assigned to Ana Ruiz shown, 0 selected");
  assert.ok(rowFor(p, "M-6").text().includes("Ana Ruiz"));
  assert.equal(p.requested.length, sent, "the list is filtered in the page, from the one read");
});

test("A11-108: a person with no open ticket has no chip; the person, Anyone and Unassigned have theirs, even at zero", async () => {
  const eve = { id: "eve", name: "Eve Stone" };
  const p = await page(new Map(), { tickets: ASSIGNED, config: { viewer: eve, pickDefault: "you" } });
  assert.deepEqual(assigneeChips(p), [
    ["Eve Stone (you)", "0", "true"], ["Anyone", "6", "false"], ["Unassigned", "1", "false"], ["Ana Ruiz", "2", "false"], ["Dan Beck", "2", "false"], ["Ben Park", "1", "false"],
  ]);
  assert.deepEqual(p.shownKeys(), [], "nothing is the person's");
  assert.equal(p.$("loaded").textContent, "0 of 0 assigned to you shown, 0 selected");
  const empty = p.$("groups").all().find((n) => n.className === "empty")!.text();
  assert.ok(empty.startsWith("No open tickets are assigned to Eve Stone, whose Linear key this board reads with."), empty);
  assert.ok(empty.includes("The Assignee row shows Anyone and Unassigned") && empty.includes("tickets.pick"), empty);
});

test("A11-108: the choice is not remembered: a new load starts on the setting's default, whatever the last load chose", async () => {
  const storage = new Map<string, string>();
  const first = await page(storage, { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  first.chip("Anyone", "assignees").fire("click");
  assert.equal(first.shownKeys().length, 6);
  const again = await page(storage, { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  assert.deepEqual(again.shownKeys(), ["M-1", "M-4"]);
});

test("A11-108: tickets.pick names a team, so the default is Anyone and the counter keeps reading open in team", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: { viewer: DAN, pickDefault: "anyone", pickOpen: "open in team A11" } });
  assert.equal(p.$("loaded").textContent, "6 of 6 open in team A11 shown, 0 selected");
  assert.deepEqual(assigneeChips(p)[1], ["Anyone", "6", "true"]);
  assert.ok(rowFor(p, "M-5").text().includes("Ben Park"), "every ticket of the team shows with its owner");
});

test("A11-108: when the tracker cannot say whose key it is, the list starts on Anyone, there is no chip for the person, and the row says why", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: { viewer: null, pickDefault: "you" } });
  assert.equal(p.$("loaded").textContent, "6 of 6 open shown, 0 selected", "every ticket is listed rather than none");
  assert.equal(assigneeChips(p).some(([text]) => text.endsWith("(you)")), false);
  assert.equal(p.$("assignees").children[0].title, assigneeFilter.NO_VIEWER);
});

test("A11-108: an instance that names no assignees has no Assignee row, and lists and counts as before", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: {} });
  assert.equal(p.$("assignees").hidden, true);
  assert.equal(p.$("loaded").textContent, "6 of 6 assigned to you shown, 0 selected", "the instance's own word for its list, as before");
});

test("A11-108: a selected ticket outside the chosen scope stays selected, and Queue sends it from the default", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  p.chip("Unassigned", "assignees").fire("click");
  tickOf(p, "M-3").checked = true;
  tickOf(p, "M-3").fire("change");
  p.chip("Dan Beck (you)", "assignees").fire("click");
  assert.deepEqual(p.shownKeys(), ["M-1", "M-4"], "the unassigned ticket is hidden again");
  p.$("queue").fire("click");
  await settle();
  assert.deepEqual(p.posts.find((x) => x.path === "/api/queue")?.body.keys, ["M-3"], "the selection survived the filter change");
});

test("A11-108: the done-when: a ticket with no assignee is hidden on the default, shown under Unassigned, and queued from there", async () => {
  const filed = [...ASSIGNED, ticketIn("M-7", { assignee: null })];
  const p = await page(new Map(), { tickets: filed, config: WITH_ASSIGNEES });
  assert.equal(p.shownKeys().includes("M-7"), false, "hidden by default");
  p.chip("Unassigned", "assignees").fire("click");
  assert.deepEqual(p.shownKeys(), ["M-3", "M-7"]);
  tickOf(p, "M-7").checked = true;
  tickOf(p, "M-7").fire("change");
  p.$("queue").fire("click");
  await settle();
  assert.deepEqual(p.posts.find((x) => x.path === "/api/queue")?.body.keys, ["M-7"]);
});

test("A11-108: a parent outside the chosen scope with a ticket in it is shown as context, so the ticket keeps its place", async () => {
  const tickets = [ticketIn("E-1", { assignee: ANA, children: ["M-8"] }), ticketIn("M-8", { assignee: DAN, parent: "E-1" })];
  const p = await page(new Map(), { tickets, config: WITH_ASSIGNEES });
  assert.deepEqual(rowsOf(p).map((r) => r.className), ["row parent context"], "folded, as every parent starts");
  assert.match(rowFor(p, "E-1").text(), /Not in this view/);
  assert.equal(rowFor(p, "E-1").text().includes("Ana Ruiz"), false, "on the signed-in person's own list no row names an owner");
  foldOf(p, "E-1").fire("click");
  assert.deepEqual(p.shownKeys(), ["E-1", "M-8"]);
  // On another person's list, the parent outside it names its owner, as any row outside the list does.
  const other = [ticketIn("E-1", { assignee: ANA, children: ["M-8"] }), ticketIn("M-8", { assignee: BEN, parent: "E-1" })];
  const ben = await page(new Map(), { tickets: other, config: WITH_ASSIGNEES });
  ben.chip("Ben Park", "assignees").fire("click");
  assert.match(rowFor(ben, "E-1").text(), /Ana Ruiz.*Not in this view/, "the context parent names its owner");
});

test("A11-108: the project sidebar's counts are the chosen scope's, so the default view counts the signed-in person's own tickets", async () => {
  const tickets = [
    ticketIn("M-1", { assignee: DAN, project: "Alpha" }),
    ticketIn("M-2", { assignee: ANA, project: "Beta" }),
    ticketIn("M-3", { assignee: ANA, project: "Beta" }),
  ];
  const p = await page(new Map(), { tickets, config: WITH_ASSIGNEES });
  assert.deepEqual(p.$("projects").children.filter((c) => c.tag === "button").map((c) => c.text()), ["Alpha1"], "Beta holds nobody's ticket of the person's, so it is not listed");
  p.chip("Anyone", "assignees").fire("click");
  assert.deepEqual(p.$("projects").children.filter((c) => c.tag === "button").map((c) => c.text()), ["Beta2", "Alpha1"], "the projects by count, as the sidebar always lists them");
});

/** The project sidebar as each button reads: its name, its count and whether it is pressed. */
const projectButtons = (p: Page) => p.$("projects").children.filter((c) => c.tag === "button")
  .map((c) => [c.children[0].text(), c.children[1].text(), c.getAttribute("aria-pressed")]);
/** The text of each button in a row of chips, as its name and count. */
const chipTexts = (p: Page, row: string) => p.$(row).children.filter((c) => c.tag === "button").map((c) => [c.text(), c.getAttribute("aria-pressed")]);

test("A11-123: the sidebar beside the Pick list names each project with its open-ticket count, most first, and exactly one project is pressed", async () => {
  const p = await page(new Map());
  assert.deepEqual(projectButtons(p), [["Alpha", "2", "true"], ["(no project)", "1", "false"], ["Beta", "1", "false"]], "most tickets first, then by name");
  assert.equal(p.$("projects").children.every((c) => c.tag === "button"), true, "each project is a button, so Enter and Space choose it");
});

test("A11-123: selecting a project lists only its tickets, and the other project's are not listed", async () => {
  const p = await page(new Map());
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"], "a first visit shows the first project");
  p.chip("Beta").fire("click");
  assert.deepEqual(p.shownKeys(), ["T-2"]);
  assert.deepEqual(projectButtons(p).map((b) => [b[0], b[2]]), [["Alpha", "false"], ["(no project)", "false"], ["Beta", "true"]]);
  p.chip("(no project)").fire("click");
  assert.deepEqual(p.shownKeys(), ["T-4"]);
});

test("A11-123: the project chosen is remembered and shown again on reload, and nothing is saved until a project is clicked", async () => {
  const storage = new Map<string, string>();
  const first = await page(storage);
  assert.equal(storage.has("ticket-mode.project"), false, "a first visit saves nothing");
  first.chip("Beta").fire("click");
  assert.equal(storage.get("ticket-mode.project"), JSON.stringify(["Beta"]));
  const reloaded = await page(storage);
  assert.deepEqual(reloaded.shownKeys(), ["T-2"]);
  assert.deepEqual(projectButtons(reloaded).map((b) => b[2]), ["false", "false", "true"]);
});

test("A11-123: a remembered project with no open tickets left shows the first project instead, with no error, and the saved choice is left as it was", async () => {
  const storage = new Map([["ticket-mode.project", JSON.stringify(["Gone"])]]);
  const p = await page(storage);
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"]);
  assert.deepEqual(projectButtons(p).map((b) => b[2]), ["true", "false", "false"]);
  assert.equal(p.$("error").textContent, "");
  assert.equal(storage.get("ticket-mode.project"), JSON.stringify(["Gone"]), "a fallback is not a choice, so nothing is saved");
});

test("A11-123: the multi-select key the old Projects row saved is ignored, and is left in storage", async () => {
  const storage = new Map([["ticket-mode.projects", JSON.stringify(["Beta"])]]);
  const p = await page(storage);
  assert.deepEqual(p.shownKeys(), ["T-1", "T-3"], "not Beta, the one it names");
  assert.equal(storage.get("ticket-mode.projects"), JSON.stringify(["Beta"]));
});

// Two projects of two people each, with a priority, a plan and a Goal label on the tickets, so every filter has something to count.
const SCOPED = [
  ticketIn("S-1", { project: "Alpha", priority: 1, assignee: DAN, uploads: ["S-1-0001-plan-a.md"], labels: [{ name: "Fleet", group: "Goal" }] }),
  ticketIn("S-2", { project: "Alpha", priority: 2, assignee: ANA, labels: [{ name: "Fleet", group: "Goal" }] }),
  ticketIn("S-3", { project: "Beta", priority: 3, assignee: BEN, uploads: ["S-3-0001-plan-b.md"], labels: [{ name: "Ticket mode", group: "Goal" }] }),
  ticketIn("S-4", { project: "Beta", priority: 3, assignee: null, uploads: ["S-4-0001-plan-c.md"] }),
];
const SCOPED_CONFIG = { viewer: DAN, pickDefault: "anyone", plan: PLAN };

test("A11-123: the Assignee, Priority, Plan and Goal filters count the chosen project's tickets only, and a chip narrows the list within it", async () => {
  const p = await page(new Map(), { tickets: SCOPED, config: SCOPED_CONFIG });
  assert.deepEqual(p.shownKeys(), ["S-1", "S-2"]);
  assert.deepEqual(assigneeChips(p).map(([name, count]) => [name, count]), [["Dan Beck (you)", "1"], ["Anyone", "2"], ["Unassigned", "0"], ["Ana Ruiz", "1"]],
    "the people with a ticket in Alpha, and no chip for Ben, who has none there");
  assert.deepEqual(chipTexts(p, "priorities").map(([text]) => text), ["All priorities", "Urgent1", "High1"]);
  assert.deepEqual(chipTexts(p, "plans").map(([text]) => text), ["All", "With a plan1", "Without a plan1"]);
  assert.equal(p.$("label-rows").text(), "GoalAllFleet2", "Ticket mode is Beta's, so it has no chip here");
  p.chip("Urgent", "priorities").fire("click");
  assert.deepEqual(p.shownKeys(), ["S-1"], "a chip narrows the list within the project");
});

test("A11-123: a Priority chosen stays on screen at 0 in a project with none of it, and the list is empty while it is chosen", async () => {
  const p = await page(new Map(), { tickets: SCOPED, config: SCOPED_CONFIG });
  p.chip("Urgent", "priorities").fire("click");
  p.chip("Beta").fire("click");
  assert.deepEqual(p.shownKeys(), [], "Beta has no urgent ticket");
  assert.deepEqual(chipTexts(p, "priorities"), [["All priorities", "false"], ["Urgent0", "true"], ["Medium2", "false"]]);
  assert.deepEqual(chipTexts(p, "plans"), [["All", "true"], ["With a plan2", "false"], ["Without a plan0", "false"]], "Beta's tickets alone");
  p.chip("All priorities", "priorities").fire("click");
  assert.deepEqual(p.shownKeys(), ["S-3", "S-4"]);
});

test("A11-123: a Goal label chosen stays on screen at 0 in a project with none of it, and the list is empty while it is chosen", async () => {
  const p = await page(new Map(), { tickets: SCOPED, config: SCOPED_CONFIG });
  const goalChip = (text: string) => p.$("label-rows").children[0].children.find((c) => c.tag === "button" && c.children[0]?.text() === text)!;
  goalChip("Fleet").fire("click");
  assert.deepEqual(p.shownKeys(), ["S-1", "S-2"]);
  p.chip("Beta").fire("click");
  assert.equal(goalChip("Fleet").children[1].text(), "0", "Fleet reads 0 in Beta");
  assert.equal(goalChip("Fleet").getAttribute("aria-pressed"), "true", "and stays pressed");
  assert.deepEqual(p.shownKeys(), []);
  goalChip("Ticket mode").fire("click");
  assert.deepEqual(p.shownKeys(), ["S-3"]);
});

test("A11-123: the project shown is kept, with its selection and the queue footer's count, when the person switches to another", async () => {
  const p = await page(new Map());
  tickOf(p, "T-1").checked = true;
  tickOf(p, "T-1").fire("change");
  assert.equal(p.$("loaded").textContent, "2 of 2 assigned to you shown, 1 selected");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket");
  p.chip("Beta").fire("click");
  assert.equal(p.$("loaded").textContent, "1 of 1 assigned to you shown, 1 selected", "the selection is kept, though T-1 is not shown");
  assert.equal(p.$("queue").textContent, "Queue 1 ticket", "and so is the footer's count");
  p.$("queue").fire("click");
  await settle();
  assert.deepEqual(p.posts.filter((x) => x.path === "/api/queue").at(-1)?.body.keys, ["T-1"], "Queue sends the ticket of the project not shown");
});

test("A11-123: the search box and Select all shown work on the chosen project's tickets, and New ticket is still offered", async () => {
  const p = await page(new Map(), { config: WRITER_CONFIG });
  assert.equal(p.$("new-ticket").hidden, false, "New ticket is offered whichever project is shown");
  p.$("filter").value = "two";
  p.$("filter").fire("input");
  assert.deepEqual(p.shownKeys(), [], "T-2 matches the search, but it is in Beta, which is not shown");
  p.$("filter").value = "";
  p.$("filter").fire("input");
  const body = await queueAll(p);
  assert.deepEqual(body?.keys, ["T-1", "T-3"], "Select all shown takes the chosen project's tickets only");
});

// An instance whose list is the key's own reads the rest one scope at a time. Dan's own tickets are the first list; the others are read when chosen.
const HELD = { people: [{ id: "dan", name: "Dan Beck", count: 2 }, { id: "ana", name: "Ana Ruiz", count: 2 }, { id: "ben", name: "Ben Park", count: 1 }], unassigned: 3, total: 8 };
const OWN = ASSIGNED.filter((t) => (t as { assignee?: { id: string } | null }).assignee?.id === "dan");
const ON_DEMAND = { viewer: DAN, pickDefault: "you", scopes: true };

test("on demand: the chips list everyone who holds the tickets, but count only a scope the page has read, from the chosen project's tickets", async () => {
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, held: HELD });
  assert.deepEqual(p.shownKeys(), ["M-1", "M-4"]);
  assert.deepEqual(assigneeChips(p), [
    ["Dan Beck (you)", "2", "true"], ["Anyone", "none", "false"], ["Unassigned", "none", "false"], ["Ana Ruiz", "none", "false"], ["Ben Park", "none", "false"],
  ], "the people are the instance's, and nothing is counted from the instance's totals");
});

test("on demand: until the instance says who holds the tickets, only the signed-in person's chip has a count, and a scope is counted once it is read", async () => {
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, hold: { "/api/people": HELD } });
  const counts = () => p.$("assignees").children.filter((c) => c.tag === "button").map((c) => [c.children[0].text(), c.children[1]?.text() ?? "none"]);
  assert.deepEqual(counts(), [["Dan Beck (you)", "2"], ["Anyone", "none"], ["Unassigned", "none"]]);
  p.release();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(counts(), [["Dan Beck (you)", "2"], ["Anyone", "none"], ["Unassigned", "none"], ["Ana Ruiz", "none"], ["Ben Park", "none"]],
    "who holds the rest adds their chips, and none is counted until its scope is read");
});

test("on demand: choosing another person reads their tickets, which join the list, and choosing them again reads nothing", async () => {
  const ana = ASSIGNED.filter((t) => (t as { assignee?: { id: string } | null }).assignee?.id === "ana");
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, held: HELD, scoped: { "assignee=ana": { tickets: ana, next: null } } });
  p.chip("Ana Ruiz", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(p.shownKeys(), ["M-2", "M-6"]);
  assert.equal(p.$("loaded").textContent, "2 of 2 assigned to Ana Ruiz shown, 0 selected");
  assert.ok(p.requested.some((r) => r.endsWith("/api/tickets?assignee=ana")));
  p.chip("Dan Beck (you)", "assignees").fire("click");
  p.chip("Ana Ruiz", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(p.requested.filter((r) => r.endsWith("/api/tickets?assignee=ana")).length, 1, "a scope read once is not read again");
});

test("on demand: Unassigned is read a page at a time, each page joining the list as it arrives, and the cursor of one asks for the next", async () => {
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, held: HELD, scoped: {
    "assignee=unassigned": { tickets: [ticketIn("U-1", { assignee: null }), ticketIn("U-2", { assignee: null })], next: "c1" },
    "assignee=unassigned&after=c1": { tickets: [ticketIn("U-3", { assignee: null })], next: null },
  } });
  p.chip("Unassigned", "assignees").fire("click");
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual([...p.shownKeys()].sort(), ["U-1", "U-2", "U-3"]);
  assert.ok(p.requested.some((r) => r.endsWith("/api/tickets?assignee=unassigned&after=c1")));
});

test("on demand: Anyone covers every scope, so a person chosen after it is not read on their own", async () => {
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, held: HELD, scoped: { "assignee=anyone": { tickets: ASSIGNED, next: null } } });
  p.chip("Anyone", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  p.chip("Ana Ruiz", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(p.shownKeys(), ["M-2", "M-6"]);
  assert.equal(p.requested.some((r) => r.endsWith("assignee=ana")), false);
});

test("on demand: an instance that does not say so is read as before, from the one list, with no request for a person", async () => {
  const p = await page(new Map(), { tickets: ASSIGNED, config: WITH_ASSIGNEES });
  p.chip("Ana Ruiz", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(p.requested.some((r) => r.includes("assignee=")), false);
  assert.equal(p.requested.some((r) => r.endsWith("/api/people")), false);
});

test("on demand: choosing the same scope again while it is being read does not read it twice", async () => {
  const ana = ASSIGNED.filter((t) => (t as { assignee?: { id: string } | null }).assignee?.id === "ana");
  const p = await page(new Map(), { tickets: OWN, config: ON_DEMAND, held: HELD, scoped: { "assignee=ana": { tickets: ana, next: null } } });
  p.chip("Ana Ruiz", "assignees").fire("click");
  p.chip("Ana Ruiz", "assignees").fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(p.requested.filter((r) => r.endsWith("/api/tickets?assignee=ana")).length, 1);
});

test("preflight: the page says no run starts while a host's check fails, naming the check and what it printed, and says nothing while none does", async () => {
  const calm = await page(new Map());
  assert.equal(calm.$("held").hidden, true);
  const held = await page(new Map(), { queueHeld: { name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 5 } });
  assert.equal(held.$("held").hidden, false);
  assert.equal(held.$("held").textContent, "No run starts while fontawesome login fails: EXPIRED: run assume repo-resources");
});

test("preflight: the reason is shown as text, never as markup", async () => {
  const held = await page(new Map(), { queueHeld: { name: "x", reason: "<img src=x onerror=alert(1)>", since: 5 } });
  assert.equal(held.$("held").textContent.includes("<img src=x onerror=alert(1)>"), true);
  assert.equal(held.$("held").children.length, 0, "set as text, so it holds no element");
});

/** What an instance's Settings page reads: one group with a key, a refused file, a note and a plugin that does not load. */
const DESCRIBED = {
  refusals: [{ file: "host.json (tickets)", message: "ticket mode: `tickets.drafts` in the host file must be true or false, not \"yes\"" }],
  notes: ["This machine declares no project: its host file names no primary, so no project.json is read."],
  groups: [
    { group: "Workers", rows: [{ key: "tickets.max", file: "host.json", group: "Workers", value: "3", state: "default", source: "built-in default", explanation: "How many workers run at once.", breaks: "Too high starts more workers than the machine carries.", depth: 0, secret: false }] },
    { group: "Pick", rows: [{ key: "tickets.linearKey.path", file: "host.json", group: "Pick", value: "/k/linear.key (the file is missing)", state: "enabled", source: "host.json", explanation: "The file the tracker's key is in.", breaks: "The board cannot read the tracker.", depth: 2, secret: true }] },
    { group: "Conventions plugin", rows: [] },
  ],
  plugins: [{ plugin: "nbl-ui@applied-ai", installed: "not installed", loads: "a worker's session does not load it: nbl-ui@applied-ai is not installed: install it for every folder" }],
  words: ["A worker may call any tool of the connector `linear` whose name matches `^mcp__linear__`."],
};

test("Settings is a page at its own address: the dialog is gone, the three ways in open it, and the way back returns to the board", async () => {
  const html = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<dialog id="settings"/, "the dialog is removed");
  assert.match(html, /<nav class="bar" aria-label="Settings">\s*<a href="#" id="back-to-board">Back to the board<\/a>/, "a way back to the board is on the page");
  for (const button of ["open-settings", "change-choice", "change-max"]) {
    const p = await page(new Map(), { config: SETTINGS, settings: DESCRIBED });
    await openFrom(p, button);
    assert.equal(p.location.hash, "#/settings", `${button} opens the page at its own address`);
    assert.equal(p.$("settings-page").hidden, false);
    assert.equal(p.$("pick").hidden, true, "the board is not shown beside it");
    p.location.hash = "";
    await p.hashChange();
    assert.equal(p.$("settings-page").hidden, true, `${button}: the way back closes it`);
    assert.equal(p.$("pick").hidden, false, "and the Pick board is back");
  }
});

test("the page draws what each key says, in its group, with its state and source in words, and the refused file as its message", async () => {
  const p = await page(new Map(), { config: SETTINGS, settings: DESCRIBED });
  await openFrom(p, "open-settings");
  const headings = p.$("settings-groups").all().filter((n) => n.tag === "h3").map((n) => n.text());
  assert.deepEqual(headings, ["Plugins", "Workers", "Pick", "Conventions plugin"], "the Plugins section first, then one heading per group, in the page's order");
  const text = p.$("settings-groups").text();
  assert.match(text, /tickets\.max[\s\S]*Value: 3\. State: default\. Source: built-in default\./);
  assert.match(text, /tickets\.linearKey\.path[\s\S]*Value: \/k\/linear\.key \(the file is missing\)\. State: enabled\. Source: host\.json\./, "a secret path shows its path and whether the file exists");
  assert.match(text, /nbl-ui@applied-ai: not installed; a worker's session does not load it/, "a plugin says whether a worker's session loads it");
  assert.match(text, /A worker may call any tool of the connector `linear`/, "a connector is said in words");
  assert.equal(p.$("settings-refusals").hidden, false);
  assert.match(p.$("settings-refusals").text(), /tickets\.drafts/, "the refusal names the field");
  assert.match(p.$("settings-notes").text(), /declares no project/, "a machine with no project says so, plainly");
  assert.equal(p.$("max").value, "3", "the controls keep what is saved");
});

test("an instance older than this page cannot describe its settings, and says so; its controls still change what is saved", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/settings"], errors: { "/api/settings": "no route GET /api/settings" } });
  await openFrom(p, "open-settings");
  assert.match(p.$("settings-notes").text(), /older than this page and cannot describe its settings/);
  await change(p, "max", "5");
  assert.deepEqual(p.posts.at(-1), { path: "/api/max", body: { max: 5 } }, "the controls work without the new route");
});

/** A plugin that does not meet the host's keys, as the server's check gives its rows: one for a connector the host does not allow, one for a skill it does not provide. */
const MISMATCHED = { ...DESCRIBED, contract: [
  { plugin: "a11ign@a11ign-local", kind: "connector-need", why: "a11ign@a11ign-local needs the connector tools matched by ^mcp__linear__get_, which tickets.connectors does not allow: add the pattern to tickets.connectors." },
  { plugin: "a11ign@a11ign-local", kind: "skill-not-provided", why: "tickets.writer.run names a11ign:write, which a11ign@a11ign-local does not provide as its writer skill: name a skill it provides, or remove the key." },
] };

test("each contract mismatch is a row in the Plugins section, naming the plugin and the key, under a label that says what the rows are", async () => {
  const p = await page(new Map(), { config: SETTINGS, settings: MISMATCHED });
  await openFrom(p, "open-settings");
  const nodes = p.$("settings-groups").all();
  const label = nodes.find((n) => n.tag === "p" && n.text().startsWith("Contract mismatches: what a plugin declares"));
  const list = nodes.find((n) => n.tag === "ul" && n.attrs["aria-labelledby"] !== undefined);
  assert.ok(label, "a label says in words what the rows are");
  assert.equal(list?.attrs["aria-labelledby"], (label as Node_ & { id: string }).id, "the rows are a list tied to that label");
  const [connector, skill] = list!.children.map((row) => row.text());
  assert.equal(list!.children.length, 2, "one row per mismatch");
  assert.match(connector, /^Mismatch: a11ign@a11ign-local needs .* tickets\.connectors/, "a connector row names the plugin and the key");
  assert.match(skill, /^Mismatch: tickets\.writer\.run names a11ign:write, which a11ign@a11ign-local does not provide/, "a skill row names the key and the plugin");
});

test("a plugin with no contract rows, and an instance that sends none, show no label and no row, and the plugin lines are as before", async () => {
  for (const settings of [{ ...DESCRIBED, contract: [] }, DESCRIBED]) {
    const p = await page(new Map(), { config: SETTINGS, settings });
    await openFrom(p, "open-settings");
    const nodes = p.$("settings-groups").all();
    assert.equal(nodes.some((n) => n.attrs["aria-labelledby"] === "contract-label"), false, "no label for the rows");
    assert.doesNotMatch(p.$("settings-groups").text(), /Mismatch|Contract mismatches/);
    assert.match(p.$("settings-groups").text(), /nbl-ui@applied-ai: not installed; a worker's session does not load it/, "the plugin line is as before");
  }
});

test("the page shows the instance it is showing: an answer that arrives after another instance is chosen is not drawn", async () => {
  const LOCAL_ANSWER = { ...DESCRIBED, contract: [], refusals: [], notes: [], plugins: [], words: [], groups: [{ group: "Workers", rows: [{ key: "LOCAL-ONLY", file: "host.json", group: "Workers", value: "1", state: "enabled", source: "host.json", explanation: "x", breaks: "y", depth: 0, secret: false }] }] };
  const p = await page(new Map(), { config: SETTINGS, settings: DESCRIBED, connections: { connections: [{ name: "local", kind: "local" }, { name: "other", kind: "ssh", ssh: "other" }], refusal: null },
    hold: { "/c/local/api/settings": LOCAL_ANSWER } });
  await openFrom(p, "open-settings");
  await chooseInstance(p, "other");
  p.release();
  await settle();
  assert.equal(p.$("settings-groups").text().includes("LOCAL-ONLY"), false, "the first instance's answer is dropped");
  assert.match(p.$("settings-groups").text(), /tickets\.max/, "the instance chosen is what is drawn");
});

test("the Settings page has its landmarks and headings, every control has its label, and nothing is a click on a box that is not a control", () => {
  const html = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  const section = html.slice(html.indexOf('<section id="settings-page"'), html.indexOf('</main>'));
  assert.match(html, /<main>[\s\S]*<section id="settings-page"[\s\S]*<\/main>/, "the page is in main");
  assert.match(section, /<h2 id="settings-title" tabindex="-1">Settings<\/h2>/, "its heading names it");
  const controls = section.split("\n").filter((line) => /<(select|input)\b/.test(line));
  assert.ok(controls.length >= 5, "the controls are on the page");
  for (const line of controls) assert.match(line, /<label(?: class="[^"]*")?>[^<]*<(select|input)\b/, `a control is labelled by its wrapping label: ${line.trim()}`);
  assert.doesNotMatch(html, /onclick=|role="button"/, "the page uses native controls only");
  assert.match(html, /aria-labelledby", id\)|setAttribute\("aria-labelledby"/, "each group names its heading");
});

test("a settings read that fails for another reason says what failed, and does not call the instance older", async () => {
  const p = await page(new Map(), { config: SETTINGS, refused: ["/api/settings"], errors: { "/api/settings": "Linear could not be reached" } });
  await openFrom(p, "open-settings");
  assert.match(p.$("settings-notes").text(), /could not be read: Linear could not be reached/);
  assert.doesNotMatch(p.$("settings-notes").text(), /older than this page/);
});

test("a refused change answered after another instance is chosen is not said on the page, which now shows the other instance", async () => {
  const p = await page(new Map(), { config: SETTINGS, connections: { connections: [{ name: "local", kind: "local" }, { name: "other", kind: "ssh", ssh: "other" }], refusal: null },
    refused: ["/c/local/api/choice"], errors: { "/c/local/api/choice": "/api/choice refused" }, hold: { "/c/local/api/choice": { error: "x" } } });
  await openFrom(p, "open-settings");
  p.$("model").value = "sonnet";
  p.$("model").fire("change");
  await settle();
  await chooseInstance(p, "other");
  p.release();
  await settle();
  assert.equal(p.$("settings-status").textContent.includes("another instance was chosen"), false, "the stale refusal is not drawn");
});

test("Back to the board returns to the card the board was showing, and focus goes back to the control that opened Settings", async () => {
  const p = await page(new Map(), { config: SETTINGS, hash: "#card-7" });
  await openFrom(p, "change-max");
  assert.equal(p.$("back-to-board").attrs.href, "#card-7", "Back names the card the board was on");
  p.location.hash = "";
  await p.hashChange();
  assert.equal(p.$("change-max").attrs.focused, "true", "focus is back on Change, which opened the page");
});

/** A row as the page's view gives it: its key, group and words, and whether the page changes it in place (`editable`, with its `input`, else `why`). */
const SHOWN = (row: { key: string; group: string; explanation: string } & Record<string, unknown>) => ({ file: "host.json", value: "x", state: "enabled", source: "host.json",
  breaks: `what breaks ${row.key}`, depth: 0, secret: false, input: null, raw: null, editable: false, why: null, alias: null, inUse: true, nest: null, ...row });
/** Settings in four sections, as a provider's keys sit among the machine's: Tracker and Exposure hold a provider each, Workers holds a key that is not one, and Machine holds the plumbing. */
const GROUPED = {
  refusals: [], notes: [], plugins: [], words: [], contract: [],
  groups: [
    { group: "Tracker", rows: [
      SHOWN({ key: "tickets.providers.tracker.provider", group: "Tracker", explanation: "The tracker's provider.", value: "linear", state: "default", source: "built-in default",
        why: "choosing or switching a provider goes through agent-org onboard" }),
      SHOWN({ key: "tickets.providers.tracker.key.path", group: "Tracker", explanation: "The file the tracker's key is in.", value: "/k/linear.key (the file is missing)", secret: true, input: "text", raw: "/k/linear.key", editable: true, why: null }),
    ] },
    { group: "Exposure", rows: [
      SHOWN({ key: "tickets.providers.exposure.port", group: "Exposure", explanation: "The loopback port the instance listens on.", value: "4747", state: "default", source: "built-in default", input: "number", raw: "4747", editable: true, why: null }),
      SHOWN({ key: "tickets.port", group: "Exposure", explanation: "The loopback port the instance listens on.", value: "4747", state: "enabled", source: "host.json", alias: "Alias of tickets.providers.exposure.port: run agent-org doctor --fix",
        why: "an alias; move it with agent-org doctor --fix, to tickets.providers.exposure.port" }),
    ] },
    { group: "Workers", rows: [SHOWN({ key: "tickets.stallMinutes", group: "Workers", explanation: "How long a run may be silent before it is stalled.", value: "20" })] },
    { group: "Machine", rows: [SHOWN({ key: "binDir", group: "Machine", explanation: "The folder the routing gh is installed in.", value: "/home/a/.local/bin" })] },
  ],
};

/** Each section on the Settings page: its name, whether it is open, and its node. */
const sectionsOf = (p: Page) => p.$("settings-groups").all().filter((n) => n.tag === "details" && n.className === "setting-group" && !n.hidden)
  .map((section) => ({ name: section.all().find((n) => n.tag === "h3")!.text(), open: section.open, node: section }));
/** The section named `name`, as the page draws it now. */
const sectionNamed = (p: Page, name: string) => sectionsOf(p).find((section) => section.name === name)!;
/** A person opens a section by its summary, which the browser reports as a toggle. */
const openSection = (p: Page, name: string) => toggle(sectionNamed(p, name), true);
/** A person opens or closes a section, which the browser reports as a toggle. */
const toggle = (section: { node: Node_ }, open: boolean) => { section.node.open = open; section.node.fire("toggle"); };
/** Type `query` into the Settings search, and let the page show what it leaves. */
async function search(p: Page, query: string) {
  p.$("settings-search").value = query;
  p.$("settings-search").fire("input");
  await settleAll();
}
/** Whether a node is drawn: it is not hidden, and no ancestor is hidden or a closed disclosure. */
const drawn = (node: Node_): boolean => {
  if (node.hidden) return false;
  if (node.parent === null) return true;
  return (node.parent.tag !== "details" || node.parent.open) && drawn(node.parent);
};
/** A section's count, which the summary says after its name and provider: the words that count the settings, not the provider. */
const countWords = (section: Node_) => section.all().filter((n) => n.tag === "span").map((n) => n.text()).find((text) => /setting|set,/.test(text))!;
/** The keys of the rows in a section that are drawn, in the order the page draws them. */
const rowsIn = (section: Node_) => section.all().filter((n) => n.tag === "dl" && drawn(n)).map((n) => n.all().find((c) => c.tag === "code")!.text());

/** The text a person sees: a closed Details shows its summary and nothing under it, and a hidden node shows nothing. */
const visibleText = (node: Node_): string => node.hidden ? "" : node.tag === "details" && !node.open
  ? node.children.filter((child) => child.tag === "summary").map((child) => child.text()).join("")
  : node.textContent + node.children.map(visibleText).join("");

test("Settings: every section starts closed to its summary line, in the page's order, and the summary names the provider and counts what is set", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  assert.deepEqual(sectionsOf(p).map((section) => [section.name, section.open]), [["Tracker", false], ["Exposure", false], ["Workers", false], ["Machine", false]]);
  const summary = sectionNamed(p, "Tracker").node.all().find((n) => n.tag === "summary")!.all().filter((n) => n.tag === "span").map((n) => n.text());
  assert.deepEqual(summary, ["provider linear", "2 settings"], "the summary names the provider and counts the settings drawn");
});

test("Settings: a section a person opens or closes is remembered in this browser, and a new page in the same browser shows it as it was left", async () => {
  const storage = new Map<string, string>();
  const p = await page(storage, { config: SETTINGS, settings: GROUPED });
  await openFrom(p, "open-settings");
  openSection(p, "Machine");
  openSection(p, "Exposure");
  toggle(sectionNamed(p, "Exposure"), false);
  p.location.hash = "#/settings";
  await p.hashChange();
  assert.deepEqual(sectionsOf(p).map((section) => [section.name, section.open]), [["Tracker", false], ["Exposure", false], ["Workers", false], ["Machine", true]], "a redraw keeps what the person left");
  const again = await page(storage, { config: SETTINGS, settings: GROUPED });
  await openFrom(again, "open-settings");
  assert.deepEqual(sectionsOf(again).map((section) => [section.name, section.open]), [["Tracker", false], ["Exposure", false], ["Workers", false], ["Machine", true]], "a new page in this browser starts as it was left");
});

test("Settings: a search shows only the sections with a match, opened, with the match's count; clearing it restores each section as the person left it", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  openSection(p, "Tracker");
  await search(p, "port");
  assert.deepEqual(sectionsOf(p).map((section) => [section.name, section.open]), [["Exposure", true]], "sections with no match are not drawn, and the one with a match is open");
  assert.deepEqual(rowsIn(sectionNamed(p, "Exposure").node), ["tickets.providers.exposure.port", "tickets.port"], "every match is shown, and nothing else");
  assert.equal(p.$("settings-search-status").textContent, "2 settings match");
  await search(p, "binDir");
  assert.equal(p.$("settings-search-status").textContent, "1 setting matches");
  assert.deepEqual(sectionsOf(p).map((section) => section.name), ["Machine"], "Machine is reachable by search even though it starts closed");
  assert.equal(sectionNamed(p, "Machine").open, true, "a section with a match is opened");
  await search(p, "zzz");
  assert.equal(p.$("settings-search-status").textContent, "No setting matches");
  assert.deepEqual(sectionsOf(p), []);
  await search(p, "");
  assert.equal(p.$("settings-search-status").textContent, "");
  assert.deepEqual(sectionsOf(p).map((section) => [section.name, section.open]), [["Tracker", true], ["Exposure", false], ["Workers", false], ["Machine", false]],
    "clearing restores each section to what the person left: Tracker, which they opened, is open");
});

test("Settings: a search does not change what the person left open, so a redraw after it is as the person left it", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  await search(p, "port");
  await search(p, "");
  p.location.hash = "#/settings";
  await p.hashChange();
  assert.equal(sectionNamed(p, "Machine").open, false, "Machine is closed as it was before the search");
});

test("Settings: a row says Editable or Read-only, what the key does and what breaks are behind its Details, and a read-only key's reason is there too", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  const port = rowOf(p, "tickets.providers.exposure.port");
  assert.match(port.text(), /Value: 4747\. State: default\. Source: built-in default\. Editable\./);
  const alias = rowOf(p, "tickets.port");
  assert.match(alias.text(), /Alias of tickets\.providers\.exposure\.port: run agent-org doctor --fix\. State: enabled\. Source: host\.json\. Read-only\./, "an alias says where its key is in place of its value");
  assert.doesNotMatch(alias.text(), /Value: 4747/, "its value text is replaced");
  const provider = rowOf(p, "tickets.providers.tracker.provider");
  assert.match(provider.text(), /Change the provider with the Plugins section or agent-org plugin/, "a provider's row says where it is changed");
  assert.equal(visibleText(p.$("settings-groups")).includes("The loopback port the instance listens on."), false, "the explanation is not visible until Details opens");
  assert.equal(visibleText(p.$("settings-groups")).includes("If it is wrong"), false, "nor is what breaks");
  const details = alias.all().find((n) => n.tag === "details")!;
  details.open = true;
  assert.match(visibleText(alias), /The loopback port the instance listens on\.[\s\S]*If it is wrong: what breaks tickets\.port[\s\S]*Read-only: an alias; move it with agent-org doctor --fix, to tickets\.providers\.exposure\.port\./,
    "opened, the explanation, what breaks and the reason read-only are all there");
});

test("Settings: a search leaves an open Edit form and the value typed into it as they were, and a Details that is open stays open", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  const row = rowOf(p, "tickets.providers.exposure.port");
  buttonIn(row, "Edit").fire("click");
  row.all().find((n) => n.tag === "input")!.value = "5000";
  row.all().find((n) => n.tag === "details")!.open = true;
  await search(p, "port");
  await search(p, "");
  const again = rowOf(p, "tickets.providers.exposure.port");
  assert.equal(again, row, "the row is the one that was drawn, not a new one");
  assert.equal(again.all().find((n) => n.tag === "input")!.value, "5000", "the value typed is still there");
  assert.equal(again.all().find((n) => n.tag === "form" || n.className === "edit-form")!.hidden, false, "the Edit form is still open");
  assert.equal(again.all().find((n) => n.tag === "details")!.open, true, "the Details is still open");
});

test("Settings: the plugins' checks stay on the page during a search, and a search that leaves no setting still shows them", async () => {
  const withChecks = { ...GROUPED, groups: [...GROUPED.groups, { group: "Conventions plugin", rows: [] }],
    plugins: [{ plugin: "a11ign@a11ign-local", installed: "not installed", loads: "a worker's session does not load it" }],
    contract: [{ plugin: "a11ign@a11ign-local", kind: "connector-need", why: "needs the connector tools matched by ^mcp__linear__get_, which tickets.connectors does not allow" }] };
  const p = await settingsPage({ config: SETTINGS, settings: withChecks });
  await search(p, "zzz");
  assert.deepEqual(sectionsOf(p).map((section) => section.name), ["Conventions plugin"], "no setting matches, and the plugins' section is still there");
  assert.match(sectionNamed(p, "Conventions plugin").node.text(), /Mismatch: needs the connector tools/, "its check is said");
  assert.match(sectionNamed(p, "Conventions plugin").node.text(), /a11ign@a11ign-local: not installed/, "its plugin line is said");
});

test("Settings: a key that is not in use is hidden, and a search finds it and shows it", async () => {
  const withApp = { ...GROUPED, groups: [...GROUPED.groups.slice(0, 2),
    { group: "Code host", rows: [SHOWN({ key: "tickets.providers.codeHost.identity.scheduler.mode", group: "Code host", explanation: "Whether the role acts as the person's account.", value: "user-accounts", state: "enabled", source: "host.json" }),
      SHOWN({ key: "tickets.providers.codeHost.identity.scheduler.appId", group: "Code host", explanation: "The App's id. Required with github-apps.", inUse: false })] }] };
  const p = await settingsPage({ config: SETTINGS, settings: withApp });
  openSection(p, "Code host");
  assert.deepEqual(rowsIn(sectionNamed(p, "Code host").node), ["tickets.providers.codeHost.identity.scheduler.mode"], "the App's id is not drawn");
  assert.equal(countWords(sectionNamed(p, "Code host").node), "1 setting", "the count is what is drawn");
  await search(p, "app");
  assert.deepEqual(rowsIn(sectionNamed(p, "Code host").node), ["tickets.providers.codeHost.identity.scheduler.appId"], "a search finds it");
  assert.equal(p.$("settings-search-status").textContent, "1 setting matches");
});

test("Settings: a role's settings sit in a disclosure under the role, closed until a person opens it or a search finds one of them", async () => {
  const roleFixture = { ...GROUPED, groups: [...GROUPED.groups.slice(0, 2),
    { group: "Code host", rows: [
      SHOWN({ key: "tickets.providers.codeHost.identity.scheduler", group: "Code host", explanation: "One role's identity.", value: "user-accounts", state: "enabled", source: "host.json" }),
      SHOWN({ key: "tickets.providers.codeHost.identity.scheduler.mode", group: "Code host", explanation: "Whether the role acts as the person's account.", value: "user-accounts", state: "enabled", source: "host.json", nest: "tickets.providers.codeHost.identity.scheduler" }),
      SHOWN({ key: "tickets.providers.codeHost.identity.scheduler.appId", group: "Code host", explanation: "The App's id. Required with github-apps.", inUse: false, nest: "tickets.providers.codeHost.identity.scheduler" }),
    ] }] };
  const p = await settingsPage({ config: SETTINGS, settings: roleFixture });
  openSection(p, "Code host");
  assert.deepEqual(rowsIn(sectionNamed(p, "Code host").node), ["tickets.providers.codeHost.identity.scheduler"], "the role is drawn; its settings are not, while the disclosure is closed");
  const nested = sectionNamed(p, "Code host").node.all().find((n) => n.tag === "details" && n.className === "setting-nested")!;
  assert.equal(nested.all().find((n) => n.tag === "summary")!.text(), "1 setting", "the disclosure says how many settings it holds that are drawn");
  await search(p, "acts as");
  assert.deepEqual(rowsIn(sectionNamed(p, "Code host").node), ["tickets.providers.codeHost.identity.scheduler", "tickets.providers.codeHost.identity.scheduler.mode"], "a search opens the disclosure and shows the match");
  await search(p, "");
  assert.deepEqual(rowsIn(sectionNamed(p, "Code host").node), ["tickets.providers.codeHost.identity.scheduler"], "clearing the search closes it again, as the person left it");
});

/** The Show settings at their defaults checkbox, set and changed as a person does. */
async function showDefaults(p: Page, on: boolean) {
  p.$("settings-all").checked = on;
  p.$("settings-all").fire("change");
  await settleAll();
}

test("Settings: a setting at its default is not drawn until the defaults are asked for, and a search or the checkbox draws it", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  openSection(p, "Exposure");
  openSection(p, "Tracker");
  // GROUPED's Exposure port is at its default, and Tracker's provider line is always drawn.
  assert.deepEqual(rowsIn(sectionNamed(p, "Exposure").node), ["tickets.port"], "the set alias is drawn, and the default port is not");
  assert.equal(countWords(sectionNamed(p, "Exposure").node), "1 set, 1 at defaults", "the summary says what is set and what is at its defaults");
  assert.deepEqual(rowsIn(sectionNamed(p, "Tracker").node), ["tickets.providers.tracker.provider", "tickets.providers.tracker.key.path"], "a provider's line and a set setting are drawn");
  await showDefaults(p, true);
  assert.ok(rowsIn(sectionNamed(p, "Exposure").node).includes("tickets.providers.exposure.port"), "the checkbox draws the defaults");
  assert.equal(countWords(sectionNamed(p, "Exposure").node), "2 settings", "with the checkbox on, the count is every setting");
  await showDefaults(p, false);
  await search(p, "port");
  assert.ok(rowsIn(sectionNamed(p, "Exposure").node).includes("tickets.providers.exposure.port"), "a search finds a default");
});

test("Settings: an editable row keeps its Edit control, and a read-only row has none", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: GROUPED });
  assert.ok(buttonIn(rowOf(p, "tickets.providers.exposure.port"), "Edit"), "an editable row is edited in place");
  assert.equal(rowOf(p, "tickets.port").all().some((n) => n.tag === "button"), false, "an alias is shown, not changed");
});

/** Settings a local instance can edit: a switch and a number, each with the input its schema entry takes. */
const EDITABLE = {
  refusals: [], notes: [], plugins: [], words: [], contract: [],
  groups: [
    { group: "Publishing", rows: [{ key: "tickets.drafts", file: "host.json", group: "Publishing", value: "true", state: "default", source: "built-in default", explanation: "Whether a worker opens its pull request as a draft.", breaks: "Any value other than true or false is refused by name.", depth: 0, secret: false, input: "boolean", raw: null, editable: true, why: null, alias: null }] },
    { group: "Serving and terminal", rows: [{ key: "tickets.port", file: "host.json", group: "Serving and terminal", value: "4747", state: "default", source: "built-in default", explanation: "The loopback port the instance listens on.", breaks: "A port another program holds stops the instance.", depth: 0, secret: false, input: "number", raw: "4747", editable: true, why: null, alias: null }] },
  ],
};
/** The reader's answer to a preview of `tickets.drafts` set to false: one change, dangerous, in force after the board restarts. */
const PREVIEW = { file: "host.json", base: "b1", note: null, changes: [{ key: "tickets.drafts", old: "true", new: "false", changed: true, applies: "board",
  inForce: "in force after the board restarts: ticket:serve and ticket:ui.", dangerous: "False opens each pull request ready and skips the Approve step, so a run goes straight to review." }] };
const SAVED = { file: "host.json", backup: "/h/host.json.bak", note: null, changes: [{ ...PREVIEW.changes[0], dangerous: null }] };
const RESTORED = { file: "host.json", changes: [{ key: "tickets.drafts", old: "false", new: "true", changed: true, applies: "board", inForce: "in force after the board restarts: ticket:serve and ticket:ui.", dangerous: null }] };
/** The instance's answer to each Settings edit, by its path. */
const EDITS = (path: string) => (path.endsWith("/preview") ? PREVIEW : path.endsWith("/save") ? SAVED : RESTORED);

/** The row of a setting on the Settings page, by its key. */
const rowOf = (p: Page, key: string) => p.$("settings-groups").all().find((n) => n.tag === "dl" && n.all().some((c) => c.tag === "code" && c.text() === key))!;
/** The button in `node` that says `label`. */
const buttonIn = (node: Node_, label: string) => node.all().find((n) => n.tag === "button" && n.text() === label)!;
/** Let the page's fetches and their handlers run, as a person's clicks are let run. */
const flush = async () => { for (let i = 0; i < 10; i++) await settle(); };
/** Stage `value` for `key` on its row: its Edit, the value typed, and Stage change. */
async function stage(p: Page, key: string, value: string) {
  const row = rowOf(p, key);
  buttonIn(row, "Edit").fire("click");
  row.all().find((n) => n.tag === "select" || n.tag === "input")!.value = value;
  buttonIn(row, "Stage change").fire("click");
  await flush();
}
/** Stage `tickets.drafts` as `value` on its row, then review what the file would say. */
async function stageDrafts(p: Page, value: string) {
  await stage(p, "tickets.drafts", value);
  p.$("review-changes").fire("click");
  await flush();
}

test("A11-132: on a local instance a row's Edit stages a change, and Review shows each old and new value and whether it is in force", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS });
  await stageDrafts(p, "false");
  assert.equal(p.$("pending").hidden, false, "the staged change is listed");
  assert.match(p.$("pending-list").text(), /^host\.json tickets\.drafts: true → false/);
  assert.deepEqual(p.posts.at(-1), { path: "/api/settings/preview", body: { file: "host.json", changes: [{ key: "tickets.drafts", value: false }] } });
  assert.match(p.$("review-files").text(), /tickets\.drafts: true → false\. in force after the board restarts: ticket:serve and ticket:ui\./);
  assert.equal(p.posts.some((post) => post.path.endsWith("/save")), false, "reviewing saves nothing");
});

test("A11-132: a change the readers refuse shows the reader's message on the page and writes nothing", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS, refused: ["/api/settings/preview"], errors: { "/api/settings/preview": "tickets.uiPort must differ from tickets.port" } });
  await stageDrafts(p, "false");
  assert.equal(p.$("edit-refusal").hidden, false);
  assert.equal(p.$("edit-refusal").text(), "tickets.uiPort must differ from tickets.port");
  assert.equal(p.posts.some((post) => post.path.endsWith("/save")), false, "nothing is saved");
});

test("A11-132: a dangerous change is saved only by its own button, which names the key and what it can break, and the save names it as confirmed", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS });
  await stageDrafts(p, "false");
  const buttons = p.$("review-files").all().filter((n) => n.tag === "button");
  assert.equal(buttons.length, 1, "one save for the file");
  assert.match(buttons[0].text(), /^Save host\.json with tickets\.drafts, which can break: False opens each pull request ready and skips the Approve step/);
  buttons[0].fire("click");
  await flush();
  assert.deepEqual(p.posts.at(-1), { path: "/api/settings/save", body: { file: "host.json", changes: [{ key: "tickets.drafts", value: false }], base: "b1", confirmed: ["tickets.drafts"] } });
  assert.match(p.$("edit-outcome").text(), /^Saved host\.json\. tickets\.drafts: true → false\. in force after the board restarts/);
  assert.equal(p.$("pending").hidden, true, "what was saved is no longer staged");
});

test("A11-132: Restore puts the backup back, says what it changed, and reads the file as it now is", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS });
  const reads = p.requested.filter((path) => path === "/api/settings").length;
  buttonIn(p.$("restores"), "Restore the backup of host.json").fire("click");
  await flush();
  assert.equal(p.posts.at(-1)?.path, "/api/settings/restore");
  assert.equal(p.$("edit-outcome").text(), "Restored host.json from its backup. tickets.drafts: false → true. in force after the board restarts: ticket:serve and ticket:ui.");
  assert.equal(p.requested.filter((path) => path === "/api/settings").length, reads + 1, "the page reads the file again");
});

test("A11-132: a remote instance offers no edit and says why in one sentence, and what is staged for one instance is cleared when another is chosen", async () => {
  const p = await settingsPage({ connections: WORK_AND_PERSONAL, config: SETTINGS, settings: EDITABLE, edits: EDITS });
  await stageDrafts(p, "false");
  assert.equal(p.$("pending").hidden, false, "a change is staged on this instance");
  await chooseInstance(p, "personal");
  assert.equal(p.$("pending").hidden, true, "the staged change is gone");
  assert.equal(p.$("settings-groups").all().some((n) => n.tag === "button" && n.text() === "Edit"), false, "no Edit on a remote instance");
  assert.match(p.$("edit-note").text(), /This instance is .+\. Its files are changed on that machine, so this page offers no edit here\./);
  assert.equal(p.$("restores").all().some((n) => n.tag === "button"), false, "no Restore on a remote instance");
});

test("A11-132: a number the page cannot read is said on its row, and nothing is sent", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS });
  const row = rowOf(p, "tickets.port");
  buttonIn(row, "Edit").fire("click");
  row.all().find((n) => n.tag === "input")!.value = "abc";
  buttonIn(row, "Stage change").fire("click");
  await flush();
  const problem = row.all().find((n) => n.tag === "p" && n.className === "notice")!;
  assert.equal(problem.hidden, false);
  assert.equal(problem.text(), "tickets.port needs a number");
  assert.equal(p.posts.length, 0, "nothing is sent");
});

test("A11-132: a review read while another change is staged is not shown, so a save never sends a change that was not reviewed", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS, hold: { "/api/settings/preview": PREVIEW } });
  await stage(p, "tickets.drafts", "false");
  p.$("review-changes").fire("click");
  await stage(p, "tickets.port", "5000");
  p.release();
  await flush();
  assert.equal(p.$("review").hidden, true, "the stale review is not shown");
  assert.equal(p.$("pending").hidden, false, "both changes are still staged");
  assert.equal(p.posts.some((post) => post.path.endsWith("/save")), false);
});

test("A11-132: when another instance's settings cannot be read, nothing staged or restorable for the instance left stays on the page", async () => {
  const p = await settingsPage({ connections: WORK_AND_PERSONAL, config: SETTINGS, settings: EDITABLE, edits: EDITS, refused: ["/c/personal/api/settings"] });
  await stage(p, "tickets.drafts", "false");
  assert.equal(p.$("pending").hidden, false, "a change is staged on this instance");
  await chooseInstance(p, "personal");
  assert.equal(p.$("edit-panel").hidden, true, "the panel is gone with the instance's settings");
  assert.equal(p.$("pending-list").all().some((n) => n.tag === "li"), false, "nothing staged is listed");
  assert.equal(p.$("restores").all().some((n) => n.tag === "button"), false, "no Restore for the instance the page left");
});

test("A11-134: a ticket with an open decision shows Needs a decision with its reason, its Select is disabled, and Grill starts the grill on it", async () => {
  const reason = 'An open decision is still in acceptance: "- Decide whether it sorts.". Grill it to settle the decision before it is queued.';
  const p = await page(new Map(), { config: WRITER_CONFIG, tickets: [ticketIn("D-1", { needsDecision: { kind: "decision", reason } }), ticketIn("T-1")] });
  const row = rowFor(p, "D-1");
  const pill = row.all().find((n) => n.className === "pill" && n.textContent === view_0.NEEDS_DECISION) as (Node_ & { title?: string }) | undefined;
  assert.equal(pill?.title, reason, "the pill's title is the reason, naming the open line");
  assert.equal(tickOf(p, "D-1").disabled, true, "its Select is disabled");
  assert.equal(tickOf(p, "T-1").disabled, false);
  const grill = row.all().find((n) => n.tag === "button" && n.textContent === view_0.GRILL)!;
  assert.equal(grill.disabled, false);
  grill.fire("click");
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(p.posts.filter((x) => x.path === "/api/grill-ticket").map((x) => x.body), [{ key: "D-1" }]);
});

test("A11-134: Grill is disabled with its reason on a machine with no terminal, and no pill or Grill shows on a ticket that can be queued", async () => {
  const p = await page(new Map(), { config: { ...WRITER_CONFIG, writerGrill: false }, tickets: [ticketIn("D-1", { needsDecision: { kind: "behaviour", reason: "It changes a screen." } }), ticketIn("T-1")] });
  const grill = rowFor(p, "D-1").all().find((n) => n.tag === "button" && n.textContent === view_0.GRILL)!;
  assert.equal(grill.disabled, true);
  assert.equal(grill.title, "Grill needs a terminal: name tickets.terminal in the host file");
  assert.equal(rowFor(p, "T-1").all().some((n) => n.textContent === view_0.GRILL || n.textContent === view_0.NEEDS_DECISION), false);
});

test("every action on a run is an icon with a tooltip and its words kept for a screen reader, and Talk to it goes to the board", async () => {
  const p = await page(new Map(), { entries: [entry("D-1", { phase: "finished", startedAt: 2, finishedAt: 5, outcome: { kind: "draft-pr", prs: SHIPPED } })] });
  const buttons = runRows(p).find((r) => r.text().includes("D-1"))!.all().filter((n) => n.tag === "button") as (Node_ & { title?: string })[];
  assert.deepEqual(buttons.map((b) => b.text()), ["Approve", "Talk to it", "Dismiss"]);
  for (const button of buttons) {
    assert.ok(button.className.split(" ").includes("icon-btn"), `${button.text()} is an icon button`);
    assert.ok((button.title ?? "") !== "", `${button.text()} says what it does on hover`);
    assert.ok(button.all().some((n) => n.className === "action-icon"), `${button.text()} has its icon`);
    assert.ok(button.all().some((n) => n.className === "sr-only" && n.text() === button.text()), `${button.text()} keeps its words for a screen reader`);
  }
  assert.match(buttons[1].title ?? "", /^Open this run's own session in a terminal/);
  buttons[1].fire("click");
  assert.ok(p.posts.some(({ path }) => path.endsWith("/api/queue/D-1/talk")), "Talk to it goes to the board");
  const link = runRows(p).find((r) => r.text().includes("D-1"))!.all().find((n) => n.tag === "a" && n.className === "pr-link") as (Node_ & { title?: string }) | undefined;
  assert.match(link?.title ?? "", /on GitHub$/, "a pull request is an icon link to GitHub");
});

test("Settings: the Changes panel is drawn only while it has something in it, and the restore buttons sit with the controls below the sections", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: EDITABLE, edits: EDITS });
  assert.equal(p.$("edit-panel").hidden, true, "with nothing staged, saved or refused, the panel is not drawn");
  assert.equal(p.$("restores").children.length, 1, "the restore buttons are still on the page");
  await stage(p, "tickets.drafts", "false");
  assert.equal(p.$("edit-panel").hidden, false, "a staged change draws the panel, where it is reviewed");
  assert.equal(p.$("restores").children.length, 1, "and the restore buttons stay below the sections");
});

// ---- A11-163: the Settings page's Plugins section

type FixturePlugin = Record<string, any>;
/** A plugin's entry as `GET /api/plugins` sends it (plugins/health.ts): the fields the page draws. */
const plugin = (name: string, over: FixturePlugin = {}): FixturePlugin => ({ name, concern: "tracker", version: "v1.2.3", contract: "1.1", where: `plugins/${name}`, description: `${name} does its work.`, state: "enabled", installed: true,
  enabled: true, checks: [], failure: null, controls: { offered: ["disable", "uninstall", "configure"], refused: {}, confirm: { uninstall: `Uninstall ${name}? Its block is removed.` } }, installCommand: `agent-org plugin install ${name}`,
  secrets: [], settingKeys: [], ...over });
const concern = (name: string, label: string, plugins: FixturePlugin[], over: FixturePlugin = {}): FixturePlugin => ({ concern: name, label, file: "host.json", required: name === "tracker" || name === "codeHost",
  enabled: plugins.find((candidate) => candidate.enabled)?.name ?? null, empty: null, plugins, ...over });
const LINEAR = plugin("linear", { settingKeys: ["tickets.providers.tracker.workingState", "tickets.providers.tracker.key.path"], secrets: [
  { setting: "key.keychain", command: "security add-generic-password -a \"$USER\" -s agent-org-linear -w" }, { setting: "key.path", command: "( umask 077; read -rs -p \"Linear API key: \" K; printf '%s' \"$K\" > ~/.config/agent-org/linear.key )" }],
  controls: { offered: ["disable", "uninstall", "configure"], refused: { disable: "linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled", uninstall: "linear is the only tracker, and exactly one tracker must be enabled: it cannot be uninstalled, since its default would put linear back" }, confirm: { uninstall: "Uninstall linear?" } } });
const TELEGRAM = plugin("telegram", { concern: "messaging", state: "not installed", installed: false, enabled: false, where: "plugins/telegram", settingKeys: [],
  controls: { offered: [], refused: {}, confirm: {} }, secrets: [{ setting: "tokenFile", command: "( umask 077; read -rs -p \"bot token: \" T; printf '%s' \"$T\" > ~/.config/agent-org/telegram-token )" }, { setting: "chairmanFile", command: "agent-org messaging:pair" }] });
const TAILSCALE = plugin("tailscale", { concern: "exposure", settingKeys: ["tickets.providers.exposure.port", "tickets.providers.exposure.tailnetPorts"], controls: { offered: ["disable", "uninstall", "configure"], refused: {}, confirm: { uninstall: "Uninstall tailscale? Its block is removed." } } });
const LOCAL = plugin("local", { concern: "exposure", state: "not installed", installed: false, enabled: false, settingKeys: ["tickets.providers.exposure.port"], controls: { offered: ["install"], refused: {}, confirm: { install: "Install local? It replaces tailscale as the exposure: no setting is lost." } } });
const SLACK = plugin("slack", { concern: "publisher", state: "not installed", installed: false, enabled: false, where: "core, until A11-161", controls: { offered: ["install"], refused: {}, confirm: {} } });
const PLUGINS = {
  version: "v1.2.3", messaging: { provider: null, why: "no project" }, note: null, bases: { "host.json": "h1" }, refused: [],
  concerns: [
    concern("tracker", "tracker", [LINEAR]),
    concern("codeHost", "code host", [plugin("github", { concern: "codeHost", settingKeys: [], controls: { offered: ["disable", "uninstall"], refused: { disable: "github is the only code host, and exactly one code host must be enabled: it cannot be disabled" }, confirm: { uninstall: "Uninstall github?" } } })]),
    concern("publisher", "publisher", [SLACK], { empty: { text: "None", commands: ["agent-org plugin install slack"] } }),
    concern("reviewer", "reviewer", [], { empty: { text: "None", commands: [] } }),
    concern("exposure", "exposure", [TAILSCALE, LOCAL]),
    concern("messaging", "messaging", [TELEGRAM], { file: "project.json", empty: { text: "None", commands: ["agent-org plugin install telegram"] } }),
  ],
};
/** The Settings rows of the five provider groups, as the instance describes them: the plugin line, a plugin's own setting, one only another plugin of the concern declares, and an old key. */
const PLUGIN_ROWS = {
  ...NOTHING_TO_DESCRIBE,
  groups: [
    { group: "Tracker", rows: [
      SHOWN({ key: "tickets.providers.tracker.provider", group: "Tracker", explanation: "The tracker's provider.", value: "linear" }),
      SHOWN({ key: "tickets.providers.tracker.workingState", group: "Tracker", explanation: "The state a ticket moves to as a worker starts.", input: "text", raw: "In Progress", editable: true }),
    ] },
    { group: "Exposure", rows: [
      SHOWN({ key: "tickets.providers.exposure.provider", group: "Exposure", explanation: "The exposure's provider.", value: "tailscale" }),
      SHOWN({ key: "tickets.providers.exposure.enabled", group: "Exposure", explanation: "Whether the exposure runs.", value: "true" }),
      SHOWN({ key: "tickets.providers.exposure.port", group: "Exposure", explanation: "The loopback port the instance listens on.", input: "number", raw: "4747", editable: true }),
      SHOWN({ key: "tickets.providers.exposure.tailnetPorts", group: "Exposure", explanation: "The ports served on the tailnet.", state: "default" }),
      SHOWN({ key: "tickets.port", group: "Exposure", explanation: "An old key for the port.", alias: "Alias of tickets.providers.exposure.port: run agent-org doctor --fix" }),
    ] },
    { group: "Workers", rows: [SHOWN({ key: "tickets.stallMinutes", group: "Workers", explanation: "How long a run may be silent before it is stalled.", value: "20" })] },
  ],
};
/** The Plugins section as the page draws it. */
const pluginsNode = (p: Page) => p.$("settings-groups").all().find((n) => n.className === "plugins")!;
/** Press the control `label` of the plugin `name`, and let the page act. */
const press = async (p: Page, name: string, label: string) => { buttonIn(pluginRow(p, name), label).fire("click"); await flush(); };
/** The row of the plugin `name`, in the Plugins section. */
const pluginRow = (p: Page, name: string) => pluginsNode(p).all().find((n) => n.tag === "li" && n.className.startsWith("plugin") && n.text().startsWith(`${name}. Version`))!;
const buttonsIn = (node: Node_) => node.all().filter((n) => n.tag === "button");

test("A11-163: the Plugins section lists the concerns in the chairman's order, each plugin with its name, version, contract and state in words", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS });
  const headings = pluginsNode(p).all().filter((n) => n.tag === "h4").map((n) => n.text());
  assert.deepEqual(headings, ["Tracker", "Code host", "Publisher", "Reviewer", "Exposure", "Messaging"]);
  assert.equal(pluginRow(p, "linear").all().find((n) => n.tag === "p")!.text(), "linear. Version v1.2.3. Contract 1.1. State: enabled.");
  assert.match(pluginRow(p, "local").text(), /^local\. Version v1\.2\.3\. Contract 1\.1\. State: not installed\./);
  assert.match(pluginRow(p, "slack").text(), /core, until A11-161\./, "a built-in says it is still core's");
  assert.deepEqual(p.requested.filter((path) => path === "/api/plugins").length, 1, "the section is its own call");
});

test("A11-163: Disable on the only tracker or code host is drawn disabled with the reason beside it, and Disable on an optional plugin posts the action with the file's base", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, pluginActions: () => ({ said: "disabled tailscale: the board is served on loopback only", changed: true, inForce: ["in force after the instance, the page and the terminal restart."] }) });
  const disable = buttonIn(pluginRow(p, "linear"), "Disable");
  assert.equal(disable.disabled, true);
  assert.ok(pluginRow(p, "linear").text().includes("linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled"), "the reason is beside it");
  assert.equal(buttonIn(pluginRow(p, "github"), "Disable").disabled, true);
  const off = buttonIn(pluginRow(p, "tailscale"), "Disable");
  assert.equal(off.disabled, false);
  off.fire("click");
  await flush();
  assert.deepEqual(p.posts.at(-1), { path: "/api/plugins/action", body: { action: "disable", name: "tailscale", base: "h1" } });
  assert.match(pluginsNode(p).text(), /disabled tailscale: the board is served on loopback only\. in force after the instance, the page and the terminal restart\./, "it says what it did and when it is in force");
  assert.ok(p.requested.filter((path) => path === "/api/plugins").length >= 2, "and the page reads the plugins again");
});

test("A11-163: Uninstall and an Install that replaces a plugin ask first, naming what is lost, and post nothing until they are confirmed", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, pluginActions: () => ({ said: "uninstalled tailscale", changed: true, inForce: [] }) });
  await press(p, "tailscale", "Uninstall");
  assert.equal(p.posts.some((post) => post.path === "/api/plugins/action"), false, "nothing is sent before the confirmation");
  assert.ok(pluginRow(p, "tailscale").text().includes("Uninstall tailscale? Its block is removed."));
  buttonIn(pluginRow(p, "tailscale"), "Cancel").fire("click");
  assert.equal(p.posts.some((post) => post.path === "/api/plugins/action"), false, "Cancel sends nothing");
  await press(p, "tailscale", "Uninstall");
  await press(p, "tailscale", "Confirm uninstall");
  assert.deepEqual(p.posts.at(-1), { path: "/api/plugins/action", body: { action: "uninstall", name: "tailscale", base: "h1", confirmed: true } });
  await press(p, "local", "Install");
  assert.ok(pluginRow(p, "local").text().includes("Install local? It replaces tailscale as the exposure: no setting is lost."));
  await press(p, "local", "Confirm install");
  assert.deepEqual(p.posts.at(-1), { path: "/api/plugins/action", body: { action: "install", name: "local", base: "h1", confirmed: true } });
  await press(p, "slack", "Install");
  assert.deepEqual(p.posts.at(-1), { path: "/api/plugins/action", body: { action: "install", name: "slack", base: "h1" } }, "an install that replaces nothing needs no confirmation");
});

test("A11-163: a refused action says the instance's sentence on the section and changes nothing, and the page reads the plugins again", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, pluginActions: () => ({}), refused: ["/api/plugins/action"], errors: { "/api/plugins/action": "the file changed since you looked: read it again" } });
  const reads = p.requested.filter((path) => path === "/api/plugins").length;
  buttonIn(pluginRow(p, "tailscale"), "Disable").fire("click");
  await flush();
  assert.match(pluginsNode(p).text(), /the file changed since you looked: read it again/);
  assert.ok(p.requested.filter((path) => path === "/api/plugins").length > reads, "so the next action carries a fresh base");
});

test("A11-163: a required concern with no plugin enabled says the board cannot run with the command, and an optional one says None with how to add one", async () => {
  const none = { ...PLUGINS, concerns: PLUGINS.concerns.map((entry) => (entry.concern === "tracker" ? { ...entry, enabled: null, empty: { text: "No tracker enabled: the board cannot run", commands: ["agent-org plugin enable linear"] } } : entry)) };
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: none });
  const texts = pluginsNode(p).all().filter((n) => n.tag === "p").map((n) => n.text());
  assert.ok(texts.includes("No tracker enabled: the board cannot run. Run agent-org plugin enable linear."));
  assert.ok(texts.includes("None. Run agent-org plugin install slack."), "an optional concern says None, with how to add one");
  const copy = buttonsIn(pluginsNode(p)).find((button) => button.attrs["data-command"] === "agent-org plugin enable linear");
  assert.ok(copy, "the command can be copied");
});

test("A11-163: a plugin that needs a secret shows the install command and the command for each secret with copy buttons, offers no Install button, and the page draws no field for a secret", async () => {
  const clipboard: string[] = [];
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, clipboard });
  const row = pluginRow(p, "telegram");
  assert.equal(buttonsIn(row).some((button) => button.text() === "Install"), false, "choosing a plugin that needs a secret goes through the CLI or onboard");
  const commands = row.all().filter((n) => n.tag === "code").map((n) => n.text());
  assert.deepEqual(commands, ["agent-org plugin install telegram", TELEGRAM.secrets[0].command, "agent-org messaging:pair"]);
  assert.match(row.text(), /A secret is never typed in this page/);
  const copy = buttonsIn(row).filter((button) => button.text() === "Copy");
  assert.deepEqual(copy.map((button) => button.attrs["data-command"]), commands, "each copy button carries its command");
  copy[1].fire("click");
  await flush();
  assert.deepEqual(clipboard, [TELEGRAM.secrets[0].command]);
  assert.equal(copy[1].text(), "Copied");
  assert.equal(pluginsNode(p).all().filter((n) => n.tag === "input" || n.tag === "textarea").some((n) => !n.parent || !n.parent.className.includes("edit-form")), false, "no field in the section takes a secret: only a setting's own edit form has inputs");
  assert.ok(pluginRow(p, "linear").all().filter((n) => n.tag === "code").map((n) => n.text()).includes(LINEAR.secrets[0].command), "an installed plugin shows its secret commands too");
});

test("A11-163: a plugin that failed to load is a red row with doctor's reason and the fix, and the other rows are drawn", async () => {
  const failed = plugin("tailscale", { concern: "exposure", state: "failed", failure: { why: "plugin tailscale: index.ts must export create, doctorChecks and onboardSteps", fix: "update agent-org, or the plugin" } });
  const answer = { ...PLUGINS, concerns: PLUGINS.concerns.map((entry) => (entry.concern === "exposure" ? { ...entry, plugins: [failed, LOCAL] } : entry)),
    refused: [{ plugin: "linear-tools", failure: { why: "plugin linear-tools: package.json is not valid JSON", fix: "fix the plugin's package.json, or remove the plugin" } }] };
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: answer });
  const row = pluginRow(p, "tailscale");
  assert.equal(row.className, "plugin failed", "a red row");
  assert.match(row.text(), /State: failed\./, "and its state in words, not by colour alone");
  assert.ok(row.text().includes("Why: plugin tailscale: index.ts must export create, doctorChecks and onboardSteps") && row.text().includes("Fix: update agent-org, or the plugin"));
  assert.equal(pluginRow(p, "linear").className, "plugin", "the other rows are not failed");
  assert.match(pluginsNode(p).text(), /Refused by the registry[\s\S]*linear-tools\. State: failed\.[\s\S]*Why: plugin linear-tools: package\.json is not valid JSON/);
  const nodes = pluginsNode(p).all();
  assert.ok(nodes.some((n) => n.tag === "dl" && n.text().includes("tickets.stallMinutes")) === false, "workers rows are outside the section");
  assert.match(p.$("settings-groups").text(), /tickets\.stallMinutes/, "and drawn");
});

test("A11-163: an enabled plugin whose checks fail stays enabled, with the failing checks and their fixes on its row", async () => {
  const slow = plugin("linear", { checks: [{ name: "tracker key", ok: false, detail: "the Keychain holds no key for agent-org-linear", fix: "security add-generic-password -a \"$USER\" -s agent-org-linear -w" }, { name: "linear mcp", ok: true, detail: "connected", fix: null }] });
  const answer = { ...PLUGINS, concerns: PLUGINS.concerns.map((entry) => (entry.concern === "tracker" ? { ...entry, plugins: [slow] } : entry)) };
  const row = pluginRow(await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: answer }), "linear");
  assert.match(row.text(), /State: enabled\./);
  assert.ok(row.text().includes("Check failing: tracker key: the Keychain holds no key for agent-org-linear Fix: security add-generic-password"));
  assert.equal(row.text().includes("linear mcp"), false, "a passing check is not repeated");
});

test("A11-163: a failed call for the plugins is said inside the section only: the rest of the page, with the provider groups where they were, is drawn", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, refused: ["/api/plugins"], errors: { "/api/plugins": "Linear could not be reached" } });
  assert.match(pluginsNode(p).text(), /The plugins could not be read: Linear could not be reached\. The rest of the page is as it was\./);
  const headings = p.$("settings-groups").all().filter((n) => n.tag === "h3").map((n) => n.text());
  assert.deepEqual(headings, ["Plugins", "Tracker", "Exposure", "Workers"], "the provider groups are drawn in their own sections, so no row goes missing");
  assert.match(p.$("settings-groups").text(), /tickets\.providers\.tracker\.provider/, "including the plugin line");
  assert.equal(p.$("settings-notes").text().includes("could not be read"), false, "the settings themselves read fine");
});

test("A11-163: an instance with no Plugins route, or an answer that lists no plugin, is said in the section and the settings are drawn as before", async () => {
  const old = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, refused: ["/api/plugins"], errors: { "/api/plugins": "no route GET /api/plugins" } });
  assert.match(pluginsNode(old).text(), /The plugins could not be read: no route GET \/api\/plugins/);
  const odd = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS });
  assert.match(pluginsNode(odd).text(), /The plugins could not be read: the instance's answer does not list the plugins/);
  assert.match(odd.$("settings-groups").text(), /tickets\.stallMinutes/);
});

test("A11-163: the rest of the page is drawn while the plugins are still being read, and the section says so", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, hold: { "/api/plugins": PLUGINS } });
  assert.match(pluginsNode(p).text(), /Reading the plugins…/);
  assert.match(p.$("settings-groups").text(), /tickets\.stallMinutes/, "the Workers rows are already drawn");
  assert.equal(p.$("settings-groups").all().some((n) => n.tag === "h4"), false, "and the plugins wait");
  p.release();
  await flush();
  assert.match(pluginsNode(p).text(), /Tracker[\s\S]*linear\. Version/);
});

test("A11-163: once the plugins are read, a plugin's settings are drawn under its concern from the schema: without the plugin and enabled lines, nor another plugin's setting, and an old key still appears", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS });
  const tracker = pluginsNode(p).all().find((n) => n.tag === "details" && n.className === "setting-group" && n.all().some((c) => c.tag === "h3" && c.text() === "Tracker settings"))!;
  assert.deepEqual(rowsIn(tracker.children.length > 0 ? tracker : tracker), [], "closed until opened");
  buttonIn(pluginRow(p, "linear"), "Configure").fire("click");
  assert.equal(tracker.open, true, "Configure opens the plugin's settings in place");
  assert.deepEqual(rowsIn(tracker), ["tickets.providers.tracker.workingState"]);
  const exposure = pluginsNode(p).all().find((n) => n.tag === "details" && n.all().some((c) => c.tag === "h3" && c.text() === "Exposure settings"))!;
  buttonIn(pluginRow(p, "tailscale"), "Configure").fire("click");
  assert.deepEqual(rowsIn(exposure), ["tickets.providers.exposure.port", "tickets.port"], "an old key is the concern's and still appears, the provider and enabled lines do not, and the default of a setting nobody has set stays at its default");
  await search(p, "tailnet");
  assert.deepEqual(rowsIn(exposure), ["tickets.providers.exposure.tailnetPorts"], "a search still finds every row");
});

test("A11-163: Configure on a plugin whose settings are in the project's declaration names the CLI command, and a remote instance's section is read-only with the note", async () => {
  const messaging = { ...PLUGINS, concerns: PLUGINS.concerns.map((entry) => (entry.concern === "messaging" ? { ...entry, plugins: [plugin("telegram", { concern: "messaging", controls: { offered: ["disable", "uninstall", "configure"], refused: {}, confirm: {} } })] } : entry)) };
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: messaging });
  buttonIn(pluginRow(p, "telegram"), "Configure").fire("click");
  const hint = pluginRow(p, "telegram").all().find((n) => n.tag === "p" && n.text().includes("agent-org plugin config telegram"))!;
  assert.equal(hint.hidden, false);
  const remote = await settingsPage({ connections: WORK_AND_PERSONAL, config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS });
  await chooseInstance(remote, "personal");
  await flush();
  assert.match(pluginsNode(remote).text(), /Its files are changed on that machine, so this page offers no edit here\./);
  assert.deepEqual(buttonsIn(pluginRow(remote, "tailscale")).map((button) => button.text()), [], "a remote instance's plugins have no control");
});

test("A11-163: settings that cannot be read leave the Plugins section drawn, with its controls, and plugins that cannot be read leave the settings", async () => {
  const p = await settingsPage({ config: SETTINGS, plugins: PLUGINS, refused: ["/api/settings"], errors: { "/api/settings": "Linear could not be reached" } });
  assert.match(p.$("settings-notes").text(), /could not be read: Linear could not be reached/);
  assert.match(pluginRow(p, "linear").text(), /State: enabled\./, "the plugins are independent of the settings");
  assert.equal(buttonIn(pluginRow(p, "tailscale"), "Disable").disabled, false);
  assert.equal(buttonsIn(pluginRow(p, "tailscale")).some((button) => button.text() === "Configure"), true, "Configure is still offered, and opens nothing the settings could not give");
});

test("A11-163: the provider groups are drawn where they were while the plugins are read, then move under their concern; a read that lands late does not replace a newer one", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: PLUGINS, hold: { "/api/plugins": PLUGINS } });
  const before = p.$("settings-groups").all().filter((n) => n.tag === "h3").map((n) => n.text());
  assert.deepEqual(before, ["Plugins", "Tracker", "Exposure", "Workers"], "no setting waits for the plugins");
  assert.match(p.$("settings-groups").text(), /tickets\.providers\.tracker\.provider/);
  p.release();
  await flush();
  const after = p.$("settings-groups").all().filter((n) => n.tag === "h3").map((n) => n.text());
  assert.deepEqual(after, ["Plugins", "Tracker settings", "Exposure settings", "Workers"], "read, they are the concerns' settings");
  const summary = sectionNamed(p, "Tracker settings").node.all().find((n) => n.tag === "summary")!.all().filter((n) => n.tag === "span").map((n) => n.text());
  assert.ok(summary.includes("plugin linear"), "and the summary still says which plugin runs");
});

test("A11-163: plugins read from a host file the reader refuses are shown with the note and with no control", async () => {
  const p = await settingsPage({ config: SETTINGS, settings: PLUGIN_ROWS, plugins: { ...PLUGINS, note: "the host file is refused, so the plugins are shown as their defaults: tickets.port must be a number" } });
  assert.match(pluginsNode(p).text(), /the host file is refused, so the plugins are shown as their defaults/);
  assert.deepEqual(buttonsIn(pluginRow(p, "tailscale")).map((button) => button.text()), [], "nothing is offered over defaults the file does not hold");
});

// A11-169: what the board says while a breaking update drains. The words are the ticket's, exactly; a non-breaking update has no note and shows nothing.
test("A11-169: the Board shows the draining update's banner and each run's line, and the version of a run only when it is not the instance's", async () => {
  const deadline = new Date(2026, 9, 21, 14, 30).getTime();
  const note = { target: "v0.280.0", deadline, finishing: 1, forced: false, stopped: 0 };
  const entries = [entry("N-1", { phase: "running", startedAt: 5, workspace: "w1", toolVersion: "v0.273.0" }), entry("N-2", { phase: "queued" }),
    entry("N-3", { phase: "queued", stoppedForUpdate: { at: deadline, target: "v0.280.0" } })];
  const draining = await page(new Map(), { entries, update: { version: "v0.280.0", note } });
  assert.equal(draining.$("update-note").hidden, false);
  assert.equal(draining.$("update-note").textContent, "Updating to v0.280 (breaking): no new runs start; 1 run finishing; forced at 14:30");
  const runs = draining.$("runs").text();
  assert.ok(runs.includes("finishing before the update"), "a live run");
  assert.ok(runs.includes("on v0.273 (instance v0.280)"), "its version, which is not the instance's");
  assert.ok(runs.includes("waits for the update"), "a queued run");
  assert.ok(runs.includes("stopped for the update at 14:30 and re-queued; resumes on v0.280"), "a run the update stopped");
  const calm = await page(new Map(), { entries, update: { version: "v0.273.0", note: null } });
  assert.equal(calm.$("update-note").hidden, true, "the banner is gone when the record is");
  assert.ok(!calm.$("runs").text().includes("finishing before the update") && !calm.$("runs").text().includes("instance v0"), "a run on the instance's version says nothing extra");
});

test("A11-167: a run whose ticket changed shows its line and a What changed link that opens the description with the old lines struck and the new added; a dependent shows what it learns from, linked", async () => {
  const sentAt = new Date(2026, 9, 21, 14, 5).getTime();
  const change = { at: sentAt, from: "Keep this.\nDrop this.", to: "Keep this.\nAdd this." };
  const pull = "https://github.com/a11ign/announcement-emulator/pull/3";
  const entries = [entry("N-1", { phase: "queued", ticketChange: change }), entry("N-2", { phase: "running", startedAt: 5, workspace: "w2", plan: { model: "opus", effort: "max" }, ticketChange: change }),
    entry("N-3", { phase: "running", startedAt: 5, workspace: "w3", ticketChanges: [change] }), entry("N-4", { phase: "queued", learned: { [pull]: { key: "A11-165", number: 3, file: "/t/b.md" } } }), entry("N-5", { phase: "queued" })];
  const p = await page(new Map(), { entries });
  const card = (key: string) => p.$("runs").all().find((node) => (node as unknown as { id?: string }).id === `run-${key}`)!;
  assert.ok(card("N-1").text().includes("ticket changed since plan, re-planning first"));
  assert.ok(card("N-2").text().includes("planning (ticket changed)"));
  assert.ok(card("N-3").text().includes("ticket changed: sent to the worker at 14:05"));
  assert.ok(card("N-4").text().includes("learns from A11-165 (#3 merged)"));
  assert.equal((card("N-4").all().find((node) => node.tag === "a" && node.text() === "A11-165 (#3 merged)") as unknown as { href?: string } | undefined)?.href, pull, "linked to the pull request");
  for (const key of ["N-5"]) assert.ok(!card(key).text().includes("What changed") && !card(key).text().includes("learns from"), "a run nothing changed under says nothing");
  const links = (key: string) => card(key).all().filter((node) => node.tag === "button" && node.className === "link-btn");
  assert.deepEqual([links("N-1"), links("N-2"), links("N-3"), links("N-4")].map((found) => found.map((node) => node.text())), [["What changed"], ["What changed"], ["What changed"], []]);
  assert.equal(p.$("ticket-diff-dialog").open, false);
  links("N-3")[0].fire("click");
  assert.equal(p.$("ticket-diff-dialog").open, true);
  assert.equal(p.$("ticket-diff-title").textContent, "What changed in N-3");
  assert.deepEqual(p.$("ticket-diff").children.map((line) => [line.tag, line.text()]), [["span", "Keep this."], ["del", "Drop this."], ["ins", "Add this."]], "the old line struck, the new one added, the shared one as it is");
});

// A11-161: what the board says when the reviewer is off and when the publisher is. The words are the ticket's, exactly.
test("A11-161: the banner \"Reviews are required and the reviewer is off\" is drawn only when reviews are required and the reviewer is off: not for a running reviewer, and not for none that is not required", async () => {
  for (const [reviewer, shown] of [["off-required", true], ["on", false], ["none", false], [undefined, false]] as const) {
    const p = await page(new Map(), { config: reviewer === undefined ? {} : { reviewer } });
    assert.equal(p.$("reviewer-off-note").hidden, !shown, String(reviewer));
    assert.equal(p.$("reviewer-off-note").textContent, shown ? "Reviews are required and the reviewer is off" : "", String(reviewer));
  }
});

test("A11-172: the board warning for review claims GitHub refuses is drawn once, whatever the number of pull requests, and gone when the queue carries none", async () => {
  const warning = "Reviews cannot be claimed on GitHub: gh: Resource not accessible by integration (HTTP 403) (3 pull requests). Run agent-org doctor.";
  const shown = await page(new Map(), { config: { reviewer: "on" }, claimWarning: warning });
  assert.equal(shown.$("claim-note").hidden, false);
  assert.equal(shown.$("claim-note").textContent, warning);
  for (const claimWarning of [null, undefined]) {
    const none = await page(new Map(), { config: { reviewer: "on" }, claimWarning });
    assert.equal(none.$("claim-note").hidden, true, String(claimWarning));
    assert.equal(none.$("claim-note").textContent, "");
  }
});

test("A11-161: each open pull request's line says \"waiting on the reviewer (off)\" or \"awaiting your review\", as the pool worded it, with no \"Pull requests\" section when every pull request belongs to a run", async () => {
  const url = "https://github.com/a11ign/control/pull/119";
  const review = [{ url, repo: "a11ign/control" }];
  const finished = (extra: Record<string, unknown> = {}) => entry("N-1", { phase: "finished", finishedAt: 7, outcome: { kind: "ready-pr", prs: review }, ...extra });
  const off = await page(new Map(), { config: { reviewer: "off-required" }, entries: [finished()], pulls: { [url]: "waiting on the reviewer (off)" } });
  assert.ok(off.$("runs").text().includes("a11ign/control #119: waiting on the reviewer (off)"));
  assert.equal(off.$("pull-requests").hidden, true, "the run lists it, so it is not listed twice");
  const people = await page(new Map(), { config: { reviewer: "none" }, entries: [finished()], pulls: { [url]: "awaiting your review" } });
  assert.ok(people.$("runs").text().includes("a11ign/control #119: awaiting your review"));
  assert.equal(people.$("pull-requests").hidden, true, "nothing extra is shown anywhere");
  assert.equal(people.$("reviewer-off-note").hidden, true, "no banner");
});

test("A11-161: with the publisher installed and switched off the Publish buttons and ticks are hidden and each run Ready to merge says \"publishing off\"; with none, or with it on, the line is not there", async () => {
  const off = await page(new Map(), { config: { publish: false, publisher: "off" }, entries: PUBLISHABLE });
  assert.equal(off.$("publish").hidden, true, "the button is hidden");
  assert.equal(tickFor(off, "P-1"), undefined, "and so are the ticks");
  const ready = runRows(off).filter((row) => row.text().includes("publishing off"));
  assert.deepEqual(ready.map((row) => ["P-1", "P-2"].some((key) => row.text().includes(key))), [true, true], "the runs that are Ready to merge say it, once each");
  assert.equal(ready.every((row) => row.text().split("publishing off").length === 2), true, "in one line each");
  assert.equal(runRows(off).find((row) => row.text().includes("P-3"))!.text().includes("publishing off"), false, "a published run does not");
  for (const config of [{ publish: false, publisher: "none" }, { publish: true, publisher: "on" }, {}]) {
    const p = await page(new Map(), { config, entries: PUBLISHABLE });
    assert.equal(p.$("runs").text().includes("publishing off"), false, JSON.stringify(config));
  }
});

/** A batch's tickets parked on its one pane, and NBF-1, which was planned together with them and has left it with its plan. */
const BATCH_CARDS = [
  entry("NBF-1", { phase: "queued", planned: true }),
  ...["NBF-2", "NBF-3", "NBF-4"].map((key) => entry(key, { phase: "finished", startedAt: 2, finishedAt: 7, batch: "b0-0", workspace: "w1", pane: "w1:p1", outcome: { kind: "needs-human", reason: "the planner needs a person: which layout?" } })),
];

test("a batch's cards say they were planned together, name each other, and link to one pane", async () => {
  const p = await page(new Map(), { connections: WORK_ALONE, config: { terminal: TERMINAL }, entries: BATCH_CARDS });
  const live = opens("http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal");
  for (const key of ["NBF-2", "NBF-3", "NBF-4"]) {
    const others = ["NBF-2", "NBF-3", "NBF-4"].filter((other) => other !== key).join(", ");
    const card = runRows(p).find((r) => r.text().startsWith(`${key} title`))!;
    const text = card.text();
    assert.ok(text.includes(`Planned together with ${others}: answer in the batch's terminal`), `${key}: ${text}`);
    const terminal = card.all().find((n) => n.className.split(" ").includes("terminal") && n.text() === "Open terminal") as (Node_ & { href?: string }) | undefined;
    assert.equal(terminal?.href, live, `${key} links the batch's one pane`);
  }
  assert.equal(runRows(p).find((r) => r.text().startsWith("NBF-1 title"))!.text().includes("Planned together"), false, "a ticket that was planned and left the batch needs no answer, and says nothing of it");
});

test("Talk opens the run's named terminal tab, and a second press goes to the same pane", async () => {
  const talking = entry("T-1", { phase: "running", startedAt: 3, talk: true, workspace: "w5", pane: "w5:p1" });
  const p = await page(new Map(), { connections: WORK_ALONE, config: { terminal: TERMINAL }, entries: [talking] });
  const talkButton = () => runRows(p)[0].all().find((n) => n.tag === "button" && n.className.includes("action-talk"))!;
  assert.ok(talkButton(), "a talk session that holds its pane offers Talk");
  talkButton().fire("click");
  await p.runTimers();
  talkButton().fire("click");
  await p.runTimers();
  assert.equal(p.tabs.length, 1, "the second press finds the first tab: one pane");
  assert.equal(p.tabs[0].location.href, opens("http://127.0.0.1:7318/?ws=w5&pane=w5%3Ap1&view=terminal"), "the tab is at the run's pane");
  assert.equal(p.posts.filter(({ path }) => path.endsWith("/api/queue/T-1/talk")).length, 2, "both presses reach the board, which starts nothing twice");
  assert.ok(runRows(p)[0].text().includes("Talking"), "and the card says Talking");
});

test("Talk on a card of a batch opens the tab named for the batch, which every card of it shares", async () => {
  const talking = ["NBF-2", "NBF-3"].map((key) => entry(key, { phase: "running", startedAt: 3, talk: true, batch: "b0-0", plan: { model: "opus", effort: "max" }, workspace: "w5", pane: "w5:p1" }));
  const p = await page(new Map(), { connections: WORK_ALONE, config: { terminal: TERMINAL }, entries: talking });
  for (const row of runRows(p)) {
    row.all().find((n) => n.tag === "button" && n.className.includes("action-talk"))!.fire("click");
    await p.runTimers();
  }
  assert.equal(p.tabs.length, 1, "a press on each of the batch's cards finds the one tab");
  assert.ok(runRows(p).every((row) => row.text().includes("Talking") && !row.text().includes("Planning")), "each card says Talking, never Planning");
});

test("Talk on a machine with no terminal opens no tab, and only asks the board", async () => {
  const talking = entry("T-1", { phase: "running", startedAt: 3, talk: true, workspace: "w5", pane: "w5:p1" });
  const p = await page(new Map(), { connections: WORK_ALONE, entries: [talking] });
  runRows(p)[0].all().find((n) => n.tag === "button" && n.className.includes("action-talk"))!.fire("click");
  await p.runTimers();
  assert.equal(p.tabs.length, 0, "there is no pane to point a tab at");
  assert.equal(p.posts.filter(({ path }) => path.endsWith("/api/queue/T-1/talk")).length, 1);
});
