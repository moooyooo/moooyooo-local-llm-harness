import unittest

from md import render
from md.inline import inline


class InlineTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(inline("hello world"), "hello world")

    def test_escape_html(self):
        self.assertEqual(inline("a < b & c > d"), "a &lt; b &amp; c &gt; d")

    def test_code_span(self):
        self.assertEqual(inline("run `ls *.py` now"), "run <code>ls *.py</code> now")

    def test_code_span_is_escaped(self):
        self.assertEqual(inline("`<b>`"), "<code>&lt;b&gt;</code>")

    def test_bold_and_em(self):
        self.assertEqual(inline("**bold** and *em* and _em2_"), "<strong>bold</strong> and <em>em</em> and <em>em2</em>")

    def test_em_inside_bold(self):
        self.assertEqual(inline("**very *much***"), "<strong>very <em>much</em></strong>")

    def test_link(self):
        self.assertEqual(inline("see [the docs](https://example.com/a_b)"), 'see <a href="https://example.com/a_b">the docs</a>')

    def test_link_with_bold_text(self):
        self.assertEqual(inline('[**go**](x"y)'), '<a href="x&quot;y"><strong>go</strong></a>')

    def test_backslash_escapes(self):
        self.assertEqual(inline(r"not \*em\* and \_x\_"), "not *em* and _x_")


class BlockTest(unittest.TestCase):
    def test_headings(self):
        self.assertEqual(render("# One\n\n### Three *x*"), "<h1>One</h1>\n<h3>Three <em>x</em></h3>")

    def test_not_a_heading(self):
        self.assertEqual(render("#hashtag"), "<p>#hashtag</p>")

    def test_paragraph_lines_are_joined(self):
        self.assertEqual(render("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>")

    def test_rule(self):
        self.assertEqual(render("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>")

    def test_unordered_list(self):
        self.assertEqual(render("- a\n* **b**\n- c"), "<ul>\n<li>a</li>\n<li><strong>b</strong></li>\n<li>c</li>\n</ul>")

    def test_ordered_list(self):
        self.assertEqual(render("1. first\n2. second\n10. tenth"), "<ol>\n<li>first</li>\n<li>second</li>\n<li>tenth</li>\n</ol>")

    def test_list_ends_paragraph(self):
        self.assertEqual(render("Items:\n- a\n- b"), "<p>Items:</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>")

    def test_fenced_code(self):
        text = "```\nx = 1 < 2\n\n# not a heading\n```"
        self.assertEqual(render(text), "<pre><code>x = 1 &lt; 2\n\n# not a heading\n</code></pre>")

    def test_fenced_code_language(self):
        self.assertEqual(render("```py\nprint(*a)\n```"), '<pre><code class="language-py">print(*a)\n</code></pre>')

    def test_blockquote(self):
        self.assertEqual(render("> # Title\n>\n> text *here*"), "<blockquote>\n<h1>Title</h1>\n<p>text <em>here</em></p>\n</blockquote>")

    def test_document(self):
        text = "\n".join([
            "# Notes",
            "Some `code` and a [link](u).",
            "",
            "- one",
            "- two",
            "",
            "```sh",
            "echo **hi**",
            "```",
            "",
            "> quoted",
            "---",
        ])
        expected = "\n".join([
            "<h1>Notes</h1>",
            '<p>Some <code>code</code> and a <a href="u">link</a>.</p>',
            "<ul>",
            "<li>one</li>",
            "<li>two</li>",
            "</ul>",
            '<pre><code class="language-sh">echo **hi**',
            "</code></pre>",
            "<blockquote>",
            "<p>quoted</p>",
            "</blockquote>",
            "<hr>",
        ])
        self.assertEqual(render(text), expected)


if __name__ == "__main__":
    unittest.main()
