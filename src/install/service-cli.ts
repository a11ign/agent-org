#!/usr/bin/env node
// @ts-check
// command: start, stop and status -- run an agent-org service (`herdr`, `instance`, `ui`, `terminal` or `auto-update`) as a launchd user agent on macOS or a systemd user unit on Linux
//
// THE ENTRY OF `start`, `stop` AND `status`, AND NOTHING ELSE: `service.ts` holds the work and is a library (A11-225). A module that other modules import must never `await` at top level: `service.ts` did, and
// `herdr-move.ts` imports it, so `import("./herdr-move.ts")` in `main` waited on `service.ts`, which waited on `main`. Nothing could settle that, the event loop emptied and Node exited 13 with only "Detected
// unsettled top-level await", on every `agent-org start herdr`. Nothing imports this file, so its top-level `await` waits on nothing but `main`.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { runCommand } from "./command-exit.ts";
import { main } from "./service.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const argv = process.argv.slice(2);
  await runCommand(argv.join(" "), () => main(argv));
}
