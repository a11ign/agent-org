// A test-support module (A11-160, step 7): the fake code host with its `rows` WATCHED. A test that used to assert which `gh` commands a caller ran, and in what order, asserts which operations of the code host's rows it
// called instead: every operation is noted with the request it was given, then done by the fake as before. `substituteCodeHost(watched.host)` puts it where core finds it.
import type { CodeHost } from "../contracts/code-host.ts";

export type WatchedCall = { op: string; request: any };

export function watchedRows(host: CodeHost): { host: CodeHost; calls: WatchedCall[] } {
  const calls: WatchedCall[] = [];
  const rows = Object.fromEntries(Object.entries(host.rows!).map(([op, member]) => {
    if (typeof member !== "function") return [op, member];
    return [op, (...args: unknown[]) => {
      calls.push({ op, request: args[0] });
      return (member as (...given: unknown[]) => unknown).apply(host.rows, args);
    }];
  })) as unknown as NonNullable<CodeHost["rows"]>;
  return { host: { ...host, rows }, calls };
}
