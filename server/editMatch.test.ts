import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closestLines, fuzzyMatch } from './editMatch.js';

const PY = 'def f(x):\n    if x:\n        return 1\n    return 2\n';

/** Applies a match the way Edit does. */
const apply = (text: string, m: NonNullable<ReturnType<typeof fuzzyMatch>>) => text.replace(m.oldStr, m.newStr);

test('a snippet indented differently is found, and the replacement follows the file', () => {
  const m = fuzzyMatch(PY, 'if x:\n    return 1', 'if x:\n    return 10\nprint(x)')!;
  assert.equal(m.oldStr, '    if x:\n        return 1');
  assert.equal(apply(PY, m), 'def f(x):\n    if x:\n        return 10\n    print(x)\n    return 2\n');
  assert.match(m.note, /lines 2-3 ignoring leading and trailing whitespace/);
});

test('blank lines and trailing spaces around the snippet are ignored', () => {
  const m = fuzzyMatch(PY, '\n    return 2   \n', '\n    return 3\n')!;
  assert.equal(apply(PY, m), PY.replace('return 2', 'return 3'));
});

test('differences in spacing inside a line are ignored, but not missing spaces', () => {
  assert.equal(apply('x = 1\ny = 2\n', fuzzyMatch('x = 1\ny = 2\n', 'x  =  1', 'x = 5')!), 'x = 5\ny = 2\n');
  assert.equal(fuzzyMatch('x = a + b\n', 'x = a+b', 'x = c'), undefined);
});

test('"\\n" written out is read as a line break', () => {
  const m = fuzzyMatch(PY, '    if x:\\n        return 1', '    if x:\\n        return 9')!;
  assert.equal(apply(PY, m), PY.replace('return 1', 'return 9'));
});

test('nothing is replaced when the match is ambiguous, or unevenly indented with tabs', () => {
  const twice = 'if a:\n    go()\nif b:\n        go()\n';
  assert.equal(fuzzyMatch(twice, 'go()', 'stop()'), undefined, 'two candidates');
  assert.equal(fuzzyMatch('\tif x:\n\t\treturn 1\n', 'if x:\nreturn 1', 'if x:\nreturn 5'), undefined, 'uneven, with tabs');
  assert.equal(fuzzyMatch(PY, '\n\n', 'x'), undefined);
});

test('CRLF files keep their line endings', () => {
  const text = 'a\r\n  b\r\n  c\r\n';
  const m = fuzzyMatch(text, 'b\nc', 'B\nC')!;
  assert.equal(apply(text, m), 'a\r\n  B\r\n  C\r\n');
});

test('the most similar lines are shown when nothing matches', () => {
  const text = ['one', 'two', 'three', 'four', 'five'].join('\n');
  assert.deepEqual(closestLines(text, 'three\nFOUR'), { from: 2, to: 5, lines: ['two', 'three', 'four', 'five'] });
  assert.equal(closestLines(text, 'nothing like it'), undefined);
});

test('a line off by a space is corrected line by line (seen: a closing bracket indented one space too far)', () => {
  const file = 'def report(self):\n        lines.append(\n            f"TOTAL {total}"\n        )\n        return lines\n';
  const m = fuzzyMatch(file, '        lines.append(\n            f"TOTAL {total}"\n         )', '        lines.append(\n            f"SUM {total}"\n         )')!;
  assert.equal(file.replace(m.oldStr, m.newStr), file.replace('TOTAL', 'SUM'));
});

test('uneven indentation still keeps the indentation new_string adds on purpose', () => {
  const file = 'def f():\n    x = 1\n    y = 2\n';
  // old_string has y one space off; the change wraps both lines in an if.
  const m = fuzzyMatch(file, '    x = 1\n     y = 2', '    if ok:\n        x = 1\n         y = 2')!;
  assert.equal(file.replace(m.oldStr, m.newStr), 'def f():\n    if ok:\n        x = 1\n        y = 2\n');
});
