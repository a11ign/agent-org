// no-token: none -- runs headless Chrome on a page built from `ui.html`'s own style block; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";

/**
 * WHAT THE PAGE'S STYLE SHEET DOES TO A RUN'S STATUS ICON, READ FROM A REAL CHROME. `ui.test.ts` runs the page's script against a fake
 * DOM, which has no CSS engine, so the colour a status takes and whether its ring turns are measured here: the style block of `ui.html`
 * and one icon per status in a row, as the page draws it, loaded in headless Chrome, which reports the computed colour and the
 * animations running on the icon's svg. Chrome's `--force-prefers-reduced-motion` stands in for a person who asked for less motion.
 *
 * With no Chrome on the machine the test is skipped and says so. With `CI=true` the absence fails, as `board-document-chrome-resolver.test.ts` does.
 * Chrome is found as `board-document.ts` finds it, by `BOARD_DOCUMENT_CHROME` or the usual install paths, but not by importing `resolveChromeBinary`:
 * that import loads the board's whole module graph, which fails to initialise when only this directory's tests run.
 */
const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
const STATUSES = ["working", "publishing", "ready-to-merge"] as const;
type Measure = Readonly<{ color: string; animation: string; running: number }>;

const HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)![1];
const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="runs"><div class="run-list">${STATUSES.map((s) => `<div class="run"><span class="icon st-${s}" id="${s}"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg></span></div>`).join("")}</div></div>
<pre id="out"></pre>
<script>
const out = {};
for (const id of ${JSON.stringify(STATUSES)}) {
  const icon = document.getElementById(id);
  const svg = icon.querySelector("svg");
  out[id] = { color: getComputedStyle(icon).color, animation: getComputedStyle(svg).animationName, running: svg.getAnimations().length };
}
document.getElementById("out").textContent = JSON.stringify(out);
</script>`;

function chromeOrSkip(t: { skip(reason: string): void }): string | null {
  const override = process.env.BOARD_DOCUMENT_CHROME;
  const found = (override ? [override] : CHROME_PATHS).find((path) => existsSync(path));
  if (found !== undefined) return found;
  const message = `no Chrome at ${override ?? CHROME_PATHS.join(", ")}`;
  if (process.env.CI === "true" || override) throw new Error(message);
  t.skip(`${message}. Not run, and not a pass; with CI=true this absence fails.`);
  return null;
}

/** Loads `html` in headless Chrome with `flags`, and returns what its `<pre id="out">` holds once its script has run. */
function dumpOut(chrome: string, html: string, flags: readonly string[]): string {
  const dir = tmpDir("ticket-ui-css-");
  const file = join(dir, "page.html");
  writeFileSync(file, html);
  // Chrome puts a socket in its TMPDIR and aborts when that path is over 107 characters, which the suite's own TMPDIR on the CI runner is.
  const scratch = mkdtempSync(join("/tmp", "ui-css-"));
  try {
    const run = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${join(dir, "profile")}`, ...flags, "--dump-dom", `file://${file}`],
      { encoding: "utf8", env: { ...process.env, TMPDIR: scratch }, timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 0, `Chrome exited ${run.status} (signal ${run.signal}): ${run.stderr.slice(-1500)}`);
    const out = /<pre id="out">([^<]*)<\/pre>/.exec(run.stdout)?.[1];
    assert.ok(out, `Chrome printed no measurement: ${run.stdout.slice(0, 500)}`);
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function measure(chrome: string, reducedMotion: boolean): Readonly<Record<(typeof STATUSES)[number], Measure>> {
  return JSON.parse(dumpOut(chrome, PAGE, reducedMotion ? ["--force-prefers-reduced-motion"] : []));
}

/**
 * THE PICK TAB'S LAYOUT, FROM A REAL CHROME. The sidebar of projects sits beside the list on a wide window and above it under 760px, and nothing
 * scrolls sideways. The Pick section's own markup is read from `ui.html`, with the project buttons and one ticket row put where the page puts them,
 * so `ui-css.test.ts` measures the page's layout and not a copy of it. The fake DOM in `ui.test.ts` has no layout, so this is the only proof of it.
 */
const PICK_SECTION = HTML.slice(HTML.indexOf('<section id="pick">'), HTML.indexOf('<section id="board"'));
const SIDEBAR_SLOT = '<nav class="filters" id="projects" aria-label="Projects"></nav>';
const LIST_SLOT = '<div id="groups"></div>';
if (!PICK_SECTION.includes(SIDEBAR_SLOT) || !PICK_SECTION.includes(LIST_SLOT)) throw new Error("the Pick section of ui.html no longer has the sidebar and list slots this test fills");
const PROJECT_BUTTONS = [["Visual Explorer - GA", 3], ["agent-org", 2], ["a11ign", 1], ["(no project)", 1]] as const;
const SIDEBAR = PROJECT_BUTTONS.map(([name, n], i) => `<button class="filter" type="button" aria-pressed="${i === 0}"><span>${name}</span><span class="n">${n}</span></button>`).join("");
const LIST = '<div class="group"><h2><span class="name">Backlog</span></h2><label class="row"><input type="checkbox"><span class="key">NBF-1</span>'
  + '<span>Fit to View does nothing, a title long enough to wrap when the window is narrow</span><span class="pill">Visual Explorer - GA</span><span class="pill">Urgent</span></label></div>';
const PICK = PICK_SECTION.replace(SIDEBAR_SLOT, `<nav class="filters" id="projects" aria-label="Projects">${SIDEBAR}</nav>`).replace(LIST_SLOT, `<div id="groups">${LIST}</div>`);

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;
type PickMeasure = Readonly<{ innerWidth: number; scrollWidth: number; sidebar: Box; list: Box }>;

function measurePick(chrome: string, width: number): PickMeasure {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style><main>${PICK}</main>
<pre id="out"></pre>
<script>
const box = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
document.getElementById("out").textContent = JSON.stringify({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, sidebar: box("#projects"), list: box(".pick-main") });
</script>`;
  return JSON.parse(dumpOut(chrome, html, [`--window-size=${width},800`]));
}

test("a Publishing run's icon has the colour of In progress and its ring turns, and a Ready to merge icon does neither", (t) => {
  const chrome = chromeOrSkip(t);
  if (chrome === null) return;
  const { working, publishing, "ready-to-merge": ready } = measure(chrome, false);
  assert.equal(publishing.color, working.color, "yellow, as the ring of a run in progress");
  assert.notEqual(publishing.color, ready.color);
  assert.deepEqual([working.animation, working.running], ["spin", 1], "the reference: the ring In progress already turns");
  assert.deepEqual([publishing.animation, publishing.running], ["spin", 1]);
  assert.deepEqual([ready.animation, ready.running], ["none", 0], "a ring that does not turn");
});

test("a person who asked for reduced motion sees the Publishing ring hold still, in the same colour", (t) => {
  const chrome = chromeOrSkip(t);
  if (chrome === null) return;
  const { working, publishing } = measure(chrome, true);
  assert.deepEqual([publishing.animation, publishing.running], ["none", 0]);
  assert.equal(publishing.color, working.color);
});

test("A11-123: the project sidebar sits beside the list on a wide window, above it under 760px, and nothing scrolls sideways", (t) => {
  const chrome = chromeOrSkip(t);
  if (chrome === null) return;
  const wide = measurePick(chrome, 1000);
  assert.equal(wide.innerWidth, 1000, "the window is the width asked for");
  assert.ok(wide.sidebar.right <= wide.list.left, "on a wide window the sidebar is left of the list");
  assert.equal(wide.sidebar.top, wide.list.top, "and starts level with it");
  const narrow = measurePick(chrome, 700);
  assert.equal(narrow.innerWidth, 700);
  assert.ok(narrow.sidebar.bottom <= narrow.list.top, "under 760px the sidebar is above the list");
  assert.ok(narrow.scrollWidth <= narrow.innerWidth, `no horizontal scroll: the page is ${narrow.scrollWidth}px wide in a ${narrow.innerWidth}px window`);
});

/**
 * THE SETTINGS PAGE HIDES WHAT IT HIDES, FROM A REAL CHROME. A row the page leaves out (a default, or a row no search finds) carries `hidden`, but
 * a setting row sets its own display, which would show it unless the page's rule for `[hidden]` wins inside the Settings page. The fake DOM in
 * `ui.test.ts` has no layout, so this is the only proof that the hidden rows are not drawn.
 */
test("a setting the page hides is not drawn: a hidden row or section stays hidden under the page's own style sheet", (t) => {
  const chrome = chromeOrSkip(t);
  if (chrome === null) return;
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><main><section id="settings-page">
<details class="setting-group" id="section" hidden><summary>Tracker</summary><dl class="setting" id="row" hidden><dt>k</dt><dd>v</dd></dl></details>
<dl class="setting" id="shown"><dt>k</dt><dd>v</dd></dl></section></main>
<pre id="out"></pre>
<script>
const display = (id) => getComputedStyle(document.getElementById(id)).display;
document.getElementById("out").textContent = JSON.stringify({ section: display("section"), row: display("row"), shown: display("shown") });
</script>`;
  assert.deepEqual(JSON.parse(dumpOut(chrome, html, [])), { section: "none", row: "none", shown: "grid" });
});
