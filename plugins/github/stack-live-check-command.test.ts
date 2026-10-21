// no-token: none -- every case is refused before the command reaches GitHub: no gh runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMMAND = fileURLToPath(new URL("./stack-live-check-command.ts", import.meta.url));

/** Runs the command with `args` and a PATH with no gh on it, so a call that got past the checks would fail by name. */
const run = (...args: string[]) => spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });

test("a flag the command does not read is refused with the usage, exit 2, and nothing is asked of GitHub", () => {
  for (const args of [["--bogus"], ["--repo=a/b"], ["--", "--repo", "a/b"]]) {
    const ran = run(...args);
    assert.equal(ran.status, 2, args.join(" "));
    assert.match(ran.stderr, /agent-org ticket:stack-live-check \[--repo <owner\/repo>\]: \S+ is not a flag this command reads/, args.join(" "));
  }
});

test("a repository that is not owner/repo is refused, exit 2, and nothing is asked of GitHub", () => {
  for (const args of [["--repo", "agent-org"], ["--repo"], ["--repo", "a/b/c"]]) {
    const ran = run(...args);
    assert.equal(ran.status, 2, args.join(" "));
    assert.match(ran.stderr, /--repo .* is not owner\/repo/, args.join(" "));
  }
});
