#!/usr/bin/env node
// @ts-check
// command: run the contingency drill: clone, compose each agent's first message, from nothing but a checkout
// THE CONTINGENCY DRILL, AS A COMMAND -- `docs/roles/README.md`'s own acceptance test for itself, until
// now typed by hand: clone, `cat`, copy a message, run a test. Automating the composition step is the
// part worth having as a script: it produces every agent's actual first message, WITH the accumulated
// memory named alongside it, from nothing but a checkout -- so a real drill (--clone) or an offline check
// against the current tree (the default) both prove the same thing docs/roles/README.md's own drill
// section asks for, without a human re-typing the roster by hand each time.
//
// Usage:
//   node packages/agent-org/src/reconstitution-drill.mjs                          # against this checkout
//   node packages/agent-org/src/reconstitution-drill.mjs --checkout=<path>        # against an already-cloned path
//   node packages/agent-org/src/reconstitution-drill.mjs --clone --repo-url=<url> # do the actual git clone first
//   node packages/agent-org/src/reconstitution-drill.mjs --json                   # machine-readable
//   node packages/agent-org/src/reconstitution-drill.mjs --out-dir=<dir>          # one file per agent, ready to paste
//
// A found gap (a roster row with no message block, a missing role file, no memory index) is REPORTED, not
// thrown past -- this script's whole purpose is to surface exactly that, which is what
// docs/roles/README.md means by "if a step needs something only this machine has, the drill has found a
// real gap, and that is the result, not a failure of the drill."
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

const README_REL = "docs/roles/README.md";
const MEMORY_INDEX_REL = "docs/roles/memory/MEMORY.md";

/**
 * DUPLICATES `roster()` in `packages/lab/src/packaging/roles-readme.test.ts` rather than importing it --
 * that file is not a module (no `export`) and lives on a branch under active review by another agent at
 * the time this was written, so importing from it would couple two unrelated units' history. Kept small
 * and pinned by this script's own test against a realistic fixture, per this repo's own rule for forced
 * duplication ("pin them equal with a test" -- CLAUDE.md, "a fact stated twice").
 * @param {string} readmeSource
 */
function parseRoster(readmeSource) {
  const rows = [];
  for (const line of readmeSource.split("\n")) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const [, role, agent, , linkPath] = m;
    if (role === "role") continue;
    rows.push({ agent, filePath: join("docs/roles", linkPath) });
  }
  return rows;
}

/**
 * Finds the "first message" blockquote for one agent name under README's own
 * "## The first message for each agent, ready to paste" section. Two header shapes exist there:
 * a single backtick-quoted agent (`` **`orchestrator`:** ``), and one shared worker template
 * (`` **Each worker** (`worker-audit`, ...): ``) whose body uses `<name>` as a placeholder.
 * @param {string} readmeSource
 */
function firstMessages(readmeSource) {
  const lines = readmeSource.split("\n");
  /** @type {Map<string, string>} */
  const messages = new Map(); // agent -> message text
  /** @type {string | null} */
  let workerTemplate = null;
  /** @type {string[]} */
  let workerNames = [];

  for (let i = 0; i < lines.length; i++) {
    const single = lines[i].match(/^\*\*`([^`]+)`:\*\*$/);
    const worker = lines[i].match(/^\*\*Each worker\*\* \(([^)]+)\):$/);
    if (!single && !worker) continue;

    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("> ")) {
      body.push(lines[j].slice(2));
      j++;
    }
    const text = body.join("\n");

    if (single) {
      messages.set(single[1], text);
    } else if (worker) {
      workerTemplate = text;
      workerNames = [...worker[1].matchAll(/`([^`]+)`/g)].map((m2) => m2[1]);
    }
  }

  if (workerTemplate) {
    for (const name of workerNames) {
      messages.set(name, workerTemplate.replaceAll("<name>", name));
    }
  }
  return messages;
}

/**
 * Reuses MEMORY.md's own `- [Title](file) — hook` index shape rather than re-deriving it.
 * @param {string} indexSource
 */
function memoryEntries(indexSource) {
  /** @type {{ title: string, hook: string }[]} */
  const entries = [];
  for (const line of indexSource.split("\n")) {
    const m = line.match(/^- \[([^\]]+)\]\([^)]+\) — (.+)$/);
    if (m) entries.push({ title: m[1], hook: m[2] });
  }
  return entries;
}

/** @param {{ title: string, hook: string }[]} entries */
function composeMemorySection(entries) {
  if (entries.length === 0) {
    return "\n\n(No accumulated memory found at " + MEMORY_INDEX_REL + " -- a real gap, not expected.)";
  }
  const lines = entries.map((e) => `  - ${e.title} -- ${e.hook}`);
  return `\n\nBefore anything else, skim ${MEMORY_INDEX_REL} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) `
    + `for lessons already learned; do not re-derive them:\n${lines.join("\n")}`;
}

/**
 * Runs the drill against one checkout path, returning a report -- gaps included, never thrown past.
 * @param {string} checkoutPath
 */
export function runDrill(checkoutPath) {
  const readmePath = resolve(checkoutPath, README_REL);
  const memoryIndexPath = resolve(checkoutPath, MEMORY_INDEX_REL);

  if (!existsSync(readmePath)) {
    return { ok: false, gap: `${README_REL} does not exist at ${checkoutPath} -- the drill cannot start`, agents: [] };
  }

  const readmeSource = readFileSync(readmePath, "utf8");
  const roster = parseRoster(readmeSource);
  const messages = firstMessages(readmeSource);
  const memory = existsSync(memoryIndexPath) ? memoryEntries(readFileSync(memoryIndexPath, "utf8")) : [];
  const memorySection = composeMemorySection(memory);

  const agents = roster.map(({ agent, filePath }) => {
    const roleFileExists = existsSync(resolve(checkoutPath, filePath));
    const baseMessage = messages.get(agent);
    const gaps = [];
    if (!roleFileExists) gaps.push(`role file missing: ${filePath}`);
    if (!baseMessage) gaps.push(`no "first message" block found for \`${agent}\` in ${README_REL}`);
    return {
      agent,
      filePath,
      gaps,
      message: baseMessage ? baseMessage + memorySection : null,
    };
  });

  return { ok: true, memoryEntryCount: memory.length, agents };
}

/** @param {string} repoUrl */
function cloneFresh(repoUrl) {
  const dir = mkdtempSync(join(tmpdir(), "a11y-reconstitution-drill-"));
  const target = join(dir, "checkout");
  execFileSync("git", ["clone", repoUrl, target], { env: sandboxGitEnv(), stdio: "pipe" });
  return target;
}

function main() {
  refuseUnknownFlags(["--checkout", "--clone", "--repo-url", "--json", "--out-dir"],
    { entry: import.meta.url, command: "node packages/agent-org/src/reconstitution-drill.mjs" });
  const argv = process.argv.slice(2);
  /** @type {(name: string) => string | undefined} */
  const flag = (name) => argv.find((a) => a.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  /** @param {string} name */
  const has = (name) => argv.includes(name);

  let checkoutPath = flag("--checkout") ?? process.cwd();
  if (has("--clone")) {
    const repoUrl = flag("--repo-url")
      ?? execFileSync("git", ["remote", "get-url", "origin"], { cwd: process.cwd(), env: sandboxGitEnv(), encoding: "utf8" }).trim();
    console.log(`cloning ${repoUrl} fresh...`);
    checkoutPath = cloneFresh(repoUrl);
    console.log(`cloned to ${checkoutPath}`);
  }

  const report = runDrill(checkoutPath);
  if (!report.ok) {
    console.error(`REFUSING: ${report.gap}`);
    process.exit(1);
  }

  const outDir = flag("--out-dir");
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const a of report.agents) {
      if (a.message) writeFileSync(join(outDir, `first-message-${a.agent}.md`), a.message + "\n");
    }
  }

  if (has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const a of report.agents) {
      console.log(`\n${"=".repeat(60)}\n${a.agent}\n${"=".repeat(60)}`);
      if (a.gaps.length) console.log(`GAPS: ${a.gaps.join("; ")}`);
      if (a.message) console.log(a.message);
    }
  }

  const anyGaps = report.agents.some((a) => a.gaps.length > 0);
  process.exit(anyGaps ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
