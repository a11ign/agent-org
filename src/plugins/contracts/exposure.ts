// @ts-check
// module: the exposure contract, version 1.2 -- where the board and a worker's terminal are served (A11-158, A11-162)
//
// A TYPE FILE: it imports nothing at run time. It is written from what core calls in `local-http.ts`, `service.ts` and the event tunnel: the machine's name for the board, the hosts
// and origins a request may come from, the terminal's address, serving a port and removing it, and a port's state. A plugin that serves only on loopback answers with no name and
// no extra hosts or origins, and serves nothing.
//
// 1.1 (A11-162) ONLY ADDS. It adds what the callers that were Tailscale's own need from a plugin and cannot ask a plugin's name for: the ports the
// plugin serves the board's page and terminal on (`ports`), why this machine cannot serve now (`readiness`), why a port cannot be taken (`claim`), the addresses served now (`served`),
// a path and the internet for `serve`, `unserve` and `portState` (the event receiver's Funnel path), and a sentence for a refusal (`ServeResult.refusal`).
//
// 1.2 (A11-279) adds `ServeOptions.local`: the loopback port the caller's entry proxies to, so `unserve` removes an entry only when it is the caller's. It is the one minor that NARROWS:
// an `unserve` that names no `local` may now be refused. Core is the only caller and names it everywhere. A test whose plugin reached the real `tailscale` removed the agents host's live
// serves because they proxied to the default ports; a second instance, or a test, with another local port now leaves them alone.

/** The exposure contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const EXPOSURE_CONTRACT_VERSION = "1.2";

/** The machine's name for the board and the port the board is served on under it. */
export type Address = Readonly<{ name: string; port: number }>;

/** What a command the plugin runs to serve a port answered: its exit status (null when it did not run), and its output. `refusal` (1.1) is a sentence a person can act on, set when it failed. */
export type ServeResult = Readonly<{ status: number | null; stdout: string; stderr: string; refusal?: string }>;

/** A served port as the machine holds it: nothing on it (`free`), this board's proxy (`ours`), or another's (`foreign`), and whether it is open to the internet. */
export type PortState = Readonly<{ kind: "free" | "ours" | "foreign"; proxy: string | null; funnel: boolean }>;

/** The ports a plugin serves the board's page (`ui`) and the worker terminal (`terminal`) on, which differ. */
export type ServedPorts = Readonly<{ ui: number; terminal: number }>;

/** The service a port serves: the board's page, or the worker terminal. */
export type ServedService = keyof ServedPorts;

/**
 * What `serve`, `unserve` and `portState` may be asked about one path of a port (1.1): `path` is a path under the port (the root when absent), and `funnel` opens the entry to the internet.
 * `local` (1.2) is the loopback port the caller's entry proxies to, which `unserve` checks before it removes anything.
 */
export type ServeOptions = Readonly<{ path?: string; funnel?: boolean; local?: number }>;

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
  /** Serve `local` (a loopback port) at `port`. A loopback-only plugin refuses it. With a `path` and `funnel` (1.1) it serves that one path, open to the internet. */
  serve(port: number, local: number, options?: ServeOptions): ServeResult;
  /** Stop serving `port`, or one `path` of it (1.1). A plugin that serves may refuse (1.2) unless the entry proxies to `options.local`, so a caller removes only its own entry. */
  unserve(port: number, options?: ServeOptions): ServeResult;
  /** What holds `port` (or one `path` of it, 1.1) on this machine, for `local`'s proxy to compare with. THROWS, with a sentence, when the machine cannot say. */
  portState(port: number, local: number, options?: Pick<ServeOptions, "path">): PortState;
  /** 1.1. The ports the board's page and the terminal are served on, or null when this plugin serves nothing (loopback only). */
  ports(): ServedPorts | null;
  /** 1.1. Why this machine cannot serve now (the program is missing, not running, or has no name), as a sentence with its fix; null when it can. A loopback-only plugin has nothing to wait for. */
  readiness(): string | null;
  /** 1.1. Why `port` cannot be taken for `service`'s `local` port (it is open to the internet, or another entry holds it), as a sentence with its fix; null when it is free or already this board's. */
  claim(port: number, local: number, service: ServedService): string | null;
  /** 1.1. The `host:port` entries this machine serves over HTTPS now, in the order the machine lists them; none for a plugin that serves on loopback only. THROWS, with a sentence, when the machine cannot say. */
  served(): readonly string[];
}
