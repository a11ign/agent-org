/**
 * THE `agent get` A FAKE HERDR OWES A STARTED PANE (#3546).
 *
 * `deliver` no longer types into a process it has just started until herdr reports it `interactive_ready` and `idle`, and it
 * then reads the agent again to see the prompt was TAKEN. A fake that answered `{}` to `agent get` was therefore reading as an
 * agent that never got ready, and every spawn test went UNDELIVERED -- which is the gate working, so the fake is what changes.
 * This models the one thing those tests are not about: a pane that is ready, and goes `working` once something is typed into it.
 * `wake-confirms-first-prompt.test.ts` is the file whose panes misbehave on purpose.
 */

/**
 * @returns a function that answers `agent get <label>` as a ready pane (`idle` until prompted, then `working`) and answers
 * `null` to every other call, so a fixture's own branches run unchanged. It also notes each `agent prompt`, and answers `null` for it.
 */
export function startedPanes() {
  const prompted = new Set<string>();
  return (args: string[]): string | null => {
    const verb = args.slice(2, 4).join(" ");
    if (verb === "agent prompt") prompted.add(args[4]);
    if (verb !== "agent get") return null;
    return JSON.stringify({ result: { agent: {
      agent_status: prompted.has(args[4]) ? "working" : "idle", interactive_ready: true, state_change_seq: 1 } } });
  };
}

/**
 * The same pane for a `herdr` that is a SHELL STUB on `PATH` (a test that runs the real entry point as a process): the `case` arms
 * to put before its `*) : ;;`. A file beside the stub (`$0.prompted`, `$0` being the stub itself) is what remembers the prompt.
 */
export const STUB_STARTED_PANE = "  *'agent prompt'*) : > \"$0.prompted\" ;;\n"
  + "  *'agent get'*) if [ -e \"$0.prompted\" ]; then s=working; else s=idle; fi; "
  + "printf '{\"result\":{\"agent\":{\"agent_status\":\"%s\",\"interactive_ready\":true}}}' \"$s\" ;;\n";
