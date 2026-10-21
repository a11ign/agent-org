// no-token: none -- the code host plugin is built over the fixture host file and runs nothing: its wrapper is asked for a path
//
// A11-160: THE HOST PROGRAMS' ACTIVATION. `host:install`, `host:check` and the instance's start-up check await `activateCodeHost()` and then read `activeCodeHost()`; a process that forgot is refused by name
// and never given a default.
import "../packaging/host-units-project.ts"; // FIRST: it names the fixture project the tool resolves at import
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapperOf } from "../host-units/host-drift-findings-and-notes.ts";
import { activateCodeHost } from "./activate-host.ts";
import { activeCodeHost, forgetActivation, PluginActivationRefusal } from "./active.ts";

test("a process that did not activate a code host is refused by name when it asks for the wrapper", () => {
  forgetActivation();
  assert.throws(() => wrapperOf(), (error: unknown) => error instanceof PluginActivationRefusal && /no code host is active in this process/.test(error.message));
});

test("after activateCodeHost the bundled GitHub plugin's wrapper is the one asked for, and a wrapper handed in wins", async () => {
  forgetActivation();
  await activateCodeHost();
  const wrapper = activeCodeHost().wrapper;
  assert.ok(wrapper !== undefined, "the host file names no code host block, so the bundled github runs, and it has a wrapper");
  assert.equal(wrapperOf(), wrapper);
  const own = { ...wrapper };
  assert.equal(wrapperOf({ wrapper: own }), own);
  forgetActivation();
});
