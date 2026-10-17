#!/usr/bin/env node
// #3068: `agent-org <command> [args]` -- the ONE bin. It takes a command name from `commands.ts`'s table and runs the program the table names,
// with the caller's arguments after the table's own, exactly as `node packages/agent-org/src/<program>.mjs <args>` did.
//
// THE PROGRAM IS RUN AS A CHILD PROCESS, NOT IMPORTED. Every program decides whether it is being run by comparing its own URL with
// `process.argv[1]` (`if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()`), so an `import()` from here would load
// each one and run none. A child keeps what a project's scripts relied on: argv, the exit code, stdio, and a signal that ends it.
//
// THIS FILE IMPORTS NOTHING FROM THE PROJECT-CONFIG CHAIN, on purpose. Listing the commands and refusing an unknown one must work in a directory
// that holds no project; only the program that runs reads the declaration, and it refuses by name when there is none.
//
// A `ticket:*` PROGRAM IS HANDED THE HOST FILE THE SERVICES USE (A11-68). Ticket mode reads `$AGENT_ORG_HOST`, and a non-interactive
// `ssh <machine> agent-org ticket:remote-info` sets none, so it read `~/.agent-org/host.json`, which on a machine onboarded with another host file
// does not exist. With the variable unset, the child gets the path `install/paths.ts` resolves (onboard's record, then the instance unit's), the
// same one `agent-org start` wrote into the unit. Only `ticket:*`: every other program resolves a PROJECT from that variable, and setting it there
// would change which project it serves. With `GH_CONFIG_DIR` unset, it also gets the workers' `gh` account the host file declares
// (`<gh.workers>/gh`), the one the services run with, so a `ticket:*` command run from a plain shell reads GitHub as the board does.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMANDS, FIXED_ARGS } from "./commands.ts";
import { hostFilePath, hostGhConfigDir, readOrNull } from "./install/paths.ts";

const REFUSED = 2;
const SIGNAL_EXIT_BASE = 128;
const SRC = dirname(fileURLToPath(import.meta.url));
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * What `agent-org <argv>` should do: run a program, or refuse. PURE, so a test drives every refusal with an array.
 * @param argv what follows `agent-org`
 */
export function planInvocation(argv: readonly string[], { commands = COMMANDS, fixedArgs = FIXED_ARGS }: { commands?: Readonly<Record<string, string>>; fixedArgs?: Readonly<Record<string, readonly string[]>>; } = {}): { run: { program: string; args: string[]; }; } | { refusal: string; } {
  const [name, ...rest] = argv;
  const list = Object.keys(commands).sort().map((command) => `  ${command}`).join("\n");
  if (name === undefined) return { refusal: `agent-org: no command given, and there is no default one. Commands:\n${list}` };
  const file = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (file === undefined) return { refusal: `agent-org: \`${name}\` is not a command. Commands:\n${list}` };
  return { run: { program: join(SRC, file), args: [...fixedArgs[name] ?? [], ...withoutRepeatedFixed(rest, fixedArgs[name] ?? [])] } };
}

/**
 * #3357: `pr:open create --title ...` reached `gh` as `gh pr create create`, because the table already supplies `create` and the program's own
 * usage text spells it too. A caller who repeats the fixed arguments exactly, leading, gets one copy, so both spellings of the command mean the same.
 * @param rest the caller's arguments
 * @param fixed the table's arguments for this command
 */
function withoutRepeatedFixed(rest: readonly string[], fixed: readonly string[]): readonly string[] {
  const repeated = fixed.length > 0 && fixed.every((arg, i) => rest[i] === arg);
  return repeated ? rest.slice(fixed.length) : rest;
}

/**
 * The environment `name`'s program runs with: the caller's, and for a `ticket:*` command with no `AGENT_ORG_HOST`, that variable set to the host
 * file `hostFile` resolves, and with no `GH_CONFIG_DIR`, the `gh` account `ghConfigDir` reads from that host file. PURE over its arguments.
 */
export function programEnv(name: string, env: NodeJS.ProcessEnv, hostFile: () => string, ghConfigDir: (hostFile: string) => string | null = () => null): NodeJS.ProcessEnv {
  if (!name.startsWith("ticket:")) return env;
  const host = (env.AGENT_ORG_HOST ?? "") !== "" ? env.AGENT_ORG_HOST as string : hostFile();
  const gh = (env.GH_CONFIG_DIR ?? "") !== "" ? null : ghConfigDir(host);
  return { ...env, AGENT_ORG_HOST: host, ...(gh === null ? {} : { GH_CONFIG_DIR: gh }) };
}

/** @returns the program's exit code, 128 + n for a signal n */
function runProgram(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [program, ...args], { stdio: "inherit", env });
    for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child.kill(signal));
    child.on("error", fail);
    child.on("close", (code, signal) => done(code ?? SIGNAL_EXIT_BASE + (signal ? constants.signals[signal as NodeJS.Signals] : 0)));
  });
}

async function main(argv: readonly string[]) {
  const plan = planInvocation(argv);
  if ("refusal" in plan) {
    console.error(plan.refusal);
    process.exitCode = REFUSED;
    return;
  }
  process.exitCode = await runProgram(plan.run.program, plan.run.args, programEnv(argv[0] ?? "", process.env, () => hostFilePath(process.env, homedir()), (host) => hostGhConfigDir(readOrNull(host))));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main(process.argv.slice(2));
