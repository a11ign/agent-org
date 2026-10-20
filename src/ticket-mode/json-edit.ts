// @ts-check
// module: changes the value at one path of a JSON text by replacing only that value's span, so every other byte of the text is kept
//
// WHY A SPLICE. Parsing and writing the whole file again would churn every line, and could reorder keys, so a person's `_` prose keys, their
// indentation and the file's last newline would not survive. Here the text outside the changed span is copied as it is. After the edits, the new
// text is parsed and compared with the old value with exactly the asked changes made, so a bug in the splice cannot reach a file.
//
// PATHS ARE OBJECT KEYS. A list is changed as a whole, so a path never names an element. A path through a key the file does not hold adds the key, and
// the rest of the path under it, at the end of its object, indented as its siblings are.
import { isDeepStrictEqual } from "node:util";

/** One change: the value at `path` becomes `value`, or the key at `path` is removed with its separator. */
export type Edit = Readonly<{ path: readonly string[]; value: unknown }> | Readonly<{ path: readonly string[]; remove: true }>;

/** A key of an object in the text, with where its member starts and the value it holds. */
type Member = { key: string; keyStart: number; value: Node };
/** A value's span in the text, and for an object, its members in order. */
type Node = { start: number; end: number; members?: Member[] };
/** How the text is laid out: its line end, and the indentation one level of nesting adds. */
type Layout = { eol: string; unit: string };

const WHITESPACE = " \t\r\n";
const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** The index after the whitespace that starts at `at`. */
function skip(text: string, at: number): number {
  let i = at;
  while (i < text.length && WHITESPACE.includes(text[i])) i++;
  return i;
}

/** The index after the string that starts at `at`, honouring its escapes. The text is valid JSON, so the closing quote is there. */
function stringEnd(text: string, at: number): number {
  let i = at + 1;
  while (text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** The value that starts at `at`, with its span and, for an object, its members. The text is valid JSON, so this reads it without checking it again. */
function parseNode(text: string, at: number): Node {
  const start = skip(text, at);
  if (text[start] === "{") {
    const members: Member[] = [];
    let i = skip(text, start + 1);
    if (text[i] === "}") return { start, end: i + 1, members };
    for (;;) {
      const keyStart = i;
      const keyEnd = stringEnd(text, i);
      const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
      const value = parseNode(text, skip(text, keyEnd) + 1);
      members.push({ key, keyStart, value });
      i = skip(text, value.end);
      if (text[i] !== ",") return { start, end: i + 1, members };
      i = skip(text, i + 1);
    }
  }
  if (text[start] === "[") {
    let i = skip(text, start + 1);
    if (text[i] === "]") return { start, end: i + 1 };
    for (;;) {
      const item = parseNode(text, i);
      i = skip(text, item.end);
      if (text[i] !== ",") return { start, end: i + 1 };
      i = skip(text, i + 1);
    }
  }
  if (text[start] === "\"") return { start, end: stringEnd(text, start) };
  LITERAL.lastIndex = start;
  const literal = LITERAL.exec(text);
  if (literal === null) throw new Error(`not a JSON value at ${start}`);
  return { start, end: start + literal[0].length };
}

/** The leading whitespace of the line that holds `at`: the indentation a member on that line has. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** The layout the file uses: its line end, and the leading whitespace of its first indented line, which is a child of its root. Two spaces when it has none. */
function layoutOf(text: string): Layout {
  return { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: /^[ \t]+(?=\S)/m.exec(text)?.[0] ?? "  " };
}

/** The members of `node` named `key`, refusing a key the object holds twice, which a parse would keep only the last of. */
function memberNamed(node: Node, key: string, path: readonly string[]): Member | undefined {
  const found = (node.members ?? []).filter((member) => member.key === key);
  if (found.length > 1) throw new Error(`the key ${path.join(".")} appears ${found.length} times in its object`);
  return found[0];
}

/** `value` as the text of a member at `indent`: indented like its siblings, with the file's line ends. */
function renderAt(value: unknown, indent: string, { eol, unit }: Layout): string {
  return JSON.stringify(value, undefined, unit).split("\n").join(`${eol}${indent}`);
}

/** The value `segments` names under `value`, as nested objects: `["a", "b"]` and `1` is `{ a: { b: 1 } }`. */
function nest(segments: readonly string[], value: unknown): unknown {
  return segments.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

/** The text with `entry` added to `object` as a new member at its end: the entry's path is nested under its first key, and its last key holds its value. */
function addMember(text: string, object: Node, entry: Readonly<{ path: readonly string[]; value: unknown }>, layout: Layout): string {
  const [head, ...rest] = entry.path;
  const held = rest.length === 0 ? entry.value : nest(rest, entry.value);
  const members = object.members ?? [];
  if (members.length === 0) {
    // An empty object has no sibling to copy: its members sit one step in from its own line.
    const indent = indentAt(text, object.start);
    const inner = `${layout.eol}${indent + layout.unit}${JSON.stringify(head)}: ${renderAt(held, indent + layout.unit, layout)}${layout.eol}${indent}`;
    return text.slice(0, object.start + 1) + inner + text.slice(object.end - 1);
  }
  const last = members[members.length - 1];
  // An object written on one line gets its new member on that line too; otherwise the member sits where its siblings do.
  const inline = !text.slice(object.start, last.keyStart).includes("\n");
  const indent = indentAt(text, inline ? object.start : last.keyStart);
  const member = `,${inline ? " " : `${layout.eol}${indent}`}${JSON.stringify(head)}: ${renderAt(held, indent, layout)}`;
  return text.slice(0, last.value.end) + member + text.slice(last.value.end);
}

/** The text with the member `member` of `object` removed, with its separator, and the layout of the members around it kept. */
function removeMember(text: string, object: Node, member: Member): string {
  const members = object.members ?? [];
  const at = members.indexOf(member);
  if (members.length === 1) return text.slice(0, object.start + 1) + text.slice(object.end - 1);
  if (at < members.length - 1) return text.slice(0, member.keyStart) + text.slice(members[at + 1].keyStart);
  return text.slice(0, members[at - 1].value.end) + text.slice(member.value.end);
}

/** One edit to the text: the new text, with the value at its path replaced, added, or removed. */
function editOnce(text: string, edit: Edit): string {
  const layout = layoutOf(text);
  const root = parseNode(text, 0);
  if (root.members === undefined) throw new Error("the file's top level is not an object");
  const { path } = edit;
  let object = root;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const member = memberNamed(object, path[depth], path);
    if (member === undefined) {
      // A key the file does not hold: a removal has nothing to remove, and a change adds the rest of the path under it.
      return "remove" in edit ? text : addMember(text, object, { path: path.slice(depth), value: edit.value }, layout);
    }
    if (member.value.members === undefined) throw new Error(`${path.slice(0, depth + 1).join(".")} is not an object, so ${path.join(".")} cannot be set inside it`);
    object = member.value;
  }
  const last = path[path.length - 1];
  const member = memberNamed(object, last, path);
  if ("remove" in edit) {
    if (member === undefined) return text;
    return removeMember(text, object, member);
  }
  if (member !== undefined) {
    const indent = indentAt(text, member.keyStart);
    return text.slice(0, member.value.start) + renderAt(edit.value, indent, layout) + text.slice(member.value.end);
  }
  return addMember(text, object, { path: [last], value: edit.value }, layout);
}

/** The value at `path` in `root` with `edit` made to it, on a copy: what the text must parse to. */
function applied(root: Record<string, unknown>, edit: Edit): Record<string, unknown> {
  const copy = structuredClone(root);
  let object: Record<string, unknown> = copy;
  const { path } = edit;
  for (const key of path.slice(0, -1)) {
    if (!(key in object)) {
      if ("remove" in edit) return copy;
      object[key] = {};
    }
    object = object[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if ("remove" in edit) delete object[last];
  else object[last] = edit.value;
  return copy;
}

/**
 * The text with each edit made in order. Each is spliced into the text the one before it made, and the result must parse to exactly the old value with
 * the edits made to it: a change that would alter anything else throws, and nothing is returned.
 */
export function spliceJson(text: string, edits: readonly Edit[]): string {
  let next = text;
  for (const edit of edits) next = editOnce(next, edit);
  const expected = edits.reduce<Record<string, unknown>>((value, edit) => applied(value, edit), JSON.parse(text) as Record<string, unknown>);
  if (!isDeepStrictEqual(JSON.parse(next), expected)) throw new Error("the edit would change more than the value it names, so nothing is written");
  return next;
}
