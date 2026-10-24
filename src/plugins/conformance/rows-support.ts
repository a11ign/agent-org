// @ts-check
// module: what the checks of `rows` share (A11-160, step 9): the subject, a `run` the host refuses, and the two conditions a rows check applies under
import type { CodeHost } from "../contracts/code-host.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { CodeHostProbe } from "./code-host.ts";
import type { Conditional } from "./suite.ts";

export type Subject = Readonly<{ host: CodeHost; probe: CodeHostProbe }>;

/** A `run` the host refuses: every call throws, as `gh` does for a call it cannot make. */
export const refused = (): string => {
  throw new Error("HTTP 502: the host refused the call");
};

/** Whether `call` throws: a read that could not be made must not answer an empty list, and a write that could not be made must not read as done. */
export function throws(call: () => unknown): boolean {
  try {
    call();
    return false;
  } catch {
    return true;
  }
}

/** Rows whose operations act on the `run` their caller hands them (`acts: "through-run"`): only those have a refused `run` to answer. */
export const withRunRows = (reason: string, run: (subject: Subject & { rows: CodeHostRows }) => unknown): Conditional<Subject> => ({
  applies: ({ host }) => host.rows?.acts === "through-run", reason: `the code host has no rows that act through the caller's run (contract 1.10), so ${reason}`, run: (subject) => run({ ...subject, rows: subject.host.rows! }),
});

export const withRows = (reason: string, run: (subject: Subject & { rows: CodeHostRows }) => unknown): Conditional<Subject> => ({
  applies: ({ host }) => host.rows !== undefined, reason: `the code host has no rows, which are optional (contract 1.10), so ${reason}`, run: (subject) => run({ ...subject, rows: subject.host.rows! }),
});
