// agent-org#1549: `pnpm test` runs the suite only where the suite can run, which is a LAID project. CI's `suite` job (agent-org#1593) copies the fixture project
// to a temporary directory and runs rstest from this checkout's root with `AGENT_ORG_HOST` naming the fixture's host declaration (.github/workflows/ci.yml).
// Without a host declaration the project's files are missing, so the suite fails for that reason and not for a fault in the tree, and the red output hides the real ones.
// So the entry refuses there, names the command CI runs and the narrow form, and otherwise runs the suite as it always did.
// Node only, no import from the tool: this file must run from any directory it is copied to.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const laid = Boolean(process.env.AGENT_ORG_HOST) || Boolean(process.env.AGENT_ORG_TOOL_REPO) || (basename(TOOL_ROOT) === "agent-org" && basename(dirname(TOOL_ROOT)) === "packages");

if (!laid) {
  console.error([
    "pnpm test: this checkout is not a laid project, and the suite cannot run from here (its files need the project around them).",
    "CI runs it from this checkout's root against a copy of the fixture project: node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts",
    "with AGENT_ORG_HOST set to the copy's .agent-org/host.json (the suite job in .github/workflows/ci.yml).",
    "A changed set runs here, narrow, with AGENT_ORG_HOST set to a host declaration:",
    "AGENT_ORG_HOST=<host.json> pnpm exec rstest run --config scripts/rstest/rstest.config.ts <changed test files>",
    "The 26 files that fail from a clone are not runnable that way.",
  ].join("\n"));
  process.exit(1);
}

const result = spawnSync("rstest", ["run", "--config", "scripts/rstest/rstest.config.ts"], { cwd: TOOL_ROOT, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
