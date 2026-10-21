// @ts-check
// module: the machinery every concern's contract suite shares (A11-158), written as `runProviderConformance` (messaging) already is
//
// A SUITE IS A TABLE OF CHECKS RUN AGAINST ONE IMPLEMENTATION, AND IT REPORTS EVERY FAILURE, not the first. A check that does not apply (an optional operation the
// implementation does not have) is `skipped` WITH its reason and never counted as a pass, and an implementation's own test asserts which checks ran, so a suite
// that skipped everything is not green. A suite resolves `{ passed, skipped }` only when nothing failed, and throws a `ConformanceError` listing each failure otherwise.
import { ConformanceError } from "../../messaging/provider-contract.ts";
import type { Concern } from "../concerns.ts";

export type Skipped = Readonly<{ check: string; reason: string }>;
export type ConformanceResult = Readonly<{ passed: readonly string[]; skipped: readonly Skipped[] }>;

/** One check: it throws (or rejects) with a message when the implementation is wrong. */
export type Run<Subject> = (subject: Subject) => unknown;
/** A check that applies only to an implementation that has the operation: `applies` says so, and `reason` is what a skip says. */
export type Conditional<Subject> = Readonly<{ applies: (subject: Subject) => boolean; reason: string; run: Run<Subject> }>;

/** What a suite throws: the concern, every failed check with its message, and what passed and was skipped before it. */
export class ContractError extends ConformanceError {
  constructor(readonly concern: Concern, failures: { check: string; message: string }[], passed: string[], skipped: Skipped[]) {
    super(failures, passed, skipped);
    this.message = `${concern} plugin failed its contract suite: ${failures.map((failure) => `${failure.check} (${failure.message})`).join("; ")}`;
  }
}

/** Throws `message` unless `condition` holds: the check's way to fail. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string => typeof value === "string";

/** Whether `value` is a function: every contract object is checked for the operations it must have before any of them is called. */
export const hasFunctions = (subject: unknown, names: readonly string[]): boolean => isObject(subject) && names.every((name) => typeof subject[name] === "function");

async function attempt(check: string, run: () => unknown, failures: { check: string; message: string }[]): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    failures.push({ check, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Run `always` (every check) and then `conditional` (each only where it applies) against `subject`, after `shape`, which must hold or nothing else is run.
 * @throws ContractError listing each failed check
 */
export async function runChecks<Subject>(concern: Concern, subject: Subject, tables: Readonly<{
  shape: Run<Subject>; always: Readonly<Record<string, Run<Subject>>>; conditional?: Readonly<Record<string, Conditional<Subject>>>;
}>): Promise<ConformanceResult> {
  const failures: { check: string; message: string }[] = [];
  const passed: string[] = [];
  const skipped: Skipped[] = [];
  if (!(await attempt("shape", () => tables.shape(subject), failures))) throw new ContractError(concern, failures, passed, skipped);
  passed.push("shape");
  for (const [check, run] of Object.entries(tables.always)) {
    if (await attempt(check, () => run(subject), failures)) passed.push(check);
  }
  for (const [check, { applies, reason, run }] of Object.entries(tables.conditional ?? {})) {
    if (!applies(subject)) skipped.push({ check, reason });
    else if (await attempt(check, () => run(subject), failures)) passed.push(check);
  }
  if (failures.length > 0) throw new ContractError(concern, failures, passed, skipped);
  return { passed, skipped };
}
