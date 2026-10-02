// @ts-check
// THE LEAK SCAN `gate` RUNS (#2792, ADR 0040 decision 6 step 2; a11ign/a11ign#2623). This repository is PUBLIC, so what is committed here is
// published. The scan reads the tool's OWN generic patterns (`src/lib/generic-leak-patterns.mjs`: a private LAN IPv4 address, a named SSH private key
// file) over every file in the tree and REFUSES on a hit, naming the file and the value. It deliberately does not call `allLeaksIn`, which reads
// a project's declaration (`.agent-org/project.json`) that this repository does not hold: the tool is configured by the project that runs it.
//
// Usage: node .github/scripts/leak-scan.mjs [--root=<dir>]   (default: the current directory)
// Exit:  0 = clean, 1 = a leak was found, 2 = the scan could not examine anything (an empty scan is not a clean one).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GENERIC_LEAK_PATTERNS } from "../../src/lib/generic-leak-patterns.mjs";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

// A (file, value) exemption, never a value-class one: the same value appearing in a NEW file is still a leak. The one entry is a fixture that
// exists to prove the tool REFUSES an SSH key path, so it has to contain one. The value is assembled from parts so this file does not itself
// carry the contiguous string the pattern matches.
const EXEMPT = Object.freeze([
  { file: "src/packaging/tracker-leak-refusal.test.ts", value: ["~/.ssh/", "a11y-fixture", "_ed25519"].join("") },
]);

/** @param {string} root @returns {string[]} every file under `root`, relative to it, in a stable order */
function filesUnder(root) {
  const found = [];
  const visit = (/** @type {string} */ directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      else if (entry.isFile()) found.push(relative(root, join(directory, entry.name)));
    }
  };
  visit(root);
  return found.sort();
}

/** @param {string} file @param {string} value */
function isExempt(file, value) {
  return EXEMPT.some((entry) => entry.file === file && entry.value === value);
}

/** @param {string} text @returns {Array<{ name: string; value: string }>} matches in text collapsed so a hard-wrapped line cannot hide one */
function leaksIn(text) {
  const collapsed = text.replace(/\s+/g, " ");
  return GENERIC_LEAK_PATTERNS.flatMap(({ name, pattern }) =>
    [...collapsed.matchAll(new RegExp(pattern.source, "g"))].map((match) => ({ name, value: match[0] })));
}

/** @param {string} root @returns {{ scanned: number; leaks: string[] }} */
export function scan(root) {
  let scanned = 0;
  const leaks = [];
  for (const file of filesUnder(root)) {
    const text = readFileSync(join(root, file), "utf8");
    if (text.includes("\0")) continue;
    scanned += 1;
    for (const { name, value } of leaksIn(text)) {
      if (!isExempt(file, value)) leaks.push(`LEAK: ${file}: ${name}: ${value}`);
    }
  }
  return { scanned, leaks };
}

function main() {
  const root = process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) ?? process.cwd();
  const { scanned, leaks } = scan(root);
  if (scanned === 0) {
    console.error(`CANNOT_ASK: no file under ${root} was examined, so "no leaks" would mean nothing`);
    process.exit(2);
  }
  for (const line of leaks) console.error(line);
  if (leaks.length > 0) process.exit(1);
  console.log(`leak scan: ${scanned} files examined, 0 leaks`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) main();
