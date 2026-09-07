import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveChromeBinary } from "../../../../scripts/board-document.mjs";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/board-document.mjs", import.meta.url));

/**
 * #280: `board-report.yml` had never once succeeded, on any route -- the publish step hardcoded
 * `/Applications/Google Chrome.app/...`, which does not exist on the `ubuntu-latest` runner the workflow
 * has run on since it was written. `resolveChromeBinary` replaces that literal with a search: an env-var
 * override, a list of known install locations across both OSes, then a PATH lookup -- each one checked
 * with `existsSync`/`which` rather than executed, so a wrong guess reports "not found" instead of a
 * `spawnSync ... ENOENT` stack trace that names neither the missing browser nor what to do about it.
 */

test("resolveChromeBinary finds the real Chrome on THIS machine, with no overrides", () => {
  // Not mocked, deliberately: this repo's own capture fleet needs a real Chromium on this Mac, so this is
  // the one assertion that exercises the actual default candidate list against actual disk state.
  const found = resolveChromeBinary();
  assert.ok(found.length > 0, "resolveChromeBinary() returned nothing on a machine known to have Chrome");
});

test("the env var override is used when it points at something real", () => {
  const found = resolveChromeBinary({
    env: { BOARD_DOCUMENT_CHROME: "/fake/but/checked/chrome" },
    exists: (p) => p === "/fake/but/checked/chrome",
  });
  assert.equal(found, "/fake/but/checked/chrome");
});

test("the env var override REFUSES with a readable message when it points at nothing, rather than trying candidates", () => {
  assert.throws(
    () => resolveChromeBinary({ env: { BOARD_DOCUMENT_CHROME: "/nonexistent/chrome" }, exists: () => false }),
    /BOARD_DOCUMENT_CHROME=\/nonexistent\/chrome does not exist/,
  );
});

test("falls through the candidate list to the one that exists", () => {
  const found = resolveChromeBinary({
    env: {},
    exists: (p) => p === "/usr/bin/google-chrome-stable",
  });
  assert.equal(found, "/usr/bin/google-chrome-stable");
});

test("falls back to PATH when no candidate path exists", () => {
  const found = resolveChromeBinary({
    env: {},
    exists: () => false,
    which: (name) => (name === "chromium" ? "/snap/bin/chromium" : ""),
  });
  assert.equal(found, "/snap/bin/chromium");
});

test("REFUSES with a readable sentence naming the env var, never a raw ENOENT, when nothing is found anywhere", () => {
  assert.throws(
    () => resolveChromeBinary({ env: {}, exists: () => false, which: () => "" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /No Chrome or Chromium found/);
      assert.match(err.message, /BOARD_DOCUMENT_CHROME/);
      assert.doesNotMatch(err.message, /ENOENT|spawnSync/, "must not leak the OS-level spawn failure");
      return true;
    },
  );
});

/**
 * A behavioural test on `resolveChromeBinary()` alone cannot catch a mutation that bypasses the CALL to
 * it -- reintroducing a bare hardcoded path at the call site in `main()` leaves this function, and every
 * test above, untouched and green. This is the source-scan that closes that gap, the same shape as
 * `route-navigated-is-not-evidence.test.ts` (#250): the hazard is a future (or REVERTED) line, and `tsc`
 * cannot see "this call site stopped calling the resolver".
 */
test("main()'s PDF path actually CALLS resolveChromeBinary(), rather than hardcoding a path at the call site", () => {
  const code = readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const chromeAssignment = code.match(/\bchrome\s*=\s*([^;]+);/);
  assert.ok(chromeAssignment, "no `chrome = ...` assignment found in board-document.mjs -- the call site "
    + "moved or was renamed, and this scan needs updating rather than silently examining nothing");
  assert.match(chromeAssignment[1], /resolveChromeBinary\(\)/,
    `the call site assigns \`chrome = ${chromeAssignment[1].trim()}\`, not the resolver's return value -- `
      + "this is issue #280's exact defect: a hardcoded path bypassing the cross-platform search");
});
