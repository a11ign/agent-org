// no-token: none -- registers tests only; nothing here reaches `gh`, `herdr` or `git`
/**
 * ONE TEST PER CASE, THE WAY `test.each` WRITES THEM.
 *
 * `node:test` has no `each`, and the node:test shim maps only `test`, `it`, `skip`, `todo` and `only`, so `test.each` is undefined in a test
 * file. This registers each case as its own `test`, titled `title: case name`, so a failing case names itself and the rest still run.
 *
 * The body gets only the case: it must not need the test context (`t.after`, `t.skip`), because a case is not a context of its own.
 * `skip` is passed to every case, so a table whose file cannot run here shows each case as skipped, as `test.each` would.
 *
 * `register` is the call that makes each test; it defaults to `test`, and a test of this helper passes a recorder to see what would be registered.
 */
import { test } from "node:test";

/** The title of one case's test: the table's title, then the case's own name. */
export const caseTitle = (title: string, c: { name: string }): string => `${title}: ${c.name}`;

type Register = (name: string, options: { skip: boolean | string }, run: () => void | Promise<void>) => void;

export function testEach<C extends { name: string }>(title: string, cases: readonly C[], body: (c: C) => void | Promise<void>,
  { skip = false, register = test }: { skip?: boolean | string; register?: Register } = {}): void {
  for (const c of cases) register(caseTitle(title, c), { skip }, () => body(c));
}
