// @ts-check
// module: how core reaches row mode's GitHub operations -- the code host's `rows` (A11-160, step 4)
//
// `src/ticket-port/<file>.ts` kept a delegating copy of each operation it moved into `plugins/github/rows/`, so a caller's import did not change; each delegate asks this for the activated code host's
// `rows` and calls it. A code host without `rows` serves ticket mode only (`docs/adr/0002-row-mode-github-is-an-optional-part-of-the-code-host-contract.md`), and a row-mode program that reaches for one
// is refused here, by name: `row mode needs a code host that implements rows: <plugin> does not`.
import { providersOfText } from "../ticket-mode/providers.ts";
import { codeHostForRows, hostFileTextForRows, PluginActivationRefusal, registerRowsReadHelpers } from "./code-host-slot.ts";
import type { CodeHostRows } from "./contracts/code-host-rows.ts";
import { defaultCatalog } from "./registry.ts";
import { rowsReadHelpers } from "./rows-light-helpers.ts";

// What core owns of row mode that reads nothing of the project is registered by loading this file.
registerRowsReadHelpers(rowsReadHelpers);

/** The code host block's plugin, as the host file names it: for the refusal's words. */
function codeHostNamed(): string {
  return providersOfText(hostFileTextForRows(process.env), defaultCatalog()).blocks.codeHost.provider;
}

/** The code host's row operations. REFUSES by name when the code host implements none. */
export function rows(): CodeHostRows {
  const host = codeHostForRows();
  if (host.rows === undefined) throw new PluginActivationRefusal(`row mode needs a code host that implements rows: ${codeHostNamed()} does not`);
  return host.rows;
}

/** The members of the rows that are operations, and not values. */
type RowOperation = { [Name in keyof CodeHostRows]: CodeHostRows[Name] extends (...args: never[]) => unknown ? Name : never }[keyof CodeHostRows];

/**
 * A delegate to the operation `name` of the code host's rows: a function that asks for the rows when it is CALLED, not when it is made, and calls the operation with the arguments it is given. It is what
 * a file of `src/ticket-port/` exports for each operation that moved into the plugin, so a caller's import did not change. The modules of the delegates' graph import nothing of row mode, so a delegate is
 * made before any caller of it runs.
 */
export function delegate<Name extends RowOperation>(name: Name): CodeHostRows[Name] {
  const call = (...args: unknown[]): unknown => {
    const operations = rows();
    return (operations[name] as (...given: unknown[]) => unknown).apply(operations, args);
  };
  return call as CodeHostRows[Name];
}

/** {@link delegate} for several operations at once: the object a file destructures its exports from. */
export function delegates<Name extends RowOperation>(...names: readonly Name[]): Pick<CodeHostRows, Name> {
  return Object.fromEntries(names.map((name) => [name, delegate(name)])) as Pick<CodeHostRows, Name>;
}
