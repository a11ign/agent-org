import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import config from "../astro.config.ts";
import { BASE } from "../src/shell/routes.ts";
import { UI_ROOT } from "./site.ts";

const SRC = join(UI_ROOT, "src");
const TOKENS = join(SRC, "styles", "tokens.css");

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

const isTest = (path: string): boolean => /\.test\.(ts|tsx)$/.test(path);
/** The source the UI ships: every stylesheet, script and page under `src/`, but not its tests. */
const SOURCE = filesUnder(SRC).filter((path) => /\.(css|ts|tsx|astro)$/.test(path) && !isTest(path));
const STYLESHEETS = SOURCE.filter((path) => path.endsWith(".css") && path !== TOKENS);
const read = (path: string): string => readFileSync(path, "utf8");
const name = (path: string): string => relative(UI_ROOT, path);

/** The colour literals in `text`: a hex colour, or a call of rgb, rgba, hsl or hsla. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/** The `/* ... *\/` comments are prose: a value named in one is not a value used. */
const MEDIA_RULE = /@media \(max-width: 820px\)/g;

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the design tokens are the one file that holds values", () => {
  it("finds the source it checks", () => {
    expect(SOURCE.length).toBeGreaterThan(10);
    expect(SOURCE).toContain(TOKENS);
  });

  it("has no colour literal outside tokens.css", () => {
    const found = SOURCE.filter((path) => path !== TOKENS).flatMap((path) => [...withoutComments(read(path)).matchAll(COLOUR)].map((match) => `${name(path)}: ${match[0]}`));
    expect(found).toEqual([]);
  });

  it("has no pixel length in a stylesheet outside tokens.css, but a 1px hairline and the one 820px media query", () => {
    const found = STYLESHEETS.flatMap((path) =>
      [...withoutComments(read(path)).replace(MEDIA_RULE, "").matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)].filter((match) => match[1] !== "1").map((match) => `${name(path)}: ${match[0]}`),
    );
    expect(found).toEqual([]);
  });

  it("writes the 820px collapse once", () => {
    const count = STYLESHEETS.reduce((total, path) => total + (withoutComments(read(path)).match(/820px/g) ?? []).length, 0);
    expect(count).toBe(1);
  });

  it("has no pixel length in a component or a page", () => {
    const found = SOURCE.filter((path) => /\.(tsx|astro)$/.test(path)).flatMap((path) => [...withoutComments(read(path)).matchAll(/\d+px\b/g)].map((match) => `${name(path)}: ${match[0]}`));
    expect(found).toEqual([]);
  });

  it("defines every custom property a stylesheet uses", () => {
    const defined = new Set([...read(TOKENS).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const used = SOURCE.flatMap((path) => [...withoutComments(read(path)).matchAll(/var\((--[\w-]+)/g)].map((match) => `${name(path)}: ${match[1]}`)).filter((entry) => !defined.has(entry.split(": ")[1]));
    expect(used).toEqual([]);
  });

  it("imports the tokens and the stylesheets from styles.css, which the layout loads", () => {
    const styles = read(join(SRC, "styles.css"));
    for (const sheet of ["./styles/tokens.css", "./lifecycle/lifecycle.css", "./shell/shell.css", "./tickets/tickets.css"]) expect(styles).toContain(`@import "${sheet}"`);
    expect(read(join(SRC, "layouts", "Shell.astro"))).toContain('import "../styles.css"');
  });
});

describe("the tokens are the boards' values", () => {
  const tokens = read(TOKENS);
  const valueOf = (token: string): string | undefined => new RegExp(`${token}:\\s*([^;]+);`).exec(tokens)?.[1].trim();

  it.each([
    ["--sidebar-width", "248px"], ["--color-page", "#0d0e11"], ["--color-sidebar", "#111216"], ["--color-surface", "#0f1013"], ["--color-raised", "#16181d"], ["--color-active", "#1e2027"],
    ["--color-border", "#23252b"], ["--color-text", "#e7e8ec"], ["--color-accent", "#5b63d9"], ["--color-accent-lighter", "#9aa1f5"],
    ["--color-success-text", "#7ee08f"], ["--color-danger-bg", "#1d1315"], ["--color-warn-text", "#e3b341"],
    ["--focus-ring-width", "2px"], ["--focus-ring-offset", "1px"], ["--skeleton-duration", "1.6s"], ["--skeleton-size", "200% 100%"],
    ["--font-size-body", "13px"], ["--line-height-body", "20px"], ["--font-size-h1", "20px"], ["--line-height-h1", "28px"], ["--font-size-mark", "15px"],
  ])("%s is %s", (token, value) => {
    expect(valueOf(token)).toBe(value);
  });

  it("holds the shimmer's gradient, in the order the boards have it", () => {
    expect(valueOf("--skeleton-gradient")).toBe("linear-gradient(90deg, var(--color-raised) 25%, var(--color-skeleton-highlight) 50%, var(--color-raised) 75%)");
    expect(valueOf("--color-skeleton-highlight")).toBe("#22252c");
  });

  it("draws the focus ring the keyboard sees from one place", () => {
    const base = read(join(SRC, "styles.css"));
    expect(base).toMatch(/:focus-visible[\s\S]*outline: var\(--focus-ring-width\) solid var\(--focus-ring-color\);[\s\S]*outline-offset: var\(--focus-ring-offset\)/);
  });

  it("turns the shimmer and the spinner off for reduced motion", () => {
    expect(read(join(SRC, "styles.css"))).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\.sk,\s*\.spin\s*{\s*animation: none;/);
  });
});

describe("the routes", () => {
  it("serve under the Astro config's base", () => {
    expect(BASE || "/").toBe(config.base);
  });
});
