import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { expandBraces, MAX_GROUPS, MAX_WORD_LENGTH } from '../scripts/braces.ts';
import { runGuard, type GuardIo } from '../scripts/guard-core.ts';
import { createGit, makeSpawnRunner, type Runner } from '../scripts/git.ts';
import { cleanupTmp, tmpDir } from '../../../scripts/test/helpers.ts';
import { ruleOf } from './support.ts';

cleanupTmp();

const runner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 128, stdout: '' });

function guard(command: string, over: Partial<GuardIo> = {}) {
  const home = tmpDir();
  const io: GuardIo = {
    stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' }),
    env: { H7_HOME: home },
    platform: 'linux',
    runner,
    realpath: (p) => p,
    homedir: home,
    fallbackCwd: '/repo',
    now: () => new Date(0),
    ...over,
  };
  return runGuard(io);
}

const verdict = (result: ReturnType<typeof guard>): 'allow' | 'ask' | 'block' =>
  result.code === 2 ? 'block' : result.stdout === '' ? 'allow' : 'ask';

describe('internal failures ask instead of allowing', () => {
  const throwing = (message: string): Runner => () => {
    throw new Error(message);
  };

  it('an exception in any rule that consults git yields ASK', () => {
    for (const command of ['git reset --hard', 'git commit -m x', 'git add .', 'rm -rf dist', 'git checkout -- .', 'git stash drop']) {
      const result = guard(command, { runner: throwing('rule exploded') });
      assert.equal(verdict(result), 'ask', command);
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /^h7 guard internal error: rule exploded$/);
    }
  });

  it('a git timeout surfaces as an error, not as a clean worktree', () => {
    const timedOut = makeSpawnRunner('git', process.env, (() => ({ status: null, stdout: '', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) })) as never);
    assert.throws(() => timedOut(['status'], '/'), /git status timed out/);
    const result = guard('git reset --hard', { runner: timedOut });
    assert.equal(verdict(result), 'ask');
    assert.match(result.stdout, /timed out/);
  });

  it('other spawn failures (for example a missing directory) are not timeouts', () => {
    const missing = makeSpawnRunner('git', process.env, (() => ({ status: null, stdout: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) })) as never);
    assert.deepEqual(missing(['status'], '/nowhere'), { status: null, stdout: '' });
  });

  it('H7_GUARD=off remains the escape hatch', () => {
    assert.equal(verdict(guard('git reset --hard', { runner: throwing('x'), env: { H7_HOME: tmpDir(), H7_GUARD: 'off' } })), 'allow');
  });

  it('stack overflows in the scanner become ASK', () => {
    assert.equal(verdict(guard('rm -rf dist', { realpath: () => { throw new RangeError('Maximum call stack size exceeded'); }, runner: throwing('x') })), 'ask');
  });
});

describe('memo keys cannot collide', () => {
  it('keeps distinct cwd/remote combinations apart', () => {
    let computations = 0;
    const disk = { kind: () => { computations++; return 'dir' as const; }, read: () => null };
    const g = createGit(runner, disk);
    g.defaultBranch('a|b', 'c');
    g.defaultBranch('a', 'b|c');
    g.defaultBranch('a|b', 'c');
    assert.equal(computations, 2);
    const roots: string[] = [];
    const g2 = createGit((_args, cwd) => { roots.push(cwd); return { status: 0, stdout: cwd }; });
    assert.equal(g2.repoRoot('x\0y'), 'x\0y');
    assert.equal(g2.repoRoot('x'), 'x');
    assert.equal(g2.isDirty('x'), true);
    assert.deepEqual(roots, ['x\0y', 'x', 'x']);
  });
});

describe('brace expansion limits', () => {
  it('rejects huge, unsafe or overlong numeric endpoints and steps', () => {
    for (const word of ['{1..1000000000}', '{0..9999999999}', '{-1234567890..0}', '{1..5..1234567890}', '{1..99999999999999999999999}', '{1..300}', '{1..9..0}x{1..300}']) {
      assert.equal(expandBraces(word), null, word);
    }
    assert.deepEqual(expandBraces('{1..1e300}'), ['{1..1e300}']);
    assert.equal(expandBraces('{000000001..3}')?.length, 3);
  });

  it('caps word length and the number of groups', () => {
    assert.equal(expandBraces(`{a,b}${'x'.repeat(MAX_WORD_LENGTH)}`), null);
    assert.equal(expandBraces(`${'x'.repeat(MAX_WORD_LENGTH - 6)}{a,b}`)?.length, 2);
    assert.equal(expandBraces('{a}'.repeat(MAX_GROUPS + 1)), null);
    assert.equal(expandBraces('{a}'.repeat(MAX_GROUPS))?.length, 1);
    assert.equal(expandBraces('{'.repeat(5000)), null);
  });

  it('never takes long, whatever the input', () => {
    const start = performance.now();
    for (const word of ['{1..99999999}'.repeat(8), `{${'a,'.repeat(300)}b}`, '{{{{{{{{{{{{{{{{a,b}}}}}}}}}}}}}}}}', `{1..${'9'.repeat(400)}}`, '{a,b}'.repeat(20), `${'{'.repeat(15)}a,b${'}'.repeat(15)}`]) {
      const result = expandBraces(word);
      assert.ok(result === null || result.length <= 256);
    }
    assert.ok(performance.now() - start < 1000);
  });

  it('property: arbitrary brace soup terminates quickly with null or a bounded list', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-c{},.0-9-]{0,200}$/), (word) => {
        const start = performance.now();
        const result = expandBraces(word);
        assert.ok(result === null || (result.length >= 1 && result.length <= 256));
        assert.ok(performance.now() - start < 1000);
      }),
      { numRuns: 400 },
    );
  });

  it('property: huge range endpoints in rm targets ask, never allow', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 40 }), (digits) => {
        assert.equal(ruleOf(`rm -rf {1..${'9'.repeat(digits)}}`), 'ask:recursive-delete-unresolved');
      }),
    );
  });
});

describe('pathological inputs stay fast and never allow destructive commands', () => {
  const destructive = ['rm -rf /', 'git push --force origin main', 'git commit --no-verify -m x', 'rm -rf ~', 'rm -rf {/,x}'];

  it('100KB of filler before the dangerous command is still caught, quickly', () => {
    for (const command of destructive) {
      for (const filler of ['echo ' + 'a'.repeat(100_000) + '\n', ': ' + 'x '.repeat(50_000) + ';', '# ' + 'c'.repeat(100_000) + '\n']) {
        const start = performance.now();
        const result = guard(filler + command);
        assert.ok(performance.now() - start < 1000, `${command} took too long`);
        assert.notEqual(verdict(result), 'allow', command);
      }
    }
  });

  it('100KB single-token and unterminated-quote commands finish quickly', () => {
    for (const command of ['a'.repeat(100_000), `"${'a'.repeat(100_000)}`, `$(${'a'.repeat(100_000)}`, `\`${'a'.repeat(100_000)}`, '('.repeat(50_000), '$('.repeat(30_000), '{'.repeat(100_000), `echo ${'$(echo '.repeat(2000)}`, `cat <<EOF\n${'x\n'.repeat(50_000)}`]) {
      const start = performance.now();
      guard(command);
      assert.ok(performance.now() - start < 1000, command.slice(0, 20));
    }
  });

  it('deeply nested shells and substitutions around a destructive command ask or block', () => {
    const nestBash = (inner: string, depth: number): string => {
      let command = inner;
      for (let i = 0; i < depth; i++) command = `bash -c '${command.replaceAll("'", "'\\''")}'`;
      return command;
    };
    const nestSubst = (inner: string, depth: number): string => '$('.repeat(depth) + inner + ')'.repeat(depth);
    for (const command of destructive) {
      for (const depth of [1, 5, 6, 7, 12, 40]) {
        for (const wrapped of [nestBash(command, Math.min(depth, 8)), `echo ${nestSubst(command, depth)}`]) {
          const start = performance.now();
          const result = guard(wrapped);
          assert.ok(performance.now() - start < 1000);
          assert.notEqual(verdict(result), 'allow', `${command} @${depth}`);
        }
      }
    }
  });

  it('property: destructive commands embedded in arbitrary harmless prefixes are never allowed', () => {
    const prefix = fc.stringMatching(/^[a-z0-9 ]{0,200}$/);
    fc.assert(
      fc.property(prefix, fc.constantFrom(...destructive), fc.constantFrom('\n', ' && ', '; ', ' || '), (head, command, sep) => {
        assert.notEqual(verdict(guard(`echo ${head}${sep}${command}`)), 'allow');
      }),
      { numRuns: 200 },
    );
  });
});
