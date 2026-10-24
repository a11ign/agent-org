// @ts-check
// module: the in-memory code host's operations for the last sections of `rows` (A11-160, step 9): one file each, and a piece of the world a test seeds, `world.tail.<section>`
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import { pullworkOperations, emptyPullwork, type FakePullwork } from "./code-host-pullwork.ts";
import { auditOperations, emptyAudit, type FakeAudit } from "./code-host-audit.ts";
import { closingOperations, emptyClosing, type FakeClosing } from "./code-host-closing.ts";
import { classesOperations, emptyClasses, type FakeClasses } from "./code-host-classes.ts";
import { queueOperations, emptyQueue, type FakeQueue } from "./code-host-queue.ts";
import { readoutsOperations, emptyReadouts, type FakeReadouts } from "./code-host-readouts.ts";
import { plumbingOperations, emptyPlumbing, type FakePlumbing } from "./code-host-plumbing.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

export type FakeTail = { pullwork: FakePullwork; audit: FakeAudit; closing: FakeClosing; classes: FakeClasses; queue: FakeQueue; readouts: FakeReadouts; plumbing: FakePlumbing };

export const emptyTail = (): FakeTail => ({ pullwork: emptyPullwork(), audit: emptyAudit(), closing: emptyClosing(), classes: emptyClasses(), queue: emptyQueue(), readouts: emptyReadouts(), plumbing: emptyPlumbing() });

export function tailOperations(world: FakeRowsWorld): Pick<CodeHostRows, never> & ReturnType<typeof pullworkOperations> & ReturnType<typeof auditOperations> & ReturnType<typeof closingOperations> & ReturnType<typeof classesOperations> & ReturnType<typeof queueOperations> & ReturnType<typeof readoutsOperations> & ReturnType<typeof plumbingOperations> {
  return { ...pullworkOperations(world), ...auditOperations(world), ...closingOperations(world), ...classesOperations(world), ...queueOperations(world), ...readoutsOperations(world), ...plumbingOperations(world) };
}
