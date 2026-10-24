// @ts-check
// module: the operations and checks of the last sections of `rows` (A11-160, step 9), gathered from one file each
import type { Conditional } from "./suite.ts";
import { PULLWORK_CHECKS, PULLWORK_OPERATIONS } from "./rows-pullwork.ts";
import { AUDIT_CHECKS, AUDIT_OPERATIONS } from "./rows-audit.ts";
import { CLOSING_CHECKS, CLOSING_OPERATIONS } from "./rows-closing.ts";
import { CLASSES_CHECKS, CLASSES_OPERATIONS } from "./rows-classes.ts";
import { QUEUE_CHECKS, QUEUE_OPERATIONS } from "./rows-queue.ts";
import { READOUTS_CHECKS, READOUTS_OPERATIONS } from "./rows-readouts.ts";
import { PLUMBING_CHECKS, PLUMBING_OPERATIONS } from "./rows-plumbing.ts";
import type { Subject } from "./rows-support.ts";

export const TAIL_OPERATIONS: readonly string[] = [...PULLWORK_OPERATIONS, ...AUDIT_OPERATIONS, ...CLOSING_OPERATIONS, ...CLASSES_OPERATIONS, ...QUEUE_OPERATIONS, ...READOUTS_OPERATIONS, ...PLUMBING_OPERATIONS];

export const TAIL_CHECKS: Readonly<Record<string, Conditional<Subject>>> = { ...PULLWORK_CHECKS, ...AUDIT_CHECKS, ...CLOSING_CHECKS, ...CLASSES_CHECKS, ...QUEUE_CHECKS, ...READOUTS_CHECKS, ...PLUMBING_CHECKS };
