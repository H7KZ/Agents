import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripNodeWarnings } from './helpers.ts';

describe('stripNodeWarnings', () => {
  const warning = '(node:4242) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time';
  const hint = '(Use `node --trace-warnings ...` to show where the warning was created)';

  it('drops only the ExperimentalWarning line and its trace-warnings hint', () => {
    assert.equal(stripNodeWarnings(`${warning}\n${hint}\n`), '');
    assert.equal(stripNodeWarnings(`${warning}\n${hint}\nh7 guard blocked [x]: why\n`), 'h7 guard blocked [x]: why\n');
  });

  it('keeps every other line, including other warnings and lines that merely mention the words', () => {
    for (const keep of ['(node:1) DeprecationWarning: x', 'error: ExperimentalWarning happened', 'see node --trace-warnings', '(Use something else)', 'h7 guard blocked']) {
      assert.equal(stripNodeWarnings(keep), keep);
    }
    assert.equal(stripNodeWarnings(''), '');
  });
});
