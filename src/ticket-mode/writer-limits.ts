// @ts-check
// module: the limits on a new-ticket request -- PURE and free of Node, so the board's page can import them as the server does
//
// THE PAGE'S New ticket DIALOG SHOWS THESE LIMITS, AND THE SERVER ENFORCES THEM. They are defined here once. `writer.ts` reads `node:fs`, so the page
// cannot import it.

/** The longest request a new-ticket run takes, in characters. */
export const WRITER_REQUEST_CHARS = 8000;

/** The most tickets one writer run may create: the hook refuses an eleventh creation. */
export const MAX_CREATED = 10;
