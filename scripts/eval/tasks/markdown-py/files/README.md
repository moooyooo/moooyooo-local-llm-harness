# md

A small Markdown to HTML converter. Standard library only. The package is split into three modules:

- `md/inline.py`: `inline(text) -> str` formats one piece of inline text.
- `md/blocks.py`: splits a document into blocks and renders each one (using `inline`).
- `md/__init__.py`: exposes `render(text) -> str`, the whole document as HTML.

## Blocks

Blocks are rendered in order and joined with `\n`. Blank lines separate blocks.

- **Heading**: `#` to `######`, a space, then the text: `<h1>text</h1>` ... `<h6>text</h6>`.
- **Horizontal rule**: a line that is exactly `---`: `<hr>`.
- **Fenced code**: a line starting with three backticks (optionally followed by a language, e.g. ```` ```py ````) up to the
  next line of three backticks. Rendered as `<pre><code>` (or `<pre><code class="language-py">`), the lines escaped (see
  below) but not formatted, each followed by `\n`, then `</code></pre>`. Blank lines inside the fence are kept.
- **Unordered list**: consecutive lines starting with `- ` or `* `: `<ul>`, one `<li>item</li>` per line, `</ul>`, each on
  its own line.
- **Ordered list**: consecutive lines starting with digits, `.` and a space: the same with `<ol>`.
- **Blockquote**: consecutive lines starting with `> ` (or a line that is just `>`): the text after the marker is rendered
  as a document of its own and wrapped as `<blockquote>\n...\n</blockquote>`.
- **Paragraph**: any other consecutive non-blank lines, joined with a single space: `<p>text</p>`.

A list, heading, rule, fence or blockquote also ends a paragraph that comes right before it.

## Inline

Applied to headings, list items and paragraphs, in this order:

1. A backslash before one of `` \ ` * _ [ ] ( ) # `` makes it a literal character.
2. `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`.
3. `` `code` `` becomes `<code>code</code>`; nothing inside it is formatted further.
4. `[text](url)` becomes `<a href="url">text</a>` (a `"` in the url becomes `&quot;`).
5. `**bold**` becomes `<strong>bold</strong>`.
6. `*em*` and `_em_` become `<em>em</em>`.
