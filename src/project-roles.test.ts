// no-token: none -- reads a roster fixture file only
/**
 * #4740: A `live` ENTRY IN `sessions.json` MAY CARRY `model`, `effort` AND `autocompact`, and `persistentEntries` returns them with the name and
 * brief. A malformed value comes back as a `refusal` naming the entry and the field; it is never dropped to a default and never a throw (a throw
 * would read as an unreadable roster and stop every seat). An absent field is not a refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { persistentEntries, persistentRoles } from "./project-roles.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const scratch = tmpDirForFile("roles-4740-");
let files = 0;
function roster(live: object[]): string {
  const path = join(scratch, `sessions-${files++}.json`);
  writeFileSync(path, JSON.stringify({ live }));
  return path;
}

test("the three fields are returned with the name and the brief", () => {
  const path = roster([{ name: "liaison", persistent: true, brief: "b.md", model: "claude-haiku-5-5", effort: "high", autocompact: 130000 }]);
  assert.deepEqual(persistentEntries(path), [{ name: "liaison", brief: "b.md", model: "claude-haiku-5-5", effort: "high", autocompact: 130000 }]);
});

test("an entry declaring none returns exactly what it returned before: a name and a brief", () => {
  const entries = persistentEntries(roster([{ name: "liaison", persistent: true, brief: "b.md" }, { name: "ceo", role: "ceo", model: "opus" }]));
  assert.deepEqual(entries, [{ name: "liaison", brief: "b.md" }]);
  assert.ok(!("model" in entries[0]) && !("refusal" in entries[0]));
});

test("every accepted effort is accepted, and a model alias or bracketed id is a model", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(persistentEntries(roster([{ name: "s", persistent: true, brief: "b", effort }]))[0].refusal, undefined, effort);
  }
  for (const model of ["sonnet", "claude-opus-5-5", "opus[1m]"]) {
    assert.equal(persistentEntries(roster([{ name: "s", persistent: true, brief: "b", model }]))[0].refusal, undefined, model);
  }
});

test("a malformed field is refused by naming the entry and the field, and the seat is still a persistent role", () => {
  const bad: [object, string][] = [
    [{ model: "" }, "model"], [{ model: "two words" }, "model"], [{ model: "-x" }, "model"], [{ model: 5 }, "model"],
    [{ effort: "HIGH" }, "effort"], [{ effort: 3 }, "effort"],
    [{ autocompact: 0 }, "autocompact"], [{ autocompact: -1 }, "autocompact"], [{ autocompact: 2.5 }, "autocompact"], [{ autocompact: "90000" }, "autocompact"], [{ autocompact: null }, "autocompact"],
  ];
  for (const [fields, field] of bad) {
    const path = roster([{ name: "liaison", persistent: true, brief: "b.md", ...fields }]);
    const [entry] = persistentEntries(path);
    assert.match(entry.refusal ?? "", new RegExp(`\`liaison\`.*\`${field}\``), JSON.stringify(fields));
    assert.deepEqual(persistentRoles(path), ["liaison"], "a bad field does not make the seat stop being checked");
  }
});

test("one seat's bad field does not touch another's entry", () => {
  const entries = persistentEntries(roster([
    { name: "a", persistent: true, brief: "a.md", effort: "turbo" },
    { name: "b", persistent: true, brief: "b.md", model: "sonnet" },
  ]));
  assert.match(entries[0].refusal ?? "", /`a`/);
  assert.deepEqual(entries[1], { name: "b", brief: "b.md", model: "sonnet" });
});
