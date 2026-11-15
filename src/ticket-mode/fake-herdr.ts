// @ts-check
// no-token: none -- a herdr held in memory; nothing is spawned
// module: the herdr the pool's tests drive (A11-279), in a module of its own so that a command can drive it too (A11-439): `pool-fixture.ts` imports `node:test`'s hooks, which a command must not load

/** The `herdr agent` verbs that take an agent target. */
const TARGETED = ["prompt", "read", "send-keys", "get"];

/** A pane id, as herdr names a workspace's panes: `w1:p1`. */
const PANE_ID = /^w\d+:p\d+$/;

/** The agent target of an `agent <verb> <target>` call, or undefined for any other call. PURE. */
function agentTargetOf(args: readonly string[]): string | undefined {
  const at = args.indexOf("agent");
  return at !== -1 && TARGETED.includes(args[at + 1] ?? "") ? args[at + 2] : undefined;
}

/**
 * A herdr that opens a workspace per `workspace create`, lists the status a test sets per label, and records every call. Like herdr 0.9.3 it lists every Claude agent with no name and answers
 * `agent_not_found` to an agent addressed by anything but its pane (A11-279). `screens` is what each pane shows, by pane id; a pane not in it shows nothing. `envs` is the environment each pane's Claude was given by
 * `workspace create --env`, by pane id; {@link restoreWithoutEnvironment} empties them, as herdr's restore of a pane does (it keeps the directory and the session, not the `--env`). A closed workspace's pane is gone.
 */
export function fakeHerdr(status: Map<string, string>) {
  const calls: string[][] = [];
  /** Set to herdr's message to have it refuse every `workspace close` with it. */
  const closing: { refusal: string | null } = { refusal: null };
  const screens = new Map<string, string>();
  const envs = new Map<string, Record<string, string>>();
  /** Set `on` to have `agent list` report no Claude session for any agent, as herdr does for one it could not read the session of. */
  const sessionless = { on: false };
  /** The workspace id of each label a `workspace create` opened; a label not in it is listed as `w<digits of the label>`, as before. */
  const opened = new Map<string, string>();
  const workspaceOf = (label: string): string => opened.get(label) ?? `w${label.replace(/\D/g, "")}`;
  let next = 0;
  const run = (args: string[]): string => {
    calls.push(args);
    if (closing.refusal !== null && args.includes("workspace") && args.includes("close")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: closing.refusal } }) });
    const target = agentTargetOf(args);
    if (target !== undefined && !PANE_ID.test(target)) {
      throw Object.assign(new Error("herdr exited 1"), { stderr: `agent target ${target} not found\n`, stdout: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${target} not found` } }) });
    }
    if (args.includes("read")) return target === undefined ? "" : screens.get(target) ?? "";
    if (args.includes("create")) {
      next += 1;
      opened.set(String(args[args.indexOf("--label") + 1]), `w${next}`);
      envs.set(`w${next}:p1`, Object.fromEntries(args.flatMap((arg, at) => (args[at - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []))));
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("workspace") && args.includes("close")) {
      const id = String(args[args.indexOf("close") + 1]);
      envs.delete(`${id}:p1`);
      for (const [label, workspace] of opened) if (workspace === id) opened.delete(label);
      return JSON.stringify({ type: "ok" });
    }
    if (args.includes("agent") && args.includes("list")) {
      const own = [...status].map(([label, s]) => ({ name: null, workspace_id: workspaceOf(label), ...(sessionless.on ? {} : { agent_session: { value: `session-${label}` } }), agent_status: s }));
      return JSON.stringify({ result: { agents: own } });
    }
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, agent_status: s, workspace_id: workspaceOf(label) })) } });
    return JSON.stringify({ type: "ok" });
  };
  /** herdr's restore of every pane (a restart of its service, or of the host): each Claude is back, and none has the `--env` it was started with. */
  const restoreWithoutEnvironment = (): void => { for (const pane of envs.keys()) envs.set(pane, {}); };
  return { run, calls, closing, screens, envs, sessionless, restoreWithoutEnvironment };
}
