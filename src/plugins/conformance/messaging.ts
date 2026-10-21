// @ts-check
// module: the messaging contract's suite (A11-158) -- `runProviderConformance`, unchanged, under the name every concern's suite has
//
// `src/messaging/provider-contract.ts` is "the only definition of a provider", and every provider's own test already calls it, so the messaging concern's suite is that
// one function and not a second one that could disagree with it. It returns `{ passed, skipped }` and throws a `ConformanceError` listing every failure, as the others do.
export { runProviderConformance as runMessagingConformance } from "../../messaging/provider-contract.ts";
