// no-token: none -- the child is a stub; no program is started
// A11-377: the After-merge sweep reads this host's doctor from a child, so the doctor's synchronous spawns never hold the board's loop
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCTOR_MS, DOCTOR_PROGRAM, doctorLinesOf, hostDoctorLines } from "./host-doctor.ts";

const LINES = [{ name: "instance", ok: true, detail: "running" }, { name: "linear mcp", ok: false, detail: "not connected" }];
const printed = (stdout: string, status: number | null = 0) => ({ status, stdout, stderr: "" });

test("the doctor's lines are the child's last line of JSON, whatever a check printed before it", () => {
  assert.deepEqual(doctorLinesOf(printed(`a check's own output\n${JSON.stringify(LINES)}\n`)), { lines: LINES });
});

test("a child that failed, printed no lines or printed lines that are not lines answers why", () => {
  assert.deepEqual(doctorLinesOf({ status: 1, stdout: "", stderr: "\nError: cannot find module\n" }), { failure: "Error: cannot find module" });
  assert.deepEqual(doctorLinesOf({ status: null, stdout: "", stderr: "", spawnError: "spawn node ETIMEDOUT" }), { failure: "spawn node ETIMEDOUT" });
  assert.deepEqual(doctorLinesOf(printed("not json")), { failure: "the doctor's child exited 0 and printed no lines" });
  assert.deepEqual(doctorLinesOf(printed(JSON.stringify([{ name: "x" }]))), { failure: "the doctor's child exited 0 and printed no lines" });
  assert.deepEqual(doctorLinesOf(printed(JSON.stringify(LINES), 1)), { failure: "the doctor's child exited 1 and printed no lines" }, "lines from a child that failed are not trusted");
});

test("the doctor runs in a child of this Node, bounded, from the doctor module that exists (A11-377)", async () => {
  const asked: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const answer = await hostDoctorLines(async (file, args, { timeoutMs }) => {
    asked.push({ file, args, timeoutMs });
    return printed(JSON.stringify(LINES));
  });
  assert.deepEqual(answer, { lines: LINES });
  assert.deepEqual(asked.map(({ file, args, timeoutMs }) => [file, args.slice(0, 2), timeoutMs]), [[process.execPath, ["--input-type=module", "-e"], DOCTOR_MS]]);
  const doctor = /import\("([^"]+)"\)/.exec(DOCTOR_PROGRAM)?.[1] ?? "";
  assert.ok(existsSync(fileURLToPath(doctor)), `the child imports ${doctor}`);
});
