// @ts-check

/**
 * agent-org's test config: a THIN CALL into `@a11ign/toolchain` (ADR 0043, Decision 3; a11ign/a11ign#3738, the move of #3549 item 3), the one rstest
 * config every a11ign repository shares. It carries the `node:test` resolve hook and shim, `forks` isolated, the build cache on in CI only, the
 * worker cap locally, the run record and the verdict line. What is agent-org's is only where the repository is, and which files are tests.
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

export default {
  ...defineToolchainConfig({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    include: ["src/**/*.test.ts", "src/**/*.test.mjs"],
  }),
  // EVERY RUN HAS A PRIVATE `TMPDIR` (a11ign/a11ign#3854, from the #3846 incident): the globalSetup makes `~/.cache/a11ign/tmp/run-*`, each test file's worker
  // points `TMPDIR` at its own directory inside it, and the teardown names the files that left something and removes the run. Both paths are relative to `root`.
  globalSetup: ["src/private-tmp.ts"],
  setupFiles: ["src/private-tmp-setup.ts"],
};
