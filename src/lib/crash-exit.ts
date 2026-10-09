// @ts-check
// A PRELOAD (`node --import=./src/lib/crash-exit.ts <entry>`): an uncaught exception ends the process with `CRASH_EXIT`, not `1` (#3038).
//
// WHY A CODE OF ITS OWN. `node` exits `1` on ANY uncaught exception, and `1` is a code the org's own contracts use: `work-tick` and `wake`
// exit `1` for ATTENTION and `work-gate` exits `1` for "found work". The unit declares `SuccessExitStatus=0 1 2`, so a tick that died on
// `ENOENT: open '.../project.json'` at import time ran 63 times on 2026-10-02 and each was journalled `Finished`: nothing said so for 2h17m.
// `70` is `EX_SOFTWARE` (sysexits.h, "internal software error") and is in none of those contracts, so a crash is the one exit nothing reads
// as a result.
//
// A PRELOAD AND NOT A `try/catch` IN `main()`, because the throw that cost the outage happened at IMPORT time, before `main()` existed.
//
// THIS FILE INSTALLS ITS HANDLER ON IMPORT, WHICH IS WHAT A PRELOAD IS, so nothing else imports it: `work-tick.mjs` carries its own `EXIT.CRASH`
// and `work-tick-crash-exit.test.ts` pins that the two agree. Importing it into a test runner would turn that runner's own uncaught
// exceptions into exit `70`.

/** `EX_SOFTWARE`. Declared in the contract that reads it: `EXIT.CRASH` in `work-tick.mjs`. */
const CRASH_EXIT = 70;

process.on("uncaughtException", (err) => {
  // Installing a handler REMOVES node's own report of the throw, so it is written here: a crash that exits 70 and says nothing is worse than `1`.
  process.stderr.write(`CRASH (exit ${CRASH_EXIT}): ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(CRASH_EXIT);
});
