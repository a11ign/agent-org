// A window longer than the pages a read was allowed: the rows past the last page are UNSEEN, which a caller may report as a limit hit rather than as unreadable.
//
// A LEAF, with no import, because two sides need the one class: the GitHub plugin throws it (core hands it the class in `RowsHelpers`, since a plugin imports core's types only), and a caller tests
// for it with `instanceof` (`rows-since.ts`, which re-exports it).
export class WindowCutShort extends Error {}
