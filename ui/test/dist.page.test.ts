import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { requireBuild, UI_ROOT } from "./site.ts";

const DIST = join(UI_ROOT, "dist");
/** The pages that hold the shell: one for each route that has its own file. */
const SHELL_PAGES = ["runs/index.html", "settings/machine/index.html", "settings/models/index.html", "settings/plugins/index.html", "settings/workers/index.html", "tickets/index.html"];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

beforeAll(() => requireBuild());

describe("the build, as static files", () => {
  it("holds only static assets and no server entry", () => {
    const extensions = new Set(filesUnder(DIST).map((path) => extname(path)));
    // No stylesheet file: every page carries its styles inline (see the next check).
    expect([...extensions].sort()).toEqual([".html", ".js", ".woff2"]);
    expect(existsSync(join(DIST, "server"))).toBe(false);
    expect(existsSync(join(DIST, "_worker.js"))).toBe(false);
  });

  it("bundles a woff2 for each family", () => {
    const fonts = filesUnder(DIST).filter((path) => path.endsWith(".woff2"));
    expect(fonts.some((path) => /inter-latin-wght-normal\..*\.woff2$/.test(path))).toBe(true);
    expect(fonts.some((path) => /jetbrains-mono-latin-wght-normal\..*\.woff2$/.test(path))).toBe(true);
  });

  it("links no stylesheet from any page, since the instance's page policy allows only inline styles", () => {
    const pages = filesUnder(DIST).filter((path) => path.endsWith(".html"));
    const shellPages = pages.filter((path) => readFileSync(path, "utf8").includes("<astro-island"));
    expect(shellPages.map((path) => path.slice(DIST.length + 1)).sort()).toEqual(SHELL_PAGES);
    expect(pages.filter((path) => /<link[^>]+rel="stylesheet"/.test(readFileSync(path, "utf8")))).toEqual([]);
    expect(shellPages.filter((path) => !/<style[ >]/.test(readFileSync(path, "utf8")))).toEqual([]);
  });

  it("holds no font as a data: address, which the instance's page policy refuses for a font", () => {
    const pages = filesUnder(DIST).filter((path) => path.endsWith(".html"));
    expect(pages.filter((path) => /url\(\s*["']?data:/.test(readFileSync(path, "utf8")))).toEqual([]);
  });

  it("names no http(s) address in a page or a stylesheet", () => {
    const pages = filesUnder(DIST).filter((path) => path.endsWith(".html") || path.endsWith(".css"));
    expect(pages.length).toBeGreaterThan(1);
    const addresses = pages.flatMap((path) => readFileSync(path, "utf8").match(/https?:\/\/[^\s"')]+/g) ?? []);
    expect(addresses).toEqual([]);
  });
});
