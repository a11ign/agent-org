// A LEAF: it imports nothing from this tool, so any module that starts a `.ts` child can import it.
// ADR 0043 Decision 8: checkout-run code is `.ts`, and the host's Node has no type stripping, so a child that runs a `.ts` file is started as
// `node --import <tsx> <file>.ts`. The loader is named by its ABSOLUTE URL, resolved from this file: a bare `--import tsx` resolves from the child's
// working directory, and a child started in a row's worktree or a project's checkout holds no `tsx`. `createRequire` and not `import.meta.resolve`,
// which the test bundler does not provide.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const IMPORT_FLAG = "--import";
const LOADER_NAME = /tsx/;

/** The loader this very process was started with, if it was started with one: `--import <url>` or `--import=<url>`. */
function inheritedLoader(execArgv: readonly string[]): string | undefined {
  for (const [at, arg] of execArgv.entries()) {
    const value = arg === IMPORT_FLAG ? execArgv[at + 1] : arg.startsWith(`${IMPORT_FLAG}=`) ? arg.slice(IMPORT_FLAG.length + 1) : undefined;
    if (value !== undefined && LOADER_NAME.test(value)) return value;
  }
  return undefined;
}

function loaderArguments(): string[] {
  try {
    return [IMPORT_FLAG, pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];
  } catch {
    // A copy of the tool with no `node_modules` above it (the gate must LOAD there, #2174): `tsx` cannot be found from this file, so a child gets the
    // loader this process was itself started with, and only failing that the bare name, which resolves from the child's working directory.
    return [IMPORT_FLAG, inheritedLoader(process.execArgv) ?? "tsx"];
  }
}

/** The `node` arguments that let a child load `.ts`: put them before the script. */
export const TSX_IMPORT: string[] = loaderArguments();

/** `args` without the loader a spawn site put before the script: a test's fake `exec` reads the script and its subcommand, not the runtime's flags. */
export const afterTsx = (args: string[]): string[] => (args[0] === IMPORT_FLAG ? args.slice(TSX_IMPORT.length) : args);
