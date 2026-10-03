#!/usr/bin/env node
// @ts-check
// #3068: `agent-org <command> [args]` -- the ONE bin. It takes a command name from `commands.mjs`'s table and runs the program the table names,
// with the caller's arguments after the table's own, exactly as `node packages/agent-org/src/<program>.mjs <args>` did.
//
// THE PROGRAM IS RUN AS A CHILD PROCESS, NOT IMPORTED. Every program decides whether it is being run by comparing its own URL with
// `process.argv[1]` (`if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()`), so an `import()` from here would load
// each one and run none. A child keeps what a project's scripts relied on: argv, the exit code, stdio, and a signal that ends it.
//
// THIS FILE IMPORTS NOTHING FROM THE PROJECT-CONFIG CHAIN, on purpose. Listing the commands and refusing an unknown one must work in a directory
// that holds no project; only the program that runs reads the declaration, and it refuses by name when there is none.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMANDS, FIXED_ARGS } from "./commands.mjs";

const REFUSED = 2;
const SIGNAL_EXIT_BASE = 128;
const SRC = dirname(fileURLToPath(import.meta.url));
const FORWARDED_SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * What `agent-org <argv>` should do: run a program, or refuse. PURE, so a test drives every refusal with an array.
 * @param {readonly string[]} argv what follows `agent-org`
 * @param {{ commands?: Readonly<Record<string, string>>, fixedArgs?: Readonly<Record<string, readonly string[]>> }} [tables]
 * @returns {{ run: { program: string, args: string[] } } | { refusal: string }}
 */
export function planInvocation(argv, { commands = COMMANDS, fixedArgs = FIXED_ARGS } = {}) {
  const [name, ...rest] = argv;
  const list = Object.keys(commands).sort().map((command) => `  ${command}`).join("\n");
  if (name === undefined) return { refusal: `agent-org: no command given, and there is no default one. Commands:\n${list}` };
  const file = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (file === undefined) return { refusal: `agent-org: \`${name}\` is not a command. Commands:\n${list}` };
  return { run: { program: join(SRC, file), args: [...(fixedArgs[name] ?? []), ...rest] } };
}

/** @param {string} program @param {string[]} args @returns {Promise<number>} the program's exit code, 128 + n for a signal n */
function runProgram(program, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [program, ...args], { stdio: "inherit" });
    for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child.kill(signal));
    child.on("error", fail);
    child.on("close", (code, signal) => done(code ?? SIGNAL_EXIT_BASE + (signal ? constants.signals[signal] : 0)));
  });
}

/** @param {readonly string[]} argv */
async function main(argv) {
  const plan = planInvocation(argv);
  if ("refusal" in plan) {
    console.error(plan.refusal);
    process.exitCode = REFUSED;
    return;
  }
  process.exitCode = await runProgram(plan.run.program, plan.run.args);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main(process.argv.slice(2));
