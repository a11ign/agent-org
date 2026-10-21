// @ts-check
// module: the in-memory exposure (A11-158) -- the reference that passes `runExposureConformance`, and what core's tests use in place of Tailscale
//
// IT SERVES INTO A MAP. Given a machine name it answers as a tailnet does: hosts, https origins, a terminal address, a port it serves and removes. Given none (the default)
// it serves on loopback only, and refuses to serve a port. A test reads what core served (`served`) and what it asked (`calls`).
import type { Address, Exposure, PortState, ServeResult } from "../contracts/exposure.ts";

const OK: ServeResult = { status: 0, stdout: "", stderr: "" };

export function createFakeExposure(name: string | null = null) {
  const served = new Map<number, number>();
  const calls: string[] = [];
  const refuse = (what: string): ServeResult => ({ status: 1, stdout: "", stderr: `fake exposure: ${what}: this exposure serves on loopback only` });
  const exposure: Exposure = {
    async machineName() {
      calls.push("machineName");
      return name;
    },
    hosts: ({ name: machine, port }: Address) => (name === null ? [] : [machine, `${machine}:${port}`]),
    origins: ({ name: machine, port }: Address) => (name === null ? [] : [`https://${machine}`, `https://${machine}:${port}`]),
    terminal: ({ name: machine, port }: Address) => (name === null ? null : `https://${machine}:${port}/?ws={workspace}&pane={pane}&view=terminal`),
    serve(port, local) {
      calls.push(`serve ${port}`);
      if (name === null) return refuse(`serve ${port}`);
      served.set(port, local);
      return OK;
    },
    unserve(port) {
      calls.push(`unserve ${port}`);
      if (name === null) return refuse(`unserve ${port}`);
      served.delete(port);
      return OK;
    },
    portState(port, local): PortState {
      const proxy = served.get(port);
      if (proxy === undefined) return { kind: "free", proxy: null, funnel: false };
      return { kind: proxy === local ? "ours" : "foreign", proxy: `http://127.0.0.1:${proxy}`, funnel: false };
    },
  };
  return Object.assign(exposure, { served, calls });
}
