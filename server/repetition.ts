/**
 * Notices a model output stuck in a loop (the same passage over and over), which local models sometimes fall into,
 * in their thinking especially. Left alone, the loop runs until the output limit, often for minutes.
 */

/** A loop: the latest `PROBE` characters occur this many times within the last `WINDOW` characters. */
const PROBE = 100;
const REPEATS = 8;
const WINDOW = 6000;
/** Check again after this many new characters. */
const STEP = 200;

export class RepetitionDetector {
  private text = '';
  private checkedAt = 0;

  /** Adds streamed text; true once it is looping. */
  push(chunk: string): boolean {
    this.text += chunk;
    if (this.text.length - this.checkedAt < STEP || this.text.length < PROBE * REPEATS) return false;
    this.checkedAt = this.text.length;
    const probe = this.text.slice(-PROBE);
    // Whitespace-only runs (e.g. long indentation) are not a loop.
    if (!probe.trim()) return false;
    const window = this.text.slice(-WINDOW);
    let count = 0;
    for (let i = window.indexOf(probe); i >= 0; i = window.indexOf(probe, i + 1)) count++;
    return count >= REPEATS;
  }

  /** The text up to where it starts repeating (one round of the loop, give or take), to keep instead of all of it. */
  trimmed(): string {
    const probe = this.text.slice(-PROBE);
    const first = this.text.indexOf(probe);
    if (first < 0) return this.text;
    const second = this.text.indexOf(probe, first + 1);
    return second < 0 ? this.text : this.text.slice(0, second);
  }
}
