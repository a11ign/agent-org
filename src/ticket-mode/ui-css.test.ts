// no-token: none -- runs headless Chrome on a page built from `ui.html`'s own style block; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const CSS = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(new URL("./ui.html", import.meta.url), "utf8"))![1];
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

function measure(chrome: string, reducedMotion: boolean): Readonly<Record<(typeof STATUSES)[number], Measure>> {
  const dir = tmpDir("ticket-ui-css-");
  const file = join(dir, "page.html");
  writeFileSync(file, PAGE);
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${join(dir, "profile")}`, ...(reducedMotion ? ["--force-prefers-reduced-motion"] : [])];
  const dom = execFileSync(chrome, [...flags, "--dump-dom", `file://${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, killSignal: "SIGKILL" });
  const out = /<pre id="out">([^<]*)<\/pre>/.exec(dom)?.[1];
  assert.ok(out, "Chrome printed no measurement");
  return JSON.parse(out);
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
