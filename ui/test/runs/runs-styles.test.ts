import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { UI_ROOT } from "../site.ts";

// A11-277: the Runs page opens the New ticket dialog for a failed After-merge check's follow-up. Loading the whole New ticket stylesheet brought its request strip's `.run-note` card rule, which drew every run's
// note on the page as a warning box. Each stylesheet the Runs page loads beside `runs.css` must leave the run rows' `run-*` classes to it.

const PAGE = join(UI_ROOT, "src", "pages", "runs", "index.astro");
const RUNS_CSS = join(UI_ROOT, "src", "runs", "runs.css");

const read = (path: string): string => readFileSync(path, "utf8");

/** The stylesheet `path` and every local one it `@import`s, in order. */
function withImports(path: string): string[] {
  const local = [...read(path).matchAll(/@import "(\.{1,2}\/[^"]+)"/g)].map(([, to]) => join(dirname(path), to!));
  return [path, ...local.flatMap(withImports)];
}

/** The stylesheets the Runs page imports itself, with theirs. */
const pageSheets = (): string[] => [...read(PAGE).matchAll(/^import "(\.{1,2}\/[^"]+\.css)";$/gm)].flatMap(([, to]) => withImports(join(dirname(PAGE), to!)));

/** The `run-*` classes a stylesheet's selectors name, comments left out. */
const runClasses = (path: string): Set<string> => new Set([...read(path).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(run-[\w-]+)/g)].map(([, name]) => name!));

describe("the Runs page's stylesheets", () => {
  it("leave the run rows' classes to runs.css", () => {
    const rows = runClasses(RUNS_CSS);
    const restyled = pageSheets().filter((path) => path !== RUNS_CSS).flatMap((path) => [...runClasses(path)].filter((name) => rows.has(name)).map((name) => `${relative(UI_ROOT, path)}: .${name}`));
    expect(restyled).toEqual([]);
  });

  it("load the New ticket dialog's rules, which the follow-up opens", () => {
    expect(pageSheets().map((path) => relative(UI_ROOT, path))).toContain("src/new-ticket/new-ticket-dialog.css");
  });
});
