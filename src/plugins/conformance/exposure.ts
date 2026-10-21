// @ts-check
// module: the exposure contract's suite (A11-158) -- `runExposureConformance(exposure, options)` is the only definition of "an exposure"
//
// TWO KINDS ARE ONE CONTRACT. An exposure with a machine name serves the board on it: it answers hosts, origins and a terminal address for that name. One with none
// serves on loopback only: it answers none of them, and refuses to serve a port. The suite reads the name first and holds the implementation to the kind it chose.
// Serving a port changes the machine, so those checks run only when `options.sandboxed` says the implementation serves into a sandbox. The 1.1 members that read the machine
// (`readiness`, `claim`, `served`) run there too: a real implementation asks its program, which a test answers with a stub.
import type { Address, Exposure } from "../contracts/exposure.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isString, runChecks } from "./suite.ts";

export type ExposureOptions = Readonly<{ sandboxed?: boolean }>;
type Subject = Readonly<{ exposure: Exposure; options: ExposureOptions }>;

const OPERATIONS = ["machineName", "hosts", "origins", "terminal", "serve", "unserve", "portState", "ports", "readiness", "claim", "served"] as const;
const PORT = 9443;
const LOCAL = 4748;
const HOOK = "/hook";
const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;

/** The address of the board under the name the exposure gave, or null for a loopback-only exposure. */
async function addressOf(exposure: Exposure): Promise<Address | null> {
  const name = await exposure.machineName();
  expect(name === null || (isString(name) && name !== ""), "machineName() must be a name, or null for a loopback-only exposure");
  return name === null ? null : { name, port: PORT };
}

const ALWAYS: Readonly<Record<string, (subject: Subject) => unknown>> = {
  "machineName is the same name each time it is asked": async ({ exposure }) => {
    expect((await exposure.machineName()) === (await exposure.machineName()), "machineName() must answer the same name each time: it is read once and cached");
  },
  "ports names the two ports a named exposure serves on, and none for a loopback-only one": async ({ exposure }) => {
    const ports = exposure.ports();
    if ((await addressOf(exposure)) === null) {
      expect(ports === null, "ports() must be null for an exposure with no name: it serves nothing");
      return;
    }
    expect(ports !== null && isPort(ports.ui) && isPort(ports.terminal), "ports() must give the ui and terminal ports a named exposure serves on, each from 1 to 65535");
    expect(ports.ui !== ports.terminal, "ports() must give the ui and the terminal different ports");
  },
  "a loopback-only exposure answers no hosts, origins or terminal": async ({ exposure }) => {
    if ((await addressOf(exposure)) !== null) return;
    const address = { name: "none", port: PORT };
    expect(exposure.hosts(address).length === 0 && exposure.origins(address).length === 0, "an exposure with no name must answer no hosts and no origins");
    expect(exposure.terminal(address) === null, "an exposure with no name must have no terminal address");
  },
  "a named exposure answers hosts, https origins and a terminal address": async ({ exposure }) => {
    const address = await addressOf(exposure);
    if (address === null) return;
    const hosts = exposure.hosts(address);
    expect(hosts.length > 0 && hosts.every(isString), `hosts() must list the Host values the board answers to under ${address.name}`);
    const origins = exposure.origins(address);
    expect(origins.length > 0 && origins.every((origin) => origin.startsWith("https://")), "origins() must list https origins: the board is served over HTTPS");
    expect(origins.every((origin) => hosts.includes(origin.slice("https://".length))), "every origin must be of a host the board answers to");
    const terminal = exposure.terminal(address);
    expect(isString(terminal) && terminal.includes("{workspace}") && terminal.includes("{pane}"), "terminal() must leave {workspace} and {pane} in the address for the board to fill");
  },
};

const sandboxed: Conditional<Subject>["applies"] = ({ options }) => options.sandboxed === true;

const CONDITIONAL: Readonly<Record<string, Conditional<Subject>>> = {
  "serve takes a port, portState says it is ours, and unserve frees it": {
    applies: sandboxed,
    reason: "serving changes the machine, and the implementation was not given a sandbox to serve in",
    run: async ({ exposure }) => {
      const address = await addressOf(exposure);
      if (address === null) {
        expect(exposure.serve(PORT, LOCAL).status !== 0, "a loopback-only exposure must refuse to serve a port");
        return;
      }
      expect(exposure.portState(PORT, LOCAL).kind === "free", "portState() must be free before anything is served");
      expect(exposure.serve(PORT, LOCAL).status === 0, "serve() must serve the port");
      expect(exposure.portState(PORT, LOCAL).kind === "ours", "portState() must say the board's own proxy holds the port");
      expect(exposure.unserve(PORT).status === 0, "unserve() must remove it");
      expect(exposure.portState(PORT, LOCAL).kind === "free", "portState() must be free once the port is removed");
    },
  },
  "one path of a port is served open to the internet on its own, and unserve removes it": {
    applies: sandboxed,
    reason: "serving changes the machine, and the implementation was not given a sandbox to serve in",
    run: async ({ exposure }) => {
      const address = await addressOf(exposure);
      if (address === null) {
        expect(exposure.serve(PORT, LOCAL, { path: HOOK, funnel: true }).status !== 0, "a loopback-only exposure must refuse to serve a path to the internet");
        return;
      }
      expect(exposure.portState(PORT, LOCAL, { path: HOOK }).kind === "free", "portState() of a path must be free before anything is served");
      expect(exposure.serve(PORT, LOCAL, { path: HOOK, funnel: true }).status === 0, "serve() must serve the path");
      const state = exposure.portState(PORT, LOCAL, { path: HOOK });
      expect(state.kind === "ours" && state.funnel, "portState() of the path must say the board's proxy holds it, open to the internet");
      expect(exposure.unserve(PORT, { path: HOOK, funnel: true }).status === 0, "unserve() must remove the path");
      expect(exposure.portState(PORT, LOCAL, { path: HOOK }).kind === "free", "portState() of the path must be free once it is removed");
    },
  },
  "readiness, claim and served answer for the machine the exposure serves in": {
    applies: sandboxed,
    reason: "these ask the machine, and the implementation was not given a sandbox to ask",
    run: async ({ exposure }) => {
      const address = await addressOf(exposure);
      const readiness = exposure.readiness();
      expect(readiness === null || (isString(readiness) && readiness !== ""), "readiness() must be a sentence, or null when the machine can serve");
      if (address === null) {
        expect(readiness === null && exposure.served().length === 0, "a loopback-only exposure has nothing to wait for and serves no address");
        return;
      }
      expect(exposure.claim(PORT, LOCAL, "ui") === null, "claim() must be null for a port nothing holds");
      expect(exposure.serve(PORT, LOCAL).status === 0, "serve() must serve the port");
      try {
        expect(exposure.claim(PORT, LOCAL, "ui") === null, "claim() must be null for a port the board's own proxy holds");
        expect(exposure.served().some((entry) => entry === `${address.name}:${PORT}`), "served() must list the host:port entry just served");
      } finally {
        exposure.unserve(PORT);
      }
    },
  },
};

/**
 * Runs every check against `exposure`, so one run reports EVERY way an exposure is wrong.
 * @throws ContractError listing each failed check
 */
export function runExposureConformance(exposure: Exposure, options: ExposureOptions = {}): Promise<ConformanceResult> {
  return runChecks("exposure", { exposure, options }, {
    shape: ({ exposure: candidate }) => expect(hasFunctions(candidate, OPERATIONS), `an exposure is an object with ${OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
    conditional: CONDITIONAL,
  });
}
