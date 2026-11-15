import { runs } from '../../../scripts/test/helpers.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { pickDecision, scan } from '../scripts/scan.ts';
import { ask, block } from '../scripts/types.ts';
import { decide, makeCtx, ruleOf } from './support.ts';

describe('pickDecision', () => {
  it('prefers a block over earlier asks and returns null for nothing', () => {
    const a = ask('a', 'x');
    const b = block('b', 'y');
    assert.equal(pickDecision([a, b]), b);
    assert.equal(pickDecision([a, ask('c', 'z')]), a);
    assert.equal(pickDecision([]), null);
  });
});

describe('scan', () => {
  it('evaluates every segment of a compound command', () => {
    assert.equal(ruleOf('ls && npm publish'), 'ask:deploy-publish');
    assert.equal(ruleOf('npm publish; git push -f origin main'), 'block:force-push-protected');
    assert.equal(ruleOf('echo ok | tee out; true'), null);
  });

  it('persists assignments and exports across segments only through the same scan', () => {
    assert.equal(ruleOf('HUSKY=0; git commit -m x'), 'block:skip-git-hooks');
    assert.equal(ruleOf('export SKIP=lint; git push'), 'block:skip-git-hooks');
    assert.equal(ruleOf('set HUSKY=0 && git commit -m x'), 'block:skip-git-hooks');
    assert.equal(ruleOf('HUSKY=0 npm test; git commit -m x'), null);
    assert.equal(ruleOf('export OTHER=1; git commit -m x'), null);
  });

  it('inherits cwd and env into nested scripts without leaking back', () => {
    assert.equal(ruleOf('cd /tmp && bash -c "rm -rf x"'), 'block:recursive-delete');
    assert.equal(ruleOf('export HUSKY=0; bash -c "git commit -m x"'), 'block:skip-git-hooks');
    assert.equal(ruleOf('bash -c "export HUSKY=0"; git commit -m x'), null);
    assert.equal(ruleOf('echo $(cd /tmp); rm -rf dist'), null);
  });

  it('scans substitutions even when the surrounding command is harmless', () => {
    assert.equal(ruleOf('echo "$(git push -f origin main)"'), 'block:force-push-protected');
    assert.equal(ruleOf('ls `git push -f origin main`'), 'block:force-push-protected');
    assert.equal(ruleOf("cat <<EOF\n$(git push -f origin main)\nEOF"), 'block:force-push-protected');
  });

  it('asks when shells are nested too deeply to inspect, and not before', () => {
    const wrap = (inner: string, levels: number): string => {
      let command = inner;
      for (let i = 0; i < levels; i++) command = `bash -c '${command.replaceAll("'", "'\\''")}'`;
      return command;
    };
    assert.equal(ruleOf(wrap('git push -f origin main', 6)), 'block:force-push-protected');
    assert.equal(ruleOf(wrap('git push -f origin main', 7)), 'ask:unscannable-command');
    assert.match(decide(wrap('ls', 8))?.reason ?? '', /nests shells too deeply/);
  });

  it('property: arbitrary command text never throws', () => {
    const soup = fc.stringMatching(/^[a-z "'`$()\\;&|<>\n#@{}:=./*~-]{0,80}$/);
    fc.assert(
      fc.property(soup, fc.constantFrom('sh' as const, 'ps' as const), (text, dialect) => {
        const ctx = makeCtx();
        scan(text, dialect, ctx, { cwd: ctx.cwd, env: {} });
      }),
      { numRuns: runs(800) },
    );
  });

  it('property: wrapping a blocked command in quotes makes it inert, in bash -c makes it live', () => {
    const blocked = fc.constantFrom('git push -f origin main', 'rm -rf /', 'git commit --no-verify');
    fc.assert(
      fc.property(blocked, (command) => {
        assert.equal(ruleOf(`echo '${command}'`), null);
        assert.notEqual(ruleOf(`bash -c '${command}'`), null);
        assert.notEqual(ruleOf(`sudo ${command}`), null);
        assert.notEqual(ruleOf(`true && ${command}`), null);
      }),
    );
  });
});
