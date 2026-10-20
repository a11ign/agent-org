// @ts-check
// module: the readers' verdict on a file's text, the one check both the Settings page's refusals and a save's refusals come from
//
// THE READERS DECIDE. Each function here calls the reader that loads the file (`parseHostConfig`, `parseTicketSettings`, `parseProjectDeclaration`) and
// answers with its message, or null when it accepts the text. The page reads a file with these, and so does a save, so a value the page shows as
// refused is the value a save refuses, with the same words. The readers are loaded lazily, as `settings-read.ts` loads them, because `host-config.ts`
// and `project-config.ts` resolve a project declaration at import and a ticket-only machine has none.
import { parseTicketSettings } from "./settings.ts";

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A message a reader refused a file with, as the page shows it. */
export const refusalOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether the host file is shaped as a ticket-only one: a `tickets` block and no `primary` (`isTicketOnlyRun`'s shape). */
export const isTicketOnly = (host: Json): boolean => !Object.hasOwn(host, "primary") && isObject(host.tickets);

/** The host file's top level as `parseHostConfig` reads it, or null when it accepts it. A ticket-only host names no project to read it against, so it is not read. */
export async function hostLevelRefusal(text: string, hostPath: string, host: Json): Promise<string | null> {
  if (isTicketOnly(host)) return null;
  try {
    const { parseHostConfig } = await import("../host-config.ts");
    parseHostConfig(text, hostPath);
    return null;
  } catch (error) {
    return refusalOf(error);
  }
}

/** The `tickets` block as `parseTicketSettings` reads the host file, or null when it accepts it. */
export function ticketsRefusal(host: Json): string | null {
  try {
    parseTicketSettings(host);
    return null;
  } catch (error) {
    return refusalOf(error);
  }
}

/** A project's declaration as `parseProjectDeclaration` reads it, or null when it accepts it. */
export async function projectRefusal(text: string, path: string): Promise<string | null> {
  try {
    const { parseProjectDeclaration } = await import("../project-config.ts");
    parseProjectDeclaration(text, path);
    return null;
  } catch (error) {
    return refusalOf(error);
  }
}
