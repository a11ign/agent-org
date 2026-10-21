// @ts-check
// module: the messaging contract, version 1.1 -- the provider `src/messaging/provider-contract.ts` describes (A11-158, A11-162)
//
// The provider's type and the suite that defines it live in `provider-contract.ts` (`runProviderConformance` is "the only definition of a provider", and every
// provider's own test already calls it). This module names them as the messaging concern's contract and gives it a version.
//
// 1.1 (A11-162) ONLY ADDS: a provider may have `clearKeyboard` and `listen` (see `MessagingProvider`), and the plugin's code half may export `pair`, the pairing command's one step that is
// the provider's own (`MessagingPair`). `pair` is not on the provider because pairing happens before there is a chairman to build the provider with.
import type { PluginDeps } from "../manifest.ts";

export type { ListenOptions, MessagingProvider, MessagingCapabilities } from "../../messaging/provider-contract.ts";

/** The messaging contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const MESSAGING_CONTRACT_VERSION = "1.1";

/** What the pairing command asks of the plugin (1.1): the files the project's `messaging` key resolves to, and where its words and the one-time code go. Resolves to the exit code: 0 paired, 1 not. */
export type MessagingPair = (options: Readonly<{ tokenFile: string; chairmanFile: string; print: (line: string) => void }>, deps: PluginDeps) => Promise<number>;
