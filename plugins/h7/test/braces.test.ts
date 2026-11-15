import { runs } from '../../../scripts/test/helpers.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { expandBraces } from '../scripts/braces.ts';
import { ruleOf } from './support.ts';

const BLOCK = 'block:recursive-delete';
const ASK = 'ask:recursive-delete-unresolved';

describe('expandBraces', () => {
  it('leaves words without expansions alone', () => {
    for (const word of ['', 'plain', '{a}', '{}', 'a{', '}{', '${HOME}', '${A,b}x', 'a{b', '{a..}', '{1..a}']) {
      assert.deepEqual(expandBraces(word), [word], word);
    }
  });

  it('expands lists with prefixes, suffixes and nesting', () => {
    assert.deepEqual(expandBraces('{a,b}'), ['a', 'b']);
    assert.deepEqual(expandBraces('x/{a,b}/y'), ['x/a/y', 'x/b/y']);
    assert.deepEqual(expandBraces('{/,x}'), ['/', 'x']);
    assert.deepEqual(expandBraces('~/{a,..}'), ['~/a', '~/..']);
    assert.deepEqual(expandBraces('{a,b{1,2}}'), ['a', 'b1', 'b2']);
    assert.deepEqual(expandBraces('{a,b}{1,2}'), ['a1', 'a2', 'b1', 'b2']);
    assert.deepEqual(expandBraces('{,a}'), ['', 'a']);
    assert.deepEqual(expandBraces('{a,}'), ['a', '']);
  });

  it('expands numeric and alphabetic sequences, ascending and descending', () => {
    assert.deepEqual(expandBraces('f{1..3}'), ['f1', 'f2', 'f3']);
    assert.deepEqual(expandBraces('f{3..1}'), ['f3', 'f2', 'f1']);
    assert.deepEqual(expandBraces('{1..7..3}'), ['1', '4', '7']);
    assert.deepEqual(expandBraces('{-1..1}'), ['-1', '0', '1']);
    assert.deepEqual(expandBraces('{a..c}'), ['a', 'b', 'c']);
    assert.deepEqual(expandBraces('{c..a}'), ['c', 'b', 'a']);
    assert.deepEqual(expandBraces('{1..2..0}'), ['1', '2']);
  });

  it('gives up (null) beyond 256 results', () => {
    assert.equal(expandBraces('{1..100000}'), null);
    assert.equal(expandBraces('{1..256}')?.length, 256);
    assert.equal(expandBraces('{1..257}'), null);
    assert.equal(expandBraces('{1..16}{1..17}'), null);
    assert.equal(expandBraces('{a,b}{1..300}'), null);
    assert.equal(expandBraces('{{1..300},x}'), null);
  });

  it('property: expansion of a list yields prefix+item+suffix for each item', () => {
    const item = fc.stringMatching(/^[a-z0-9._-]{0,6}$/);
    fc.assert(
      fc.property(item, fc.array(item, { minLength: 2, maxLength: 5 }), item, (prefix, items, suffix) => {
        assert.deepEqual(expandBraces(`${prefix}{${items.join(',')}}${suffix}`), items.map((i) => prefix + i + suffix));
      }),
    );
  });

  it('property: never throws and always returns at least one variant or null', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9{},.$/~-]{0,30}$/), (word) => {
        const result = expandBraces(word);
        assert.ok(result === null || (result.length >= 1 && result.length <= 256));
      }),
      { numRuns: runs(500) },
    );
  });
});

describe('recursive delete and brace expansion', () => {
  it('blocks if any expansion is outside or forbidden', () => {
    for (const command of ['rm -rf {/,x}', 'rm -rf ~/{a,..}', 'rm -rf {x,/}', 'rm -rf {a,b}/../..', 'rm -rf /{a..c}', 'rm -rf {.,x}', 'rm -rf ~/{a,b}', 'rm -rf {x,../y}', 'rm -rf {x,{y,/}}', 'rm -rf {x,~}']) {
      assert.equal(ruleOf(command), BLOCK, command);
    }
  });

  it('allows expansions that all stay inside the repository', () => {
    for (const command of ['rm -rf {dist,build}', 'rm -rf dist{1..3}', 'rm -rf src/{a,b}/tmp', 'rm -rf {a..c}/x', 'rm -rf {x,y}*']) {
      assert.equal(ruleOf(command), null, command);
    }
  });

  it('asks when the expansion cannot be bounded or uses variables', () => {
    for (const command of ['rm -rf {1..100000}', 'rm -rf {x,$Y}', 'rm -rf $X{a,b}', 'rm -rf {a,b}$(pwd)']) {
      assert.equal(ruleOf(command), ASK, command);
    }
  });

  it('prefers a block over an ask in the same command', () => {
    assert.equal(ruleOf('rm -rf $X /'), BLOCK);
    assert.equal(ruleOf('rm -rf {$X,/}'), BLOCK);
    assert.equal(ruleOf('rm -rf $X $Y'), ASK);
  });
});

describe('parser differentials never allow unresolved targets', () => {
  it('property: any target containing a variable, substitution or ~user asks or blocks', () => {
    const name = fc.stringMatching(/^[a-z]{1,6}$/);
    const wrappers: ((n: string) => string)[] = [
      (n) => `$${n}`,
      (n) => `\${${n}}`,
      (n) => `"$${n}/x"`,
      (n) => `$(echo ${n})`,
      (n) => `\`echo ${n}\``,
      (n) => `~${n}`,
      (n) => `~${n}/x`,
      (n) => `x/$${n}`,
      (n) => `{${n},y}$Z`,
    ];
    fc.assert(
      fc.property(name, fc.constantFrom(...wrappers), (n, wrap) => {
        const rule = ruleOf(`rm -rf ${wrap(n)}`);
        assert.ok(rule === ASK || rule === BLOCK, `${wrap(n)} -> ${rule}`);
      }),
    );
  });

  it('property: nested shells and substitutions carry the same verdict', () => {
    for (const target of ['$HOMEX', '{/,x}', '~other']) {
      assert.notEqual(ruleOf(`bash -c 'rm -rf ${target}'`), null, target);
      assert.notEqual(ruleOf(`echo $(rm -rf ${target})`), null, target);
    }
  });
});
