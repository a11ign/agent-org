// @ts-check
// module: the contract version rule, one rule for both kinds of plugin (A11-158, Decision 8 of A11-157)
//
// A VERSION IS `<major>.<minor>`. A minor only adds, so a plugin that implements 1.3 is read by an agent-org that reads major 1; a major breaks, so a plugin of
// another major is refused by name. The rule is the Claude plugin contract's (`ticket-mode/plugin-contract.ts`, A11-139), which imports its parser from here, so
// there is one rule and not two. Core reads a set of majors per concern (`READ_MAJORS`): a release that reads two majors at once says so here.
import type { Concern } from "./concerns.ts";

/** A contract version as a plugin declares it: `<major>.<minor>`, such as `1.0`. */
export const CONTRACT_VERSION = /^\d+\.\d+$/;

/** The major of a `<major>.<minor>` version: the digits before the dot. */
export const majorOf = (version: string): number => Number(version.split(".")[0]);

/** Whether `version` has a major in `majors`. */
export const readsMajor = (majors: readonly number[], version: string): boolean => majors.includes(majorOf(version));

/** The majors of each concern's contract this agent-org reads. */
export const READ_MAJORS: Readonly<Record<Concern, readonly number[]>> = Object.freeze({ tracker: [1], codeHost: [3], publisher: [1], reviewer: [2], exposure: [1], messaging: [1] });

/** Whether this agent-org reads the contract `version` of a plugin of `concern`. */
export const readsConcernContract = (concern: Concern, version: string): boolean => readsMajor(READ_MAJORS[concern], version);

/**
 * The refusal of a plugin whose contract major is not read, naming the plugin, the concern, the version it declares and what this agent-org reads. `reads` is
 * the majors, so a test that reads others gets its own words.
 */
export function unreadMajorRefusal(plugin: string, concern: Concern, version: string, reads: readonly number[] = READ_MAJORS[concern]): string {
  return `plugin ${plugin} implements ${concern} contract ${version}; this agent-org reads ${concern} ${reads.map((major) => `${major}.x`).join(" and ")}: update agent-org, or use a plugin of a major it reads`;
}
