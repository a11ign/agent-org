// @ts-check
// EVERY PATH A WORKFLOW NAMES MUST EXIST IN THIS REPOSITORY (#2792, a11ign/a11ign#2623). This repository was extracted from a product's
// `packages/agent-org/` by a history rewrite, so a workflow copied from that product can name a path that only ever lived beside it
// (`packages/agent-org/src/...`, `scripts/...`) and would fail at run time, or worse, be skipped. This check reads each workflow's text for
// paths under the directories this repository has and refuses one that is not there, naming it.
//
// Usage: node .github/scripts/workflow-paths.mjs [--root=<dir>]   (default: the current directory)
// Exit:  0 = every named path exists, 1 = a workflow names one that does not, 2 = nothing was examined.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = ".github/workflows";
// The top-level directories a path is CLAIMED under: this repository's own, then the ones only the product has. The second group is the point
// of the check -- a copied workflow that says `packages/agent-org/src/arm-pr.mjs` names a directory that does not exist here, so it must be
// caught as a missing path and not skipped as "not one of ours". A directory in neither list is not a claim about any tree and is ignored.
const OWN_DIRECTORIES = ["\\.github", "src", "host"];
const PRODUCT_ONLY_DIRECTORIES = ["packages", "scripts", "docs"];
const NAMED_PATH = new RegExp(`(?<![\\w./-])((?:${[...OWN_DIRECTORIES, ...PRODUCT_ONLY_DIRECTORIES].join("|")})/[\\w./-]*\\w)`, "g");

/** @param {string} text @returns {string[]} */
export function pathsNamedIn(text) {
  return [...new Set([...text.matchAll(NAMED_PATH)].map((match) => match[1] ?? ""))];
}

/** @param {string} root @returns {{ examined: number; named: number; missing: string[] }} */
export function check(root) {
  const workflowDirectory = join(root, WORKFLOWS);
  const files = existsSync(workflowDirectory) ? readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name)).sort() : [];
  const missing = [];
  let named = 0;
  for (const file of files) {
    for (const path of pathsNamedIn(readFileSync(join(workflowDirectory, file), "utf8"))) {
      named += 1;
      if (!existsSync(join(root, path))) missing.push(`MISSING PATH: ${WORKFLOWS}/${file} names ${path}, which is not in this repository`);
    }
  }
  return { examined: files.length, named, missing };
}

function main() {
  const root = process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) ?? process.cwd();
  const { examined, named, missing } = check(root);
  if (examined === 0 || named === 0) {
    console.error(`CANNOT_ASK: ${examined} workflow files and ${named} named paths under ${root}; a check that finds nothing has verified nothing`);
    process.exit(2);
  }
  for (const line of missing) console.error(line);
  if (missing.length > 0) process.exit(1);
  console.log(`workflow paths: ${examined} workflows, ${named} paths named, all present`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) main();
