// @ts-check

/**
 * agent-org's test config: a THIN CALL into `@a11ign/toolchain` (ADR 0043, Decision 3; a11ign/a11ign#3738, the move of #3549 item 3), the one rstest
 * config every a11ign repository shares. It carries the `node:test` resolve hook and shim, `forks` isolated, the build cache on in CI only, the
 * worker cap locally, the run record and the verdict line. What is agent-org's is only where the repository is, which files are tests, and
 * which of them have not converted yet.
 *
 * THE HOOK IS THE PACKAGE'S, NOT A COPY HERE. `defineToolchainConfig` loads `register-node-test-alias.mjs` into every worker itself, so this
 * repository has no hook of its own to keep in step with the package's (a second copy is what ADR 0043 Decision 3 rejected).
 *
 * `include` IS THE TWO GLOBS `node --test` WAS GIVEN, `.ts` AND `.mjs`: a11ign's own include matches `*.test.ts` only, and agent-org holds
 * `*.test.mjs` files too. `root` is this file's repository root, not the working directory, because the `gate` job runs it from the project's
 * root with the tool laid out at `packages/agent-org`.
 *
 * THE WORKER CAP IS THE PACKAGE'S: half the cores per run, and rstest's default in CI. #3536 holds the host to two slotted suites, so two runs
 * of eight workers are the 16 cores; a run that takes no slot (a bare `rstest run`) is a further eight.
 */
import { fileURLToPath } from "node:url";
import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";

/**
 * THE FILES THAT DID NOT CONVERT, AND WHY: each fails under rstest for a reason that is in the TEST, and a test file is not this row's to edit
 * (#3738's Region names no test file; one slice per directory is amended in by `product-manager`). NONE IS DROPPED: the `gate` job runs exactly
 * this list under `node --import tsx --test`, and counts the two sets against the files on disk, so a file in neither fails the job.
 * Measured on `64bde21` under `@rstest/core` 0.12.3 and `@a11ign/toolchain` 0.1.2; a slice that fixes a file deletes its line.
 *
 * - `describe()` WITH AN OPTION: the shim refuses every `describe()` option by name (#1383), because a dropped `{ skip }` would RUN the suite
 *   node:test skips. The shim has no `describe.skip` either (probed: `undefined`), so the fix is `{ skip }` on each `test()` (mapped), or the shim
 *   learning `describe` options, which is a `@a11ign/toolchain` change and not this row's.
 * - `import()` OF AN ABSOLUTE PATH WITH A `?query`: rstest cannot find it ("Cannot find module '/tmp/...' imported from @rstest/core/dist").
 *   Probed: the same file as a `file:` URL (`pathToFileURL(path).href`, with or without the query) imports, a `/* webpackIgnore: true *\/`
 *   comment does not rescue the path form. Fix in the test: import the `file:` URL.
 * - ONE MODULE IMPORTED TWICE, BUNDLED AND NATIVE: a static `import` is rstest's copy and `import(fileUrl)` is Node's, so `value === createInbound`
 *   is false across them. Fix in the test: take both from the same kind of import.
 * - `process.kill(process.pid, 0)`: the rstest worker replaces `process.kill` with a guard that throws "process.kill unexpectedly called with"
 *   for its own pid, which the code under test uses to ask whether a pid is alive. Fix in the test: ask about a pid that is not the worker's.
 * - `mock.timers`: the shim maps `mock.fn` and refuses the rest. ADR 0043 Consequence 2 names this file: port it to rstest's fake timers.
 */
export const NOT_YET_CONVERTED = [
  "src/messaging/ask-ceo.test.mjs", // describe() with { skip }
  "src/messaging/converse.test.mjs", // describe() with { skip }
  "src/messaging/inbound.test.mjs", // one module imported twice, bundled and native
  "src/messaging/providers/telegram/poll.test.mjs", // process.kill(process.pid, 0), through acquireLock
  "src/packaging/row-claim-stale-rule.test.ts", // import() of a path built at run time
  "src/work-gate-stale-blocker-cleared.test.ts", // mock.timers
  "src/work-tick-health.test.ts", // process.kill(process.pid, 0), through processAlive
];

export default {
  ...defineToolchainConfig({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    include: ["src/**/*.test.ts", "src/**/*.test.mjs"],
  }),
  // Appended to rstest's own default (`**/node_modules/**`, `**/dist/**`), which a plain array does not replace.
  exclude: NOT_YET_CONVERTED,
};
