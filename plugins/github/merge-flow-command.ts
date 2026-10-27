// command: the `merge flow` row for one organisation, from a checkout (A11-274) -- every repository of it, as `gh` acts on this machine
//
// Usage: node plugins/github/merge-flow-command.ts --owner <organisation>
//
// It prints the row doctor draws and exits 1 while any repository lacks the merge flow, 0 when none does, and 2 on a usage it does not read or an owner that lists no repository. It reads what doctor's row reads
// (`merge-flow-checks.ts`), as whichever account `gh` acts as here: on an agents host the `gh` wrapper is the workers'. A file of its own, so loading the plugin never runs it.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commandExec } from "./command-exec.ts";
import { ghRunner } from "./gh.ts";
import { mergeFlowRow, readingsOf } from "./merge-flow-checks.ts";

const REFUSED = 2;

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const [flag, owner, ...rest] = process.argv.slice(2);
  if (flag !== "--owner" || owner === undefined || rest.length > 0) {
    console.error("usage: node plugins/github/merge-flow-command.ts --owner <organisation>");
    process.exitCode = REFUSED;
  } else {
    const readings = readingsOf([owner], [], ghRunner({ exec: commandExec }));
    if (readings.repositories.length === 0 && readings.unlisted.length === 0) {
      console.error(`${owner} is not an organisation the account gh acts as here can list, or it has no repository`);
      process.exitCode = REFUSED;
    } else {
      const row = mergeFlowRow(readings);
      console.log(`${row.ok ? "ok" : "FAIL"} ${row.name}: ${row.detail}${row.fix === null ? "" : `\nfix: ${row.fix.split(" | ").join("\n     ")}`}`);
      process.exitCode = row.ok ? 0 : 1;
    }
  }
}
