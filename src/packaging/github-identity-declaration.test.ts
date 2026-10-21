// no-token: none -- a source test of the host file's reader: nothing reaches `gh`, a program or the network
//
// #4900: HOW EACH ROLE AUTHENTICATES, as `host.json` declares it (moved out of `app-token.test.ts` by A11-160, which moved the minter and the wrapper into `plugins/github`; their tests went with them). The reader
// stays core's: it refuses a host file by FIELD NAME, and the code host plugin reads the identity it is given as a setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDirForFile } from "./../lib/tmp-fixture.ts";

// `host-config.ts` resolves the project's checkout from `$AGENT_ORG_HOST` or the working directory AT IMPORT (`project-config.ts`'s
// `HOME_CHECKOUT`), and this file may be run as `cd <the tool's own checkout> && npx rstest run <this file>`, which is in no project.
// So the host file is named first and the two modules are imported after it: a static import would be hoisted above this and refuse.
// `??=` leaves a host a caller already named alone.
const SETUP = tmpDirForFile("github-identity-declaration-setup-");
writeFileSync(join(SETUP, "host.json"), JSON.stringify({ projects: [{ id: "p", checkout: SETUP }], primary: "p" }));
process.env.AGENT_ORG_HOST ??= join(SETUP, "host.json");
const { GITHUB_ROLES, HostConfigRefusal, parseHostConfig, roleIdentity } = await import("../host-config.ts");
const { SUPPORTED_SCHEMA } = await import("../project-config.ts");

const HOST = {
  schema: SUPPORTED_SCHEMA, home: "/home/h", binDir: "/home/h/bin", primary: "p", projects: [{ id: "p", checkout: "/home/h/p" }],
  gh: { workers: "/home/h/workers", leads: "/home/h/leads", leadsHeader: [], leadsWorkspaces: [] },
};
const parse = (extra: Record<string, unknown>) => parseHostConfig(JSON.stringify({ ...HOST, ...extra }), "host.json");
const refusalField = (extra: Record<string, unknown>) => {
  try { parse(extra); } catch (error) { return error instanceof HostConfigRefusal ? error.field : `not a refusal: ${error}`; }
  return "not refused";
};
const SCHEDULER_APP = { mode: "github-apps", appId: "123456", keyPath: "/home/h/.config/agent-org/apps/a11ign-scheduler.pem" };

test("#4900: a host that says nothing about `github` is `user-accounts` for every role, and an app on one role leaves the others there", () => {
  const roles = GITHUB_ROLES;
  assert.deepEqual(roles.map((r) => roleIdentity(parse({}), r).mode), ["user-accounts", "user-accounts", "user-accounts", "user-accounts"]);
  assert.deepEqual(roles.map((r) => roleIdentity(parse({ github: {} }), r).mode), ["user-accounts", "user-accounts", "user-accounts", "user-accounts"]);
  const mixed = parse({ github: { identity: { scheduler: SCHEDULER_APP, workers: { mode: "user-accounts" } } } });
  assert.deepEqual(roles.map((r) => roleIdentity(mixed, r).mode), ["github-apps", "user-accounts", "user-accounts", "user-accounts"], "the per-role mix");
  assert.deepEqual(roleIdentity(mixed, "scheduler"), SCHEDULER_APP);
});

test("#4900: an app id written as the integer a hand-written file holds is read as its string; an installation id is kept", () => {
  const host = parse({ github: { identity: { workers: { ...SCHEDULER_APP, appId: 987, installationId: 55 } } } });
  assert.deepEqual(roleIdentity(host, "workers"), { ...SCHEDULER_APP, appId: "987", installationId: "55" });
});

test("#4900: the declaration is refused by FIELD NAME: a role that is not one, a missing id or key, a relative key, a half-flipped role", () => {
  const role = (value: unknown, name = "scheduler") => ({ github: { identity: { [name]: value } } });
  assert.equal(refusalField(role(SCHEDULER_APP, "worker")), "github.identity.worker", "a typo would leave a role on the shared account looking migrated");
  assert.equal(refusalField(role({ mode: "github-app" })), "github.identity.scheduler.mode");
  assert.equal(refusalField(role({ mode: "github-apps", keyPath: SCHEDULER_APP.keyPath })), "github.identity.scheduler.appId");
  assert.equal(refusalField(role({ mode: "github-apps", appId: "1" })), "github.identity.scheduler.keyPath");
  assert.equal(refusalField(role({ ...SCHEDULER_APP, keyPath: "keys/a.pem" })), "github.identity.scheduler.keyPath");
  assert.equal(refusalField(role({ ...SCHEDULER_APP, appId: "a b" })), "github.identity.scheduler.appId");
  assert.equal(refusalField(role({ mode: "user-accounts", appId: "1" })), "github.identity.scheduler.appId", "an app named under user-accounts would be ignored");
  assert.equal(refusalField({ github: "github-apps" }), "github");
  assert.equal(refusalField(role(SCHEDULER_APP)), "not refused", "POSITIVE CONTROL: the valid form is not refused by any of the above");
});
