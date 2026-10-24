import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ROOT } from "../../test/site.ts";

const SRC = join(UI_ROOT, "src");
const OWN = join(SRC, "run-detail", "run-detail.css");

const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** The selectors of each rule of a stylesheet, as written: `.a, .b:hover` is two. */
const selectorsOf = (path: string): string[] =>
  [...withoutComments(readFileSync(path, "utf8")).matchAll(/([^{}@]+)\{/g)].flatMap((match) => match[1].split(",").map((selector) => selector.trim())).filter((selector) => selector.startsWith("."));

describe("the Run detail stylesheet", () => {
  it("defines no selector another stylesheet defines, since the runs route loads it beside runs.css", () => {
    const own = new Set(selectorsOf(OWN));
    const others = filesUnder(SRC).filter((path) => path.endsWith(".css") && path !== OWN && !path.endsWith("tokens.css"));
    const clashes = others.flatMap((path) => selectorsOf(path).filter((selector) => own.has(selector)).map((selector) => `${path.slice(SRC.length + 1)}: ${selector}`));
    expect(own.size).toBeGreaterThan(20);
    expect(clashes).toEqual([]);
  });
});
