// @ts-check
// module: `ticket:capture`'s pure parts -- a size, a route, a capture's file name, the throwaway host file it starts the board from, and a PNG's size
//
// NOTHING IS STARTED OR WRITTEN HERE. `capture-command.ts` does that, and calls these to decide what it does. The host file is built in code, not copied
// from a fixture, so the test that loads it through `readTicketSettings` breaks when a key is renamed, and the board's key is the one the settings reader
// reads.
//
// THE ROUTE is the board's own hash address: `/settings` is the Settings page (`#/settings`), `/` the board. A route that is not a plain path is refused,
// so a capture never opens another address.

/** The size a capture is taken at when `--size` is not given: the size the worker brief asks for. */
export const DEFAULT_SIZE = "1280x800";

/** A capture's width and height in CSS pixels, both whole and at least 1. */
export type Size = Readonly<{ width: number; height: number }>;

/** Why a capture was refused, named, so the person sees what to change and nothing started. */
export class CaptureRefusal extends Error {}

/** The largest side a capture may ask for, in pixels: the browser's own viewport limit, far above any screen. */
const MAX_SIDE = 16384;

/** Whether `side` is a whole number of pixels a capture can be made at. */
const isSide = (side: number): boolean => side >= 1 && side <= MAX_SIDE;

/** `WxH` as a size: whole, positive, and at most 16384 on each side. REFUSES anything else, naming the form. */
export function parseSize(text: string): Size {
  const match = /^(\d+)x(\d+)$/.exec(text);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (match === null || !isSide(width) || !isSide(height)) {
    throw new CaptureRefusal(`--size must be WIDTHxHEIGHT in pixels, such as 1280x800, not ${JSON.stringify(text)}`);
  }
  return { width, height };
}

/** A route as the board names it: `/` for the board, `/settings` for the Settings page. REFUSES anything that is not a plain path. */
export function parseRoute(route: string): string {
  if (!/^\/[A-Za-z0-9_\-/]*$/.test(route)) {
    throw new CaptureRefusal(`the route must be a path of the board such as /settings, not ${JSON.stringify(route)}`);
  }
  return route;
}

/** The route's name as a file name: `/settings` is `settings`, `/` is `board`, and anything else is its words joined by `-`. PURE. */
export function routeSlug(route: string): string {
  return route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-") || "board";
}

/** The file a capture is written to: `<route>-<W>x<H>.png`, so the same route at two sizes never overwrite each other. PURE. */
export function captureName(route: string, size: Size): string {
  return `${routeSlug(route)}-${size.width}x${size.height}.png`;
}

/** The address a paired browser opens to show `route` on the board page at `uiPort`: the hash route, as the board reads it. PURE. */
export function routeAddress(uiPort: number, route: string): string {
  const path = parseRoute(route);
  return path === "/" ? `http://127.0.0.1:${uiPort}/` : `http://127.0.0.1:${uiPort}/#${path}`;
}

/** The section that is shown once `route` has drawn: the Settings page's, or the board's. PURE. */
export const readySelector = (route: string): string => (parseRoute(route) === "/settings" ? "#settings-page:not([hidden])" : "#board:not([hidden])");

/**
 * The host file a throwaway instance and board start from. Only the machine facts a capture needs: this checkout as its one repository, the two ports, a
 * local exposure, the tracker's key read from a file, and the state and bin folders inside the throwaway directory, so no real host file, key or `gh`
 * wrapper is read or written. `readTicketSettings` loads it (`capture.test.ts`). PURE.
 */
export function captureHost({ checkout, stateDir, binDir, port, uiPort, keyPath }: Readonly<{
  checkout: string; stateDir: string; binDir: string; port: number; uiPort: number; keyPath: string;
}>): Record<string, unknown> {
  return {
    schema: 1,
    projects: {},
    binDir,
    clones: { "agent-org": checkout },
    stateDir,
    tickets: {
      providers: {
        exposure: { provider: "local", port, uiPort },
        tracker: { provider: "linear", key: { path: keyPath } },
      },
    },
  };
}

/** The one-line herdr the throwaway environment puts first on PATH: it answers the instance's start question (no workspaces), and starts nothing. */
export const HERDR_STUB = [
  "#!/bin/sh",
  "# ticket:capture's throwaway herdr: the instance asks its session's workspaces once at start, and the answer is none, so no herdr server starts.",
  "case \"$*\" in",
  "  *\"workspace list\"*) echo '{\"result\":{\"workspaces\":[]}}' ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/** The size a PNG file was made at, read from its header, or null when the bytes are not a PNG. PURE. */
export function pngSize(bytes: Uint8Array): Size | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
