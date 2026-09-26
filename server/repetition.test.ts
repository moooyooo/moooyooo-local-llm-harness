import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RepetitionDetector } from './repetition.js';

/** Streams `text` in small chunks, as Ollama does; returns where the loop was noticed. */
function stream(text: string): { at?: number; d: RepetitionDetector } {
  const d = new RepetitionDetector();
  for (let i = 0; i < text.length; i += 7) if (d.push(text.slice(i, i + 7))) return { at: i + 7, d };
  return { d };
}

test('a passage repeated over and over is noticed early and cut after its first round', () => {
  const round = 'Wait, I should check the file again before editing it, because the indentation might be different. ';
  const intro = 'Let me think about the task. ';
  const { at, d } = stream(intro + round.repeat(40));
  assert.ok(at && at < intro.length + round.length * 12, `noticed at ${at}`);
  const kept = d.trimmed();
  assert.ok(kept.startsWith(intro + round) && kept.length < intro.length + round.length * 2, kept);
});

test('ordinary long output is not a loop', () => {
  const prose = Array.from({ length: 200 }, (_, i) => `Step ${i}: update item ${i * 7} and check that total ${i * 13} is right.`).join('\n');
  assert.equal(stream(prose).at, undefined);
  // Code with many similar short lines, and long runs of spaces.
  const code = Array.from({ length: 300 }, (_, i) => `    { id: ${i}, name: "item${i}" },`).join('\n') + ' '.repeat(3000);
  assert.equal(stream(code).at, undefined);
});
