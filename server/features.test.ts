import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFeatures, FEATURES, NO_FEATURES, parseFeatures } from './features.js';

test('features are off unless named, and "all" turns every one on', () => {
  assert.deepEqual(parseFeatures(undefined), NO_FEATURES);
  assert.deepEqual(parseFeatures(''), NO_FEATURES);
  assert.deepEqual(parseFeatures('none'), NO_FEATURES);
  assert.deepEqual(parseFeatures(' trimOutputs , fuzzyEdit '), { ...NO_FEATURES, trimOutputs: true, fuzzyEdit: true });
  assert.equal(describeFeatures(parseFeatures('all')), FEATURES.join(', '));
  assert.throws(() => parseFeatures('trimOutput'), /Unknown feature "trimOutput"/);
});
