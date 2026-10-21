// @ts-check
// module: the messaging contract, version 1.0 -- the provider `src/messaging/provider-contract.ts` describes (A11-158)
//
// The provider's type and the suite that defines it live in `provider-contract.ts` (`runProviderConformance` is "the only definition of a provider", and every
// provider's own test already calls it). This module names them as the messaging concern's contract and gives it a version.
export type { MessagingProvider, MessagingCapabilities } from "../../messaging/provider-contract.ts";

/** The messaging contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const MESSAGING_CONTRACT_VERSION = "1.0";
