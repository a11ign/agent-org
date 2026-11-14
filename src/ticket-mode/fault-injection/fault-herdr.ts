// @ts-check
// module: a herdr whose server a scenario kills and brings back (A11-439) -- the pool's own fake herdr, wrapped
//
// KILLED: every call fails as herdr's CLI fails with no server to talk to, the way the synchronous and the asynchronous herdr both reject it (`pool-watch-herdr-listing.test.ts`): `Command failed: herdr <args>` with what
// herdr printed. RESTARTED: its service starts again (a new start time, which the board reads to tell a restart, A11-279), and it restores every pane as herdr does: the Claude in it is back, interrupted, idle at its prompt, and
// without the `--env` it was started with. Nothing else of the fake changes: what it lists, opens and closes is `fakeHerdr`'s, the herdr every pool test drives.
//
// A PANE THE BOARD PROMPTS IS ANSWERED BY ITS WORKER. Each prompt is kept by pane, so a scenario's worker carries on only when the board told it to, as a real one does: a run the board never prompts after the restart stays
// idle, and the report shows whether the board said why.
import { fakeHerdr } from "../fake-herdr.ts";
import type { RestartReads } from "../pool-resume.ts";

/** What a restored Claude shows at its prompt: the interruption, then the empty prompt. */
export const INTERRUPTED_SCREEN = "⎿  Interrupted · What should Claude do instead?\n\n> ";

/** What herdr prints when its server is gone. */
export const SERVER_GONE = "the herdr server is not running";

/** A killed herdr's refusal, as `execFile` rejects it: the command on the first line, then what herdr printed. PURE. */
export const herdrGone = (args: readonly string[]): Error => Object.assign(new Error(`Command failed: herdr ${args.join(" ")}\n${SERVER_GONE}\n`), { stderr: `${SERVER_GONE}\n` });

/** The pane a herdr `agent prompt <pane> <text>` call prompts, or undefined for any other call. PURE. */
const promptedPane = (args: readonly string[]): string | undefined => {
  const at = args.indexOf("agent");
  return at !== -1 && args[at + 1] === "prompt" ? args[at + 2] : undefined;
};

/** A herdr a scenario can kill and restart, over `fakeHerdr`'s workspaces, statuses and screens. */
export function faultyHerdr() {
  const status = new Map<string, string>();
  const base = fakeHerdr(status);
  const state = { down: false, starts: 1 };
  /** Every prompt the board sent while herdr was up, by pane. */
  const prompts = new Map<string, string[]>();
  const run = (args: string[]): string => {
    if (state.down) throw herdrGone(args);
    const pane = promptedPane(args);
    if (pane !== undefined) prompts.set(pane, [...(prompts.get(pane) ?? []), String(args[args.indexOf(pane) + 1] ?? "")]);
    return base.run(args);
  };
  /** The server is gone: every call fails until {@link restart}. */
  const kill = (): void => { state.down = true; };
  /** The service starts again and restores each pane in `panes`: idle, interrupted, its environment gone. */
  const restart = (panes: ReadonlyMap<string, string>): void => {
    state.down = false;
    state.starts += 1;
    base.restoreWithoutEnvironment();
    for (const [label, pane] of panes) {
      status.set(label, "idle");
      base.screens.set(pane, INTERRUPTED_SCREEN);
    }
  };
  /** When herdr's service last started, as the board reads it: it moves on each restart. */
  const restartReads: RestartReads = { bootId: () => "fixture-boot", herdrStart: () => String(state.starts) };
  return { run, status, screens: base.screens, envs: base.envs, calls: base.calls, prompts, kill, restart, restartReads, isDown: () => state.down };
}

export type FaultyHerdr = ReturnType<typeof faultyHerdr>;
