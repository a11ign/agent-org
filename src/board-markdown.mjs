// @ts-check
// A markdown -> HTML converter for EXACTLY the subset `board-document.mjs` emits, and no more.
//
// Not a general markdown library, and deliberately not one. The alternative was a dependency (`marked`,
// `markdown-it`) in a repo whose isolation gate exists to catch phantom dependencies, or a system binary
// (`pandoc`) that is not installed on this machine and would make the board's daily document depend on an
// operator's `brew install`. The subset below is what one generator emits, it is written by that
// generator, and it is pinned by tests.
//
// If you add syntax to the document, add it here and to `board-markdown.test.ts`. Anything unhandled
// passes through as literal text rather than being silently dropped -- a missing sentence in a board
// document is the failure mode to avoid, and a stray asterisk is visible where an absence is not.
//
// THAT SENTENCE WAS A CLAIM AND NOT A PROPERTY UNTIL 2026-09-06, AND IT COST TWO PARAGRAPHS OF EDITION 1.
// The paragraph fallback decided "this line starts a new block" from the character class `^[#>|`-]`, so
// any paragraph beginning with inline code -- `` `fleet:hours`, built and measured... `` -- was refused by
// the paragraph branch, claimed by no other branch, and DISCARDED by a bare `i++`. Two board achievements
// rendered as headings with no body, on the one page that promises every claim carries its evidence. A
// backtick only starts a block when it is a fence and a dash only when it is a rule or a bullet, so the
// class was answering a question it could not answer. It is now `startsBlock()`, the SAME predicates the
// branches themselves use, and the fallback is unconditional: a line no branch claimed IS a paragraph.
// Found by the CEO reading the rendered PDF, not by the converter, which is the point of the test below.
/** @param {string} s */
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The code placeholder is deliberately not a bare number in spaces: ` 0 ` occurs in ordinary prose, and a
// converter that reaches into its own output for a token the text can also contain corrupts the text.
/** @param {number} i */
const SLOT = (i) => `§CODE${i}§`;

/**
 * Inline: `code`, **bold**, *italic*, [text](url). Code first, so markup inside it stays literal.
 * @param {string} text
 */
export function inline(text) {
  /** @type {string[]} */
  const codes = [];
  let s = escape(text).replace(/`([^`]+)`/g, (_, c) => SLOT(codes.push(c) - 1));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/§CODE(\d+)§/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** @param {string} row */
const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Does this line BEGIN a block? Asked with the same predicates the branches use, never by first
 * character -- see the note at the top of this file for what guessing cost.
 * @param {string} line @param {string} [next] */
const startsBlock = (line, next = "") => /^```/.test(line) || /^\s*$/.test(line)
  || /^---+\s*$/.test(line) || /^#{1,4}\s+/.test(line) || /^>\s?/.test(line)
  || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)
  || (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(next));

/** @typedef {(lines: string[], i: number) => [string, number] | null} BlockHandler */

// ONE HANDLER PER BLOCK KIND. Each takes the lines and the cursor, and returns `[html, nextIndex]` when
// it claims the line or `null` when it does not -- so `toHtml` is a loop over handlers rather than a
// fifteen-branch conditional. Extracted when `complexity` refused the single function at 25 against a
// budget of 15; the handlers are the shape the file already had, named.
/** @type {BlockHandler} */
const fence = (lines, i) => {
  if (!/^```/.test(lines[i])) return null;
  /** @type {string[]} */
  const body = [];
  for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
  return [`<pre><code>${escape(body.join("\n"))}</code></pre>`, i + 1];
};

/** @type {BlockHandler} */
const blank = (lines, i) => (/^\s*$/.test(lines[i]) ? ["", i + 1] : null);
/** @type {BlockHandler} */
const rule = (lines, i) => (/^---+\s*$/.test(lines[i]) ? ["<hr/>", i + 1] : null);

/** @type {BlockHandler} */
const heading = (lines, i) => {
  const m = /^(#{1,4})\s+(.*)$/.exec(lines[i]);
  return m ? [`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`, i + 1] : null;
};

/** @type {BlockHandler} */
const table = (lines, i) => {
  if (!/^\|/.test(lines[i]) || !/^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "")) return null;
  const head = cells(lines[i]);
  /** @type {string[][]} */
  const rows = [];
  let j = i + 2;
  for (; j < lines.length && /^\|/.test(lines[j]); j++) rows.push(cells(lines[j]));
  return [`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}`
    + "</tbody></table>", j];
};

/** @type {BlockHandler} */
const quote = (lines, i) => {
  if (!/^>\s?/.test(lines[i])) return null;
  /** @type {string[]} */
  const body = [];
  for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ""));
  return [`<blockquote>${toHtml(body.join("\n"))}</blockquote>`, i];
};

/** @param {string} tag @param {RegExp} pattern @returns {BlockHandler} */
const listOf = (tag, pattern) => (lines, i) => {
  if (!pattern.test(lines[i])) return null;
  /** @type {string[]} */
  const items = [];
  for (; i < lines.length && pattern.test(lines[i]); i++) items.push(lines[i].replace(pattern, ""));
  return [`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`, i];
};

/** @type {BlockHandler[]} */
const HANDLERS = [fence, blank, rule, heading, table, quote,
  listOf("ul", /^\s*[-*]\s+/), listOf("ol", /^\s*\d+\.\s+/)];

/** @param {string} md */
export function toHtml(md) {
  const lines = md.split("\n");
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length;) {
    const claimed = HANDLERS.reduce((/** @type {[string, number] | null} */ hit, handler) => hit ?? handler(lines, i), null);
    if (claimed) {
      const [html, next] = claimed;
      if (html) out.push(html);
      i = next;
      continue;
    }
    // UNCONDITIONAL FALLBACK. Every handler has declined, so this is a paragraph -- the first line is
    // taken without asking and only the CONTINUATION is guarded. A fallback that can decline is a
    // fallback that can delete; see the note at the top of this file for what that cost.
    const para = [lines[i++]];
    for (; i < lines.length && !startsBlock(lines[i], lines[i + 1] ?? ""); i++) para.push(lines[i]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
