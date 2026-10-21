// @ts-check
// module: the contract versions of this release, and the fakes: one in-memory plugin per concern (A11-158, A11-159, A11-160, A11-161, A11-162)
//
// THERE IS NO BUILT-IN PLUGIN. Until A11-161 a concern whose code still lived in core (the publisher's `slack`, the reviewer's `atomic`) was a row here, pinned there by `CORE_RUNS`, so a host
// file that named it read while core ran its code unconditionally. Every concern is now a bundled package (`plugins/<name>`) the registry finds from its manifest, and core runs whichever
// plugin a host enables: nothing is pinned, and `none` is the absence of an enabled plugin. What stays is each concern's contract version, which a plugin written now declares, and the fakes
// core's own tests build on (`src/plugins/fakes/`); they run no host, so a host file cannot enable one.
import type { Concern } from "./concerns.ts";
import { CONCERNS } from "./concerns.ts";
import { CODE_HOST_CONTRACT_VERSION } from "./contracts/code-host.ts";
import { EXPOSURE_CONTRACT_VERSION } from "./contracts/exposure.ts";
import { MESSAGING_CONTRACT_VERSION } from "./contracts/messaging.ts";
import { PUBLISHER_CONTRACT_VERSION } from "./contracts/publisher.ts";
import { REVIEWER_CONTRACT_VERSION } from "./contracts/reviewer.ts";
import { TRACKER_CONTRACT_VERSION } from "./contracts/tracker.ts";
import { FAKE_TRACKER_WRITING } from "./fakes/tracker.ts";
import { type CatalogPlugin, NO_TOOLING, type Tooling } from "./manifest.ts";

/** The version of each concern's contract in this release: what a plugin written now declares. */
export const CONTRACT_VERSIONS: Readonly<Record<Concern, string>> = {
  tracker: TRACKER_CONTRACT_VERSION, codeHost: CODE_HOST_CONTRACT_VERSION, publisher: PUBLISHER_CONTRACT_VERSION,
  reviewer: REVIEWER_CONTRACT_VERSION, exposure: EXPOSURE_CONTRACT_VERSION, messaging: MESSAGING_CONTRACT_VERSION,
};

/** The tooling a fake declares: the fake tracker's writer tools, so a core test of the writer builds on the fake, and none for the rest. */
const fakeTooling = (concern: Concern): Tooling => (concern === "tracker" ? Object.freeze({ ...NO_TOOLING, connectorServers: ["fake"], writer: FAKE_TRACKER_WRITING }) : NO_TOOLING);

/** The fakes, one per concern: in-memory implementations (`src/plugins/fakes/`) that pass their concern's suite and that core's own tests use. They run no host. */
export const FAKES: readonly CatalogPlugin[] = Object.freeze(CONCERNS.map((concern): CatalogPlugin => Object.freeze({
  name: `fake-${concern}`, concern, description: `An in-memory ${concern} that passes the ${concern} contract suite, for core's tests.`,
  contract: CONTRACT_VERSIONS[concern], entry: null, settings: Object.freeze({}), tooling: fakeTooling(concern), where: "fake", dir: null,
})));
