import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { requireBuild, UI_ROOT } from "./site.ts";

const DIST = join(UI_ROOT, "dist");

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
    const pages = filesUnder(DIST).filter((path) => path.endsWith(".html") && !/<meta http-equiv="refresh"/.test(readFileSync(path, "utf8")));
    expect(pages.length).toBe(6);
    expect(pages.filter((path) => /<link[^>]+rel="stylesheet"/.test(readFileSync(path, "utf8")))).toEqual([]);
    expect(pages.filter((path) => !/<style[ >]/.test(readFileSync(path, "utf8")))).toEqual([]);
  });

  it("names no http(s) address in a page or a stylesheet", () => {
    const pages = filesUnder(DIST).filter((path) => path.endsWith(".html") || path.endsWith(".css"));
    expect(pages.length).toBeGreaterThan(1);
    const addresses = pages.flatMap((path) => readFileSync(path, "utf8").match(/https?:\/\/[^\s"')]+/g) ?? []);
    expect(addresses).toEqual([]);
  });
});
