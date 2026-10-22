// module: what a merged pull request found, as the code host reads it (A11-167)
//
// A dependent ticket's planner is given what each blocker's pull request found. That is the pull request's title and body, which summarise it and say what it found when there is no write-up, and the
// markdown sections its diff ADDED: a write-up's new section is a heading among the added lines of a `.md` file. No heading is named here, because a write-up's heading is whatever its author chose
// (announcement-emulator#3 added `### Scripted replay` to its spike write-up). Read through the plugin's `gh` runner, so this file spawns nothing.
import type { MergedFindings, FindingsSection } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";

/** The most characters one section's text keeps: a write-up's section is a few paragraphs, and a section past this is cut, with the cut said. */
export const SECTION_CHARS = 20_000;

/** The files a pull request adds to that are not write-ups: its acceptance file, its changesets and the changelog the release writes. */
const NOT_WRITE_UP = /(^|\/)(\.acceptance|\.changeset)\/|(^|\/)CHANGELOG\.md$/;

const HEADING = /^(#{1,6})\s+(\S.*)$/;

/** The file a `diff --git a/<path> b/<path>` header names, or null. PURE. */
const fileOfHeader = (line: string): string | null => /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2] ?? null;

/**
 * The sections a diff adds to the markdown files that are write-ups: for each added heading, its text and the added lines under it until the next added heading. Lines the diff only shows
 * as context, and removed lines, are left out, and so is a heading inside a fenced code block. Added text with no added heading above it in its file is not a section, and the pull request's body
 * covers it. PURE.
 */
export function addedSections(diff: string): FindingsSection[] {
  const sections: FindingsSection[] = [];
  let file: string | null = null;
  let open: { file: string; heading: string; lines: string[] } | null = null;
  let fenced = false;
  const close = () => {
    if (open !== null) sections.push({ file: open.file, heading: open.heading, text: cut(open.lines.join("\n").trim()) });
    open = null;
  };
  for (const line of diff.split("\n")) {
    const header = fileOfHeader(line);
    if (header !== null) {
      close();
      fenced = false;
      file = header.endsWith(".md") && !NOT_WRITE_UP.test(header) ? header : null;
      continue;
    }
    if (file === null || !line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    if (added.trimStart().startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(added);
    if (heading !== null) {
      close();
      open = { file, heading: added.trim(), lines: [] };
    } else if (open !== null) {
      open.lines.push(added);
    }
  }
  close();
  return sections;
}

const cut = (text: string): string => (text.length > SECTION_CHARS ? `${text.slice(0, SECTION_CHARS)}\n(cut at ${SECTION_CHARS} characters)` : text);

/**
 * WHAT THE MERGED PULL REQUEST AT `url` FOUND, or `null` for "could not ask": a refused `gh`, an answer that does not parse, and a pull request that has not merged, whose findings are not final.
 * `null` is never "it found nothing": a caller that passes findings on must not read a failed read as an empty one.
 */
export function readMergedFindings(url: string, gh: Gh): MergedFindings | null {
  try {
    const pull: { number: number; title: string; body: string | null; state: string } = JSON.parse(gh(["pr", "view", url, "--json", "number,title,body,state"]));
    if (pull.state !== "MERGED" || typeof pull.title !== "string" || !Number.isInteger(pull.number)) return null;
    return { title: pull.title, number: pull.number, body: pull.body ?? "", sections: addedSections(gh(["pr", "diff", url])) };
  } catch (error) {
    void error; // no read is "cannot say", which the caller asks again on
    return null;
  }
}
