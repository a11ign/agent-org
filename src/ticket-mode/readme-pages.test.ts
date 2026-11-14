import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A11-441: the README is a short front page, and each task (install, onboard, services, ticket mode, plugins,
// troubleshooting) has a page of its own under docs/guide/. These read the real files.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUIDE = "docs/guide";
const README_MAX_LINES = 150;
const TASK_PAGES = ["install", "onboard", "services", "ticket-mode", "plugins", "troubleshooting"].map((name) => `${GUIDE}/${name}.md`);

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** The targets of a page's relative markdown links, without their `#anchor`: web, mail and in-page links are not files. */
function relativeLinkTargets(markdown: string): string[] {
  const targets = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target]) => target ?? "");
  return targets.filter((target) => !/^(?:[a-z]+:|#)/.test(target)).map((target) => target.split("#")[0] ?? "");
}

/** Each relative link of a file that names no file or folder, as `<file>: <target>`. */
function brokenLinks(file: string, markdown: string, exists: (path: string) => boolean): string[] {
  return relativeLinkTargets(markdown)
    .filter((target) => !exists(join(dirname(file), target)))
    .map((target) => `${file}: ${target}`);
}

const shippedPages = (): string[] => [
  "README.md",
  ...readdirSync(join(ROOT, GUIDE)).filter((name) => name.endsWith(".md")).map((name) => `${GUIDE}/${name}`),
];

test(`the README is under ${README_MAX_LINES} lines and links to a page for each task`, () => {
  const readme = read("README.md");
  assert.ok(readme.split("\n").length < README_MAX_LINES, `README.md is ${readme.split("\n").length} lines`);
  const linked = new Set(relativeLinkTargets(readme));
  assert.deepEqual(TASK_PAGES.filter((page) => !linked.has(page)), [], "a task page the README does not link to");
});

test("every relative link in the README and the guide pages names a file that exists", () => {
  const exists = (path: string): boolean => existsSync(join(ROOT, path));
  assert.deepEqual(shippedPages().flatMap((file) => brokenLinks(file, read(file), exists)), []);
});

test("a link is resolved from the folder of the page it is on, and a web or in-page link is not a file", () => {
  const files = new Set(["src/a.ts", "docs/guide/b.md"]);
  const exists = (path: string): boolean => files.has(path);
  const page = "[a](../../src/a.ts) [b](b.md#part) [c](c.md) [web](https://example.com) [here](#top) [root](src/a.ts)";
  assert.deepEqual(brokenLinks("docs/guide/x.md", page, exists), ["docs/guide/x.md: c.md", "docs/guide/x.md: src/a.ts"]);
});
