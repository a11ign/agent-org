// @ts-check
// module: the in-memory exposure (A11-158, A11-162) -- the reference that passes `runExposureConformance`, and what core's tests use in place of Tailscale
//
// IT SERVES INTO A MAP. Given a machine name it answers as a tailnet does: hosts, https origins, a terminal address, the ports it serves the board on, a port (or one path of one)
// it serves and removes (only the caller's own, contract 1.2). Given none (the default) it serves on loopback only, and refuses to serve a port. A test reads what core served (`entries`) and what it asked (`calls`).
import type { Address, Exposure, PortState, ServedPorts, ServeOptions, ServeResult } from "../contracts/exposure.ts";

const OK: ServeResult = { status: 0, stdout: "", stderr: "" };

/** The ports a named fake serves the board and the terminal on, unless a test names others. */
export const FAKE_PORTS: ServedPorts = Object.freeze({ ui: 9443, terminal: 9444 });

/** One served entry: the port and path it is served at, the loopback port it proxies to, and whether it is open to the internet. */
type Entry = Readonly<{ port: number; path: string; local: number; funnel: boolean }>;

const keyOf = (port: number, path: string | undefined): string => `${port}${path ?? ""}`;

export function createFakeExposure(name: string | null = null, ports: ServedPorts = FAKE_PORTS) {
  const entries = new Map<string, Entry>();
  const calls: string[] = [];
  const refused = (refusal: string): ServeResult => ({ status: 1, stdout: "", stderr: refusal, refusal });
  const refuse = (what: string): ServeResult => refused(`fake exposure: ${what}: this exposure serves on loopback only`);
  const notOurs = (key: string, local: number | undefined): ServeResult =>
    refused(`fake exposure: unserve ${key}: the entry does not proxy to ${local === undefined ? "a named loopback port" : `127.0.0.1:${local}`}, so it is not the caller's`);
  /** Whether any entry of `port` is open to the internet: the machine opens a port, not a path. */
  const isOpen = (port: number): boolean => [...entries.values()].some((entry) => entry.port === port && entry.funnel);
  const exposure: Exposure = {
    async machineName() {
      calls.push("machineName");
      return name;
    },
    hosts: ({ name: machine, port }: Address) => (name === null ? [] : [machine, `${machine}:${port}`]),
    origins: ({ name: machine, port }: Address) => (name === null ? [] : [`https://${machine}`, `https://${machine}:${port}`]),
    terminal: ({ name: machine, port }: Address) => (name === null ? null : `https://${machine}:${port}/?ws={workspace}&pane={pane}&view=terminal`),
    serve(port, local, { path = "", funnel = false }: ServeOptions = {}) {
      calls.push(`serve ${keyOf(port, path)}${funnel ? " funnel" : ""}`);
      if (name === null) return refuse(`serve ${port}`);
      entries.set(keyOf(port, path), { port, path, local, funnel });
      return OK;
    },
    unserve(port, { path = "", local }: ServeOptions = {}) {
      calls.push(`unserve ${keyOf(port, path)}`);
      if (name === null) return refuse(`unserve ${port}`);
      // As a serving plugin does (contract 1.2): only the caller's own entry is removed.
      if (local === undefined || entries.get(keyOf(port, path))?.local !== local) return notOurs(keyOf(port, path), local);
      entries.delete(keyOf(port, path));
      return OK;
    },
    portState(port, local, { path = "" }: Pick<ServeOptions, "path"> = {}): PortState {
      const entry = entries.get(keyOf(port, path));
      if (entry === undefined) return { kind: "free", proxy: null, funnel: isOpen(port) };
      return { kind: entry.local === local ? "ours" : "foreign", proxy: `http://127.0.0.1:${entry.local}`, funnel: isOpen(port) };
    },
    ports: () => (name === null ? null : ports),
    readiness: () => null,
    claim(port, local, service) {
      const state = exposure.portState(port, local);
      if (state.funnel) return `port ${port} is open to the internet, and the board is never served there: change the ${service} port`;
      if (state.kind === "foreign") return `port ${port} already serves ${state.proxy ?? "another entry"}, and the board will not replace it: change the ${service} port`;
      return null;
    },
    served: () => (name === null ? [] : [...new Set([...entries.values()].map((entry) => `${name}:${entry.port}`))]),
  };
  return Object.assign(exposure, { entries, calls });
}
