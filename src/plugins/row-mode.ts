// @ts-check
// module: row mode's way to the code host's `rows`: the accessor, with what core owns of row mode registered (A11-160, step 4)
//
// Most of row mode's GitHub operations read the project's vocabulary and board (labels, the board's owner and number, how a row declares its waits), which core hands the code host as `RowsHelpers`. Those
// modules evaluate the project's declaration when they load, and a host with no project (ticket mode on a laptop, doctor, onboard) refuses that. So the registration is HERE and not in `rows.ts`: the delegates
// in `src/ticket-port/` whose operations read the project import `rows` from this file, and the ones that read nothing of it import it from `rows.ts`, which loads neither the vocabulary nor the board.
import { readFileSync } from "node:fs";
import { hostConfigPath } from "../host-config.ts";
import { registerHostFileReader, registerRowsProjectHelpers } from "./code-host-slot.ts";
import { rowsProjectHelpers } from "./rows-helpers.ts";

registerRowsProjectHelpers(rowsProjectHelpers);
registerHostFileReader((env) => {
  try {
    return readFileSync(hostConfigPath({ env }), "utf8");
  } catch {
    return null;
  }
});

export { delegate, delegates, rows } from "./rows.ts";
