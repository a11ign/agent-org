// @ts-check
// module: the exposure contract's suite (A11-158) -- `runExposureConformance(exposure, options)` is the only definition of "an exposure"
//
// TWO KINDS ARE ONE CONTRACT. An exposure with a machine name serves the board on it: it answers hosts, origins and a terminal address for that name. One with none
// serves on loopback only: it answers none of them, and refuses to serve a port. The suite reads the name first and holds the implementation to the kind it chose.
// Serving a port changes the machine, so those checks run only when `options.sandboxed` says the implementation serves into a sandbox.
import type { Address, Exposure } from "../contracts/exposure.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isString, runChecks } from "./suite.ts";

export type ExposureOptions = Readonly<{ sandboxed?: boolean }>;
type Subject = Readonly<{ exposure: Exposure; options: ExposureOptions }>;

const OPERATIONS = ["machineName", "hosts", "origins", "terminal", "serve", "unserve", "portState"] as const;
const PORT = 9443;
const LOCAL = 4748;

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
