// @ts-check
// module: who places a new-ticket request's ticket -- PURE and free of Node, so the board's page can import it as the server does

/**
 * Who places a new-ticket request's ticket (A11-199): `auto` leaves the project, repository, goal, priority and parent to the writer, and `manual` gives
 * the choices the person made, which the writer uses as given and chooses the rest.
 */
export type Placement = "auto" | "manual";

/** The placement a form implies when its request names none: `manual` when it names any of its five choices, else `auto`. PURE. */
export const placementOf = (form: Readonly<Record<string, unknown>>): Placement => (Object.keys(form).length === 0 ? "auto" : "manual");
