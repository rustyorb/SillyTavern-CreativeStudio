import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore } from '../src/ui/palette.js';

test('palette fuzzy score prefers direct substring, supports subsequence, rejects misses', () => {
    assert.ok(fuzzyScore('sera', 'Seraphina Character') > fuzzyScore('sra', 'Seraphina Character'));
    assert.ok(fuzzyScore('sph', 'Seraphina') > 0);
    assert.equal(fuzzyScore('xyz', 'Seraphina'), -1);
    assert.equal(fuzzyScore('', 'anything'), 0);
});
