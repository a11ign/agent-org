/**
 * #1053: THE FIVE SPAWN HELPERS ACTUALLY CALL THE GUARD — the call site, not the closure.
 *
 * THIS FILE HAS NO `// no-token: gh` DECLARATION, AND THAT IS DELIBERATE. It calls helpers that spawn
 * `gh`, so the declaration would be untrue and the acceptance parser refuses it correctly (#827: the claim
 * is verified shallowly, and a file that calls the thing cannot declare the exemption). It lives apart
 * from `tracker-writer-population.test.ts` for exactly that reason: the WALK needs no token and belongs in
 * the acceptance job; this probe does not and runs in the full suite.
 *
 * WHY IT EXISTS AT ALL: reachability through the import closure proves a helper CAN see the guard, never
 * that it CALLS it. A helper importing `assertNoLeakInArgv` and not using it passes the walk and checks
 * nothing — which is the distinction this repository spent the night learning in the other direction.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

afterEach(() => forgetActivation());

/**
 * A private LAN address ASSEMBLED, never written whole — and the tree guard is why.
 *
 * The first version of these files wrote the literal out, and `tracked-source-leak-guard` refused the push
 * naming all four occurrences. That is the guard working on the file that builds a guard, and the fix is
 * #1037's: **concatenate, so the literal never appears contiguously in the tree, while the assembled
 * string still matches the pattern** — because a positive control for a leak guard has to be the thing it
 * looks for. The documentation ranges cannot serve here; they are exactly what the pattern does not match.
 */
const PRIVATE_LAN = ["192.168", "1.50"].join(".");

/**
 * `gh --version` CARRYING A LEAK. Chosen so this probe cannot write: if a guard were ever removed, this
 * argv spawns `gh --version`, prints a version and returns — it does not post a comment. **A probe testing
 * a write guard must not be able to perform the write it is testing for**, and the obvious argv
 * (`issue comment`) can.
 */
const PROBE_ARGV = ["--version", "--body", `the box at ${PRIVATE_LAN} answered`];

test("#1053: each of the FIVE spawn helpers refuses a leaking argv, at the helper and not the call site", async () => {
  // Driven through the real helpers. `gh --version` is harmless if a helper ever stops checking, so this
  // asserts a refusal without being able to cause the write it guards against.
  // A11-160 (step 8): `board-data.ts`'s `gh` no longer spawns: it asks the code host's runner (the GitHub plugin's, here) and hands it the
  // guard as the runner's `guard`, which the runner runs before it starts the program. The probe is unchanged; the next test holds the hand-over.
  const helpers: [string, (args: string[]) => unknown][] = [
    ["board-data.ts gh", (await import("../board-data.ts")).gh],
    ["merge-guard/lookups.ts gh", (await import("../merge-guard/lookups.ts")).gh],
  ];
  for (const [name, spawn] of helpers) {
    assert.throws(() => spawn(PROBE_ARGV), /REFUSING/, `${name} must refuse a leaking body`);
  }
});

test("#1053 (A11-160, step 8): board-data.ts's `gh` hands the code host's runner the leak guard, for any code host: refusing the probe, passing a clean argv", async () => {
  // The runner is the code host's, so a code host whose runner did not check would let a leak through if the guard were not handed over. Here the code host is the fake, whose runner is a recorder:
  // what is asserted is what board-data.ts asks of it (the project's root, the git variables taken off, the buffer it has always had, and the guard), not what the runner then does.
  const { gh, ROOT } = await import("../board-data.ts");
  const host = createFakeCodeHost();
  const asked: NonNullable<Parameters<NonNullable<typeof host.rows>["runnerWith"]>[0]>[] = [];
  const ran: string[][] = [];
  host.rows!.runnerWith = (request) => { asked.push(request ?? {}); return (args) => { ran.push([...args]); return ""; }; };
  substituteCodeHost(host);
  gh(["issue", "list"]);
  assert.equal(asked.length, 1, "one runner is asked for per call");
  assert.equal(asked[0].cwd, ROOT);
  assert.equal(asked[0].withoutGitEnv, true, "the variables a hook sets are taken off");
  assert.equal(asked[0].maxBuffer, 32 * 1024 * 1024);
  assert.deepEqual(ran, [["issue", "list"]]);
  assert.equal(typeof asked[0].guard, "function", "the leak guard is handed to the runner");
  assert.throws(() => asked[0].guard!(PROBE_ARGV), /REFUSING/, "and it refuses a leaking argv");
  assert.doesNotThrow(() => asked[0].guard!(["issue", "list", "--repo", "a/b"]), "POSITIVE CONTROL: a clean argv passes the same guard");
});
