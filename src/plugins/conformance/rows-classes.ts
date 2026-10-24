// @ts-check
// module: the code host contract suite's checks of the classes section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsClasses } from "../contracts/code-host-rows-classes.ts";
import { expect, type Conditional } from "./suite.ts";
import { refused, throws, withRows, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const CLASSES_OPERATIONS = [
  "redCheckOf", "recentRunsOf", "jobOfCheckUrl", "jobFailedStepOf", "jobLogTextOf", "changedFilesPageOf", "pullMergedAtOf", "openPullBehindBy", "updatePullBranch", "sharedFailureRowsOf", "fileSharedFailureRow",
  "closedClassRowsOf", "closedRowsTitledOf", "labelledRowsOf", "mainCommitLoginsSince", "mergedPullsSince", "postMarkedIssueComment", "commentBodyOf",
  "commentOnCheckoutRowByInput", "openRowsCarryingLabel",
] as const satisfies readonly (keyof RowsClasses & keyof CodeHostRows)[];

/** An answer that is JSON but no comment: GitHub's error document, printed to standard output as the program exits non-zero (#563). */
const NOT_FOUND = JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest" });

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const CLASSES_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the classes section throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      redCheckOf: () => rows.redCheckOf({ repo, number: 1, head8: "abcdef12", run: refused }), recentRunsOf: () => rows.recentRunsOf({ repo, kind: "on-main", limit: 10, run: refused }),
      jobFailedStepOf: () => rows.jobFailedStepOf({ repo, jobId: 1, run: refused }), jobLogTextOf: () => rows.jobLogTextOf({ repo, jobId: 1, run: refused }),
      changedFilesPageOf: () => rows.changedFilesPageOf({ repo, number: 1, perPage: 100, run: refused }), pullMergedAtOf: () => rows.pullMergedAtOf({ repo, number: 1, run: refused }),
      openPullBehindBy: () => rows.openPullBehindBy({ repo, number: 1, run: refused }), sharedFailureRowsOf: () => rows.sharedFailureRowsOf({ label: "x", state: "open", newest: 20, run: refused }),
      closedClassRowsOf: () => rows.closedClassRowsOf({ repo, classLabel: null, perPage: 100, run: refused }), closedRowsTitledOf: () => rows.closedRowsTitledOf({ repo, perPage: 100, run: refused }),
      labelledRowsOf: () => rows.labelledRowsOf({ repo, label: "x", run: refused }),
      mainCommitLoginsSince: () => rows.mainCommitLoginsSince({ repo, since: new Date(0), run: refused }), mergedPullsSince: () => rows.mergedPullsSince({ repo, since: new Date(0), maxPages: 1, run: refused }),
      commentBodyOf: () => rows.commentBodyOf({ repo, id: 1, run: refused }),
      openRowsCarryingLabel: () => rows.openRowsCarryingLabel({ repo, label: "x", limit: 10, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a write the rows could not make for the classes section throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      updatePullBranch: () => rows.updatePullBranch({ repo, number: 1, run: refused }), fileSharedFailureRow: () => rows.fileSharedFailureRow({ label: "x", description: "d", title: "t", body: "b", run: refused }),
      postMarkedIssueComment: () => rows.postMarkedIssueComment({ repo, issue: 1, marker: "<!-- m -->", day: "2026-10-24", text: "t", run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
  "an answer that is JSON and not a comment is never a comment's body": withRunRows("no answer is handed to the read", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const read = (answer: string) => rows.commentBodyOf({ repo, id: 1, run: () => answer });
    expect(read(NOT_FOUND).kind === "not-a-comment", "an error document is not a comment");
    expect(read("<html>502</html>").kind === "not-json", "an answer that is not JSON is not a comment");
    const empty = read(JSON.stringify({ body: "" }));
    expect(empty.kind === "body" && empty.body === "", "an emptied comment is a comment with an empty body");
  }),
  "the repository and job a check's details address names are read without asking the code host": withRows("no check is asked", ({ rows }) => {
    const found = rows.jobOfCheckUrl("https://github.com/o/r/actions/runs/555/job/666");
    expect(found !== null && found.repo === "o/r" && found.jobId === "666", "a workflow job's address names its repository and job");
    expect(rows.jobOfCheckUrl("https://example.com/status/1") === null, "an address that names no workflow job is null");
  }),
};
