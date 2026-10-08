/**
 * (a11ign/a11ign#3556, toolchain row 4d of #3550) THE NUMBER OF `.mjs` FILES THE TOOL HAS CAN ONLY GO DOWN.
 *
 * The standard is TypeScript source in every repository, converted when a file is touched or moved and never in a big-bang rewrite (ADR 0043,
 * Decision 1). "As touched" is only measured if the count of what is left is pinned, so a new source file is `.ts`, and a pull request that
 * converts a `.mjs` lowers the pin in the same diff: **the pin is the progress report.**
 *
 * THE PIN IS A READING AT A COMMIT, not a fact about every tree: 210 source and 44 test files at agent-org `21eb99c`, counted by this test's own walk, less the one source file this pull request converts (`src/messaging/fake-provider.ts`). The row's own figures (204 and 244) were read at `b404507` over every tracked `.mjs`; this test counts a population
 * that reads the same in a checkout and in the copy `ci.yml`'s `gate` lays under a project, and the difference is named below.
 *
 *   - SOURCE: every non-test `.mjs` under `src/`, `host/` and `.github/`, `src/packaging/` INCLUDED where the file is the tool's. In the copy `ci.yml`'s `gate`
 *     lays under a project, `src/packaging/` also holds the project's own helpers (an `rsync --ignore-existing` of them, `tool-source.ts`), and those are not the
 *     tool's. The rule that tells them apart is mechanical: a `src/packaging/` file counts when the tool's own repository lists it (`git ls-files`, tracked or
 *     not yet added), and that repository is `AGENT_ORG_TOOL_REPO` where the gate names it, else the tool's directory. Where neither is a repository of its
 *     own the test FAILS and says so; it never falls back to leaving the directory out, which was the blind spot the first review of #204 found
 *     (`update-primary-argv.mjs` was never counted, and a new production `.mjs` there was invisible).
 *   - TEST: every `*.test.mjs` under the same roots, `src/packaging/` included (its tests are the tool's own). Stated apart because a new test is
 *     `.ts` already: 226 of them are.
 *
 * A `.ts` THAT A SHIPPED COMMAND IMPORTS CANNOT RUN YET (measured, not assumed): `/usr/bin/node` 22.22.1 on the host is built without TypeScript support
 * (`ERR_NO_TYPESCRIPT`, `process.features.typescript === false`), and node refuses to strip types under `node_modules` whatever the build. Converting
 * `src/messaging/sources/watched.mjs` (the ADR's worked example) passes `tsc` and its tests under `tsx`, and `agent-org messaging:watch`, which
 * `chairman-watch.service` runs, then dies on `ERR_UNKNOWN_FILE_EXTENSION`. That file is therefore still `.mjs` and counted here (#3556). So a file to convert is one
 * only `tsx` runs, and a new source file a shipped command imports is the one exception to "new is `.ts`": raise the pin in that diff and say why.
 *
 * IT FAILS ON A RISE ONLY. A drop passes and says the pin can be lowered, because a pin that also failed on a shrink would turn two honest
 * conversions merged together red (`lib/pin-ratchet.mjs`, #3232). A rise names the files the change added against its base, where the base
 * can be read (the gate's laid-out copy has no `.git`; `AGENT_ORG_TOOL_REPO` names where it came from), and says so where it cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { TOOL_REPO_ENV, resolveBase, scanAtBase, undeclaredGrowth } from "../lib/pin-ratchet.mjs";
import { withGitSandbox } from "../lib/git-sandbox.ts";
import { TOOL_ROOT } from "./copied-tool-fixture.ts";

// 209 to 210 (a11ign/a11ign#3516): `src/trace/gh-calls.mjs` is a NEW source file that a shipped command imports (`trace.mjs`, line 22), so it cannot be `.ts` (node on the host has no TypeScript).
// 210 to 211 (a11ign/a11ign#3536): `suite-slots.mjs` is a shipped command (`node src/suite-slots.mjs suite|run`) AND is imported by path by a11y-witness's `verify`, which runs under plain `node` with no `tsx`.
// 211 to 212 (a11ign/a11ign#3514): `src/trace/map.mjs` is a NEW source file that a shipped command imports (`trace.mjs`, `--map`), so it cannot be `.ts` (node on the host has no TypeScript). Its test is `map.test.ts`, so TEST_MJS_PIN stays 44.
// 212 to 213 (a11ign/a11ign#3563): `src/trace/wake-cache.mjs` is a NEW source file that a shipped command imports (`trace.mjs`, `--wake-cache`), so it cannot be `.ts` (node on the host has no TypeScript). Its test is `wake-cache.test.mjs`, named by the row's Acceptance command, so TEST_MJS_PIN rises 44 to 45 below.
// 213 to 214 (a11ign/a11ign#3567): `src/work-tick-health.mjs` is a NEW source file that a shipped command imports (`work-tick.mjs`, which the timer's unit runs with plain `node`), so it cannot be `.ts`. Its test is `work-tick-health.test.ts`, so TEST_MJS_PIN stays 45.
// 214 to 215 (a11ign/a11ign#3425): `src/messaging/walk.mjs` is a NEW source file that a shipped command imports (`answers.mjs` and `watch.mjs`, which `messaging:listen` and `messaging:watch` run under plain `node`), so it cannot be `.ts` (node on the host has no TypeScript).
// 215 to 216 (a11ign/a11ign#3510): `src/deferral-log.mjs` is a NEW source file that a shipped command imports (`wake.mjs`, the gate's tick), so it cannot be `.ts` (node on the host has no TypeScript).
// 216 to 217 (a11ign/a11ign#3659): `src/ci-health-liveness.mjs` is the file the row's Region names, and the gate (`work-gate.mjs`, run by the tick under plain `node`) will import it, so it cannot be `.ts` (node on the host has no TypeScript).
// 217 to 218 (a11ign/a11ign#3511): `src/trace/waterfall.mjs` is a NEW source file that a shipped command imports (`trace.mjs` and `aggregate.mjs`, `trace -- <row>` and `--aggregate`), so it cannot be `.ts` (node on the host has no TypeScript).
// 218 to 219 (a11ign/a11ign#3512): `src/trace/swimlane.mjs` is a NEW source file that a shipped command imports (`trace.mjs`, `trace -- <row> --html`), so it cannot be `.ts`.
// 219 to 220 (a11ign/a11ign#3515): `src/trace/publish.mjs` is a NEW source file that a shipped unit runs (`trace-publish.service`, `/usr/bin/node src/trace/publish.mjs`), so it cannot be `.ts` (node on the host has no TypeScript).
// 220 to 221 (a11ign/a11ign#3540): `src/messaging/selftest.mjs` is a NEW source file that a shipped command imports (`messaging:selftest` in `commands.mjs`, and the work tick's `--tick` call, both run under plain `node`), so it cannot be `.ts` (node on the host has no TypeScript).
// 221 to 222 (a11ign/a11ign#3883): `src/claim-label-strip.mjs` is a NEW source file that a shipped command imports (`work-gate.mjs`, which the work tick runs with plain `node` before any build, and `close-rows-for-merged-pr.mjs`), so it cannot be `.ts` (node on the host has no TypeScript). It is the leaf that lets the gate strip a closed row's claim labels without importing the close path (#2174). Its tests are in `closed-row-ends-instance.test.ts`, so TEST_MJS_PIN stays 52.
// 222 to 223 (a11ign/a11ign#3943): `src/idle-with-open-rows.mjs` is a NEW source file that a shipped command imports (`org-health.mjs`, a leaf `work-gate.mjs` runs with plain `node` before any build), so it cannot be `.ts`. It is the pure reading of "no engineer holds a row, and why each open row is not being built"; its tests are `src/idle-with-open-rows.test.ts` (a `.ts`), so TEST_MJS_PIN stays 52.
// 223 to 224 (a11ign/a11ign#4005): `src/work-gate/held-on-satisfied-orders.mjs` is a NEW source file that a shipped command imports (`work-gate/org-health.mjs`, which the work tick runs with plain `node` before any build), so it cannot be `.ts`. It is the registry and remote reads a release-state `Waiting-for:` needs and the two orders for a row held on a satisfied condition or an umbrella edge; its tests are `.ts` (`wait-release-states.test.ts`, `work-gate-held-on-satisfied.test.ts`), so TEST_MJS_PIN stays 52.
// 224 to 225 (a11ign/a11ign#4020): `src/work-gate/chairman-ask-orders.mjs` is a NEW source file that a shipped command imports (`work-gate.mjs`, which the work tick runs with plain `node` before any build, and `row-file.mjs`), so it cannot be `.ts` (node on the host has no TypeScript). It is the leaf that raises `needs:chairman` for a row whose declared `Waiting-for:` conditions are all true; its tests are `.ts` (`chairman-ask-on-clear.test.ts`), so TEST_MJS_PIN stays 52.
// 225 to 226 (a11ign/a11ign#4043): `src/board-truth-audit.mjs` is a NEW source file that a shipped command imports (`org-health.mjs`, which `work-gate.mjs` imports and the work tick runs with plain `node` before any build), so it cannot be `.ts`. It is the leaf holding the six board-against-reality questions.
// 226 to 227 (a11ign/a11ign#4046): `src/host-kernel.mjs` is a NEW source file that a shipped command imports (`host-units.mjs`, which `host:check` runs with plain `node`), so it cannot be `.ts` (node on the host has no TypeScript). It reads the running and installed kernels and does the drained reboot; it is also run directly (`node src/host-kernel.mjs --reboot`).
// 227 to 228 (a11ign/a11ign#4050): `src/unpark-satisfied.mjs` is a NEW source file that a shipped command imports (`work-gate.mjs`, which the work tick runs with plain `node` before any build), so it cannot be `.ts` (node on the host has no TypeScript). It un-parks a parked row whose every condition is true, on the tick; its test is `unpark-satisfied.test.mjs`, named by the row's Acceptance command, so TEST_MJS_PIN rises 56 to 57 below.
// 228 to 229 (a11ign/a11ign#4071): `src/trace/otel-receiver.mjs` is a NEW source file that a shipped unit runs (`otel-receiver.service`, `/usr/bin/node src/trace/otel-receiver.mjs`), so it cannot be `.ts` (node on the host has no TypeScript).
// 229 to 230 (a11ign/a11ign#4078): `src/row-tracker.mjs` is a NEW source file that a shipped command imports (`row-file.mjs`, `pnpm run row-file`, run with plain `node`), so it cannot be `.ts` (node on the host has no TypeScript). It is the pure function that names a row's tracker.
// 230 to 231 (a11ign/a11ign#4064): `src/work-gate/ready-when-unblocked.mjs` is a NEW source file that a shipped command imports (`work-gate.mjs`, which the work tick runs with plain `node` before any build), so it cannot be `.ts` (node on the host has no TypeScript). It promotes a cleared row its filer declared `Ready-when-unblocked: yes`, with no wake; its test is `ready-when-unblocked.test.mjs`, named by the row's Acceptance command, so TEST_MJS_PIN rises 64 to 65 below.
// 231 to 232 (a11ign/a11ign#4073): `src/trace/growth.mjs` is a NEW source file that is a command run with plain `node` (`node src/trace/growth.mjs --from=… --to=…`, the table the row posts on #4055), so it cannot be `.ts` (node on the host has no TypeScript).
// 232 to 233 (a11ign/a11ign#4074): `src/trace/triage-sample.mjs` is a NEW source file the row's Acceptance command runs under plain `node` (a module `trace` can import and a command that runs on its own), so it cannot be `.ts`.
// 233 to 234 (a11ign/a11ign#4123): `src/defect-class-line.mjs` is the leaf the row's Region names, and shipped commands import it (`pr-open.mjs`, `row-file.mjs`, `acceptance-commands.mjs`, run with plain `node`), so it cannot be `.ts` (node on the host has no TypeScript). It is the one parse of a defect row's `Class:` line, shared by `pr:open` and CI.
// 234 to 235 (a11ign/a11ign#4126): `src/class-repeat.mjs` is a NEW source file that a shipped command imports (`org-health.mjs`, a leaf `work-gate.mjs` runs with plain `node` before any build), so it cannot be `.ts` (node on the host has no TypeScript).
// 235 to 236 (a11ign/a11ign#4124): `src/found-by-chairman.mjs` is a NEW source file that a shipped command imports (`board-data.mjs`, which `board-document.mjs` and `board-report.mjs` run with plain `node`), so it cannot be `.ts` (node on the host has no TypeScript).
// 236 to 237 (a11ign/a11ign#4148): `src/tick-snapshot.mjs` is a NEW source file that a shipped command imports (`work-tick.mjs`, run with plain `node` by the work-tick unit), so it cannot be `.ts` (node on the host has no TypeScript loader).
// 237 to 238 (a11ign/a11ign#4065): `src/work-gate/org-health-suppression.mjs` is a NEW source file that a shipped command imports (`work-gate.mjs`, which the work tick runs with plain `node` before any build), so it cannot be `.ts` (node on the host has no TypeScript). It holds the `org-health` orders to `ceo` that repeat and carries the rest as a digest; its test is `org-health-suppression.test.mjs`, named by the row's Acceptance command, so TEST_MJS_PIN rises 70 to 71 below.
// 238 to 239 (a11ign/a11ign#4175): `src/unwaited-stock-rows.mjs` is a NEW source file that a shipped command imports (`org-retro.mjs`, which `work-gate.mjs` runs with plain `node` before any build), so it cannot be `.ts` (node on the host has no TypeScript). It reads the backlog or parked rows no wait moves for the daily retrospective; its test is `unwaited-stock-rows.test.mjs`, named by the row's Acceptance command, so TEST_MJS_PIN rises 71 to 72 below.
const SOURCE_MJS_PIN = 239;
// 44 to 45 (a11ign/a11ign#3563): `wake-cache.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 45 to 46 (a11ign/a11ign#3425): `walk.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 46 to 47 (a11ign/a11ign#3510): `deferral-log.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 47 to 48 (a11ign/a11ign#3659): `ci-health-liveness.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 48 to 49 (a11ign/a11ign#3511): `waterfall.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 49 to 50 (a11ign/a11ign#3512): `swimlane.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 50 to 51 (a11ign/a11ign#3515): `publish.test.mjs` is the test file the row's Acceptance command names, so it is `.mjs`.
// 51 to 52 (a11ign/a11ign#3540): `selftest.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 52 to 53 (a11ign/a11ign#3982): `forme-button.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 53 to 54 (a11ign/a11ign#4043): `board-truth-audit.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 54 to 55 (a11ign/a11ign#4046): `host-kernel.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 55 to 56 (a11ign/a11ign#4068): `wake-order-id.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 56 to 57 (a11ign/a11ign#4050): `unpark-satisfied.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 57 to 58 (a11ign/a11ign#4071): `otel-receiver.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`, which cannot import a `.ts`), so it is `.mjs`.
// 58 to 59 (a11ign/a11ign#4078): `row-tracker.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 59 to 60 (a11ign/a11ign#4070): `wake-calm-arm.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 60 to 62 (a11ign/a11ign#4080): `ready-label-audit.test.mjs` and `board-report-trackers.test.mjs` are two of the test files the row's Acceptance command names (run under plain `node --test`), so they are `.mjs`.
// 62 to 63 (a11ign/a11ign#4139): `ci-changeset-on-push.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 63 to 64 (a11ign/a11ign#4076): `codex-price.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 64 to 65 (a11ign/a11ign#4064): `ready-when-unblocked.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 65 to 66 (a11ign/a11ign#4073): `growth.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`, which cannot import a `.ts`), so it is `.mjs`.
// 66 to 67 (a11ign/a11ign#4074): `triage-sample.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 67 to 68 (a11ign/a11ign#4123): `defect-class-line.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 68 to 69 (a11ign/a11ign#4126): `class-repeat.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 69 to 70 (a11ign/a11ign#4124): `found-by-chairman.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 70 to 71 (a11ign/a11ign#4065): `org-health-suppression.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 71 to 72 (a11ign/a11ign#4072): `wake-clear-instead-of-compact.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
// 72 to 73 (a11ign/a11ign#4175): `unwaited-stock-rows.test.mjs` is the test file the row's Acceptance command names (run under plain `node --test`), so it is `.mjs`.
const TEST_MJS_PIN = 73;

const ROOTS = ["src", "host", ".github"];
const isTest = (path: string): boolean => path.endsWith(".test.mjs");
const isSource = (path: string): boolean => path.endsWith(".mjs") && !isTest(path);
const PACKAGING = "src/packaging/";

/** The tool's `.mjs` files under `root` that `keep` accepts, as `src/...` paths, sorted. */
function mjsFiles(root: string, keep: (path: string) => boolean): string[] {
  return ROOTS.filter((dir) => existsSync(join(root, dir))).flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => `${dir}/${entry.split("\\").join("/")}`))
    .filter((path) => !path.includes("node_modules/") && keep(path)).sort();
}

/**
 * The `src/packaging/` files the tool's own repository lists, tracked or not yet added, or why that cannot be read. The gate's copy of the tool also holds the project's
 * helpers there, so the walk of the live tree is filtered by this set; a base archive holds only the tool's files and needs no filter.
 */
function ownedPackaging(repository: string): Set<string> | string {
  try {
    const run = (args: string[]): string => execFileSync("git", ["-C", repository, ...args], { env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const top = realpathSync(run(["rev-parse", "--show-toplevel"]).trim());
    if (top !== realpathSync(repository)) return `\`${repository}\` is inside the repository at \`${top}\`, not a repository of its own`;
    return new Set(run(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", PACKAGING]).split("\0").filter(Boolean));
  } catch (error) {
    return `\`${repository}\` is not a repository (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
}

/** The tool's non-test `.mjs` source under `root`: `src/packaging/` files only where `owned` lists them, so a project's copied helpers are not the tool's. */
const sourceFiles = (root: string, owned: Set<string>): string[] => mjsFiles(root, (path) => isSource(path) && (!path.startsWith(PACKAGING) || owned.has(path)));

type Judgement = { ok: boolean; message: string };

/** What a claimant is told to do about a rise. A shipped command cannot import a `.ts` yet, so that one case raises the pin and says why (product-manager, #3556). */
const RISE_RULE: Record<string, string> = {
  source: "a new source file is `.ts`, unless a shipped command imports it; then raise the pin in this diff and say why",
  test: "a new test is `.ts`",
};

/** A rise is refused, naming `added` where it is known; a drop passes and says the pin can come down. */
function judgeCount({ kind, current, pin, added }: { kind: string; current: string[]; pin: number; added: string[] | string }): Judgement {
  if (current.length > pin) {
    const named = typeof added === "string" ? `which of them is new could not be read (${added})` : added.length === 0 ? "none is new against the base, so the pin itself sits below the tree" : `added since the base: ${added.join(", ")}`;
    return { ok: false, message: `${current.length} ${kind} \`.mjs\` files, pinned at ${pin}: ${RISE_RULE[kind] ?? RISE_RULE.source}, or this pull request converts another \`.mjs\` and lowers the pin with it; ${named}` };
  }
  if (current.length < pin) return { ok: true, message: `${kind}: ${current.length} \`.mjs\` files against a pin of ${pin}: the pin can be lowered to ${current.length}` };
  return { ok: true, message: `${kind}: ${current.length} \`.mjs\` files, equal to the pin` };
}

/** The files `current` holds that the base did not, or why the base could not be read. The gate's laid-out copy has no `.git` of its own. */
function addedSinceBase(current: string[], keep: (path: string) => boolean, { repository, env }: { repository: string; env: NodeJS.ProcessEnv }): string[] | string {
  const base = resolveBase(repository, env);
  if ("unreadable" in base) return base.unreadable;
  const atBase = scanAtBase({ repo: repository, ref: base.ref, paths: ROOTS, scan: (root) => mjsFiles(root, keep) });
  return undeclaredGrowth({ current, base: atBase, declared: [] });
}

/** The repository the tool's own files are listed from: where the gate laid the tool out FROM, else the tool's directory. */
const TOOL_REPOSITORY = process.env[TOOL_REPO_ENV] || TOOL_ROOT;

const KINDS = [
  { kind: "source", pin: SOURCE_MJS_PIN, keep: isSource },
  { kind: "test", pin: TEST_MJS_PIN, keep: isTest },
];

for (const { kind, pin, keep } of KINDS) {
  test(`the tool's ${kind} \`.mjs\` count has not risen above its pin`, (t) => {
    const owned = ownedPackaging(TOOL_REPOSITORY);
    assert.ok(typeof owned !== "string", `which \`src/packaging/\` files are the tool's and which the project's cannot be told, so the count would be wrong: ${owned}`);
    const current = kind === "source" ? sourceFiles(TOOL_ROOT, owned) : mjsFiles(TOOL_ROOT, keep);
    const verdict = judgeCount({ kind, current, pin, added: current.length > pin ? addedSinceBase(current, keep, { repository: TOOL_REPOSITORY, env: process.env }) : [] });
    if (verdict.ok) t.diagnostic(verdict.message);
    assert.ok(verdict.ok, verdict.message);
  });
}

test("the ratchet RUNS: the walk finds files in both populations", () => {
  // POSITIVE CONTROL for the emptiness a count of zero would hide: `assert.ok(count <= pin)` is also true of a walk that finds nothing.
  const owned = ownedPackaging(TOOL_REPOSITORY);
  assert.ok(typeof owned !== "string", `${owned}`);
  const source = sourceFiles(TOOL_ROOT, owned);
  assert.ok(source.includes("src/work-gate.mjs"), "the walk no longer finds a source file that is known to be there");
  assert.ok(source.includes("src/packaging/update-primary-argv.mjs"), "the walk no longer counts the tool's own `.mjs` under src/packaging/, the blind spot the first review found");
  assert.ok(mjsFiles(TOOL_ROOT, isTest).length > 0, "the walk finds no `.mjs` test at all");
});

const FIXTURE = ["src/a.mjs", "src/b.mjs", "src/c.mjs"];

test("a list with one extra `.mjs` is REFUSED, naming the file", () => {
  const verdict = judgeCount({ kind: "source", current: [...FIXTURE, "src/new-thing.mjs"], pin: FIXTURE.length, added: ["src/new-thing.mjs"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /src\/new-thing\.mjs/);
  assert.match(verdict.message, /is `\.ts`/);
});

test("the refusal tells a claimant the one case where the pin is raised, and the README says the same", () => {
  const { message } = judgeCount({ kind: "source", current: [...FIXTURE, "src/new-thing.mjs"], pin: FIXTURE.length, added: ["src/new-thing.mjs"] });
  assert.match(message, /a new source file is `\.ts`, unless a shipped command imports it; then raise the pin in this diff and say why/);
  assert.doesNotMatch(judgeCount({ kind: "test", current: [...FIXTURE, "src/x.test.mjs"], pin: FIXTURE.length, added: [] }).message, /shipped command/, "a test is never imported by a command");
  assert.match(readFileSync(join(TOOL_ROOT, "README.md"), "utf8"), /unless a shipped command imports it; then raise the pin in this diff and say why/);
});

test("a rise whose base cannot be read is still refused, and says why it names no file", () => {
  const verdict = judgeCount({ kind: "source", current: [...FIXTURE, "src/new-thing.mjs"], pin: FIXTURE.length, added: "no .git here" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /could not be read \(no \.git here\)/);
});

test("a list with one fewer passes and says the pin can be lowered", () => {
  const verdict = judgeCount({ kind: "source", current: FIXTURE.slice(1), pin: FIXTURE.length, added: [] });
  assert.equal(verdict.ok, true);
  assert.match(verdict.message, /the pin can be lowered to 2/);
});

test("a list equal to the pin passes and does not claim the pin can be lowered", () => {
  const verdict = judgeCount({ kind: "source", current: FIXTURE, pin: FIXTURE.length, added: [] });
  assert.equal(verdict.ok, true);
  assert.doesNotMatch(verdict.message, /can be lowered/);
});

test("against a real base the file a commit added is named, and an unchanged tree names nothing", () => {
  withGitSandbox((box) => {
    const QUEUE = { GITHUB_EVENT_NAME: "merge_group" }; // the merge commit's first parent is the base, so no `origin/main` is needed
    // `git archive` refuses a path the base lacks, so the sandbox holds all three roots the way the tool does.
    for (const dir of ROOTS) mkdirSync(join(box.dir, dir), { recursive: true });
    for (const dir of ROOTS) writeFileSync(join(box.dir, dir, ".keep"), "");
    writeFileSync(join(box.dir, "src/a.mjs"), "");
    box.run(["add", "-A"]);
    box.commit("base");
    writeFileSync(join(box.dir, "src/new-thing.mjs"), "");
    box.run(["add", "-A"]);
    box.commit("adds one");
    const current = mjsFiles(box.dir, isSource);
    assert.deepEqual(addedSinceBase(current, isSource, { repository: box.dir, env: QUEUE }), ["src/new-thing.mjs"]);
    box.run(["checkout", "-q", "HEAD^1"]);
    box.run(["checkout", "-q", "-b", "same"]);
    writeFileSync(join(box.dir, "src/a.mjs"), "// edited\n");
    box.run(["add", "-A"]);
    box.commit("edits only");
    assert.deepEqual(addedSinceBase(mjsFiles(box.dir, isSource), isSource, { repository: box.dir, env: QUEUE }), []);
  });
});

test("a new `.mjs` under src/packaging/ is counted, and a helper the gate copied in from the project is not", () => {
  // THE REVIEWER'S MUTATION on #204 (`src/packaging/zzz-review-blind-spot.mjs`, 0 red) as a standing case. `laid` is the gate's copy: the tool's tree, plus a project helper beside it.
  withGitSandbox((box) => {
    mkdirSync(join(box.dir, "src/packaging"), { recursive: true });
    writeFileSync(join(box.dir, "src/packaging/tool.mjs"), "");
    box.run(["add", "-A"]);
    box.commit("base");
    const laid = join(box.dir, "laid");
    cpSync(join(box.dir, "src"), join(laid, "src"), { recursive: true });
    writeFileSync(join(laid, "src/packaging/project-helper.mjs"), "");
    const before = ownedPackaging(box.dir);
    assert.ok(typeof before !== "string", String(before));
    assert.deepEqual(sourceFiles(laid, before), ["src/packaging/tool.mjs"], "the tool's file counts and the project's copy does not");
    for (const root of [box.dir, laid]) writeFileSync(join(root, "src/packaging/zzz-new.mjs"), "");
    const after = ownedPackaging(box.dir);
    assert.ok(typeof after !== "string", String(after));
    assert.deepEqual(sourceFiles(laid, after), ["src/packaging/tool.mjs", "src/packaging/zzz-new.mjs"], "a new tool file under src/packaging/ is counted, added to git or not");
  });
});

test("which packaging files are the tool's cannot be told outside a repository of its own, and the test says so instead of leaving the directory out", () => {
  withGitSandbox((box) => {
    const inner = join(box.dir, "inner");
    mkdirSync(inner);
    assert.equal(typeof ownedPackaging(inner), "string");
    assert.match(String(ownedPackaging(inner)), /not a repository of its own/);
  });
});

test("a directory that is not a repository of its own names no file and says so", () => {
  withGitSandbox((box) => {
    const inner = join(box.dir, "inner");
    mkdirSync(inner);
    const reason = addedSinceBase(["src/a.mjs"], isSource, { repository: inner, env: {} });
    assert.equal(typeof reason, "string");
  });
});

test("each pin is a number written in this file, never one read from the tree", () => {
  // POSITIVE CONTROL for the ratchet that compares with a count read at run time and so can never fail: it would be spelled `= mjsFiles(...).length`, and this
  // test goes red on it. The mutation check is `const SOURCE_MJS_PIN = mjsFiles(TOOL_ROOT, isSource).length;`.
  const text = readFileSync(new URL(import.meta.url), "utf8");
  for (const name of ["SOURCE_MJS_PIN", "TEST_MJS_PIN"]) assert.match(text, new RegExp(`^const ${name} = \\d+;$`, "m"), `${name} is not a literal number`);
});
