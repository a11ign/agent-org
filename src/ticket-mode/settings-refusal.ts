// module: the refusal ticket mode's host-file readers raise, naming the field it refuses
//
// It lives apart from `settings.ts` so that `providers.ts`, which `settings.ts` reads through, can raise it without importing the module that imports it.

/** A field of the host file that is refused: the field, and the reason it is, which the message names with the field. */
export class TicketSettingsRefusal extends Error {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super(`ticket mode: \`${field}\` in the host file ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}
