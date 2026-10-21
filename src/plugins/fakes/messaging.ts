// @ts-check
// module: the in-memory messaging provider (A11-158) -- `createFakeProvider`, which already passes `runProviderConformance` and which every messaging test sends through
//
// IT IS NOT COPIED: the messaging concern's fake is the provider the messaging tests have always used, so there is one reference that can disagree with nothing.
export { createFakeProvider as createFakeMessaging } from "../../messaging/fake-provider.ts";
