// `messaging:check` (a11ign/a11ign#2901): READ THE CONFIGURATION AND THE SECRET FILES' PERMISSIONS, PRINT A VERDICT, MAKE NO NETWORK CALL.
// A LEAF module. It never reads a secret's content either (`secretFileProblem` judges the descriptor and stops), so the worst this command
// can print is a path, a mode and an owner.
//
// Exit 0: off, or on and every file it can judge is safe. Exit 1: the key is malformed, or a secret file is unsafe or missing.
// **A CHAIRMAN FILE THAT DOES NOT EXIST IS NOT A FAILURE**: the pairing command (row 3) is what writes it, and a check that failed
// before the chairman had paired would be red on the day the feature is first configured. It is reported as NOT YET PAIRED, and a file
// that DOES exist is held to the same rule as the token's.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { secretFileProblem } from "./secret.ts";
import { MilestonesRefusal, readMilestonesFile } from "./sources/milestones.ts";

type Verdict = { exitCode: number; lines: string[] };

function judgeFiles(config: import("./config.ts").MessagingOn, { uid, exists = existsSync }: { uid?: number; exists?: (path: string) => boolean; }): { failed: boolean; lines: string[]; } {
  const token = secretFileProblem(config.tokenFile, { uid });
  const lines = [token === null ? `token file: ok (${config.tokenFile}, mode 0600, owned by the running user)` : `token file: REFUSED -- ${token}`];
  if (!exists(config.chairmanFile)) {
    lines.push(`chairman file: NOT YET PAIRED (${config.chairmanFile} is absent; the pairing command writes it)`);
    return { failed: token !== null, lines };
  }
  const chairman = secretFileProblem(config.chairmanFile, { uid });
  lines.push(chairman === null ? `chairman file: ok (${config.chairmanFile}, mode 0600, owned by the running user)` : `chairman file: REFUSED -- ${chairman}`);
  return { failed: token !== null || chairman !== null, lines };
}

/** The declared milestones, read and validated, and nothing fetched: whether a condition is true is the watcher's question and needs the network. */
function judgeMilestones(path: string | null): { failed: boolean; lines: string[]; } {
  if (path === null) return { failed: false, lines: [] };
  try {
    const declared = readMilestonesFile(path);
    return { failed: false, lines: [`milestones: ok (${declared.length} declared in ${path})`] };
  } catch (error) {
    if (error instanceof MilestonesRefusal) return { failed: true, lines: [`milestones: REFUSED -- ${error.message}`] };
    throw error;
  }
}

export function runMessagingCheck({ root, home, uid, exists }: { root: string; home?: string; uid?: number; exists?: (path: string) => boolean; }): Verdict {
  let config: ReturnType<typeof readMessagingConfig>;
  try {
    config = readMessagingConfig(root, { home });
  } catch (error) {
    if (error instanceof MessagingConfigRefusal) return { exitCode: 1, lines: [`messaging: MALFORMED -- ${error.message}`] };
    throw error;
  }
  if (!config.enabled) {
    return { exitCode: 0, lines: ["messaging: OFF (no `messaging` key in .agent-org/project.json); nothing is constructed and no unit is installed"] };
  }
  const files = judgeFiles(config, { uid, exists });
  const milestones = judgeMilestones(config.milestones);
  const failed = files.failed || milestones.failed;
  const lines = [...files.lines, ...milestones.lines];
  const summary = config.summary === null ? "no daily summary (opt-in, none declared)" : `summary at ${config.summary.at} ${config.summary.timezone}`;
  const header = [`messaging: ON, provider ${config.provider}, ${summary}`];
  return { exitCode: failed ? 1 : 0, lines: [...header, ...lines, "no network call was made"] };
}

/** Returns the project root: `--root=<dir>`, else the current directory */
function rootFrom(argv: string[]): string {
  const flag = argv.find((arg) => arg.startsWith("--root="));
  return resolve(flag === undefined ? process.cwd() : flag.slice("--root=".length));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, lines } = runMessagingCheck({ root: rootFrom(process.argv.slice(2)) });
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = exitCode;
}
