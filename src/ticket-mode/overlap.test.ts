import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredRegionFiles } from "../region-paths.ts";
import { parsePaths, pathsAsRegion } from "./overlap.ts";

test("A11-82: a plan's ## Paths section lists its repository-prefixed paths, bullets only, in order, each once", () => {
  const plan = [
    "# Plan",
    "",
    "## Approach",
    "- `nbl-ui-netbox:src/not/a/path.ts` is in the approach, not the section",
    "",
    "## Paths",
    "- `agent-org:src/ticket-mode/pool.ts`",
    "* `agent-org:src/ticket-mode/`",
    "- `agent-org:src/ticket-mode/pool.ts` again",
    "- `nbl-ui-netbox:docs/guide.md` the guide, with a note after it",
    "  - `agent-org:src/ticket-port/` indented, which is still a bullet",
  ].join("\n");
  assert.deepEqual(parsePaths(plan), ["agent-org:src/ticket-mode/pool.ts", "agent-org:src/ticket-mode/", "nbl-ui-netbox:docs/guide.md", "agent-org:src/ticket-port/"]);
});

test("A11-82: the section ends at the next heading, and a plan without the section declares no paths", () => {
  assert.deepEqual(parsePaths("## Paths\n- `agent-org:a.ts`\n### Notes\n- `agent-org:b.ts`\n"), ["agent-org:a.ts"]);
  assert.deepEqual(parsePaths("# Plan\n- `agent-org:a.ts`\n"), [], "a bullet outside the section is not a path");
  assert.deepEqual(parsePaths(""), []);
});

test("A11-82: a line that is no `repo:path` bullet is nothing: plain text, a bullet without backticks, a bullet with no path, and a bare path", () => {
  assert.deepEqual(parsePaths([
    "## Paths",
    "agent-org:src/a.ts",
    "- src/b.ts",
    "- `src/c.ts`",
    "- `agent-org:`",
    "- `:src/d.ts`",
    "- `agent-org:src/e.ts with a space`",
    "- `agent-org:src/f.ts`",
  ].join("\n")), ["agent-org:src/f.ts"]);
});

test("A11-82: a plan with CRLF line endings reads the same", () => {
  assert.deepEqual(parsePaths("## Paths\r\n- `agent-org:src/a.ts`\r\n- `agent-org:src/b/`\r\n"), ["agent-org:src/a.ts", "agent-org:src/b/"]);
});

// A11-125: one section of paths for `pr:open` and the overlap wait. A plan with only `## Paths` is read by both, one with both sections by its Paths alone,
// and a plan written before the Paths section by its prefixed Region lines.
const PATHS_ONLY = "# Plan\n\n## Approach\n- `agent-org:src/not/a/path.ts` is in the approach\n\n## Paths\n- `agent-org:src/ticket-mode/pool.ts`\n- `agent-org:src/ticket-mode/`\n- `agent-org:README.md`\n";
const REGION_ONLY = "# Plan\n\n## Region\n\n```\nagent-org:src/ticket-mode/pool.ts\nREADME.md\nnbl-ui-netbox:docs/guide.md\n```\n";

test("A11-125: a plan with only a Paths section is read by the overlap wait, and pr:open reads the same paths as its Region", () => {
  const paths = ["agent-org:src/ticket-mode/pool.ts", "agent-org:src/ticket-mode/", "agent-org:README.md"];
  assert.deepEqual(parsePaths(PATHS_ONLY), paths);
  assert.equal(pathsAsRegion(PATHS_ONLY), "## Region\n\n```\nagent-org:src/ticket-mode/pool.ts\nagent-org:src/ticket-mode/\nagent-org:README.md\n```");
  assert.deepEqual([...(declaredRegionFiles(pathsAsRegion(PATHS_ONLY) ?? "", { rootFiles: new Set() }) ?? [])].sort(), [...paths].sort(),
    "pr:open's Region reader finds the same files the overlap wait holds on");
});

test("A11-125: a plan with both sections is read from its Paths alone, and a plan with no paths has no Region to derive", () => {
  const both = `${PATHS_ONLY}\n${REGION_ONLY}`;
  assert.deepEqual(parsePaths(both), parsePaths(PATHS_ONLY), "the Region's lines are not added");
  assert.equal(pathsAsRegion(both), pathsAsRegion(PATHS_ONLY));
  assert.equal(pathsAsRegion("## Paths\n\nnothing listed here\n"), null, "a Paths section with no paths is no Region: pr:open reads the ticket's own");
  assert.equal(pathsAsRegion(REGION_ONLY), null, "a plan with no Paths section derives none");
});

test("A11-125: a plan with no Paths section takes the prefixed lines of its fenced Region, and a bare or unfenced one is not read", () => {
  assert.deepEqual(parsePaths(REGION_ONLY), ["agent-org:src/ticket-mode/pool.ts", "nbl-ui-netbox:docs/guide.md"], "a bare README.md names no repository, so it is not read");
  assert.deepEqual(parsePaths("## Region\nagent-org:src/a.ts\n"), [], "a Region outside a fence is prose, as before");
});
