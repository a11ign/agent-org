// no-token: none -- `perPullRequestOrders` and `decide` over in-memory pull requests, and a child `node` whose state directory is a throwaway copy; nothing reaches `gh`, `git`, herdr or the fleet
/**
 * agent-org#1187: `holds.recheck` IS WIRED TO ITS FLAG, AND THE FLAG HAS A SWITCH.
 *
 * THE DEFECT (agent-org#1165, shipped OFF): `sharedFileOrders` takes `{ recheck }`, defaulting to OFF, and nothing passed it. `perPullRequestOrders` called
 * `sharedFileOrders(prs)` and `decide` called `perPullRequestOrders` with a clock, so the re-check could not be turned on by anyone, and the flag was in no
 * registry, so `machinery:flag on holds.recheck` was refused as "not a flag any module reads" and the digest listed it as `flag-without-a-switch`.
 *
 * THE FIXTURE is #1165's own hold (#149 held behind #148 on a file #148 has since dropped), because it is the one case where the flag changes the output: every
 * "off" below is read against the same call that, with the flag on, says something.
 *
 * WHAT EACH TEST SEES, because "the option is passed" proved nothing in #1165 (the option existed and nothing passed it):
 *   (1) `perPullRequestOrders` passes `recheck` to `sharedFileOrders`: ON orders the release, OFF and every older way of calling it (a bare clock, no clock) do not;
 *   (2) `decide` passes the flag's reading to it, and the reading ITSELF comes from the state directory when the caller passes none -- through a child process,
 *       because `decide` has no state-directory parameter and a child with `A11IGN_SHADOW_STATE_DIR` is how the shadow runner gives it one;
 *   (3) `machinery:flag on|off holds.recheck` is what writes that state, so the switch and the reader are one record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "../host-config.ts";
import { main as machineryFlag } from "../machinery-flag.ts";
import { perPullRequestOrders } from "./pr-orders.ts";
import { readReenqueueState } from "./causes/pr-ejected.ts";
import { RECHECK_FLAG, sharedFileOrders } from "./shared-file-orders.ts";
import { decide, recheckFlagOn } from "./tick/tick-decisions-and-flags.ts";

type Order = { session: string; cause: string; subject: string; prompt: string; causeKey: string };
type Pr = { number: number; files: { path: string }[]; changedFiles: number; labels: { name: string }[]; body: string; comments: unknown[]; headRefName: string;
  mergeStateStatus: string; statusCheckRollup: unknown[]; reviewDecision: string | null; isDraft: boolean };

const NOW = Date.parse("2026-10-12T12:00:00Z");
const SESSION = "worker-agent-org-1187";
const quiet = () => undefined;
const RELEASE = /#149 is held behind #148 \(`Waiting-for: merged`\), but it no longer shares an open file with it/;

const prOf = (number: number, paths: string[], over: Partial<Pr> = {}): Pr => ({
  number, files: paths.map((path) => ({ path })), changedFiles: paths.length, headRefName: `agent/some-slug-${number}`, labels: [{ name: `session:worker-${number}` }],
  body: "", comments: [], mergeStateStatus: "CLEAN", statusCheckRollup: [], reviewDecision: null, isDraft: false, ...over });
/** #148 dropped the shared file; #149 is still held behind it. The only fact the flag changes the reading of. */
const HELD = (): Pr[] => [prOf(148, ["src/a.ts"]), prOf(149, ["src/shared.ts"], { labels: [{ name: "session:worker-149" }, { name: "hold:worker-149" }], body: "Waiting-for: merged #148" })];
/** The same two with the overlap still there: a sequence the hold is doing its job for, which the flag leaves alone. */
const OVERLAPPING = (): Pr[] => [prOf(148, ["src/a.ts", "src/shared.ts"]), HELD()[1]];

const releases = (orders: Order[]) => orders.filter((order) => RELEASE.test(order.prompt));
const perPr = (prs: Pr[], now?: number | { nowMs?: number; recheck?: boolean }) => perPullRequestOrders(prs, null, null, now) as Order[];

test("(1) perPullRequestOrders passes `recheck` to sharedFileOrders: ON orders the release of the hold whose overlap has gone, and OFF does not", () => {
  assert.equal(releases(sharedFileOrders(HELD(), quiet, { recheck: true }) as Order[]).length, 1, "POSITIVE CONTROL: the fixture is one the re-check releases");
  const on = releases(perPr(HELD(), { nowMs: NOW, recheck: true }));
  assert.equal(on.length, 1, "on: the release reaches the order path");
  assert.equal(on[0].session, "worker-149", "to the owner of the held pull request");
  assert.equal(on[0].cause, "pr-merge-conflict", "filed under the existing cause");
  assert.equal(releases(perPr(HELD(), { nowMs: NOW, recheck: false })).length, 0, "off, said");
  assert.equal(releases(perPr(HELD(), { nowMs: NOW })).length, 0, "off, by omission: an options bag with no `recheck` is today's call");
});

test("(1) OFF is today's output byte for byte, whichever way the clock is passed, and it is what sharedFileOrders says with no option", () => {
  for (const make of [HELD, OVERLAPPING]) {
    const today = JSON.stringify(perPr(make(), NOW));
    assert.equal(JSON.stringify(perPr(make(), { nowMs: NOW, recheck: false })), today, "`{ recheck: false }` is the bare clock");
    assert.equal(JSON.stringify(perPr(make(), { nowMs: NOW })), today, "an omitted `recheck` is the bare clock");
    const shared = (orders: Order[]) => orders.filter((order) => order.causeKey.includes("/shares/") || RELEASE.test(order.prompt));
    assert.equal(JSON.stringify(shared(perPr(make(), NOW))), JSON.stringify(shared(sharedFileOrders(make(), quiet) as Order[])), "the shared-file part is `sharedFileOrders(prs)` unchanged");
  }
});

test("(1) ON changes nothing for a hold that is still a sequence, which is the control for the release above", () => {
  assert.equal(JSON.stringify(perPr(OVERLAPPING(), { nowMs: NOW, recheck: true })), JSON.stringify(perPr(OVERLAPPING(), NOW)), "overlap still there: the flag has nothing to say");
});

test("(2) decide passes the reading through: `recheck: true` orders the release, `false` does not, and the order is the one perPullRequestOrders made", () => {
  // prOwnerRouting pinned OFF: an omitted reading is the host's `prs.ownerRouting` (#1325), ON here, and the fixture PRs have no `isCrossRepository: false`, so the held PR reads as outside and its release is withheld.
  const ordersOf = (recheck: boolean) => decide({ prs: HELD(), readyRows: [], nowMs: NOW, recheck, prOwnerRouting: false }) as Order[];
  assert.equal(releases(ordersOf(true)).length, 1, "on");
  assert.equal(releases(ordersOf(false)).length, 0, "off");
});

test("(2) recheckFlagOn: a caller's reading wins, and absent it the flag is read from the state directory it is given", () => {
  const dir = tmpDir("recheck-flag-on-");
  const read = () => readReenqueueState(dir, quiet);
  assert.equal(recheckFlagOn({ asked: undefined }, read), false, "POSITIVE CONTROL: no state file reads OFF");
  assert.equal(machineryFlag(["on", RECHECK_FLAG, `--session=${SESSION}`], { dir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(recheckFlagOn({ asked: undefined }, read), true, "after `machinery:flag on holds.recheck`, the reader says ON");
  assert.equal(recheckFlagOn({ asked: false }, read), false, "a caller that passes `false` is not overridden by the file");
  assert.equal(machineryFlag(["off", RECHECK_FLAG, `--session=${SESSION}`], { dir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(recheckFlagOn({ asked: undefined }, read), false, "after `off`, the reader says OFF again");
  assert.equal(recheckFlagOn({ asked: true }, read), true, "and a caller that passes `true` is not overridden by it");
});

/** The state directory a child `node` is given as its own: the shadow runner's way (`SHADOW_STATE_DIR_ENV`), the only one `decide` has. */
function releasesFromChild(stateDir: string, scratch: string): number {
  const prsFile = join(scratch, "prs.json");
  const script = join(scratch, "tick-child.mjs");
  writeFileSync(prsFile, JSON.stringify(HELD()));
  writeFileSync(script, [
    `import { readFileSync } from "node:fs";`,
    `const [tick, prsFile] = process.argv.slice(2);`,
    `const { decide } = await import(tick);`,
    `const prs = JSON.parse(readFileSync(prsFile, "utf8"));`,
    `process.stdout.write(JSON.stringify(decide({ prs, readyRows: [], nowMs: ${NOW} }).map((order) => order.prompt)));`,
  ].join("\n"));
  const out = execFileSync(process.execPath, [script, pathToFileURL(join(import.meta.dirname, "tick", "tick-decisions-and-flags.ts")).href, prsFile], {
    encoding: "utf8", env: { ...process.env, [SHADOW_STATE_DIR_ENV]: stateDir }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return (JSON.parse(out) as string[]).filter((prompt) => RELEASE.test(prompt)).length;
}

test("(2) decide READS THE FLAG ITSELF when the caller passes none: the state directory's record is what turns the release on", () => {
  const scratch = tmpDir("recheck-switch-child-");
  const stateDir = join(scratch, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, SHADOW_COPY_MARKER), "");
  assert.equal(releasesFromChild(stateDir, scratch), 0, "no state file: the flag is OFF, and nothing is released (today's tick)");
  assert.equal(machineryFlag(["on", RECHECK_FLAG, `--session=${SESSION}`], { dir: stateDir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(releasesFromChild(stateDir, scratch), 1, "after `machinery:flag on holds.recheck` the same tick releases the hold");
  assert.equal(machineryFlag(["off", RECHECK_FLAG, `--session=${SESSION}`], { dir: stateDir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(releasesFromChild(stateDir, scratch), 0, "after `off` it does not");
});

test("(3) `machinery:flag on holds.recheck` is accepted: the flag is in the registry the command checks, and `list` names it", () => {
  const dir = tmpDir("recheck-flag-switch-");
  const out: string[] = [];
  const err: string[] = [];
  const code = machineryFlag(["list"], { dir, now: NOW, out: (text) => out.push(text), err: (text) => err.push(text) });
  assert.equal(code, 0, err.join(""));
  assert.match(out.join(""), new RegExp(`^${RECHECK_FLAG.replace(".", "\\.")}  OFF$`, "m"), "listed as a flag a module reads (no `(no module reads it)`), and OFF");
  assert.equal(machineryFlag(["on", RECHECK_FLAG, `--session=${SESSION}`], { dir, now: NOW, out: quiet, err: (text) => err.push(text) }), 0, err.join(""));
});
