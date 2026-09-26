/**
 * Changes to what the model sees, or to how the loop reacts to it, that are switched on one by one, so each can be
 * measured on its own (scripts/eval --features) before it becomes the default. All are off unless turned on:
 * none has shown a benefit yet.
 *
 * - fuzzyEdit: an Edit whose old_string differs from the file only in whitespace is applied when unique; otherwise the
 *   error shows the most similar lines (server/editMatch.ts).
 * - failureAdvice: after several failed tool calls in a row, or failed Edits of one file, the tool result asks the
 *   model to rethink.
 * - loopDetection: a streamed reply that keeps repeating a passage is stopped and retried once (server/repetition.ts).
 * - outputLimit: each call's output is capped at what the context window has left; with thinking on, compaction
 *   starts at 65% of the window, and a reply cut off while thinking is asked to think more briefly.
 * - trimOutputs: before summarizing, old tool outputs are replaced with a short note.
 * - todoList: the TodoWrite tool and a system prompt rule to use it; the list is shown to the model every few calls,
 *   and a turn that ends with items left gets one reminder.
 */
export const FEATURES = ['fuzzyEdit', 'failureAdvice', 'loopDetection', 'outputLimit', 'trimOutputs', 'todoList'] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

export const NO_FEATURES: Features = Object.fromEntries(FEATURES.map((f) => [f, false])) as Features;

/** "fuzzyEdit,trimOutputs", "all" or "none" (also empty). Throws on an unknown name. */
export function parseFeatures(spec: string | undefined): Features {
  const names = (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === 'all') return Object.fromEntries(FEATURES.map((f) => [f, true])) as Features;
  const on = { ...NO_FEATURES };
  for (const name of names) {
    if (name === 'none') continue;
    if (!(FEATURES as readonly string[]).includes(name)) throw new Error(`Unknown feature "${name}". Known: ${FEATURES.join(', ')}, all, none`);
    on[name as Feature] = true;
  }
  return on;
}

export function describeFeatures(features: Features): string {
  const on = FEATURES.filter((f) => features[f]);
  return on.length ? on.join(', ') : 'none';
}
