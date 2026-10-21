// @ts-check
// module: the exposure contract, version 1.0 -- where the board and a worker's terminal are served (A11-158)
//
// A TYPE FILE: it imports nothing at run time. It is written from what core calls today in `tailnet.ts`, `local-http.ts` and `service.ts`: the machine's name for
// the board, the hosts and origins a request may come from, the terminal's address, serving a port and removing it, and a port's state. A plugin that serves only
// on loopback answers with no name and no extra hosts or origins, and serves nothing.

/** The exposure contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const EXPOSURE_CONTRACT_VERSION = "1.0";

/** The machine's name for the board and the port the board is served on under it. */
export type Address = Readonly<{ name: string; port: number }>;

/** What a command the plugin runs to serve a port answered: its exit status (null when it did not run), and its output. */
export type ServeResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;

/** A served port as the machine holds it: nothing on it (`free`), this board's proxy (`ours`), or another's (`foreign`), and whether it is open to the internet. */
export type PortState = Readonly<{ kind: "free" | "ours" | "foreign"; proxy: string | null; funnel: boolean }>;

/** An exposure plugin. */
export interface Exposure {
  /** The name the board answers to on this machine, read once and cached; null when there is none (loopback only), or it cannot be read. */
  machineName(): Promise<string | null>;
  /** The `Host` values a request to the board may carry under `address`: none for a plugin that serves on loopback only. */
  hosts(address: Address): readonly string[];
  /** The `Origin` values a request to the board may carry under `address`: none for a plugin that serves on loopback only. */
  origins(address: Address): readonly string[];
  /** The address of a worker's live terminal under `address`, with `{workspace}` and `{pane}` left in it for the board to fill, or null when none is served. */
  terminal(address: Address): string | null;
  /** Serve `local` (a loopback port) at `port`. A loopback-only plugin refuses it. */
  serve(port: number, local: number): ServeResult;
  /** Stop serving `port`. */
  unserve(port: number): ServeResult;
  /** What holds `port` on this machine, for `local`'s proxy to compare with. */
  portState(port: number, local: number): PortState;
}
